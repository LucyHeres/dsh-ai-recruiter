import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/lib/store.js'
import { identityEvidence, executeNavigation, navigationActionSpec, pageObservation, recoverablePageError, frameUrl } from '../dist/lib/page-actions.js'
import { assertPositionEvidence } from '../dist/lib/greeting-planner.js'
import { GreetingExecutor, createGreetingJob, greetingPolicy, dailyUsage } from '../dist/lib/greeting-executor.js'
import { navigateResumes } from '../dist/lib/resume-navigation.js'
import { detectPlatformLogin } from '../dist/lib/platform-login.js'
import { readUploadChannels } from '../dist/lib/upload-options.js'
import { hostLoginClassifier } from '../dist/lib/login-planner.js'
import { PageProgress } from '../dist/lib/page-progress.js'
import { DeveloperLog } from '../dist/lib/developer-log.js'
import { hostPagePlanner } from '../dist/lib/page-model.js'
import { modelPageObservation } from '../dist/lib/model-observation.js'
import { PageOperation, PageRecovery } from '../dist/lib/page-operation.js'

const origin = 'https://lpt.liepin.com'
const url = `${origin}/custom-list`
const signal = () => new AbortController().signal
const bounds = { x: 10, y: 10, width: 200, height: 200 }
const page = (name = '林先生', snapshotId = 's1') => ({ snapshotId, documentId: 'doc', url,
  text: `${name} 作品集：数据库迁移`, items: [
    { ref: 'card', role: 'article', name: `${name} 作品集：数据库迁移`, bounds },
    { ref: 'hello', role: 'button', name: '联系此人', context: { text: `${name} 作品集：数据库迁移` }, bounds: { x: 20, y: 20, width: 20, height: 20 } },
    { ref: 'job', role: 'tab', name: '数据工程师', elementId: 'arbitrary-job-123', states: ['selected'] },
    { ref: 'search', role: 'textbox', name: '查询' }, { ref: 'select', role: 'combobox', name: '排序' },
    { ref: 'download', role: 'button', name: '取得附件', context: { text: `${name} 原始简历` } },
  ] })
const greet = (name = '林先生') => ({ action: 'greet', ref: 'hello', name, identityQuote: `${name} 作品集：数据库迁移`, evidenceRefs: [], reason: '匹配当前候选人',
  position: { ref: 'job', quote: '数据工程师', platformJobId: '123' } })
const end = { action: 'finish', reason: '本次任务完成' }

async function greetingFixture(run, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'recruit-model-'))
  try {
    const store = new Store(root, 'test'); await store.init()
    const job = createGreetingJob({ id: randomUUID(), platform: 'liepin', tabId: 1, limit: options.limit ?? 1, jobId: 'system-job', confirmed: true }, options.policy)
    Object.assign(job, { jobName: '数据工程师', platformJobs: [{ id: '123', name: '数据工程师' }] })
    await store.put(`greeting-${job.id}`, job)
    const calls = [], observations = [], sleeps = []
    const logger = options.log ? new DeveloperLog(store.root) : undefined
    let snapshots = 0, clock = 0
    const call = async (tool, args = {}) => {
      calls.push({ tool, args })
      if (tool === 'browser_list_tabs') return { tabs: options.newTab && !calls.some(row => row.tool === 'browser_open_tab') ? [] : [{ tabId: 1, url: options.tabUrl ?? url }] }
      if (tool === 'browser_open_tab') return { tabId: 1 }
      if (tool === 'browser_wait') return options.wait ? options.wait(args) : options.readiness ?? { conditionMet: true, waitedMs: 500 }
      if (tool === 'browser_list_frames') return { frames: [] }
      if (tool === 'browser_snapshot') {
        snapshots++
        const p = options.page?.(snapshots, args) ?? page('林先生', `s${snapshots}`)
        const state = await store.get(`greeting-${job.id}`)
        if (options.receipts !== false && state.results.some(row => row.stage === 'sending')) {
          p.items.push({ ref: 'receipt', role: 'status', name: '招呼已发送成功' })
        }
        return p
      }
      if (tool === 'browser_hover' && options.hover) return options.hover(args)
      if (tool === 'browser_inspect_element' && options.inspect) return options.inspect(args, snapshots)
      if (tool === 'browser_click') {
        const state = await store.get(`greeting-${job.id}`)
        if (args.policy.riskLevel === 'business_write') assert.equal(state.results.at(-1).stage, 'sending', 'must save before sending')
        if (options.click) return options.click(args, state)
      }
      if (options.interact) return options.interact(tool, args)
      return {}
    }
    const actions = [...(options.actions ?? [greet(), end])]
    const plannerOf = options.plannerOf ?? (() => ({ decide: async observation => {
      observations.push(structuredClone(observation))
      if (options.receipts !== false && observation.pendingGreeting) return { action: 'record_result', outcome: 'completed', evidenceRefs: ['receipt'], reason: '平台显示招呼已发送成功' }
      if (options.decide) return options.decide(observation)
      assert.ok(actions.length, 'unexpected extra model turn')
      return actions.shift()
    } }))
    const executor = new GreetingExecutor(store, call, async () => calls.push({ tool: 'begin' }), plannerOf, logger,
      options.policy, { now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms } })
    await run({ store, job, calls, observations, sleeps, executor, logger, execute: () => executor.run(job, signal()) })
  } finally { await rm(root, { recursive: true, force: true }) }
}
const sends = calls => calls.filter(row => row.tool === 'browser_click' && row.args.policy.riskLevel === 'business_write')

const checked = (outcome, ref = 'receipt') => ({ action: 'record_result', outcome, evidenceRefs: [ref], reason: outcome === 'completed' ? '平台显示招呼已发送成功' : '权益弹窗已取消，没有发送' })
const modalPage = (snapshotId, paid = true) => ({ snapshotId, documentId: 'doc', url, format: 'dom',
  dialogs: [{ ref: 'modal', text: paid ? '支付费用 1 次超级聊聊权益 使用并发送' : '确认免费默认招呼', closeRef: 'close' }],
  items: [{ ref: 'modal', role: 'dialog', name: paid ? '支付费用 1 次超级聊聊权益' : '免费确认' },
    { ref: 'close', role: 'button', name: '关闭', dialogRef: 'modal' },
    { ref: 'confirm', role: 'button', name: '使用并发送', dialogRef: 'modal' }] })

test('paid modal is cancelled before another candidate; opening it never counts toward limit', async () => {
  let ui = 'first', premature = false
  await greetingFixture(async ({ execute, job, calls, observations }) => {
    await execute()
    assert.equal(job.status, 'completed'); assert.equal(job.results.length, 2)
    assert.deepEqual(job.results.map(row => row.stage), ['skipped', 'succeeded'])
    assert.equal(sends(calls).length, 2); assert.ok(!calls.some(row => row.tool === 'browser_click' && row.args.ref === 'confirm'))
    assert.equal(observations.find(row => row.pendingGreeting).remaining, 1)
    assert.ok(observations.some(row => row.page.dialogs?.length === 1))
  }, { receipts: false, page: i => ui === 'paid' ? modalPage(`s${i}`) : {
    ...page(ui === 'first' ? '林先生' : '王女士', `s${i}`), ...(ui === 'sent' ? { items: [...page('王女士').items, { ref: 'receipt', role: 'status', name: '王女士 招呼发送成功' }] } : {}) },
    click: args => { if (args.ref === 'close') ui = 'second'; else if (args.ref === 'hello') ui = ui === 'first' ? 'paid' : 'sent' },
    decide: observation => {
      if (ui === 'first') return greet()
      if (ui === 'paid') {
        if (!premature) { premature = true; return greet('王女士') }
        return { action: 'click', ref: 'close', reason: '取消消耗权益的弹窗' }
      }
      if (ui === 'second' && observation.pendingGreeting) return checked('not_completed', 'card')
      return ui === 'second' ? greet('王女士') : checked('completed')
    } })
})

