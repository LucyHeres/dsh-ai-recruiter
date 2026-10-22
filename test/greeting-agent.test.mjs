import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { GreetingAgent } from '../dist/lib/greeting-agent.js'
import { runBrowserAgent } from '../dist/lib/browser-agent.js'
import { Store } from '../dist/lib/store.js'
import { createGreetingJob } from '../dist/lib/greeting-executor.js'

const origin = 'https://lpt.liepin.com'
const schema = (name, readOnly, properties, required = []) => ({ name, description: 'opaque tool',
  inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { readOnlyHint: readOnly },
  _meta: { browserAgent: { available: true, capability: name.replace('_', '.') } } })
const props = { tabId: { type: 'integer' }, snapshotId: { type: 'string' }, ref: { type: 'string' } }
const infos = [schema('browser_snapshot', true, { tabId: props.tabId }, ['tabId']),
  schema('browser_custom_interaction', false, props, ['tabId', 'snapshotId', 'ref'])]
const page = n => ({ tabId: 1, snapshotId: `s${n}`, documentId: 'doc', url: `${origin}/opaque`, items: [
  { ref: 'candidate', role: 'article', name: '林先生 数据处理项目' },
  { ref: 'target', role: 'button', name: 'opaque action', context: { text: '林先生 数据处理项目' } },
  ...(n > 1 ? [{ ref: 'receipt', role: 'status', name: '已确认发送完成' }] : []),
] })
const snapshot = { name: 'browser_snapshot', args: { tabId: 1 } }
const select = { name: 'task_select_candidate', args: { tabId: 1, snapshotId: 's1', ref: 'target', name: '林先生' } }
const write = { name: 'browser_custom_interaction', args: { tabId: 1, snapshotId: 's1', ref: 'target', purpose: 'business_write' } }
const report = { name: 'task_report_result', args: { tabId: 1, snapshotId: 's2', outcome: 'completed', evidenceRefs: ['receipt'], reason: '已确认发送完成' } }
const finish = { name: 'task_finish', args: { reason: '完成用户目标' } }
async function fixture(steps, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'generic-greeting-'))
  try {
    const store = new Store(dir, 'test'); await store.init()
    const job = createGreetingJob({ id: randomUUID(), platform: 'liepin', limit: options.limit ?? 1, confirmed: true })
    Object.assign(job, options.job)
    await store.put(`greeting-${job.id}`, job)
    const put = store.put.bind(store)
    if (options.storageFailure) store.put = async (key, value) => {
      if (value.phase === 'sending') throw new Error('SIMULATED_STORAGE_FAILURE')
      return put(key, value)
    }
    const requests = [], calls = []; let snapshots = 0, writes = 0
    const llm = { async *stream(request) {
      requests.push(request)
      await options.onModel?.(requests.length)
      const next = steps.shift(); assert.ok(next, 'Unexpected model request')
      const list = typeof next === 'function' ? next(request) : next
      for (let index = 0; index < list.length; index++) {
        const action = list[index]
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'block-end', index, block: { type: 'tool-call', id: `${requests.length}-${index}`, name: action.name, arguments: JSON.stringify(action.args) } }
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } }
    const call = async (name, args) => {
      calls.push(name)
      if (name === 'browser_list_tabs') return { tabs: [{ tabId: 1, url: `${origin}/opaque` }] }
      if (name === 'browser_snapshot') return (options.page ?? page)(++snapshots)
      if (name === 'browser_inspect_element') return { item: (options.page ?? page)(snapshots).items.find(item => item.ref === args.ref) }
      if (name === 'browser_custom_interaction' || name === 'browser_click') {
        if (args.policy.riskLevel !== 'business_write') return { dispatched: true }
        writes++
        const saved = await store.get(`greeting-${job.id}`)
        assert.equal(saved.results.at(-1).stage, 'sending')
        assert.ok(saved.results.at(-1).attemptedAt, 'persist the attempt before dispatch')
        const failure = typeof options.writeError === 'function' ? options.writeError(writes) : options.writeError
        if (failure) throw new Error(failure)
        options.onDispatch?.(writes)
        return options.observeAfterAction ? { output: { dispatched: true, snapshot: (options.page ?? page)(++snapshots) } } : { dispatched: true }
      }
      return {}
    }
    const executor = new GreetingAgent(store, call, async () => calls.push('begin'), async () => options.infos ?? infos,
      () => opts => runBrowserAgent(llm, { provider: 'test', model: 'same-host-model' }, { ...opts, maxTurns: steps.length + 2 }),
      undefined, { ...options.policy, dailyLimit: options.dailyLimit ?? 100 }, options.timing)
    await executor.run(job, options.signal ?? new AbortController().signal)
    return { job, calls, requests, writes }
  } finally { await rm(dir, { recursive: true, force: true }) }
}
test('search tasks reject candidate selection and writes before search conditions are verified', async () => {
  const stop = { name: 'task_finish', args: { reason: '条件无法确认，停止', status: 'stopped' } }
  const out = await fixture([[snapshot], [select], [write], [stop]], { job: { mode: 'search', search: { keyword: 'java开发工程师' } } })
  assert.equal(out.writes, 0)
  assert.equal(out.job.results.length, 0)
  assert.equal(out.job.status, 'stopped')
  assert.match(JSON.stringify(out.requests), /SEARCH_CONDITIONS_UNVERIFIED/)
})

