import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GreetingAgent } from '../dist/lib/greeting-agent.js'
import { runResumeAgent } from '../dist/lib/resume-agent.js'
import { runBrowserAgent } from '../dist/lib/browser-agent.js'
import { AgentBrowserTools } from '../dist/lib/agent-browser-tools.js'
import { Store } from '../dist/lib/store.js'
import { runRecruitmentAgent } from '../dist/lib/recruitment-presets.js'

const string = { type: 'string' }

async function foregroundAttachment(options = {}) {
  const calls = []
  let complete = false
  const page = { tabId: 1, snapshotId: 'detail-1', documentId: 'detail', format: 'dom',
    url: 'https://lpt.liepin.com/resume/apply', viewport: { width: 1440, height: 743 },
    dialogs: [{ ref: 'dialog', text: '林先生的简历详情' }],
    items: [
      { ref: 'dialog', role: 'dialog', name: options.foreign ? '周女士的简历详情' : '林先生的简历详情', states: ['enabled'] },
      { ref: 'attachment-section', role: 'section', name: '附件简历 文件.pdf 预览 下载', dialogRef: 'dialog' },
      { ref: 'download-1', role: 'button', name: '下载', states: ['enabled'], dialogRef: 'dialog', parentRef: 'attachment-section',
        bounds: { x: 580, y: options.offscreen ? 1400 : 574, width: 48, height: 27 } },
    ] }
  if (options.multiple) page.items.push({ ...page.items[2], ref: 'another-download' })
  const names = ['browser_scroll', 'task_import_attachment']
  await runRecruitmentAgent({ system: 'fixture', goal: {}, signal: new AbortController().signal,
    isComplete: () => complete,
    tools: names.map(name => ({ name, inputSchema: {}, readOnly: false, execute: async args => {
      calls.push({ name, args })
      if (name === 'browser_scroll') {
        page.snapshotId = 'detail-2'
        page.items[2] = { ...page.items[2], ref: 'download-2', bounds: { x: 580, y: 574, width: 48, height: 27 } }
      } else complete = true
      return {}
    } })),
  }, { job: { kind: 'resume_import', platform: 'liepin', limit: 1, results: [] },
    broker: { currentPage: () => page }, current: () => ({ name: '林先生', dispatched: false }),
    agent: () => async () => ({ status: 'stopped', turns: 0, modelMs: 0, toolMs: 0 }) })
  return calls
}

test('resume foreground selects the actual download control with dialog identity instead of the attachment section', async () => {
  const calls = await foregroundAttachment()
  assert.deepEqual(calls, [{ name: 'task_import_attachment', args: {
    tabId: 1, snapshotId: 'detail-1', ref: 'download-1', evidenceRefs: ['dialog'],
  } }])
})

test('an offscreen foreground attachment scrolls before import and uses the new snapshot and ref', async () => {
  const calls = await foregroundAttachment({ offscreen: true })
  assert.deepEqual(calls.map(call => call.name), ['browser_scroll', 'task_import_attachment'])
  assert.equal(calls[0].args.ref, 'download-1')
  assert.equal(calls[0].args.deltaY, 650)
  assert.equal(calls[1].args.snapshotId, 'detail-2')
  assert.equal(calls[1].args.ref, 'download-2')
})

test('a foreign resume dialog or multiple download choices do not trigger a preset import', async () => {
  assert.deepEqual(await foregroundAttachment({ foreign: true }), [])
  assert.deepEqual(await foregroundAttachment({ multiple: true }), [])
})
const integer = { type: 'integer' }
const refs = { tabId: integer, snapshotId: string, ref: string }
const observe = { type: 'object', properties: { wait: { enum: ['none', 'dom_quiet'] },
  returnSnapshot: { enum: ['none', 'viewport'] }, requireChange: { type: 'boolean' }, timeoutMs: integer }, additionalProperties: false }
const info = (name, properties, readOnly, required = []) => ({ name, inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly }, _meta: { browserAgent: { available: true, capability: name.replace('_', '.') } } })
const infos = [info('browser_list_tabs', {}, true), info('browser_snapshot', { tabId: integer, format: string, viewportOnly: { type: 'boolean' } }, true, ['tabId']),
  info('browser_click', { ...refs, observe }, false, ['tabId', 'snapshotId', 'ref']),
  info('browser_hover', { ...refs, observe }, false, ['tabId', 'snapshotId', 'ref']),
  info('browser_navigate', { tabId: integer, url: string }, false, ['tabId', 'url']),
  info('browser_open_tab', { url: string }, false, ['url']),
  info('browser_wait', { tabId: integer, condition: { type: 'object' }, timeoutMs: integer }, true, ['tabId']),
  info('browser_scroll', { ...refs, deltaY: integer }, false, ['tabId']),
  info('browser_inspect_element', refs, true, ['tabId', 'snapshotId', 'ref'])]