test('last candidate free confirmation keeps one sending row until observed success', async () => {
  let ui = 'list'
  await greetingFixture(async ({ execute, job, calls }) => {
    await execute(); assert.equal(job.status, 'completed'); assert.equal(job.results.length, 1)
    assert.equal(job.results[0].stage, 'succeeded'); assert.ok(job.results[0].confirmedAt)
    assert.deepEqual(sends(calls).map(row => row.args.ref), ['hello', 'confirm'])
    assert.equal(sends(calls)[1].args.policy.confirmationId, sends(calls)[0].args.policy.confirmationId)
  }, { receipts: false, page: i => ui === 'modal' ? modalPage(`s${i}`, false) : {
    ...page('林先生', `s${i}`), ...(ui === 'sent' ? { items: [...page().items, { ref: 'receipt', role: 'status', name: '招呼已发送成功' }] } : {}) },
    click: (args, state) => { assert.equal(state.results.length, 1); assert.equal(state.results[0].stage, 'sending'); ui = args.ref === 'hello' ? 'modal' : 'sent' },
    decide: () => ui === 'list' ? greet() : ui === 'modal'
      ? { action: 'submit', ref: 'confirm', reason: '确认免费默认招呼' } : checked('completed') })
})

test('unknown final confirmation stops with one protected row and never replays the send', async () => {
  let ui = 'list'
  await greetingFixture(async ({ execute, job, calls }) => {
    await execute(); assert.equal(job.status, 'unknown'); assert.equal(job.results.length, 1)
    assert.equal(job.results[0].stage, 'unknown'); assert.equal(sends(calls).length, 2)
  }, { receipts: false, page: i => ui === 'modal' ? modalPage(`s${i}`, false) : page('林先生', `s${i}`),
    click: args => { if (args.ref === 'hello') ui = 'modal'; else throw new Error('RESULT_UNKNOWN reply lost') },
    decide: () => ui === 'list' ? greet() : { action: 'submit', ref: 'confirm', reason: '免费确认' } })
})

test('result freshness follows its own evidence source, not identical text elsewhere on the page', () => {
  for (const identity of ['elementId', 'context', 'bounds']) {
    const item = (ref, name, index) => ({ ref, role: 'button', name,
      ...(identity === 'elementId' ? { elementId: `control-${index}` } : {}),
      ...(identity === 'context' ? { context: { text: `record ${index}` } } : {}),
      ...(identity === 'bounds' ? { bounds: { x: 10, y: 100 * index, width: 100, height: 30 } } : {}),
    })
    const before = { snapshotId: 'before', documentId: 'doc', items: [item('a', 'Done', 1), item('b', 'Send', 2)] }
    const operation = new PageOperation('before', before)
    const after = { ...before, snapshotId: 'after', items: [item('new-b', 'Done', 1), item('new-a', 'Done', 2)] }
    assert.doesNotThrow(() => operation.assertResult(after, 'completed', ['new-a']), identity)
    assert.throws(() => operation.assertResult(after, 'completed', ['new-b']), /PAGE_OPERATION_RESULT_REQUIRED/, identity)
    const renumbered = { ...before, snapshotId: 'renumbered', items: [item('b', 'Done', 1), item('a', 'Send', 2)] }
    assert.throws(() => operation.assertResult(renumbered, 'completed', ['a', 'b']), /PAGE_OPERATION_RESULT_REQUIRED/, identity)
  }
})

test('ambiguous duplicate evidence and unchanged whole-page text remain insufficient', () => {
  const before = { snapshotId: 'before', items: [{ ref: 'old', name: 'Done' }], text: 'Done' }
  const operation = new PageOperation('before', before)
  const after = { ...before, snapshotId: 'after', items: [{ ref: 'new', name: 'Done' }, { ref: 'extra', name: 'Done' }] }
  assert.throws(() => operation.assertResult(after, 'completed', ['extra']), /PAGE_OPERATION_RESULT_REQUIRED/)
  assert.throws(() => operation.assertResult(after, 'completed', ['evidence:page-text']), /PAGE_OPERATION_RESULT_REQUIRED/)
})

test('unchanged entry button is not evidence of sending, and retries cannot erase pending state', async () => {
  for (const next of [checked('completed', 'hello'), greet('王女士'), end]) {
    await greetingFixture(async ({ execute, job, calls }) => {
      await execute(); assert.equal(job.status, 'unknown'); assert.equal(job.results.length, 1)
      assert.equal(job.results[0].stage, 'unknown'); assert.equal(sends(calls).length, 1)
      assert.equal(calls.filter(row => row.tool === 'browser_click').length, 1)
    }, { receipts: false, actions: [greet(), next, next, next] })
  }
})

test('post-dispatch observation failure stays unknown; confirmed pre-dispatch failure allows same candidate on a fresh page', async () => {
  await greetingFixture(async ({ execute, job, calls }) => {
    await execute(); assert.equal(job.status, 'unknown'); assert.equal(job.results[0].stage, 'unknown'); assert.equal(sends(calls).length, 1)
  }, { receipts: false, page: i => { if (i > 1) throw new Error('PAGE_CHANGED'); return page('林先生', `s${i}`) } })
  await greetingFixture(async ({ execute, job, calls }) => {
    await execute(); assert.equal(job.status, 'completed'); assert.deepEqual(job.results.map(row => row.stage), ['failed', 'succeeded'])
    assert.equal(job.results[0].key, job.results[1].key); assert.equal(sends(calls).length, 2)
  }, { actions: [greet(), greet()], click: (_, state) => { if (state.results.length === 1) throw new Error('PAGE_CHANGED') } })
})

test('one candidate can recover through arbitrary cancel control, Escape or back, then continue an inline flow', async () => {
  for (const recoveryAction of [
    { action: 'click', ref: 'arbitrary-cancel', reason: '撤回偏离目标的路径' },
    { action: 'press_key', key: 'ESC', reason: '退出当前浮层' },
    { action: 'back', reason: '返回当前目标' },
  ]) {
    let ui = 'list'
    await greetingFixture(async ({ execute, job, calls, observations }) => {
      await execute()
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.results.map(row => row.stage), ['skipped', 'succeeded'])
      assert.equal(job.results[0].retryable, true)
      assert.equal(job.results[0].key, job.results[1].key, 'the same candidate may be chosen again only after explicit not_completed')
      assert.equal(sends(calls).length, 3)
      assert.ok(observations.some(row => row.processed.some(result => result.retryable)))
      assert.ok(!observations.some(row => row.page.dialogs?.some(dialog => dialog.closeRef)))
    }, { receipts: false, page: i => {
      const p = page('林先生', `s${i}`)
      if (ui === 'unexpected') return { ...p, dialogs: [{ ref: 'panel', text: '所选路径超出本次目标' }], items: [
        { ref: 'panel', role: 'dialog', name: '路径说明' }, { ref: 'arbitrary-cancel', role: 'button', name: '返回原步骤', dialogRef: 'panel' } ] }
      if (ui === 'ready') p.items.push({ ...p.items[1], ref: 'normal', name: '另一条符合目标的操作' })
      if (ui === 'inline') p.items.push({ ref: 'inline-next', role: 'button', name: '执行当前操作' })
      if (ui === 'done') p.items.push({ ref: 'receipt', role: 'status', name: '林先生 招呼已发送成功', states: ['disabled'] })
      return p
    }, click: args => { ui = args.ref === 'hello' ? 'unexpected' : args.ref === 'arbitrary-cancel' ? 'ready' : args.ref === 'normal' ? 'inline' : 'done' },
    interact: tool => { if (tool === 'browser_press_key' || tool === 'browser_history') ui = 'ready'; return {} },
    decide: observation => {
      if (ui === 'list') return greet()
      if (ui === 'unexpected') return recoveryAction
      if (ui === 'ready' && observation.pendingGreeting) return checked('not_completed', 'card')
      if (ui === 'ready') return { ...greet(), ref: 'normal' }
      if (ui === 'inline') return { action: 'submit', ref: 'inline-next', reason: '继续当前目标' }
      return checked('completed')
    } })
  }
})