test('search confirmation cannot substitute for actually submitting the search', async () => {
  const confirm = { name: 'task_confirm_search', args: { tabId: 1, snapshotId: 's1', evidence: [{ field: 'keyword', ref: 'candidate', quote: '林先生' }] } }
  const stop = { name: 'task_finish', args: { reason: '尚未搜索', status: 'stopped' } }
  const out = await fixture([[snapshot], [confirm], [stop]], { job: { mode: 'search', search: { keyword: 'java开发工程师' } } })
  assert.equal(out.writes, 0)
  assert.equal(out.job.results.length, 0)
  assert.match(JSON.stringify(out.requests), /SEARCH_NOT_SUBMITTED/)
})

test('one search setup hands the filtered list back to the click-only preset without per-person verification', async () => {
  const query = 'java开发工程师'
  const submit = { name: 'browser_click', args: { tabId: 1, snapshotId: 's1', ref: 'search', purpose: 'navigation' } }
  const confirm = { name: 'task_confirm_search', args: { tabId: 1, snapshotId: 's2', evidence: [{ field: 'keyword', ref: 'keyword', quote: query }] } }
  const out = await fixture([[snapshot], [submit], [snapshot], [confirm]], {
    job: { mode: 'search', search: { keyword: query } }, infos: [...infos, schema('browser_click', false, props, ['tabId', 'snapshotId', 'ref'])],
    page: number => ({ ...page(number), url: `${origin}/search`, items: [
      { ref: 'candidate', role: 'article', name: '林先生 30岁 本科 5年经验' },
      { ref: 'target', role: 'button', name: '立即沟通', context: { text: '林先生 30岁 本科 5年经验' } },
      { ref: 'keyword', role: 'textbox', name: '关键词', value: query },
      { ref: 'search', role: 'button', name: '搜索' },
    ] }),
  })
  assert.equal(out.job.status, 'completed')
  assert.equal(out.writes, 1)
  assert.equal(out.requests.length, 4)
  assert.ok(out.job.results[0].clickedAt)
  assert.equal(out.job.results[0].confirmedAt, undefined)
})