const people = ['林先生', '周女士']
const body = index => `${people[index]} ${30 + index}岁 本科 8年经验`
const baseJob = (kind, platform, limit = 2) => ({ kind, platform, limit, id: `preset-${kind}-${platform}`, tabId: 1,
  status: 'running', results: [], detail: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
const originOf = platform => platform === 'liepin' ? 'https://lpt.liepin.com' : 'https://www.zhipin.com'
const greetingUrl = platform => `${originOf(platform)}${platform === 'liepin' ? '/recommend' : '/web/chat/recommend'}?jobid=123`
const resumeUrl = platform => `${originOf(platform)}${platform === 'liepin' ? '/resume/apply' : '/web/chat/index'}`
const stopped = { status: 'stopped', message: 'AI needs user assistance', turns: 1, modelMs: 1, toolMs: 0 }

async function greetingFixture(platform, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'platform-presets-'))
  try {
    const store = new Store(directory, 'test'); await store.init()
    const job = { ...baseJob('greeting', platform, options.limit ?? 2), jobId: 'system-job', jobName: '数据工程师',
      platformJobs: options.platformJobs ?? [{ id: '123', name: '数据工程师' }] }
    if (options.selectedPlatformJob) job.selectedPlatformJob = options.selectedPlatformJob
    if (options.noPreferredTab) delete job.tabId
    for (const prior of options.priorJobs ?? []) await store.put(`greeting-${prior.id}`, prior)
    await store.put(`greeting-${job.id}`, job)
    let snapshots = 0, time = 0, modal = !!options.modal, selectedPosition = !options.switchPosition, format = 'semantic'
    let loading = options.loadingSnapshots ?? 0, panelOpen = false, selectedTargetId = '123'
    const recipients = options.people ?? people
    const cardText = index => `${options.onlinePrefix ? '在线 ' : ''}${recipients[index]} ${30 + index}岁 本科 8年经验`
    const sent = new Set(), calls = [], waits = [], modelRequests = [], fallbacks = [], logs = []
    const page = () => {
      const positionItem = { ref: 'position',
        elementId: options.semanticPositionWithoutId && format === 'semantic' ? undefined : selectedPosition ? `job-${selectedTargetId}` : 'job-999',
        role: 'tab', name: selectedPosition ? '数据工程师' : '其他职位', states: ['selected'],
        ...(options.businessOptions && selectedPosition ? { href: `${originOf(platform)}/recommend?jobId=${selectedTargetId}` } : {}) }
      const positionVisible = !options.ambiguousPosition && !((options.jobTrigger || options.sameNameOptions) && !selectedPosition)
      const result = { tabId: 1, snapshotId: `s${++snapshots}`, documentId: 'recommendation', format, frameId: 0,
        url: options.noJobQuery ? greetingUrl(platform).split('?')[0] : greetingUrl(platform), text: '', items: [
          ...(positionVisible ? [positionItem] : []),
          ...(options.switchPosition && !selectedPosition && !options.jobTrigger && !options.sameNameOptions ? [{ ref: 'choose-position', elementId: 'job-123', role: 'option', name: '数据工程师' }] : []),
          ...(options.jobTrigger ? [
            { ref: 'job-trigger', elementId: 'job-switch', role: 'combobox', name: '切换职位', hasPopup: true },
            ...(panelOpen ? [{ ref: 'trigger-option', elementId: 'job-123', role: 'option', name: '数据工程师' }] : []),
          ] : []),
          ...(options.sameNameOptions ? [
            { ref: 'same-a', elementId: 'job-123', ...(options.businessOptions ? { href: `${originOf(platform)}/recommend?jobId=123` } : {}), role: 'option', name: '数据工程师', context: { text: '数据工程师 北京-朝阳区 3-5k' } },
            { ref: 'same-b', elementId: 'job-456', ...(options.businessOptions ? { href: `${originOf(platform)}/recommend?jobId=456` } : {}), role: 'option', name: '数据工程师', context: { text: '数据工程师 上海-浦东新区 6-8k' } },
          ] : []),
          ...recipients.flatMap((name, index) => [
            { ref: `card-${index}`, role: 'article', name: cardText(index), bounds: { x: 10, y: index * 160, width: 500, height: 150 } },
            { ref: `greet-${index}`, elementId: `greet-${index}`, role: 'button', name: sent.has(index) ? '已沟通' : platform === 'liepin' ? '立即沟通' : '打招呼',
              context: options.missingContext ? undefined : { text: cardText(index) }, bounds: { x: 300, y: index * 160 + 20, width: 80, height: 30 } },
          ]),
        ], dialogs: [] }
      if (options.ambiguousPosition) result.items = result.items.filter(item => item.ref !== 'position')
      if (modal) {
        result.dialogs = [{ ref: 'notice', name: '平台通知', text: '今日推荐已更新', closeRef: 'dismiss' }]
        result.items.push({ ref: 'dismiss', role: 'button', name: '关闭', dialogRef: 'notice' })
      }
      options.mutatePage?.(result, sent)
      if (loading-- > 0) { result.items = [{ ref: 'root', role: 'RootWebArea', name: '' }]; result.dialogs = []; result.readyState = 'loading' }
      return result
    }
    let latest
    const call = async (name, args) => {
      calls.push({ name, args })
      if (name === 'browser_list_tabs') return { tabs: options.tabs ?? [{ tabId: 1, url: greetingUrl(platform) }] }
      if (name === 'browser_snapshot') { format = args.format ?? 'semantic'; return latest = page() }
      if (name === 'browser_open_tab') return { tabId: 1, snapshot: latest = page() }
      if (name === 'browser_wait') return { conditionMet: true, snapshot: latest = page() }
      if (name === 'browser_scroll' && options.onScroll) { options.onScroll(); return { snapshot: latest = page() } }
      if (name === 'browser_inspect_element') {
        const item = structuredClone(latest.items.find(item => item.ref === args.ref))
        if (args.ref.startsWith('greet-')) item.context = { text: cardText(Number(args.ref.at(-1))) }
        return { item }
      }
      if (name === 'browser_hover' && args.ref === 'job-trigger') {
        if (options.jobTrigger === 'hover') panelOpen = true
        return { dispatched: true, snapshot: latest = page() }
      }
      if (name === 'browser_click' && (args.ref === 'job-trigger' || args.ref === 'same-a' || args.ref === 'same-b' || args.ref === 'trigger-option')) {
        if (args.ref === 'job-trigger') panelOpen = options.jobTrigger !== 'click-broken'
        else { selectedPosition = true; panelOpen = false; selectedTargetId = args.ref === 'same-b' ? '456' : '123' }
        return { dispatched: true, snapshot: latest = page() }
      }
      if (name === 'browser_click') {
        assert.equal(args.snapshotId, latest.snapshotId)
        if (args.ref === 'dismiss') { modal = false; return { dispatched: true, snapshot: latest = page() } }
        if (args.ref === 'choose-position') { selectedPosition = true; return { dispatched: true, snapshot: latest = page() } }
        assert.equal(args.policy.riskLevel, 'business_write')
        const index = Number(args.ref.at(-1))
        const saved = await store.get(`greeting-${job.id}`)
        assert.equal(saved.results.at(-1).name, recipients[index])
        assert.equal(saved.results.at(-1).stage, 'sending'); assert.ok(saved.results.at(-1).attemptedAt)
        if (options.writeError) throw new Error(options.writeError)
        assert.ok(!sent.has(index), 'a recipient cannot be sent twice')
        sent.add(index)
        return { dispatched: true, snapshot: latest = page() }
      }
      return {}
    }
    const fallback = () => {
      fallbacks.push(true)
      if (!options.model) return async input => { options.onFallback?.(input); return stopped }
      return input => runBrowserAgent({ async *stream(request) {
        modelRequests.push(request)
        const actions = options.model(request, latest)
        for (const [index, action] of actions.entries()) {
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'block-end', index, block: { type: 'tool-call', id: `ai-${modelRequests.length}-${index}`, name: action.name, arguments: JSON.stringify(action.args) } }
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } }, { provider: 'test', model: 'fallback' }, { ...input, maxTurns: 4 })
    }
    const logger = { write: (_level, event, fields) => logs.push({ event, ...fields }), updateContext() {} }
    const executor = new GreetingAgent(store, call, async () => {}, async () => infos, fallback, logger, {},
      { now: () => time, sleep: async (milliseconds, signal) => { signal.throwIfAborted(); waits.push(milliseconds); time += milliseconds } })
    await executor.run(job, options.signal ?? new AbortController().signal)
    return { job, calls, sent, waits, modelRequests, fallbacks, logs }
  } finally { await rm(directory, { force: true, recursive: true }) }
}