test('a dispatched submit cannot be repeated against the same unchanged state', async () => {
  let ui = 'list'
  await greetingFixture(async ({ execute, job, calls }) => {
    await execute(); assert.equal(job.status, 'unknown')
    assert.equal(job.results[0].stage, 'unknown')
    assert.deepEqual(sends(calls).map(row => row.args.ref), ['hello', 'confirm'])
  }, { receipts: false, page: i => ui === 'list' ? page('林先生', `s${i}`) : modalPage(`s${i}`, false),
    click: () => { ui = 'inline' }, decide: () => ui === 'list' ? greet() : { action: 'submit', ref: 'confirm', reason: '提交当前操作' } })
})

test('independent recoverable failures do not exhaust a three-error global counter', () => {
  const recovery = new PageRecovery(), p = page()
  for (const code of ['ELEMENT_OCCLUDED', 'ELEMENT_NOT_FOUND', 'PAGE_CHANGED', 'SNAPSHOT_EXPIRED']) {
    assert.equal(recovery.failed(new Error(code), { action: 'click', ref: 'hello' }, p).exhausted, false)
  }
  recovery.reset()
  assert.equal(recovery.failed(new Error('ELEMENT_OCCLUDED'), { action: 'click', ref: 'hello' }, p).exhausted, false)
  assert.equal(recovery.failed(new Error('ELEMENT_OCCLUDED'), { action: 'click', ref: 'hello' }, p).exhausted, false)
  assert.equal(recovery.failed(new Error('ELEMENT_OCCLUDED'), { action: 'click', ref: 'hello' }, p).exhausted, true)
})

test('identity can use candidate context or related geometry without age/degree labels', () => {
  assert.equal(identityEvidence(page(), 'hello', '林先生').ref, 'hello')
  const p = page(); delete p.items[1].context
  assert.equal(identityEvidence(p, 'hello', '林先生', ['card']).ref, 'hello')
  p.items[0].bounds = { ...bounds, x: 1000 }
  assert.throws(() => identityEvidence(p, 'hello', '林先生', ['card']), /CANDIDATE_EVIDENCE_INVALID/)
  p.items[1].states = ['blocked_by_dialog']
  assert.throws(() => identityEvidence(p, 'hello', '林先生'), /ELEMENT_OCCLUDED/)
})

test('observations retain context and selected IDs while stripping sensitive URL query values', () => {
  const p = page(); p.url = `${url}?jobid=123&access_token=secret#credential`
  p.items[0].href = `${url}?candidateId=42&session=secret`
  p.items.push({ ref: 'behind', name: '遮挡', states: ['occluded'] })
  const observed = pageObservation(p)
  assert.equal(observed.url, `${url}?jobid=123`)
  assert.equal(observed.items[0].href, `${url}?candidateId=42`)
  assert.ok(observed.items[1].context.text.includes('林先生'))
  assert.equal(observed.items[2].elementId, 'arbitrary-job-123')
  assert.equal(observed.hiddenElementCount, 1)
  assert.ok(!JSON.stringify(observed).includes('secret'))
})

test('position verification uses selected evidence and target ID, rejects wrong job or fabricated quote', () => {
  const p = page(), job = { jobId: 'system-job', jobName: '数据工程师', platformJobs: [{ id: '123', name: '数据工程师' }] }
  const evidence = greet().position
  assertPositionEvidence(p, job, evidence)
  assert.throws(() => assertPositionEvidence(p, job, { ...evidence, platformJobId: '456' }), /POSITION_EVIDENCE_INVALID/)
  assert.throws(() => assertPositionEvidence(p, job, { ...evidence, quote: '后端开发' }), /POSITION_EVIDENCE_INVALID/)
  p.items[2].states = []
  assert.throws(() => assertPositionEvidence(p, job, evidence), /POSITION_EVIDENCE_INVALID/)
  p.url = `${url}?jobid=123`
  assert.throws(() => assertPositionEvidence(p, job, evidence), /POSITION_EVIDENCE_INVALID/)
  p.items[2].states = ['selected']
  assertPositionEvidence(p, job, evidence)
  p.items[2].states = []
  p.url = url; p.selectedTabs = [{ name: '数据工程师', elementId: p.items[2].elementId }]
  assertPositionEvidence(p, job, evidence)
})

test('generic navigation maps inputs, selection, key focus, frames and back to real tools', async () => {
  const calls = [], p = page()
  const view = { tabId: 1, page: p, tabs: [{ tabId: 1, url }], frames: [{ frameId: 8, documentId: `${origin}/frame:1792045450123` }, { frameId: 9, url: 'https://foreign.example/frame' }], origins: [origin], call: async (tool, args) => calls.push({ tool, args }) }
  for (const action of [
    { action: 'type', ref: 'search', text: '数据' }, { action: 'select_option', ref: 'select', value: 'latest' },
    { action: 'press_key', key: 'Enter', ref: 'search' }, { action: 'inspect_frame', frameId: 8 },
    { action: 'back' }, { action: 'navigate', url: `${origin}/frame` },
  ]) await executeNavigation(navigationActionSpec.parse({ ...action, reason: '页面导航' }), view)
  assert.deepEqual(calls.map(row => row.tool), ['browser_type', 'browser_select_option', 'browser_click', 'browser_press_key', 'browser_history', 'browser_navigate'])
  assert.equal(calls[0].args.clear, true)
  assert.equal(calls[0].args.snapshotId, p.snapshotId)
  assert.equal(calls[3].args.ref, undefined, 'gateway key schema has no ref field')
  assert.equal(view.frameId, undefined)
  assert.equal(frameUrl(view.frames[0]), `${origin}/frame`)
  await assert.rejects(executeNavigation(navigationActionSpec.parse({ action: 'inspect_frame', frameId: 9, reason: '导航' }), view), /FRAME_NOT_OBSERVED/)
  const before = calls.length
  for (const action of [{ action: 'navigate', url: `${origin}/invented` }, { action: 'switch_tab', tabId: 99 }, { action: 'inspect_frame', frameId: 99 }, { action: 'click', ref: 'stale' }]) {
    await assert.rejects(executeNavigation(navigationActionSpec.parse({ ...action, reason: '导航' }), view))
  }
  assert.equal(calls.length, before)
  assert.equal(recoverablePageError(new Error('RESULT_UNKNOWN ELEMENT_NOT_FOUND')), false)
})

