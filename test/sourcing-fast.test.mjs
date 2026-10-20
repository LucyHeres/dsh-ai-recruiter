import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateSources, numberEvidence } from '../dist/lib/sourcing/evaluator.js'
import { runSourcingWorkflow } from '../dist/lib/sourcing/fast-runner.js'
import { SourcingHandoff } from '../dist/lib/sourcing/browser.js'

const requirements = { keyword: 'Java', criteria: [{ id: 'java', label: 'Java', quote: 'Java开发', weight: 100, must: true }] }
const judgement = (source, state = 'match') => ({ sourceId: source.sourceId, fields: [], assessments: [{ criterionId: 'java', state, evidenceId: state === 'unknown' ? null : 0, reason: '原文证据' }] })
const done = { status: 'completed', message: 'done', turns: 1, modelMs: 10, toolMs: 1 }
const signal = () => new AbortController().signal

test('numbered evidence preserves the entire source, exact text and unicode boundaries', () => {
  const text = ('Java开发负责订单与数据维护。' + '证据'.repeat(80) + '🙂\n').repeat(12)
  const evidence = numberEvidence(text)
  assert.equal(evidence.map(e => e.text).join(''), text)
  assert.ok(evidence.every((e, i) => e.id === i && e.text.length <= 240 && !/[\uD800-\uDBFF]$/.test(e.text)))
})

test('assessment conversation is isolated and rejects cross-person evidence, duplicated IDs; ungrounded optional fields are omitted', async () => {
  const sources = [{ sourceId: 'one', name: '陈先生', text: 'Java开发' }, { sourceId: 'two', name: '李先生', text: 'Python开发' }]
  const agent = async options => {
    assert.deepEqual(options.tools.map(t => t.name), ['sourcing_submit_assessments'])
    assert.equal(options.initialToolResults, undefined)
    assert.deepEqual(options.goal.candidates.map(c => c.evidence.map(e => e.text).join('')), sources.map(s => s.text))
    const submit = options.tools[0].execute
    const unknown = judgement(sources[1], 'unknown')
    unknown.assessments[0].evidenceId = 99 // harmless surplus metadata is discarded
    const valid = { candidates: [judgement(sources[0]), unknown] }
    await assert.rejects(submit({ candidates: [judgement(sources[0]), judgement(sources[0])] }), /SOURCE_MISMATCH/)
    await assert.rejects(submit({ candidates: [judgement(sources[0]), { ...judgement(sources[1]), assessments: [{ ...judgement(sources[1]).assessments[0], evidenceId: 99 }] }] }), /EVIDENCE_MISSING/)
    assert.equal(options.isComplete(), false)
    await submit({ candidates: [{ ...valid.candidates[0], fields: [{ label: '期望薪资', value: '30-50K' }] }, valid.candidates[1]] })
    assert.equal(options.isComplete(), true)
    return done
  }
  const result = await evaluateSources(agent, requirements, sources, signal())
  assert.equal(result.length, 2)
  assert.deepEqual(result[0].fields, [], 'invented salary never persists or triggers another assessment')
  assert.equal(result[0].assessments[0].quote, sources[0].text)
  assert.equal(result[1].assessments[0].quote, '')
})

test('incomplete assessment never becomes an accepted result and cancellation is respected', async () => {
  const sources = [{ sourceId: 'one', name: '陈先生', text: 'Java开发' }]
  await assert.rejects(evaluateSources(async () => ({ ...done, status: 'budget' }), requirements, sources, signal()), /ASSESSMENT_INCOMPLETE/)
  const controller = new AbortController()
  const agent = async options => { await options.tools[0].execute({ candidates: [judgement(sources[0])] }); controller.abort(new Error('cancelled')); return done }
  await assert.rejects(evaluateSources(agent, requirements, sources, controller.signal), /cancelled/)
})