async function resumeFixture(platform, options = {}) {
  const job = baseJob('resume_import', platform, options.limit ?? 2)
  const signal = options.signal ?? new AbortController().signal
  let url = resumeUrl(platform), candidate, preview = false, snapshots = 0, imports = 0, modelCalls = 0, modelTurns = 0, latest, format = 'semantic'
  const calls = [], saved = []
  const page = () => { const observed = { tabId: 1, snapshotId: `r${++snapshots}`, documentId: 'resume-page', format, frameId: 0, url,
    text: candidate === undefined ? '' : body(candidate),
    items: candidate === undefined ? people.map((name, index) => ({ ref: `candidate-${index}`, role: options.sparseSemantic && format === 'semantic' ? 'text' : 'button', name: body(index) }))
      : [{ ref: 'identity', role: 'article', name: body(candidate) },
        { ref: preview ? 'attachment' : 'preview', role: 'button', name: preview ? options.unknownDownload && candidate === 0 ? '取回文件' : '下载简历' : '预览附件', context: { text: body(candidate) } }] }
    if (platform === 'liepin' && candidate === undefined) observed.items.push({ ref: 'received', role: 'tab', name: '收到简历', states: ['selected'] })
    return observed
  }
  const broker = new AgentBrowserTools(infos, async (name, args) => {
    calls.push({ name, args })
    if (name === 'browser_list_tabs') return { tabs: [{ tabId: 1, url }] }
    if (name === 'browser_snapshot') { format = args.format ?? 'semantic'; return latest = page() }
    if (name === 'browser_inspect_element') return { item: latest.items.find(item => item.ref === args.ref) }
    if (name === 'browser_navigate') { url = args.url; candidate = undefined; preview = false; return { dispatched: true } }
    if (name === 'browser_click') {
      assert.equal(args.policy.riskLevel, 'browser_mutation')
      if (args.ref === 'preview') preview = true
      else { candidate = Number(args.ref.at(-1)); url = `${originOf(platform)}/resume/detail/${candidate}` }
      return { dispatched: true, snapshot: latest = page() }
    }
    return {}
  }, { origins: [originOf(platform)], signal, confirmationId: 'resume-preset' })
  let error
  try {
    await runResumeAgent({ job, signal, broker, priorJobs: options.priorJobs ?? [],
      progress: async (phase, detail) => saved.push({ phase, detail, job: structuredClone(job) }),
      agent: async input => {
        modelCalls++; options.onFallback?.(input)
        if (!options.model) return stopped
        return runBrowserAgent({ async *stream(request) {
          modelTurns++
          for (const [index, action] of options.model(request, latest).entries()) {
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'block-end', index, block: { type: 'tool-call', id: `resume-ai-${modelTurns}-${index}`, name: action.name, arguments: JSON.stringify(action.args) } }
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } }, { provider: 'test', model: 'resume-fallback' }, { ...input, maxTurns: 4 })
      },
      ingest: async (ref, observed, result) => {
        assert.equal(ref, 'attachment'); assert.equal(observed.snapshotId, latest.snapshotId)
        assert.ok(saved.at(-1).job.results.at(-1).attemptedAt)
        imports++
        if (options.importError) throw new Error(options.importError)
        result.stage = 'succeeded'; result.detail = 'confirmed server receipt'
      } })
  } catch (caught) { error = caught }
  return { job, calls, saved, imports, modelCalls, modelTurns, error }
}