test('model chooses a nonstandard candidate and host persists sending before the click', () => greetingFixture(async ({ execute, job, calls, observations }) => {
  await execute()
  assert.equal(job.status, 'completed')
  assert.equal(sends(calls).length, 1)
  assert.equal(job.results[0].stage, 'succeeded')
  assert.match(job.results[0].detail, /发送成功/)
  assert.ok(job.results[0].confirmedAt)
  assert.equal(observations[0].targetJob.platformJobs[0].id, '123')
  assert.equal(observations.length, 2, 'final dispatch must be followed by a result check')
  assert.equal(calls.filter(row => row.tool === 'browser_snapshot').length, 2)
  assert.match(job.detail, /已核对/)
}))

test('existing entry page is reused without reloading and discarding its current selection', () => greetingFixture(async({execute,job,calls})=>{
  delete job.tabId
  await execute()
  assert.equal(job.status,'completed');assert.equal(sends(calls).length,1)
  assert.ok(!calls.some(row=>['browser_navigate','browser_open_tab','browser_wait'].includes(row.tool)))
}, {tabUrl:`${origin}/recommend?existing=1`,page:i=>({...page('林先生',`s${i}`),url:`${origin}/recommend?existing=1`})}))

test('new page gets one bounded DOM readiness check before the first model decision; timeout is not business success', async () => {
  for (const readiness of [{ conditionMet: true, waitedMs: 500 }, { conditionMet: false, timeout: true, waitedMs: 2000 }]) {
    await greetingFixture(async ({ execute, job, calls, observations, logger }) => {
      delete job.tabId
      await execute()
      assert.equal(job.status, 'completed'); assert.equal(observations.length, 2)
      const wait = calls.find(row => row.tool === 'browser_wait')
      assert.deepEqual(wait.args.condition, { type: 'dom_quiet', quietMs: 500, timeoutMs: 2000 }); assert.equal(wait.args.timeoutMs, 5000)
      assert.ok(calls.indexOf(wait) < calls.findIndex(row => row.tool === 'browser_snapshot'))
      await logger.flush()
      const report = await logger.read(undefined, 1000)
      const row = report.lines.map(line => JSON.parse(line)).find(row => row.event === 'greeting.page_readiness')
      assert.equal(row.conditionMet, readiness.conditionMet)
    }, { newTab: true, readiness, log: true })
  }
})

test('a truly unknown readiness response still stops without calling model or replaying browser actions', () => greetingFixture(async ({ execute, job, calls, observations }) => {
  delete job.tabId
  await execute()
  assert.equal(job.status, 'failed'); assert.match(job.detail, /TOOL_CALL_OUTCOME_UNKNOWN/)
  assert.equal(observations.length, 0); assert.equal(job.results.length, 0); assert.equal(sends(calls).length, 0)
  assert.equal(calls.filter(row => row.tool === 'browser_wait').length, 1)
  assert.equal(calls.filter(row => row.tool === 'browser_finish').length, 1)
}, { newTab: true, wait: () => { throw new Error('TOOL_CALL_OUTCOME_UNKNOWN: browser.wait 未返回') } }))

test('failed pre-dispatch attempt keeps the actual reason; fresh choice succeeds and stops at limit', () => greetingFixture(async ({ execute, job, calls, observations, logger }) => {
  await execute()
  assert.equal(job.status, 'completed'); assert.equal(sends(calls).length, 2)
  assert.equal(observations.length, 3)
  assert.match(job.results[0].detail, /上下文发生变化.*PAGE_CHANGED/)
  assert.ok(!job.results[0].detail.includes('遮挡'))
  assert.equal(job.results[1].stage, 'succeeded')
  await logger.flush()
  const report = JSON.stringify(await logger.read(undefined, 1000))
  assert.match(report, /PAGE_CHANGED/)
}, { log: true, page: i => page(i === 1 ? '林先生' : '王女士', `s${i}`), actions: [greet(), greet('王女士')],
  click: (args, state) => { if (state.results.length === 1) throw new Error('PAGE_CHANGED') } }))

test('optional profile with no navigation URL uses verified text identity and still persists before sending', async () => {
  for (const href of [undefined, '#', 'javascript:void(0)']) {
    await greetingFixture(async ({ execute, job, calls, logger }) => {
      await execute()
      assert.equal(job.status, 'completed'); assert.equal(sends(calls).length, 1)
      assert.equal(job.results[0].identityKind, 'text'); assert.equal(job.results[0].stage, 'succeeded')
      await logger.flush()
      const report = await logger.read(undefined, 1000)
      assert.match(JSON.stringify(report), /greeting.profile_evidence/)
      assert.ok(!JSON.stringify(report).includes('林先生'))
    }, { log: true, page: i => { const p = page('林先生', `s${i}`); p.items[0].href = href; return p },
      actions: [{ ...greet(), profileRef: 'card' }, end] })
  }
})

test('observed relative candidate link resolves to same-platform URL identity', () => greetingFixture(async ({ execute, job, calls }) => {
  await execute()
  assert.equal(job.status, 'completed'); assert.equal(sends(calls).length, 1)
  assert.equal(job.results[0].identityKind, 'url')
}, { page: i => { const p = page('林先生', `s${i}`); p.items[0].href = '/candidate?candidateId=42&token=private'; return p },
  actions: [{ ...greet(), profileRef: 'card' }, end] }))

test('out-of-scope or unsafe profile yields specific feedback before a corrected action may send', async () => {
  for (const [href, code] of [['https://foreign.example/candidate?token=private', 'CANDIDATE_PROFILE_ORIGIN_NOT_ALLOWED'],
    ['https://user:private@lpt.liepin.com/candidate', 'CANDIDATE_PROFILE_URL_INVALID'], ['https://[invalid', 'CANDIDATE_PROFILE_URL_INVALID']]) {
    const feedback = [], actions = [{ ...greet(), profileRef: 'card' }, greet(), end]
    await greetingFixture(async ({ execute, job, calls, logger }) => {
      await execute()
      assert.equal(job.status, 'completed'); assert.equal(sends(calls).length, 1)
      assert.equal(sends(calls)[0].args.snapshotId, 's2', 'rejected evidence must not dispatch on s1')
      assert.match(feedback[0].error, new RegExp(code)); assert.match(feedback[0].error, /profileRef/)
      await logger.flush()
      const report = JSON.stringify(await logger.read(undefined, 1000))
      assert.match(report, new RegExp(code)); assert.ok(!report.includes('private') && !report.includes('foreign.example'))
    }, { log: true, page: i => { const p = page('林先生', `s${i}`); p.items[0].href = href; return p },
      plannerOf: () => ({ decide: async observation => observation.pendingGreeting
        ? { action: 'record_result', outcome: 'completed', evidenceRefs: ['receipt'], reason: '平台显示发送成功' } : actions.shift(), recordResult: value => feedback.push(value) }) })
  }
})

test('missing profile href does not bypass candidate association or literal identity quote', async () => {
  for (const invalid of [{ ...greet(), profileRef: 'unrelated' }, { ...greet(), profileRef: 'card', identityQuote: '林先生 伪造经历' }]) {
    await greetingFixture(async ({ execute, job, calls }) => {
      await execute()
      assert.equal(job.status, 'failed'); assert.equal(job.results.length, 0); assert.equal(sends(calls).length, 0)
      assert.match(job.detail, /CANDIDATE_(PROFILE_EVIDENCE|IDENTITY_QUOTE)_INVALID/)
    }, { page: i => { const p = page('林先生', `s${i}`); p.items.push({ ref: 'unrelated', role: 'link', name: '另一候选人', bounds: { ...bounds, x: 1000 } }); return p },
      actions: [invalid, invalid, invalid] })
  }
})

