import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runBrowserAgent } from '../dist/lib/browser-agent.js'
import { runSourcingWorkflow } from '../dist/lib/sourcing/fast-runner.js'
import { SourcingHandoff } from '../dist/lib/sourcing/browser.js'

function fixture(options = {}) {
  let pending, captured, recorded = 0, prepared = false, overlay = true, preparations = 0, navigationCalls = 0, assessments = 0
  const events = [], requests = []
  const controller = new AbortController()
  const page = () => ({ tabId: 1, snapshotId: 's', documentId: 'doc', url: 'https://lpt.liepin.com/recommend',
    items: [{ ref: 'surface', role: 'button', name: overlay ? '提示层' : '候选列表' }] })
  const broker = { currentPage: page, contextSnapshot: () => undefined,
    tools: [{ name: 'browser_snapshot', execute: async () => page() }] }
  const cards = [{ sourceId: 'person-1', name: '陈先生', text: 'Java开发工作经历', ref: 'person', openRef: 'open', evidenceRefs: ['person'] }]
  const locator = { tabId: 1, snapshotId: 's', identityRef: 'resume', resumeRefs: ['resume'] }
  const driver = {
    recognizes: async () => true,
    prepareSearch: async () => {
      preparations++
      if (options.failPreparation && overlay) throw new SourcingHandoff('unknown_overlay')
      return {}
    },
    cards: async () => cards,
    open: async () => { events.push('open'); if (options.unknownOpen) throw new Error('BROWSER_WRITE_OUTCOME_UNKNOWN'); return locator },
    resume: async () => locator,
    returnToList: async () => undefined,
    advance: async () => { throw new Error('unexpected advance') },
  }
  const tool = (name, execute) => ({ name, description: name, inputSchema: { type: 'object' }, readOnly: false, execute })
  const tools = [
    tool('sourcing_confirm_search', async () => { prepared = true; return { searchReady: true } }),
    tool('sourcing_select_candidate', async args => { pending = args.name; events.push('select'); return { qualified: true } }),
    tool('sourcing_read_resume', async () => { captured = 'Java开发真实工作经历'; return { capturedCharacters: captured.length } }),
    tool('sourcing_record_candidate', async () => { events.push('record'); recorded++; pending = undefined; return {} }),
    tool('browser_close_surface', async () => { overlay = false; events.push('close'); return { changed: true } }),
  ]
  const operations = { tools, recoveryTools: () => [...tools], remaining: () => 1 - recorded,
    preview: async card => ({ text: card.text, duplicate: false }), complete: () => recorded === 1,
    state: () => ({ searchReady: prepared, pending, needsGreeting: false }),
    captured: () => pending && captured ? { name: pending, text: captured, scope: 'online' } : undefined }
  const job = { limit: 1, sourceMode: 'recommend', candidates: [], requirements: { keyword: 'Java', listCriteria: [{ field: 'education', requirement: '本科', quote: '本科' }], criteria: [
    { id: 'java', label: 'Java', quote: 'Java', must: true, weight: 100 },
  ] } }
  const llm = { async *stream(request) {
    requests.push(request)
    const goal = JSON.parse(request.messages[0].content[0].text)
    let calls
    if (request.tools[0]?.name === 'sourcing_submit_assessments') {
      assessments++
      assert.equal(request.tools.length, 1, 'assessments have no browser capabilities')
      calls = [{ name: 'sourcing_submit_assessments', args: { candidates: goal.candidates.map(candidate => ({ sourceId: candidate.sourceId,
        ...(goal.mode === 'detail' ? { fields: [] } : {}),
        ...(goal.mode === 'preview' ? { listAssessments: goal.listCriteria.map(c => ({ field: c.field, state: 'match', evidenceId: 0, reason: 'source evidence' })) } : { assessments: [{ criterionId: 'java', state: 'match', evidenceId: 0, reason: 'source evidence' }] }) })) } }]
    } else {
      navigationCalls++
      if (navigationCalls > 1) assert.ok(request.messages.some(message => message.role === 'assistant'), 'recovery stays in the same conversation')
      calls = options.repeatUnchanged ? [{ name: 'sourcing_collect', args: {} }]
        : [{ name: 'browser_close_surface', args: {} }, { name: 'sourcing_confirm_search', args: {} }]
    }
    for (let index = 0; index < calls.length; index++) {
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'block-end', index, block: { type: 'tool-call', id: `call-${requests.length}-${index}`, name: calls[index].name, arguments: JSON.stringify(calls[index].args) } }
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  } }
  const agent = opts => runBrowserAgent(llm, { provider: 'test', model: 'test' }, opts)
  const run = () => runSourcingWorkflow({ createSourcingDriver: () => driver }, { broker, job, signal: controller.signal }, operations, agent,
    { system: 'test', goal: {}, tools, signal: controller.signal, maxTurns: 5, maxDurationMs: 5000,
      isFatal: error => /OUTCOME_UNKNOWN|RESULT_UNKNOWN|TASK_STORAGE_UNAVAILABLE/.test(String(error)) })
  return { run, events, requests, counts: () => ({ preparations, navigationCalls, assessments, recorded, pending }) }
}

test('known platform flow completes with zero navigation inference and isolated scoring only', async () => {
  const f = fixture()
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.deepEqual(f.counts(), { preparations: 1, navigationCalls: 0, assessments: 2, recorded: 1, pending: undefined })
  assert.deepEqual(f.events, ['select', 'open', 'record'])
})

test('only an unexpected surface starts navigation inference, and fixed code resumes before another model turn', async () => {
  const f = fixture({ failPreparation: true })
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(f.counts().navigationCalls, 1)
  assert.equal(f.counts().preparations, 2)
  assert.deepEqual(f.events, ['close', 'select', 'open', 'record'])
  assert.match(JSON.stringify(f.requests.find(request => request.tools.some(tool => tool.name === 'browser_close_surface')).messages), /unknown_overlay/)
})

test('an unknown input stops the outer agent, keeps the pending candidate and never starts recovery or another collection', async () => {
  const f = fixture({ unknownOpen: true })
  await assert.rejects(f.run(), /OUTCOME_UNKNOWN/)
  assert.equal(f.counts().navigationCalls, 0)
  assert.equal(f.counts().preparations, 1)
  assert.equal(f.counts().pending, '陈先生')
  assert.equal(f.counts().recorded, 0)
  assert.equal(f.events.filter(event => event === 'open').length, 1)
})

test('refreshing observation without changing the page cannot repeatedly restart the domain workflow', async () => {
  const f = fixture({ failPreparation: true, repeatUnchanged: true })
  const result = await f.run()
  assert.equal(result.status, 'stopped')
  assert.match(result.message, /REPEATED_FAILURE/)
  assert.equal(f.counts().preparations, 1)
  assert.equal(f.counts().assessments, 0)
})