for (const platform of ['liepin', 'boss']) {
  test(`${platform}: two greetings use real bookkeeping, evidence and pacing with zero model calls`, async () => {
    const out = await greetingFixture(platform)
    assert.equal(out.job.status, 'completed'); assert.equal(out.sent.size, 2)
  // 回归：快照带 frameId=0，但 browser_click/hover/scroll 的 schema 不声明它，
  // 携带会被 additionalProperties:false 拒绝（真实事故：首屏后第一次点击必失败）。
  const located = out.calls.filter(call => ['browser_click', 'browser_hover', 'browser_scroll'].includes(call.name))
  assert.ok(located.length > 0)
  assert.ok(located.every(call => call.args.frameId === undefined))
    assert.deepEqual(out.job.results.map(row => row.stage), ['succeeded', 'succeeded'])
    assert.ok(out.job.results.every(row => row.clickedAt && !row.confirmedAt)); assert.deepEqual(out.waits, [5000])
    assert.ok(!out.logs.some(row => row.tool === 'task_report_result'))
    assert.equal(out.fallbacks.length, 0); assert.equal(out.calls.at(-1).name, 'browser_finish')
  })
  test(`${platform}: two resume imports select, preview, capture and return without model calls`, async () => {
    const out = await resumeFixture(platform)
    assert.equal(out.error, undefined); assert.equal(out.job.status, 'completed'); assert.equal(out.imports, 2)
    assert.deepEqual(out.job.results.map(row => row.stage), ['succeeded', 'succeeded'])
    assert.equal(out.modelCalls, 0)
    assert.equal(out.calls.filter(call => call.name === 'browser_navigate').length, 1)
  })
}

test('a known platform job is switched and reverified before any greeting is sent', async () => {
  const out = await greetingFixture('boss', { switchPosition: true })
  assert.equal(out.job.status, 'completed'); assert.equal(out.fallbacks.length, 0)
  const inputs = out.calls.filter(call => call.name === 'browser_click')
  assert.equal(inputs[0].args.ref, 'choose-position'); assert.equal(inputs[0].args.policy.riskLevel, 'browser_mutation')
  assert.equal(inputs[1].args.policy.riskLevel, 'business_write')
})

test('an unverified position hands off to AI without selecting or sending', async () => {
  const out = await greetingFixture('liepin', { ambiguousPosition: true })
  assert.equal(out.sent.size, 0); assert.equal(out.job.results.length, 0); assert.equal(out.fallbacks.length, 1)
})