test('unknown greeting is never resent when profile URL and text identity modes change', async () => {
  for (const firstHasUrl of [false, true]) {
    const withProfile = hasUrl => { const p = page(); if (hasUrl) p.items[0].href = `${origin}/candidate?id=42`; return p }
    await greetingFixture(async ({ execute, job, store, calls }) => {
      await execute()
      assert.equal(job.status, 'unknown'); assert.equal(sends(calls).length, 1)
      let retried = 0
      const second = { ...job, id: randomUUID(), results: [], events: [], status: 'queued' }
      const executor = new GreetingExecutor(store, async tool => {
        if (tool === 'browser_list_tabs') return { tabs: [{ tabId: 1, url }] }
        if (tool === 'browser_snapshot') return withProfile(!firstHasUrl)
        if (tool === 'browser_click') retried++
        return {}
      }, async () => {}, () => ({ decide: async () => ({ ...greet(), profileRef: 'card' }) }))
      await executor.run(second, signal())
      assert.equal(retried, 0); assert.equal(second.results.length, 0); assert.equal(second.status, 'failed')
    }, { page: () => withProfile(firstHasUrl), actions: [{ ...greet(), profileRef: 'card' }],
      click: () => { throw new Error('RESULT_UNKNOWN response lost') } })
  }
})

test('uncertain greeting remains unknown and later jobs cannot resend it', () => greetingFixture(async ({ execute, job, calls, store, executor }) => {
  await execute()
  assert.equal(job.status, 'unknown'); assert.equal(job.results[0].stage, 'unknown')
  assert.equal(sends(calls).length, 1)
  const second = { ...job, id: randomUUID(), results: [], status: 'queued', events: [] }
  // A new executor that deliberately keeps selecting the same person is stopped by history.
  const retry = new GreetingExecutor(store, async (tool, args) => {
    if (tool === 'browser_list_tabs') return { tabs: [{ tabId: 1, url }] }
    if (tool === 'browser_list_frames') return { frames: [] }
    if (tool === 'browser_snapshot') return page()
    if (tool === 'browser_click') throw new Error('must not resend')
    return {}
  }, async () => {}, () => ({ decide: async () => greet() }))
  await retry.run(second, signal())
  assert.equal(second.status, 'failed'); assert.equal(second.results.length, 0)
}, { click: () => { throw new Error('RESULT_UNKNOWN response lost') } }))

test('host waits its configured cooldown then asks model again using a fresh snapshot', () => greetingFixture(async ({ execute, job, calls, sleeps, observations }) => {
  await execute()
  assert.equal(job.status, 'completed'); assert.equal(sends(calls).length, 2)
  assert.deepEqual(sleeps, [5000])
  assert.deepEqual(sends(calls).map(row => row.args.snapshotId), ['s1', 's4'])
  assert.equal(observations[3].page.snapshotId, 's4')
}, { limit: 2, policy: { intervalMinSeconds: 5, intervalMaxSeconds: 5 },
  page: i => page(i === 1 ? '林先生' : '王女士', `s${i}`), actions: [greet(), greet('王女士'), greet('王女士'), end] }))

test('model unavailable and daily quota reached both stop before browser writes', async () => {
  await greetingFixture(async ({ execute, job, calls }) => { await execute(); assert.equal(job.status, 'failed'); assert.equal(calls.length, 0) },
    { plannerOf: () => { throw new Error('模型不可用') } })
  await greetingFixture(async ({ execute, job, calls, store }) => {
    await store.put('greeting-prior', { ...job, id: 'prior', results: [{ name: '旧候选人', stage: 'unknown', updatedAt: new Date().toISOString() }] })
    await execute(); assert.equal(job.status, 'failed'); assert.equal(calls.length, 0)
  }, { policy: { dailyLimit: 1 } })
  assert.equal(greetingPolicy({ dailyLimit: undefined }).dailyLimit, 100)
  assert.throws(() => greetingPolicy({ intervalMinSeconds: 9, intervalMaxSeconds: 5 }))
  assert.equal(dailyUsage([{ platform: 'liepin', createdAt: new Date().toISOString(), results: [{ stage: 'skipped' }] }]).liepin, 0)
})

test('wrong position evidence is replanned and never sends a greeting', () => greetingFixture(async ({ execute, job, calls }) => {
  await execute(); assert.equal(job.status, 'failed'); assert.equal(sends(calls).length, 0)
}, { actions: [1, 2, 3].map(() => ({ ...greet(), position: { ref: 'job', quote: '数据工程师', platformJobId: '456' } })) }))

test('identity quote tolerates DOM whitespace while preserving exact character order and punctuation', async () => {
  await greetingFixture(async ({ execute, job, calls }) => {
    await execute(); assert.equal(job.status, 'completed'); assert.equal(sends(calls).length, 1)
  }, { actions: [{ ...greet(), identityQuote: '林 先生作品集：数据库迁移' }, end] })
  for (const identityQuote of ['林先生 数据库迁移 作品集', '林先生 作品集，数据库迁移']) {
    const invalid = { ...greet(), identityQuote }
    await greetingFixture(async ({ execute, job, calls }) => {
      await execute(); assert.equal(job.status, 'failed'); assert.equal(sends(calls).length, 0)
    }, { actions: [invalid, invalid, invalid] })
  }
})

test('quote validation returns actual scoped source text so the model can correct on a fresh snapshot', async () => {
  const feedback = []; let turn = 0
  await greetingFixture(async ({ execute, job, calls, logger }) => {
    await execute(); assert.equal(job.status, 'completed'); assert.equal(sends(calls).length, 1)
    assert.equal(sends(calls)[0].args.snapshotId, 's2')
    assert.equal(feedback[0].dispatched, false)
    assert.equal(feedback[0].feedback.snapshotId, 's1')
    assert.ok(feedback[0].feedback.candidateSources[0].context.text.includes('林先生'))
    await logger.flush()
    const report = await logger.read(undefined, 1000)
    const row = report.lines.map(JSON.parse).find(row => row.errorCode === 'CANDIDATE_IDENTITY_QUOTE_INVALID')
    assert.equal(row.quoteFound, false); assert.equal(row.nameIncluded, true)
    assert.ok(!JSON.stringify(report).includes('林先生') && !JSON.stringify(report).includes('数据库迁移'))
  }, { log: true, plannerOf: () => ({ recordResult: result => feedback.push(result), decide: async observation => {
    if (observation.pendingGreeting) return { action: 'record_result', outcome: 'completed', evidenceRefs: ['receipt'], reason: '平台显示发送成功' }
    if (++turn === 1) return { ...greet(), identityQuote: '林先生 擅长数据库迁移' }
    if (turn === 2) {
      const actual = feedback[0].feedback.candidateSources.find(item => item.ref === 'hello')
      assert.ok(observation.page.items.some(item => item.ref === actual.ref))
      return { ...greet(), identityQuote: actual.context.text }
    }
    return end
  } }) })
})

test('position rejection explains a wrong target ID and returns selected evidence without sending', async () => {
  const feedback = []; let turn = 0
  await greetingFixture(async ({ execute, job, calls }) => {
    await execute(); assert.equal(job.status, 'completed'); assert.equal(sends(calls).length, 1)
    assert.match(feedback[0].error, /platformJobId/)
    assert.equal(feedback[0].feedback.positionSources[0].ref, 'job')
  }, { plannerOf: () => ({ recordResult: value => feedback.push(value), decide: async observation => {
    if (observation.pendingGreeting) return { action: 'record_result', outcome: 'completed', evidenceRefs: ['receipt'], reason: '平台显示发送成功' }
    if (++turn === 1) return { ...greet(), position: { ref: 'job', quote: '数据工程师', platformJobId: '456' } }
    return turn === 2 ? greet() : end
  } }) })
})