function fixture(overrides = {}) {
  let revision = 0, pending, current, recorded = 0, needsGreeting = false, fallbackCalls = 0, assessmentCalls = 0, searchReady = overrides.searchReady ?? true
  const events = [], assessedBatches = []
  const cards = [1, 2, 3].map(i => ({ sourceId: String(i), name: `陈${i}先生`, text: 'Java开发', ref: `name${i}`, evidenceRefs: [`card${i}`] }))
  const job = { requirements, candidates: [], searchFilters: {}, jobName: 'Java', limit: 2 }
  const page = () => ({ tabId: 1, snapshotId: `s${revision}`, items: [] })
  const broker = { currentPage: page, tools: [{ name: 'browser_snapshot', execute: async () => { revision++; return page() } }] }
  const driver = {
    recognizes: async () => true,
    prepareSearch: async () => ({ tabId: 1, snapshotId: 's0', ref: 'position', mode: 'position', filters: [] }),
    cards: async () => { revision++; return cards.map(c => ({ ...c, ref: `${c.ref}-s${revision}` })) },
    open: async card => { events.push('open:' + card.sourceId); current = card; return locator() },
    resume: async () => { revision++; return locator() },
    returnToList: async () => { events.push('return') },
    greeting: async (name, candidateKey) => ({ candidateKey, name }),
    advance: async () => { throw new SourcingHandoff('end_unverified') },
    ...overrides.driver,
  }
  const locator = () => ({ tabId: 1, snapshotId: `s${revision}`, identityRef: 'resume', resumeRefs: ['resume'] })
  const hooks = {
    sourcing_confirm_search: async () => { searchReady = true; return { searchReady } },
    sourcing_select_candidate: async args => {
      assert.equal(args.snapshotId, page().snapshotId)
      assert.match(args.ref, new RegExp(`-s${revision}$`), 'old model refs are never reused')
      pending = args.name
      events.push('select:' + args.name)
      return { qualified: true }
    },
    sourcing_read_resume: async () => ({ capturedCharacters: 6 }),
    sourcing_record_candidate: async args => {
      assert.equal(args.snapshotId, page().snapshotId)
      assert.equal(args.fields.length, 0)
      events.push('record:' + pending); recorded++; pending = undefined; needsGreeting = !!overrides.autoGreet
      return { needsGreeting, candidateKey: current.sourceId }
    },
    sourcing_greet_candidate: async args => { events.push('greet:' + args.candidateKey); needsGreeting = false },
    ...overrides.hooks,
  }
  const tools = Object.entries(hooks).map(([name, execute]) => ({ name, execute }))
  const ops = { tools, recoveryTools: () => tools, preview: async card => ({ text: card.text, duplicate: false }), remaining: () => 2 - recorded, complete: () => recorded >= 2 && !needsGreeting,
    state: () => ({ searchReady, pending, needsGreeting }),
    captured: () => pending ? { name: pending, text: 'Java开发', scope: 'online' } : undefined }
  const agent = async options => {
    if (options.tools[0]?.name !== 'sourcing_submit_assessments') { fallbackCalls++; events.push('fallback'); return overrides.fallback?.(options, ops) ?? done }
    assessmentCalls++
    assessedBatches.push(options.goal.candidates.map(s => s.sourceId))
    await options.tools[0].execute({ candidates: options.goal.candidates.map(s => { const row = judgement(s); if (options.goal.mode === 'preview') delete row.fields; return row }) }, options.signal)
    return done
  }
  return { run: () => runSourcingWorkflow({ createSourcingDriver: () => driver }, { broker, job, signal: signal() }, ops, agent,
    { system: 'fallback', goal: {}, tools, signal: signal() }), events, assessedBatches, counts: () => ({ recorded, assessmentCalls, fallbackCalls }) }
}

test('one batch preview and one assessment per accepted candidate, with fresh refs and serial greeting', async () => {
  const f = fixture({ autoGreet: true })
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.deepEqual(f.counts(), { recorded: 2, assessmentCalls: 3, fallbackCalls: 0 })
  assert.equal(f.assessedBatches[0].length, 2)
  assert.ok(f.events.indexOf('greet:1') < f.events.indexOf('select:陈2先生'))
})

test('unknown browser input and storage errors stop without handing off or replaying', async () => {
  for (const code of ['BROWSER_WRITE_OUTCOME_UNKNOWN', 'TASK_STORAGE_UNAVAILABLE']) {
    const f = fixture({ driver: { open: async () => { throw Error(code) } } })
    await assert.rejects(f.run(), new RegExp(code))
    assert.equal(f.counts().fallbackCalls, 0)
    assert.equal(f.events.filter(e => e.startsWith('select:')).length, 1)
  }
})