test('a job dropdown that only opens on hover is opened and switched without a model turn', async () => {
  const out = await greetingFixture('liepin', { switchPosition: true, jobTrigger: 'hover' })
  assert.equal(out.job.status, 'completed', out.job.detail); assert.equal(out.fallbacks.length, 0, out.job.detail)
  assert.ok(out.calls.some(call => call.name === 'browser_hover' && call.args.ref === 'job-trigger'))
  assert.ok(out.calls.some(call => call.name === 'browser_click' && call.args.ref === 'trigger-option'))
})

test('a job dropdown that ignores hover is retried once with a real click instead of handing off', async () => {
  const out = await greetingFixture('liepin', { switchPosition: true, jobTrigger: 'click' })
  assert.equal(out.job.status, 'completed', out.job.detail); assert.equal(out.fallbacks.length, 0, out.job.detail)
  const trigger = out.calls.filter(call => call.args?.ref === 'job-trigger')
  assert.deepEqual(trigger.map(call => call.name), ['browser_hover', 'browser_click'])
})

test('two same-name platform jobs without ID evidence stop immediately instead of looping with the model', async () => {
  const out = await greetingFixture('liepin', { limit: 1, switchPosition: true, noJobQuery: true, sameNameOptions: true,
    platformJobs: [{ id: '123', name: '数据工程师' }, { id: '456', name: '数据工程师' }] })
  assert.equal(out.sent.size, 0); assert.equal(out.fallbacks.length, 0)
  assert.equal(out.job.status, 'failed'); assert.match(out.job.detail, /PRESET_POSITION_AMBIGUOUS/)
})

test('an explicitly chosen platform job disambiguates two same-name options without a model turn', async () => {
  const out = await greetingFixture('liepin', { limit: 1, switchPosition: true, noJobQuery: true, sameNameOptions: true,
    businessOptions: true, selectedPlatformJob: { id: '456', name: '数据工程师' },
    platformJobs: [{ id: '123', name: '数据工程师' }, { id: '456', name: '数据工程师' }] })
  assert.equal(out.job.status, 'completed', out.job.detail); assert.equal(out.fallbacks.length, 0, out.job.detail)
  assert.ok(out.calls.some(call => call.name === 'browser_click' && call.args.ref === 'same-b'))
})

test('an unverifiable target position stops after bounded identical pauses instead of burning model turns', async () => {
  const out = await greetingFixture('liepin', { limit: 1, ambiguousPosition: true,
    model: () => [{ name: 'browser_snapshot', args: { tabId: 1 } }] })
  assert.equal(out.sent.size, 0); assert.equal(out.job.status, 'failed')
  assert.match(out.job.detail, /PRESET_NO_PROGRESS/)
})

test('ticking page content cannot keep the preset stalled indefinitely', async () => {
  // 无关文案（时间戳/活跃度）每次渲染都变。旧实现把整页 items 哈希进签名，停滞计数
  // 会被这些噪声不断清零；现在页面身份只看 URL/文档/前景，业务状态没变就应该停止。
  let tick = 0
  const out = await greetingFixture('liepin', { limit: 1, ambiguousPosition: true,
    model: () => [{ name: 'browser_snapshot', args: { tabId: 1 } }],
    mutatePage: page => { page.items.push({ ref: 'tick', role: 'status', name: `刚刚活跃 ${++tick}` }) } })
  assert.equal(out.sent.size, 0); assert.equal(out.job.status, 'failed')
  assert.match(out.job.detail, /PRESET_NO_PROGRESS/)
})

test('an explicit conflicting business job ID is never degraded into a name-only pass', async () => {
  const hide = page => { page.url += '?jobId=456' }
  const out = await greetingFixture('liepin', { limit: 1, noJobQuery: true, mutatePage: hide,
    model: () => [{ name: 'browser_snapshot', args: { tabId: 1 } }] })
  assert.equal(out.sent.size, 0); assert.equal(out.job.status, 'failed')
  assert.match(out.job.detail, /POSITION_EVIDENCE_INVALID|PRESET_NO_PROGRESS/)
})

test('one AI interaction handles an unfamiliar foreground then presets complete the batch', async () => {
  const out = await greetingFixture('liepin', { modal: true, model: (request, page) => {
    assert.match(JSON.stringify(request.messages), /平台通知/)
    return [{ name: 'browser_click', args: { tabId: 1, snapshotId: page.snapshotId, ref: 'dismiss', purpose: 'navigation' } }]
  } })
  assert.equal(out.job.status, 'completed'); assert.equal(out.sent.size, 2)
  // 回归：快照带 frameId=0，但 browser_click/hover/scroll 的 schema 不声明它，
  // 携带会被 additionalProperties:false 拒绝（真实事故：首屏后第一次点击必失败）。
  const located = out.calls.filter(call => ['browser_click', 'browser_hover', 'browser_scroll'].includes(call.name))
  assert.ok(located.length > 0)
  assert.ok(located.every(call => call.args.frameId === undefined))
  assert.equal(out.modelRequests.length, 1); assert.equal(out.fallbacks.length, 1)
})