test('semantic greeting only needs refs/name; host reads selected node evidence and persists before sending', () => greetingFixture(async ({ execute, job, calls }) => {
  await execute()
  assert.equal(job.status, 'completed'); assert.equal(sends(calls).length, 1)
  assert.equal(calls.filter(row => row.tool === 'browser_inspect_element').length, 3)
  assert.equal(calls.find(row => row.tool === 'browser_snapshot').args.format, 'semantic')
  assert.equal(sends(calls)[0].args.observe.wait, 'dom_quiet')
  assert.equal(job.results[0].identityKind, 'text')
}, { page: i => ({ snapshotId: `s${i}`, documentId: 'doc', url, format: 'semantic', text: '', items: [
  { ref:'hello',role:'button',name:'联系此人',states:[] },{ref:'card',role:'StaticText',name:'林先生',states:[]},
  { ref:'job',role:'tab',name:'数据工程师',states:['selected'] } ] }),
  inspect: args => ({ item: args.ref === 'job' ? { ref:'job',name:'数据工程师',role:'tab',states:['selected'],elementId:'arbitrary-job-123' }
    : { ref:args.ref, name:args.ref==='card'?'林先生':'联系此人',role:args.ref==='card'?'StaticText':'button',bounds:args.ref==='card'?bounds:{x:20,y:20,width:20,height:20},
      contextCandidates:[{text:'联系此人'}, {text:'林先生 作品集：数据库迁移'}] } }),
  actions:[{action:'greet',ref:'hello',name:'林先生',candidateRef:'card',position:{ref:'job'},reason:'联系目标候选人'},end] }))

test('automatic identity/position evidence still rejects unrelated name and wrong selected job', async () => {
  for (const action of [{action:'greet',ref:'hello',name:'另一人',position:{ref:'job'},reason:'联系'},
    {action:'greet',ref:'hello',name:'林先生',position:{ref:'job'},reason:'联系'}]) {
    await greetingFixture(async({execute,job,calls})=>{await execute();assert.equal(job.status,'failed');assert.equal(sends(calls).length,0)},
      {page:i=>{const p=page('林先生',`s${i}`);p.url += '?jobId=456';return p},actions:[action,action,action]})
  }
})

test('resume model can search, choose, focus key, inspect iframe and download through host ingest', async () => {
  const job = { platform: 'liepin', tabId: 1, limit: 1, results: [], status: 'running' }, calls = [], seenFrames = []
  const actions = [
    { action: 'type', ref: 'search', text: '林先生' }, { action: 'press_key', key: 'Enter', ref: 'search' },
    { action: 'select_option', ref: 'select', value: 'latest' }, { action: 'inspect_frame', frameId: 8 },
    { action: 'select_candidate', ref: 'card', name: '林先生' }, { action: 'download', ref: 'download', evidenceRefs: [] },
  ]
  let snapshots = 0, ingests = 0
  await navigateResumes({ job, listTabId: 1, listUrl: url, origins: [origin], signal: signal(), priorJobs: [],
    planner: { decide: async observation => { assert.ok(actions.length); return { ...actions.shift(), reason: '按最新页面操作' } } },
    snapshot: async frame => { seenFrames.push(frame); return page('林先生', `s${++snapshots}`) },
    call: async (tool, args) => { calls.push({ tool, args }); return tool === 'browser_list_tabs' ? { tabs: [{ tabId: 1, url }] } : tool === 'browser_list_frames' ? { frames: [{ frameId: 8, url: `${origin}/frame` }] } : {} },
    progress: async () => {}, ingest: async (ref, p, result) => { assert.equal(ref, 'download'); assert.equal(p.snapshotId, 's6'); result.stage = 'succeeded'; ingests++ },
  })
  assert.equal(job.status, 'completed'); assert.equal(ingests, 1)
  assert.equal(seenFrames[4], 8)
  assert.ok(calls.some(row => row.tool === 'browser_type'))
  assert.ok(calls.some(row => row.tool === 'browser_select_option'))
})

test('primary login probe bypasses model; fallback reads existing tab and keeps it open', async () => {
  let models = 0
  const fast = await detectPlatformLogin(async tool => { assert.equal(tool, 'browser_channel_login'); return { loggedIn: true } }, 'liepin', false, signal(), async () => { models++; return {} })
  assert.equal(fast.status, 'logged_in'); assert.equal(models, 0)
  const calls = []
  const fallback = await detectPlatformLogin(async tool => {
    calls.push(tool)
    if (tool === 'browser_channel_login') throw new Error('old gateway')
    if (tool === 'browser_list_tabs') return { tabs: [{ tabId: 1, url }] }
    if (tool === 'browser_snapshot') return page()
    throw new Error(`unexpected ${tool}`)
  }, 'liepin', false, signal(), async (p, platform) => { models++; assert.equal(p.snapshotId, 's1'); assert.equal(platform, 'liepin'); return { status: 'unknown', detail: '证据不足' } })
  assert.equal(fallback.status, 'unknown'); assert.equal(models, 1)
  assert.ok(!calls.includes('browser_close_tab') && !calls.includes('browser_open_tab') && !calls.includes('browser_navigate'))
})

test('upload channels come from enabled company settings plus the always-available default channel', async () => {
  const channels = await readUploadChannels({ call: async (operation, args) => {
    assert.equal(operation, 'channelList'); assert.deepEqual(args, { status: 0 })
    return { ok: true, data: [
      { channelType: 39, channelDesc: '自建平台', openStatus: 0 }, { channelType: 1000, channelDesc: '人才活动', openStatus: 0 },
      { channelType: 20, channelDesc: '内推', openStatus: 0 }, { channelType: 34, channelDesc: '猎头', openStatus: 0 },
      { channelType: 40, channelDesc: '停用渠道', openStatus: 1 },
    ] }
  } })
  assert.deepEqual(channels.map(row => row.id), ['0', '39', '1000', '20', '34'])
  assert.deepEqual(channels[0], { id: '0', label: '默认渠道', channelType: 0 })
  assert.equal(channels[3].requires, 'recommenderId'); assert.equal(channels[4].requires, 'headhunterSupplierId')
  const withDefault = await readUploadChannels({ call: async () => ({ ok: true, data: [{ channelType: 0, channelDesc: '默认渠道', openStatus: 0 }] }) })
  assert.deepEqual(withDefault.map(row => row.id), ['0'])
  await assert.rejects(readUploadChannels({ call: async () => ({ ok: true, data: { channels: [] } }) }), /格式不可识别/)
  await assert.rejects(readUploadChannels({ call: async () => ({ ok: false, failure: { message: '未授权' } }) }), /未授权/)
})

test('host model route is captured and missing services fail without rule fallback', () => {
  assert.throws(() => hostPagePlanner({ get: () => undefined }, navigationActionSpec, 'system', 'test')(), /默认模型/)
})

test('page planners reject a removed provider before requesting any model output', () => {
  let calls = 0
  const llm = { listProviders: () => [{ id: 'deepseek-official' }], stream() { calls++; throw new Error('must not call') } }
  const ctx = { get: key => key === 'llm' ? llm : key === 'agentDefaultModel'
    ? { currentSelection: () => ({ provider: 'xinling-workbuddy', model: 'glm-5.3-flash' }) } : undefined }
  for (const feature of ['test', 'greeting', 'resume']) {
    assert.throws(() => hostPagePlanner(ctx, navigationActionSpec, 'system', feature)(), /HOST_MODEL_PROVIDER_UNAVAILABLE.*模型设置/)
  }
  assert.equal(calls, 0)
})