test('production greeting adapter executes an unknown native action with one persistent model conversation', async () => {
  const out = await fixture([[snapshot], [select, write], [snapshot], [report, finish]], { dailyLimit: 1 })
  assert.equal(out.job.status, 'completed'); assert.equal(out.writes, 1)
  assert.equal(out.job.results[0].stage, 'succeeded'); assert.ok(out.job.results[0].confirmedAt)
  assert.deepEqual(out.calls, ['begin', 'browser_snapshot', 'browser_custom_interaction', 'browser_snapshot', 'browser_finish'])
  assert.ok(out.requests[2].messages.length > out.requests[1].messages.length)
  assert.ok(out.requests[0].tools.some(tool => tool.name === 'browser_custom_interaction'))
  assert.ok(!out.requests[0].tools.some(tool => tool.name === 'page_action'))
})

test('startup plus ordered bookkeeping and opaque native inputs completes two people in three model turns', async () => {
  let clock = 0
  const observedInput = structuredClone(infos[1])
  observedInput.inputSchema.properties.observe = { type: 'object', properties: {
    wait: { enum: ['none', 'dom_quiet'] }, returnSnapshot: { enum: ['none', 'viewport'] },
    requireChange: { type: 'boolean' }, timeoutMs: { type: 'integer' },
  } }
  const tabs = schema('browser_list_tabs', true, {})
  const selectSecond = { ...select, args: { ...select.args, snapshotId: 's2', ref: 'second-target', name: '周女士' } }
  const writeSecond = { ...write, args: { ...write.args, snapshotId: 's2', ref: 'second-target' } }
  const reportSecond = { ...report, args: { ...report.args, snapshotId: 's3', evidenceRefs: ['second-receipt'] } }
  const out = await fixture([[select, write], [report, selectSecond, writeSecond], [reportSecond, finish]], {
    limit: 2, infos: [infos[0], observedInput, tabs], observeAfterAction: true,
    timing: { now: () => clock += 100000 },
    page: n => {
      const current = page(n)
      current.items.push({ ref: 'second-target', role: 'button', name: 'opaque second action', context: { text: '周女士 数据处理项目' } })
      if (n >= 3) current.items.push({ ref: 'second-receipt', role: 'status', name: '周女士 已确认发送完成' })
      return current
    },
  })
  assert.equal(out.job.status, 'completed'); assert.equal(out.writes, 2); assert.equal(out.requests.length, 3)
  assert.deepEqual(out.job.results.map(row => [row.name, row.stage]), [['林先生', 'succeeded'], ['周女士', 'succeeded']])
  assert.equal(out.calls.filter(name => name === 'browser_snapshot').length, 1)
  assert.ok(out.requests.every(request => request.system.includes('Group consecutive calls')))
})
test('the final verified result ends the task without another model turn or queued input', async () => {
  const out = await fixture([[snapshot], [select, write], [snapshot], [report, write]], { dailyLimit: 1 })
  assert.equal(out.job.status, 'completed'); assert.equal(out.job.phase, 'finished')
  assert.equal(out.job.results[0].stage, 'succeeded'); assert.equal(out.writes, 1)
  assert.equal(out.requests.length, 4); assert.equal(out.calls.at(-1), 'browser_finish')
  assert.match(out.job.detail, /1.*1/)
})

test('two controls with the same completion label are verified individually and finish at the limit', async () => {
  let clock = 0
  const firstSelect = { ...select, args: { ...select.args, ref: 'candidate' } }
  const secondSelect = { ...select, args: { ...select.args, snapshotId: 's2', ref: 'second-candidate', name: '周女士' } }
  const secondWrite = { ...write, args: { ...write.args, snapshotId: 's2', ref: 'second' } }
  const firstReport = { ...report, args: { ...report.args, evidenceRefs: ['target'] } }
  const secondReport = { ...report, args: { ...report.args, snapshotId: 's3', evidenceRefs: ['second'] } }
  const out = await fixture([[snapshot], [firstSelect, write], [snapshot], [firstReport, secondSelect, secondWrite], [snapshot], [secondReport]], {
    limit: 2, timing: { now: () => clock += 100000 },
    page: n => ({ ...page(n), items: [page(n).items[0],
      { ref: 'second-candidate', role: 'article', name: '周女士 数据处理项目' },
      { ref: 'target', role: 'button', elementId: 'first-control', name: n >= 2 ? 'Done' : 'Send' },
      { ref: 'second', role: 'button', elementId: 'second-control', name: n >= 3 ? 'Done' : 'Send' },
    ] }),
  })
  assert.equal(out.job.status, 'completed'); assert.equal(out.writes, 2)
  assert.deepEqual(out.job.results.map(row => row.stage), ['succeeded', 'succeeded'])
  assert.equal(out.requests.length, 6)
})