test('uncertain greeting dispatch stops without AI, retry or a second recipient', async () => {
  const out = await greetingFixture('boss', { writeError: 'TOOL_CALL_OUTCOME_UNKNOWN' })
  assert.equal(out.job.status, 'unknown'); assert.equal(out.fallbacks.length, 0)
  assert.equal(out.calls.filter(call => call.name === 'browser_click').length, 1)
  assert.equal(out.job.results.length, 1)
})

test('unknown import outcome keeps the existing stop boundary and never hands off to AI', async () => {
  const out = await resumeFixture('liepin', { importError: 'UPLOAD_OUTCOME_UNKNOWN' })
  assert.match(String(out.error), /OUTCOME_UNKNOWN/); assert.equal(out.job.status, 'unknown')
  assert.equal(out.imports, 1); assert.equal(out.modelCalls, 0)
})

test('an ordinary attachment failure reaches AI as a correlated error without a blind retry', async () => {
  const out = await resumeFixture('liepin', { importError: 'FILE_RESPONSE_NOT_ATTACHMENT', onFallback: input => {
    const failure = input.initialToolResults.find(seed => seed.name === 'task_import_attachment' && seed.isError)
    assert.match(failure.value.error.message, /FILE_RESPONSE_NOT_ATTACHMENT/)
    assert.equal(input.goal.presetProgress.current.name, people[0])
  } })
  assert.equal(out.imports, 1); assert.equal(out.modelCalls, 1)
})

test('click completion does not need a result control or treat unrelated completed controls as delivery confirmation', async () => {
  const out = await greetingFixture('liepin', { limit: 1, mutatePage: (page, sent) => {
    if (sent.size) page.items = page.items.filter(item => item.ref !== 'greet-0')
    page.items.find(item => item.ref === 'greet-1').name = '已沟通'
  } })
  assert.equal(out.job.results[0].stage, 'succeeded'); assert.equal(out.sent.size, 1)
  assert.ok(out.job.results[0].clickedAt); assert.equal(out.job.results[0].confirmedAt, undefined)
  assert.equal(out.fallbacks.length, 0)
})

test('after a click a paid foreground does not cause another preset submission or claim message delivery', async () => {
  const out = await greetingFixture('boss', { limit: 2, mutatePage: (page, sent) => {
    if (!sent.size) return
    page.dialogs = [{ ref: 'paid', name: '超级聊聊', text: '消耗一次权益后发送', closeRef: 'cancel' }]
    page.items.push({ ref: 'misleading-status', role: 'status', name: '发送成功' })
  } })
  assert.equal(out.job.results[0].stage, 'succeeded'); assert.ok(out.job.results[0].clickedAt)
  assert.equal(out.job.results[0].confirmedAt, undefined)
  assert.equal(out.calls.filter(call => call.name === 'browser_click').length, 1)
  assert.equal(out.fallbacks.length, 1)
})

test('liepin continues immediately after click receipts even when button labels have not updated', async () => {
  const out = await greetingFixture('liepin', { mutatePage: observed => {
    for (const item of observed.items) if (/^greet-/.test(item.ref)) item.name = '立即沟通'
  } })
  assert.equal(out.job.status, 'completed')
  assert.equal(out.sent.size, 2)
  assert.equal(out.fallbacks.length, 0)
  assert.equal(out.calls.filter(call => call.name === 'browser_click').length, 2)
  assert.ok(out.job.results.every(row => row.clickedAt && !row.confirmedAt))
})

test('liepin never clicks continue-communication controls', async () => {
  const out = await greetingFixture('liepin', { limit: 1, mutatePage: observed => {
    observed.items.find(item => item.ref === 'greet-0').name = '继续沟通'
  } })
  assert.equal(out.job.status, 'completed')
  assert.deepEqual([...out.sent], [1])
})

test('distinct same-name identities are handed to AI instead of selecting a recipient by name', async () => {
  const out = await greetingFixture('liepin', { mutatePage: page => {
    for (const item of page.items) {
      item.name = item.name.replace(people[1], people[0])
      if (item.context) item.context.text = item.context.text.replace(people[1], people[0])
    }
  } })
  assert.equal(out.sent.size, 0); assert.equal(out.job.results.length, 0); assert.equal(out.fallbacks.length, 1)
})

test('a bare semantic greeting control is inspected once to recover its own card identity', async () => {
  const out = await greetingFixture('liepin', { missingContext: true, mutatePage: page => {
    page.items = page.items.filter(item => !item.ref.startsWith('card-'))
    for (const item of page.items) delete item.bounds
  } })
  assert.equal(out.job.status, 'completed'); assert.equal(out.fallbacks.length, 0)
  assert.ok(out.calls.some(call => call.name === 'browser_inspect_element' && call.args.ref === 'greet-0'))
})