function modelContext(outputs) {
  const requests = []
  let selection = { provider: 'host-provider', model: 'host-default', reasoningEffort: 'medium' }
  const ctx = { get: key => key === 'agentDefaultModel' ? { currentSelection: () => selection } : key === 'llm' ? {
    async *stream(options) {
      requests.push(structuredClone({ ...options, signal: undefined }))
      const output = outputs.shift()
      if (output instanceof Error) throw output
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: output }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  } : undefined }
  return { ctx, requests, setSelection: next => { selection = next } }
}

test('host default model route is held for a task and invalid output retries without executing', async () => {
  const model = modelContext(['not JSON', JSON.stringify({ action: 'back', reason: '返回' })])
  const planner = hostPagePlanner(model.ctx, navigationActionSpec, '只做页面决策', 'test')()
  model.setSelection({ provider: 'other', model: 'other' })
  const selected = await planner.decide({ page: pageObservation(page()) }, signal())
  assert.equal(selected.action, 'back')
  assert.equal(model.requests.length, 2)
  assert.ok(model.requests.every(request => request.provider === 'host-provider' && request.model === 'host-default'))
  assert.equal(model.requests[1].messages.length, 2)
  const unavailable = modelContext([new Error('provider unavailable')])
  await assert.rejects(hostPagePlanner(unavailable.ctx, navigationActionSpec, 'system', 'test')().decide({}, signal()), /provider unavailable/)
  assert.equal(unavailable.requests.length, 1)
})

test('login fallback accepts model evidence and rejects invented evidence or wrong origin', async () => {
  for (const [quote, pageURL, expected] of [['林先生', url, 'logged_in'], ['页面不存在的内容', url, 'unknown'], ['林先生', 'https://foreign.example/', 'unknown']]) {
    const model = modelContext([JSON.stringify({ status: 'logged_in', reason: '有登录后的工作内容', evidence: [quote] })])
    const result = await hostLoginClassifier(model.ctx)({ ...page(), url: pageURL }, 'liepin', signal())
    assert.equal(result.status, expected)
  }
})

test('model can switch a job and dismiss a novel popup before greeting, then host stops at limit', () => greetingFixture(async ({ execute, job, calls }) => {
  await execute()
  assert.equal(job.status, 'completed'); assert.equal(sends(calls).length, 1)
  assert.deepEqual(calls.filter(row => row.tool === 'browser_click').map(row => row.args.ref), ['job', 'dismiss', 'hello'])
}, { actions: [{ action: 'click', ref: 'job', reason: '切换目标职位' }, { action: 'click', ref: 'dismiss', reason: '关闭新出现的弹窗' }, greet()],
  page: i => i !== 2 ? page('林先生', `s${i}`) : { snapshotId: `s${i}`, documentId: 'doc', url, text: '操作回执',
    dialogs: [{ ref: 'dialog', text: '平台新版提示', closeRef: 'dismiss' }], items: [{ ref: 'dismiss', name: '知道了', role: 'button', dialogRef: 'dialog' }] } }))

test('legacy same-name receipts with unrelated identity keys do not block a different candidate', () => greetingFixture(async ({ execute, job, calls, store }) => {
  await store.put('greeting-legacy', { ...job, id: 'legacy', results: [{ key: 'legacy-card-key', name: '林先生', stage: 'succeeded', updatedAt: new Date().toISOString() }] })
  await execute(); assert.equal(job.status, 'completed'); assert.equal(sends(calls).length, 1)
}))

test('cancellation during a dispatched greeting preserves unknown and releases ownership', async () => {
  const controller = new AbortController()
  await greetingFixture(async ({ executor, job, calls, store }) => {
    await executor.run(job, controller.signal)
    assert.equal(job.status, 'unknown'); assert.equal(job.results[0].stage, 'unknown')
    assert.equal((await store.get(`greeting-${job.id}`)).results[0].stage, 'unknown')
    assert.equal(calls.filter(row => row.tool === 'browser_finish').length, 1)
  }, { click: () => { controller.abort(); throw new Error('cancelled while awaiting reply') } })
})

const nav = (action, extra = {}) => navigationActionSpec.parse({ action, reason: '观察当前页面后操作', ...extra })
const viewFor = (p, calls) => ({ tabId: 1, page: p, tabs: [{ tabId: 1, url: p.url }], frames: [], origins: [origin],
  call: async (tool, args) => calls.push({ tool, args }) })

test('hover uses the observed locator and delegates live clickability to the browser instead of snapshot flags', async () => {
  const calls = [], view = viewFor(page(), calls)
  await executeNavigation(nav('hover', { ref: 'job' }), view)
  assert.deepEqual(calls, [{ tool: 'browser_hover', args: { tabId: 1, snapshotId: 's1', documentId: 'doc', ref: 'job', settleMs: 350, observe: { wait: 'dom_quiet', timeoutMs: 1500 } } }])
  await assert.rejects(executeNavigation(nav('hover', { ref: 'gone' }), view), /ELEMENT_NOT_FOUND/)
  view.page.items[2].states.push('occluded')
  await executeNavigation(nav('hover', { ref: 'job' }), view)
  assert.equal(calls.length, 2)
  const obstruction = new Error('ELEMENT_OCCLUDED')
  view.call = async () => { throw obstruction }
  await assert.rejects(executeNavigation(nav('click', { ref: 'job' }), view), error => error === obstruction)
})

test('submit delegates snapshot state flags to the browser while preserving live failure and duplicate-write handling', async () => {
  for (const state of ['occluded', 'disabled', 'hidden', 'blocked_by_dialog']) {
    const current = page(), calls = [], view = viewFor(current, calls)
    current.items[1].states = [state]
    const operation = new PageOperation(current.snapshotId, current)
    let dispatched = 0
    const obstruction = new Error('ELEMENT_OCCLUDED')
    await assert.rejects(operation.submit('hello', view, async () => { dispatched++; throw obstruction }, recoverablePageError), error => error === obstruction)
    assert.equal(dispatched, 1)
    await operation.submit('hello', view, async () => { dispatched++; return { dispatched: true } }, recoverablePageError)
    await assert.rejects(operation.submit('hello', view, async () => { dispatched++ }, recoverablePageError), /PAGE_ACTION_REPEAT_BLOCKED/)
    assert.equal(dispatched, 2)
  }
})

test('repeat guard ignores snapshot/ref replacements and reason changes but reports the actual target', async () => {
  const history = [], calls = [], progress = new PageProgress(history, 'greeting')
  for (let i = 0; i < 2; i++) {
    const p = page('林先生', `s${i}`); p.items[2].ref = `job${i}`
    await progress.execute(nav('click', { ref: `job${i}`, reason: `选择职位理由${i}` }), viewFor(p, calls))
    progress.observe(viewFor(page('林先生', `s${i + 1}`), calls))
    assert.equal(history.at(-1).pageChanged, false)
    assert.equal(history.at(-1).target.name, '数据工程师')
  }
  await assert.rejects(progress.execute(nav('click', { ref: 'job', reason: '换个理由再点' }), viewFor(page(), calls)), /PAGE_ACTION_REPEAT_BLOCKED/)
  assert.equal(calls.length, 2)
  assert.match(history.at(-1).outcome, /此次未执行/)
  assert.equal(history.at(-1).attemptsInState, 2)
  await progress.execute(nav('hover', { ref: 'job' }), viewFor(page(), calls))
  assert.equal(calls.at(-1).tool, 'browser_hover', 'a blocked click must not block a different interaction')
})