test('changing result explanations or evidence refs cannot evade repeated failure limits', async () => {
  const attempts = Array.from({ length: 3 }, (_, index) => [{ ...report,
    args: { ...report.args, evidenceRefs: [index % 2 ? 'candidate' : 'target'], reason: `changed explanation ${index}` } }])
  const out = await fixture([[snapshot], [select, write], [snapshot], ...attempts], {
    page: n => ({ ...page(n), items: page(1).items }),
  })
  assert.equal(out.requests.length, 6); assert.equal(out.writes, 1)
  assert.equal(out.job.status, 'unknown'); assert.match(out.job.detail, /BROWSER_AGENT_REPEATED_FAILURE/)
})

test('readable candidate, profile and selected position do not need clickable snapshot states before a real browser input', async () => {
  const selection = { ...select, args: { ...select.args, evidenceRefs: ['candidate', 'supplement'], profileRef: 'profile', position: { ref: 'position' } } }
  const out = await fixture([[snapshot], [selection, write], [snapshot], [report, finish]], {
    job: { jobId: 'system-job', jobName: '数据工程师', platformJobs: [{ id: '123', name: '数据工程师' }] },
    page: n => {
      const current = page(n); current.format = 'semantic'
      current.items[0].states = ['occluded']; current.items[1].states = ['occluded']
      current.items.push({ ref: 'supplement', role: 'text', name: '林先生 数据处理项目', states: ['disabled'] },
        { ref: 'profile', role: 'link', name: '林先生', href: `${origin}/candidate/42`, states: ['occluded'] },
        { ref: 'position', role: 'tab', name: '数据工程师', elementId: 'job-123', states: ['selected', 'disabled', 'occluded'] })
      return current
    },
  })
  assert.equal(out.job.status, 'completed'); assert.equal(out.writes, 1)
  assert.equal(out.job.results[0].stage, 'succeeded'); assert.equal(out.job.results[0].identityKind, 'url')
  assert.equal(out.requests.length, 4)
})
test('hidden or modal-background candidate evidence cannot establish the recipient identity', async () => {
  for (const state of ['hidden', 'invisible', 'blocked_by_dialog']) {
    const out = await fixture([[snapshot], [select, write], request => {
      assert.match(JSON.stringify(request.messages), /CANDIDATE_EVIDENCE_UNREADABLE.*target/)
      return [finish]
    }], { page: n => { const current = page(n); current.items[1].states = [state]; return current } })
    assert.equal(out.writes, 0); assert.equal(out.job.results.length, 0)
  }
})
test('ordinary predispatch failure is an observation, not an automatic task interruption', async () => {
  const out = await fixture([[snapshot], [select, write], request => {
    assert.match(JSON.stringify(request.messages), /ELEMENT_OCCLUDED/)
    const error = request.messages.findLast(message => message.role === 'tool' && message.isError)
    assert.equal(JSON.parse(error.content[0].text).recovery.snapshot.snapshotId, 's2')
    return [{ name: 'task_report_result', args: { ...report.args, outcome: 'not_completed', reason: '平台显示未发送' } }, finish]
  }], { writeError: 'ELEMENT_OCCLUDED' })
  assert.equal(out.job.status, 'completed'); assert.equal(out.job.results[0].stage, 'skipped')
  assert.equal(out.job.results[0].attemptedAt, undefined)
  assert.equal(out.requests.length, 3)
})
test('uncertain dispatch stops the model and later actions without replay', async () => {
  const out = await fixture([[snapshot], [select, write, write]], { writeError: 'TRANSPORT_TIMEOUT' })
  assert.equal(out.job.status, 'unknown'); assert.equal(out.writes, 1); assert.equal(out.requests.length, 2)
  assert.equal(out.job.results[0].stage, 'unknown')
})
test('business write without a candidate record never reaches the transport', async () => {
  const out = await fixture([[snapshot], [write], [finish]])
  assert.equal(out.writes, 0); assert.match(JSON.stringify(out.requests[2].messages), /TASK_CANDIDATE_REQUIRED/)
})
test('a failed durable preflight stops the agent before dispatch rather than becoming a retryable browser error', async () => {
  const out = await fixture([[snapshot], [select, write, write]], { storageFailure: true })
  assert.equal(out.writes, 0); assert.equal(out.requests.length, 2)
  assert.equal(out.job.status, 'failed'); assert.match(out.job.detail, /TASK_STORAGE_UNAVAILABLE/)
})
test('an unchanged evidence snapshot cannot confirm a dispatched greeting', async () => {
  const out = await fixture([[snapshot], [select, write], [{ ...report, args: { ...report.args, snapshotId: 's1', evidenceRefs: ['target'] } }], [finish]])
  assert.equal(out.job.status, 'unknown'); assert.equal(out.writes, 1)
  assert.match(JSON.stringify(out.requests[3].messages), /PAGE_OPERATION_RESULT_REQUIRED/)
})
test('workbench production entry points use the shared agent rather than the retired action planner', async () => {
  const source = await readFile(new URL('../src/lib/workbench.ts', import.meta.url), 'utf8')
  assert.match(source, /new GreetingAgent\(/); assert.doesNotMatch(source, /new GreetingExecutor\(|hostGreetingPlanner/)
})
test('a noninteractive result is recorded, then model dismisses the foreground and continues to a second candidate', async () => {
  let clock = 0
  const second = { ...select, args: { ...select.args, snapshotId: 's3', name: '周女士' } }
  const secondWrite = { ...write, args: { ...write.args, snapshotId: 's3' } }
  const dismiss = { ...write, args: { ...write.args, snapshotId: 's2', ref: 'dismiss', purpose: 'navigation' } }
  const firstReport = { ...report, args: { ...report.args, evidenceRefs: ['evidence:dialog:0'] } }
  const secondReport = { ...report, args: { ...report.args, snapshotId: 's4', evidenceRefs: ['evidence:page-text'] } }
  const out = await fixture([[snapshot], [select, write], [snapshot], [firstReport, dismiss], [snapshot], [second, secondWrite], [snapshot], [secondReport, finish]], {
    limit: 2, timing: { now: () => clock += 100000 },
    page: n => {
      const p = page(n); p.items = p.items.filter(i => i.ref !== 'receipt')
      if (n === 2) { p.dialogs = [{ text: '平台确认该操作已经成功完成' }]; p.items.push({ ref: 'dismiss', role: 'button', name: 'opaque dismiss' }) }
      if (n >= 3) p.items = p.items.map(i => ({ ...i, name: i.name.replaceAll('林先生', '周女士'), ...(i.context ? { context: { text: i.context.text.replaceAll('林先生', '周女士') } } : {}) }))
      if (n === 4) p.text = '本次操作已经成功完成'
      return p
    },
  })
  assert.equal(out.job.status, 'completed'); assert.equal(out.writes, 2)
  assert.deepEqual(out.job.results.map(r => [r.name, r.stage]), [['林先生', 'succeeded'], ['周女士', 'succeeded']])
  assert.equal(out.calls.filter(name => name === 'browser_custom_interaction').length, 3)
  assert.equal(out.requests.length, 8)
})

function twoPeople() {
  return { steps: [[snapshot], [select, write], [snapshot], [report], [snapshot],
    [{ ...select, args: { ...select.args, snapshotId: 's3', name: '周女士' } }, { ...write, args: { ...write.args, snapshotId: 's3' } }],
    [snapshot], [{ ...report, args: { ...report.args, snapshotId: 's4' } }, finish]],
    page: n => {
      const p = page(n)
      if (n >= 3) p.items = p.items.filter(i => i.ref !== 'receipt').map(i => ({ ...i, name: i.name.replaceAll('林先生', '周女士'),
        ...(i.context ? { context: { text: i.context.text.replaceAll('林先生', '周女士') } } : {}) }))
      if (n === 4) p.items.push({ ref: 'receipt', name: '周女士 已确认发送完成' })
      return p
    } }
}
test('click pacing waits only the remainder of five seconds; confirmation time counts and old batch/random settings cannot add pauses', async () => {
  let clock = 0; const sleeps = [], clicks = [], f = twoPeople()
  const out = await fixture(f.steps, { limit: 2, page: f.page, policy: { intervalMinSeconds: 30, intervalMaxSeconds: 60, batchMin: 1, batchMax: 1, batchPauseSeconds: 600 },
    timing: { now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms } },
    onDispatch: () => clicks.push(clock), onModel: turn => { if (turn === 4) clock = 1200 } })
  assert.equal(out.job.status, 'completed'); assert.deepEqual(sleeps, [3800]); assert.deepEqual(clicks, [0, 5000])
  assert.equal(out.requests.length, 8, 'cooldown must not require another model/observation round')
})
test('slow model verification consumes the entire interval with no extra cooldown', async () => {
  let clock = 0; const sleeps = [], clicks = [], f = twoPeople()
  const out = await fixture(f.steps, { limit: 2, page: f.page,
    timing: { now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms } },
    onDispatch: () => clicks.push(clock), onModel: turn => { if (turn === 4) clock = 7000 } })
  assert.equal(out.job.status, 'completed'); assert.deepEqual(sleeps, []); assert.deepEqual(clicks, [0, 7000])
})
test('cancellation during the interval cannot dispatch the next greeting', async () => {
  const abort = new AbortController(); const f = twoPeople()
  const out = await fixture(f.steps, { limit: 2, page: f.page, signal: abort.signal,
    timing: { now: () => 0, sleep: async () => { abort.abort(); throw new Error('cancelled') } } })
  assert.equal(out.writes, 1); assert.equal(out.job.status, 'stopped')
})
test('a proven unsent retry updates the existing candidate record instead of appending another person', async () => {
  const retrySelect = { ...select, args: { ...select.args, snapshotId: 's2' } }
  const retryWrite = { ...write, args: { ...write.args, snapshotId: 's2' } }
  const out = await fixture([[snapshot], [select, write], request => {
    // PAGE_CHANGED now returns a read-only refreshed snapshot in the failed
    // call result, avoiding the old extra snapshot/model turn.
    const errors = request.messages.filter(message => message.role === 'tool' && message.isError)
    assert.equal(JSON.parse(errors.at(-1).content[0].text).recovery.snapshot.snapshotId, 's2')
    return [{ ...report, args: { ...report.args, outcome: 'not_completed', reason: '明确未发送' } }, retrySelect, retryWrite]
  },
    [snapshot], [{ ...report, args: { ...report.args, snapshotId: 's3' } }, finish]], {
    writeError: count => count === 1 ? 'PAGE_CHANGED' : undefined,
    page: n => { const p = page(n); if (n === 2) p.items.find(i => i.ref === 'receipt').name = '明确未发送'; return p },
  })
  assert.equal(out.job.status, 'completed'); assert.equal(out.job.results.length, 1)
  assert.equal(out.job.results[0].stage, 'succeeded'); assert.equal(out.job.results[0].retryable, undefined)
  assert.equal(out.requests.length, 5, 'fresh recovery evidence removes one model round')
})