test('an unchanged completion label does not require model verification after a successful click', async () => {
  const out = await greetingFixture('liepin', { limit: 1, mutatePage: (page, sent) => {
    if (sent.size) page.items.find(item => item.ref === 'greet-0').name = '打招呼'
  } })
  assert.equal(out.job.status, 'completed'); assert.equal(out.job.results[0].confirmedAt, undefined)
  assert.ok(out.job.results[0].clickedAt); assert.equal(out.fallbacks.length, 0)
  assert.equal(out.calls.filter(call => call.name === 'browser_click').length, 1)
})

test('a sparse semantic resume list uses a fresh DOM observation without paying for a model turn', async () => {
  const out = await resumeFixture('liepin', { sparseSemantic: true })
  assert.equal(out.error, undefined); assert.equal(out.job.status, 'completed'); assert.equal(out.modelCalls, 0)
  assert.equal(out.imports, 2)
  assert.ok(out.calls.some(call => call.name === 'browser_snapshot' && call.args.format === 'dom'))
})

test('the preset deadline bounds an uncooperative tool without requesting AI or another input', async () => {
  let dispatched = 0
  const job = baseJob('greeting', 'liepin', 1)
  const page = { tabId: 1, snapshotId: 'budget', url: greetingUrl('liepin'), items: [
    { ref: 'target', role: 'button', name: '立即沟通', context: { text: body(0) } },
  ] }
  await assert.rejects(runRecruitmentAgent({ system: 'test', goal: {}, signal: new AbortController().signal, maxDurationMs: 20,
    tools: [{ name: 'task_select_candidate', inputSchema: {}, readOnly: false, execute: async () => { dispatched++; return new Promise(() => {}) } }],
  }, { job, broker: { currentPage: () => page }, current: () => undefined,
    agent: () => { assert.fail('deadline cannot fall through to AI') } }), /DURATION_BUDGET/)
  assert.equal(dispatched, 1)
})

test('cancellation before preset startup performs no input and does not initialize the model', async () => {
  const abort = new AbortController(); abort.abort()
  const out = await greetingFixture('boss', { signal: abort.signal })
  assert.equal(out.sent.size, 0); assert.equal(out.job.status, 'stopped'); assert.equal(out.fallbacks.length, 0)
})

test('AI imports a renamed attachment once, then the preset returns to the list and imports the next person', async () => {
  const out = await resumeFixture('boss', { unknownDownload: true, model: (request, page) => {
    assert.match(JSON.stringify(request.messages), /取回文件/)
    return [{ name: 'task_import_attachment', args: { tabId: 1, snapshotId: page.snapshotId, ref: 'attachment' } }]
  } })
  assert.equal(out.error, undefined); assert.equal(out.job.status, 'completed'); assert.equal(out.imports, 2)
  assert.equal(out.modelTurns, 1)
  assert.equal(out.calls.filter(call => call.name === 'browser_navigate').length, 1)
})

test('a historical greeting is skipped by the original hook and the preset continues to the next recipient', async () => {
  const prior = await greetingFixture('liepin', { limit: 1 })
  const out = await greetingFixture('liepin', { limit: 1, priorJobs: [{ ...prior.job, id: 'previous-greeting' }] })
  assert.equal(out.job.status, 'completed'); assert.equal(out.fallbacks.length, 0)
  assert.deepEqual([...out.sent], [1]); assert.equal(out.job.results[0].name, people[1])
})

test('a historical resume is skipped without another import or a model round', async () => {
  const prior = await resumeFixture('boss', { limit: 1 })
  const out = await resumeFixture('boss', { limit: 1, priorJobs: [{ ...prior.job, id: 'previous-import' }] })
  assert.equal(out.error, undefined); assert.equal(out.job.status, 'completed'); assert.equal(out.modelCalls, 0)
  assert.equal(out.imports, 1); assert.equal(out.job.results[0].name, people[1])
})

test('Liepin online labels and nested card fragments keep the actual recipient and execute without AI', async () => {
  const out = await greetingFixture('liepin', { people: ['林甲', '周乙'], onlinePrefix: true,
    noJobQuery: true, semanticPositionWithoutId: true, mutatePage: page => {
      for (let index = 0; index < 2; index++) {
        const card = page.items.find(item => item.ref === `card-${index}`)
        card.role = 'div'
        page.items.push({ ref: `inner-${index}`, role: 'div', parentRef: card.ref,
          name: card.name.replace(/^在线 /, '') + ' 期望：研发工程师',
          bounds: { x: 20, y: index * 160 + 5, width: 180, height: 110 } })
      }
    } })
  assert.equal(out.job.status, 'completed'); assert.equal(out.fallbacks.length, 0)
  assert.deepEqual(out.job.results.map(row => row.name), ['林甲', '周乙'])
  // 语义观察没有平台职位 ID 可对照：按「唯一同名 + 唯一选中」降级通过并留痕，
  // 不再为补一个 ID 多付一次 DOM 快照。
  assert.ok(out.logs.some(row => row.event === 'recruitment.position_evidence' && row.level === 'degraded'))
})