test('repeat guard detects alternating open/close cycles and permits genuine new states', async () => {
  const calls = [], history = [], progress = new PageProgress(history, 'greeting')
  const state = open => {
    const p = page(); p.items[2].states = open ? ['selected', 'expanded'] : ['selected']
    return p
  }
  for (const open of [false, true, false, true]) {
    await progress.execute(nav('click', { ref: 'job' }), viewFor(state(open), calls))
    progress.observe(viewFor(state(!open), calls))
    assert.equal(history.at(-1).pageChanged, true)
  }
  await assert.rejects(progress.execute(nav('click', { ref: 'job' }), viewFor(state(false), calls)), /PAGE_ACTION_REPEAT_BLOCKED/)
  const changed = page(); changed.items[2].name = '另一职位'
  await progress.execute(nav('click', { ref: 'job' }), viewFor(changed, calls))
  assert.equal(calls.length, 5)
  progress.observe(viewFor(changed, calls))
  assert.equal(history.at(-1).pageChanged, false)
  progress.checkpoint()
  await progress.execute(nav('click', { ref: 'job' }), viewFor(state(false), calls))
  assert.equal(calls.length, 6, 'completed candidate boundary allows legitimate reuse of navigation')
})

test('navigation uncertainty propagates once without retry or a fabricated observation', async () => {
  const history = [], progress = new PageProgress(history, 'greeting')
  let calls = 0
  const view = { ...viewFor(page(), []), call: async () => { calls++; throw new Error('RESULT_UNKNOWN dispatch reply lost') } }
  await assert.rejects(progress.execute(nav('hover', { ref: 'job' }), view), /RESULT_UNKNOWN/)
  progress.observe(view)
  assert.equal(calls, 1)
  assert.equal(history.at(-1).after, undefined)
  assert.match(history.at(-1).outcome, /RESULT_UNKNOWN/)
})

test('greeting loop stops a model that insists on repeating a successful but ineffective click', () => greetingFixture(async ({ execute, job, calls, observations, logger }) => {
  await execute()
  assert.equal(job.status, 'failed')
  assert.match(job.detail, /PAGE_ACTION_REPEAT_BLOCKED/)
  assert.equal(calls.filter(row => row.tool === 'browser_click').length, 2)
  assert.equal(sends(calls).length, 0)
  assert.equal(observations[1].recentActions[0].ref, 'job')
  assert.equal(observations[1].recentActions[0].pageChanged, false)
  assert.equal(observations[1].recentActions[0].reason, '选择当前职位')
  await logger.flush()
  const rows = (await logger.read(undefined, 1000)).lines.map(JSON.parse)
  const result = rows.find(row => row.event === 'greeting.action_result')
  assert.equal(result.pageChanged, false)
  assert.equal(result.targetRole, 'tab')
  assert.equal(result.targetElementId, 'arbitrary-job-123')
  assert.ok(result.beforeStateKey && result.afterStateKey)
  assert.ok(rows.some(row => row.event === 'greeting.action_repeat_blocked'))
  const encoded = JSON.stringify(rows)
  assert.ok(!encoded.includes('林先生') && !encoded.includes('数据库迁移'))
}, { log: true, decide: () => ({ action: 'click', ref: 'job', reason: '选择当前职位' }) }))

test('hover recovery opens a disappearing menu, selects from a fresh snapshot and only then greets', async () => {
  let menuOpen = false, selected = false
  await greetingFixture(async ({ execute, job, calls, observations }) => {
    await execute()
    assert.equal(job.status, 'completed')
    assert.equal(calls.filter(row => row.tool === 'browser_click' && row.args.ref === 'trigger').length, 2)
    const hover = calls.find(row => row.tool === 'browser_hover')
    assert.equal(hover.args.ref, 'trigger'); assert.equal(hover.args.snapshotId, 's4')
    const option = calls.find(row => row.tool === 'browser_click' && row.args.ref === 'option')
    assert.equal(option.args.snapshotId, 's5')
    assert.equal(observations[4].recentActions.at(-1).action, 'hover')
    assert.equal(observations[4].recentActions.at(-1).pageChanged, true)
    assert.ok(observations[4].page.items.some(item => item.ref === 'option'))
    assert.equal(sends(calls).length, 1)
  }, { actions: [nav('click', { ref: 'trigger' }), nav('click', { ref: 'trigger' }), nav('click', { ref: 'trigger' }),
    nav('hover', { ref: 'trigger' }), nav('click', { ref: 'option' }), greet(), end],
    page: i => {
      const p = page('林先生', `s${i}`)
      if (!selected) Object.assign(p.items[2], { name: '其他职位', elementId: 'another-job' })
      p.items.push({ ref: 'trigger', name: '职位菜单', role: 'button', states: menuOpen ? ['expanded'] : [] })
      if (menuOpen) p.items.push({ ref: 'option', name: '数据工程师', role: 'option', elementId: 'choose-123' })
      return p
    },
    hover: args => { assert.equal(args.ref, 'trigger'); menuOpen = true; return { hovered: true } },
    click: args => {
      if (args.ref === 'trigger') menuOpen = false // the menu flashes then closes
      if (args.ref === 'option') { assert.equal(menuOpen, true); selected = true; menuOpen = false }
      if (args.ref === 'hello') assert.equal(selected, true)
      return {}
    },
  })
})

test('resume loop shares the repeat guard and cannot click the same ineffective menu 33 times', async () => {
  const job = { platform: 'liepin', tabId: 1, limit: 1, results: [], status: 'running' }, calls = []
  let snapshots = 0
  await assert.rejects(navigateResumes({ job, listTabId: 1, listUrl: url, origins: [origin], signal: signal(), priorJobs: [],
    planner: { decide: async () => nav('click', { ref: 'job' }) },
    snapshot: async () => page('林先生', `s${++snapshots}`),
    call: async (tool, args) => { calls.push({ tool, args }); return tool === 'browser_list_tabs' ? { tabs: [{ tabId: 1, url }] } : tool === 'browser_list_frames' ? { frames: [] } : {} },
    progress: async () => {}, ingest: async () => assert.fail('no ingest expected'),
  }), /PAGE_ACTION_REPEAT_BLOCKED/)
  assert.equal(calls.filter(row => row.tool === 'browser_click').length, 2)
  assert.equal(job.results.length, 0)
})

test('waiting for loading remains allowed and cannot clear a blocked click history', async () => {
  const calls = [], history = [], progress = new PageProgress(history, 'greeting')
  for (let i = 0; i < 2; i++) {
    await progress.execute(nav('click', { ref: 'job' }), viewFor(page(), calls))
    progress.observe(viewFor(page(), calls))
  }
  for (let i = 0; i < 4; i++) {
    await progress.execute(nav('wait'), viewFor(page('林先生', `load-${i}`), calls))
    progress.observe(viewFor(page('林先生', `next-${i}`), calls))
  }
  await assert.rejects(progress.execute(nav('click', { ref: 'job' }), viewFor(page(), calls)), /PAGE_ACTION_REPEAT_BLOCKED/)
  assert.equal(calls.filter(row => row.tool === 'browser_click').length, 2)
  assert.equal(calls.filter(row => row.tool === 'browser_wait').length, 4)
})