test('changed details hand off with the same pending candidate rather than restarting search', async () => {
  const f = fixture({ driver: { open: async () => { throw new SourcingHandoff('unknown_modal') } }, fallback: async options => {
    assert.equal(options.goal.hostState.pending, '陈1先生')
    assert.equal(options.goal.hostState.searchReady, true)
    assert.equal(options.goal.requirements, requirements)
    return { ...done, status: 'stopped' }
  } })
  assert.equal((await f.run()).status, 'stopped')
  assert.equal(f.counts().fallbackCalls, 1)
})

test('low-score cards never open, and incomplete batches never change browser/host candidate state', async () => {
  const f = fixture({ hooks: { sourcing_select_candidate: async () => ({ qualified: false }) } })
  await f.run()
  assert.equal(f.events.some(e => e.startsWith('open:')), false)
  assert.equal(f.counts().recorded, 0)
})

test('candidate condition judgements preserve source-bound evidence and fill omitted fields as unknown', async () => {
  const sources = [{ sourceId: 'candidate', name: 'Example', text: 'Java开发；期望工作城市：武汉；学历：本科' }]
  let calls = 0
  const runner = async options => {
    calls++
    assert.deepEqual(options.goal.candidateFilters, { city: '武汉', education: '本科' })
    assert.match(options.system, /不能把现居城市当作工作意向/)
    const candidate = { ...judgement(sources[0]), filterAssessments: [
      { field: 'city', state: 'match', evidenceId: 0, reason: 'Explicit desired city' },
      { field: 'education', state: 'match', evidenceId: 0, reason: 'Explicit education' },
    ] }
    delete candidate.fields
    await assert.rejects(options.tools[0].execute({ candidates: [{ ...candidate, filterAssessments: [candidate.filterAssessments[0], candidate.filterAssessments[0]] }] }), /FILTER_ASSESSMENT_REQUIRED/)
    await assert.rejects(options.tools[0].execute({ candidates: [{ ...candidate, filterAssessments: candidate.filterAssessments.map(row => ({ ...row, evidenceId: 99 })) }] }), /FILTER_EVIDENCE_MISSING/)
    await options.tools[0].execute({ candidates: [candidate] })
    return done
  }
  const result = await evaluateSources(runner, requirements, sources, signal(), undefined, 'preview', { city: '武汉', education: '本科' })
  assert.equal(calls, 1)
  assert.equal(result[0].filterAssessments.length, 2)
  assert.equal(result[0].filterAssessments[0].quote, sources[0].text)
})

test('omitted condition decisions do not force a second assessment turn or count as verified matches', async () => {
  const sources = [{ sourceId: 'one', name: '陈先生', text: 'Java开发' }]
  const result = await evaluateSources(async options => {
    await options.tools[0].execute({ candidates: [judgement(sources[0])] })
    assert.equal(options.isComplete(), true)
    return done
  }, requirements, sources, signal(), undefined, 'preview', { city: '武汉', education: '本科' })
  assert.deepEqual(result[0].filterAssessments.map(row => [row.field, row.state, row.quote]), [['city', 'unknown', ''], ['education', 'unknown', '']])
})

test('AI preparing recovery returns to the fast driver once without replaying candidate or greeting actions', async () => {
  let preparations = 0
  const f = fixture({ searchReady: false, driver: { prepareSearch: async () => {
    if (++preparations === 1) throw new SourcingHandoff('unknown_startup_dialog')
    return { tabId: 1, snapshotId: 's0', ref: 'position', mode: 'position', filters: [] }
  } }, fallback: async options => {
    await options.tools.find(tool => tool.name === 'sourcing_confirm_search').execute({})
    assert.equal(options.isComplete(), true, 'ready navigation returns ownership to the fast driver')
    return done
  } })
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(preparations, 2)
  assert.deepEqual(f.counts(), { recorded: 2, assessmentCalls: 3, fallbackCalls: 1 })
  assert.equal(result.turns, 4)
})

test('an unknown fallback outcome never resumes the fast driver even after preparation became ready', async () => {
  let preparations = 0
  const f = fixture({ searchReady: false, driver: { prepareSearch: async () => { preparations++; throw new SourcingHandoff('startup_dialog') } }, fallback: async options => {
    await options.tools.find(tool => tool.name === 'sourcing_confirm_search').execute({})
    return { ...done, status: 'stopped', message: 'BROWSER_WRITE_OUTCOME_UNKNOWN' }
  } })
  await assert.rejects(f.run(), /OUTCOME_UNKNOWN/)
  assert.equal(preparations, 1)
  assert.equal(f.counts().assessmentCalls, 0)
})