test('missing platform tab and the first loading observation do not cost model turns', async () => {
  const out = await greetingFixture('liepin', { noPreferredTab: true, tabs: [], loadingSnapshots: 2 })
  assert.equal(out.job.status, 'completed'); assert.equal(out.fallbacks.length, 0)
  assert.equal(out.calls.filter(call => call.name === 'browser_open_tab').length, 1)
  assert.ok(out.calls.some(call => call.name === 'browser_wait'))
})

test('multiple platform tabs use the uniquely matching task page without AI or opening a duplicate', async () => {
  const out = await greetingFixture('liepin', { noPreferredTab: true, tabs: [
    { tabId: 2, url: resumeUrl('liepin') }, { tabId: 1, url: greetingUrl('liepin') },
  ] })
  assert.equal(out.job.status, 'completed'); assert.equal(out.fallbacks.length, 0)
  assert.equal(out.calls.filter(call => call.name === 'browser_open_tab').length, 0)
})

test('separate same-name cards are ambiguous even when age and metadata are identical', async () => {
  const out = await greetingFixture('liepin', { people: ['林甲', '林甲'], mutatePage: page => {
    for (const item of page.items) {
      item.name = item.name.replace('31岁', '30岁')
      if (item.context) item.context.text = item.context.text.replace('31岁', '30岁')
    }
  } })
  assert.equal(out.sent.size, 0); assert.equal(out.fallbacks.length, 1)
  assert.ok(out.logs.some(row => row.event === 'recruitment.preset_paused' && row.reason === 'candidate_ambiguous'))
})

test('an off-screen card is scrolled into view before selection and sending', async () => {
  let scrolled = false
  const out = await greetingFixture('liepin', { onScroll: () => { scrolled = true }, mutatePage: page => {
    page.viewport = { width: 600, height: 320 }
    if (!scrolled) for (const item of page.items) if (['card-1', 'greet-1'].includes(item.ref)) item.bounds.y += 500
  } })
  assert.equal(out.job.status, 'completed'); assert.equal(out.fallbacks.length, 0)
  const scroll = out.calls.findIndex(call => call.name === 'browser_scroll')
  const secondWrite = out.calls.findIndex(call => call.name === 'browser_click' && call.args.ref === 'greet-1')
  assert.ok(scroll >= 0 && scroll < secondWrite)
})

test('a blank page has five bounded readiness waits then logs why AI is needed', async () => {
  const out = await greetingFixture('liepin', { noPreferredTab: true, tabs: [], loadingSnapshots: 100 })
  assert.equal(out.sent.size, 0); assert.equal(out.fallbacks.length, 1)
  assert.equal(out.calls.filter(call => call.name === 'browser_open_tab').length, 1)
  assert.equal(out.calls.filter(call => call.name === 'browser_wait').length, 5)
  assert.ok(out.logs.some(row => row.event === 'recruitment.preset_paused' && row.reason === 'page_loading'))
  // 回归：browser_wait 在网关里是只读能力，不接受 purpose；传了会被 schema 拒绝，
  // 预设随即以 tool_failed 交棒，导致每次新开标签页首屏都进不了预设。
  assert.ok(!out.logs.some(row => row.event === 'recruitment.preset_paused' && row.errorCode === 'BROWSER_ARGUMENT_INVALID'))
  assert.ok(!out.logs.some(row => row.event === 'recruitment.preset_paused' && row.failedTool === 'browser_wait'))
})

test('multiple matching tabs without an active or preferred one are not arbitrarily replaced', async () => {
  const out = await greetingFixture('liepin', { noPreferredTab: true, tabs: [
    { tabId: 2, url: greetingUrl('liepin') }, { tabId: 3, url: greetingUrl('liepin') },
    { tabId: 4, url: resumeUrl('liepin'), active: true },
  ] })
  assert.equal(out.sent.size, 0)
  assert.ok(!out.calls.some(call => ['browser_open_tab', 'browser_navigate'].includes(call.name)))
  assert.ok(out.logs.some(row => row.event === 'recruitment.preset_paused' && row.reason === 'platform_tabs_ambiguous'))
})


test('a unique named position needs no platform mapping or DOM job ID for preset switching', async () => {
  for (const platform of ['liepin', 'boss']) {
    const out = await greetingFixture(platform, { limit: 1, switchPosition: true, noJobQuery: true, platformJobs: [],
      mutatePage: page => { for (const item of page.items) if (['position', 'choose-position'].includes(item.ref)) item.elementId = 'random-widget-456' } })
    assert.equal(out.job.status, 'completed', out.job.detail)
    assert.equal(out.fallbacks.length, 0)
    assert.ok(out.calls.some(call => call.name === 'browser_click' && call.args.ref === 'choose-position'))
  }
})
