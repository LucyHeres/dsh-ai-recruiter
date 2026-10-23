import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSourcingSession } from '../dist/lib/sourcing/session.js'
import { Store, hash } from '../dist/lib/store.js'
import { normalized } from '../dist/lib/page-actions.js'
import { PNG } from 'pngjs'

const entry = 'https://www.zhipin.com/web/chat/recommend'
const frameEntry = 'https://www.zhipin.com/web/frame/recommend/?jobid=job123'
const props = { tabId: { type: 'integer' }, snapshotId: { type: 'string' }, ref: { type: 'string' } }
const info = (name, readOnly, properties, required = []) => ({ name,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly }, _meta: { browserAgent: { available: true } } })
const observe = { type: 'object', properties: { wait: { enum: ['none', 'dom_quiet'] },
  returnSnapshot: { enum: ['none', 'viewport', 'full'] }, timeoutMs: { type: 'integer' }, requireChange: { type: 'boolean' } } }
const infos = [info('browser_list_tabs', true, {}),
  info('browser_list_frames', true, { tabId: props.tabId }, ['tabId']),
  info('browser_snapshot', true, { tabId: props.tabId, frameId: { type: 'integer' }, format: { enum: ['dom', 'semantic'] }, viewportOnly: { type: 'boolean' } }, ['tabId']),
  info('browser_navigate', false, { tabId: props.tabId, url: { type: 'string' } }, ['tabId', 'url']),
  info('browser_click', false, { ...props, observe }, ['tabId', 'snapshotId', 'ref']),
  info('browser_scroll', false, { ...props, deltaY: { type: 'number' } }, ['tabId']),
  info('browser_inspect_element', true, props, ['tabId', 'snapshotId', 'ref'])]

async function fixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'boss-fixed-route-'))
  const store = new Store(dir, 'test'); await store.init()
  let revision = 0, detail = false, returned = false, selected = options.selected !== false
  let stale = !!options.staleCanvas, canvasFailure = false
  let frameMode = false, frameNavigations = 0
  let frameReads = 0, frameJobId = options.frameJobId ?? 'job123', positionMenu = !!options.menuInitiallyOpen
  let visualMode = false, canvasY = 0, transcriptions = 0, contactMade = false
  const images = new Map(), messages = []
  let navigationCalls = 0, assessments = 0, greetings = 0, snapshots = 0, scrolls = 0
  const inputs = [], routes = []
  const text = '12-20K 张先生 30岁 6年经验 本科 Java开发 期望 上海 Java工程师 优势 熟悉订单、支付和履约系统。 2018.07 2022.06 甲公司 Java开发 负责订单服务；2022.07 至今 乙公司 高级Java开发 负责支付系统与数据库优化。 2014 2018 某大学 计算机科学与技术 本科'
  const full = '张先生 Java开发 6年工作经验 工作经历：在甲公司负责Java订单服务的设计、开发和上线。项目经历：参与支付系统，负责数据库优化、服务接口实现、故障分析与持续交付，推动核心服务稳定运行并完成跨团队需求联调。'
  const shellItems = [
    { ref: 'shell-message', role: 'link', name: '消息', bounds: { x: 10, y: 80, width: 60, height: 30 } },
    { ref: 'shell-recommend', role: 'link', name: '推荐', bounds: { x: 10, y: 120, width: 60, height: 30 } },
    { ref: 'shell-jobs', role: 'button', name: '职位管理', bounds: { x: 10, y: 160, width: 80, height: 30 } },
  ]
  const documentTitle = options.titleName ?? 'Java工程师 _ 上海 13-20K'
  // 真实 BOSS 卡片：招呼按钮在卡片容器之外，按钮 context 含全卡原文；快照把长卡片根文本截断。
  const truncated = options.truncatedRoot
  const cardItems = [
    { ref: 'card', role: truncated ? 'div' : 'article', name: truncated ? text.slice(0, 24) : text, bounds: { x: 100, y: 150, width: 650, height: 200 } },
    ...(options.missingName ? [] : [{ ref: 'name', role: truncated ? 'div' : 'link', name: '张先生', parentRef: 'card',
      ...(truncated ? {} : { href: 'https://www.zhipin.com/web/geek/resume?geekId=observed123' }),
      ...(truncated ? {} : { context: { text } }), bounds: { x: 120, y: 170, width: 70, height: 30 } }]),
    { ref: 'greet', role: 'button', name: '立即沟通', ...(truncated ? {} : { parentRef: 'card' }),
      context: { text: truncated ? `${text} 立即沟通` : text }, bounds: { x: 500, y: 200, width: 100, height: 30 } },
  ]
  const listItems = () => !options.changingGreetingState ? cardItems : cardItems.map(item => item.ref === 'greet'
    ? { ...item, name: contactMade ? '继续沟通' : '打招呼', context: { text: `${text} ${contactMade ? '继续沟通' : '打招呼'}` } } : item)
  const documentItems = () => [
    { ref: 'job-title', role: 'div', name: documentTitle, bounds: { x: 900, y: 12, width: 280, height: 36 } },
    { ref: 'job-title-inner', role: 'div', name: documentTitle, parentRef: 'job-title', bounds: { x: 901, y: 13, width: 278, height: 34 } },
    ...listItems(),
  ]
  const page = () => {
    if ((stale || options.canvas && detail) && visualMode) return { tabId: 1, frameId: 2, frameInteraction: 'same-origin',
      snapshotId: `s${revision}`, documentId: stale ? 'old-resume-canvas' : 'boss-resume-canvas',
      url: options.outerUrl ? entry : 'https://www.zhipin.com/web/frame/c-resume/?source=recommend',
      ...(options.outerUrl ? { frameUrl: 'https://www.zhipin.com/web/frame/c-resume/?source=recommend' } : {}),
      format: 'dom', viewport: { width: 774, height: 1600 }, dialogs: [],
      items: [{ ref: 'canvas', role: 'canvas', tagName: 'canvas', name: '', bounds: { x: 0, y: canvasY, width: 774, height: 800 } }] }
    const shell = options.frame && !frameMode
    const document = options.document && frameMode
    return { tabId: 1, snapshotId: `s${revision}`, documentId: frameMode ? 'boss-frame-document' : 'boss-document', format: 'dom',
    url: frameMode && !options.outerUrl ? `https://www.zhipin.com/web/frame/recommend/?jobid=${frameJobId}` : entry,
    ...(frameMode && options.outerUrl ? { frameUrl: `https://www.zhipin.com/web/frame/recommend/?jobid=${frameJobId}` } : {}),
    frameId: frameMode ? 1 : 0, ...(frameMode ? { tabUrl: entry, frameInteraction: options.legacyFrame ? undefined : 'same-origin' } : {}),
    viewport: { width: 1440, height: 800, scrollY: 0 }, selectedTabs: shell || document ? [] : selected ? [{ name: 'Java工程师', elementId: options.dynamicId === undefined ? 'job-job123' : options.dynamicId }] : [],
    dialogs: !shell && detail && !options.canvas ? [{ ref: 'resume', text: full, closeRef: 'close' }] : !shell && options.unexpected ? [{ ref: 'unexpected', text: '新的业务提示，请理解后处理' }] : [],
    items: shell ? shellItems : detail && options.canvas ? [...listItems(), { ref: 'visual-close', role: 'div', tagName: 'div', name: '', bounds: { x: 1400, y: 6, width: 24, height: 24 } }]
      : detail ? [{ ref: 'resume', role: 'dialog', name: full, dialogRef: 'resume' },
      { ref: 'close', role: 'button', name: '关闭', dialogRef: 'resume' }]
      : document ? [...documentItems().map(item => {
        if (!['job-title', 'job-title-inner'].includes(item.ref)) return item
        const title = frameJobId !== 'job123' ? '产品经理 _ 上海 13-20K' : item.name
        return { ...item, name: options.realMenu && positionMenu && item.ref === 'job-title' ? `${title} ${title} Java工程师 _ 上海 13-20K 调整顺序` : title,
          ...(returned && options.returnedTitleState ? { states: [options.returnedTitleState] } : {}) }
      }), ...(positionMenu ? options.realMenu ? [
        { ref: 'job-list', role: 'ul', name: 'Java工程师 _ 上海 13-20K', parentRef: 'job-title', bounds: { x: 880, y: 80, width: 280, height: 88 } },
        { ref: 'position', role: 'li', name: `${options.missingTarget ? '其他职位' : 'Java工程师'} _ 上海 13-20K`, parentRef: 'job-list', bounds: { x: 880, y: 80, width: 280, height: 44 } },
        { ref: 'position-inner', role: 'span', name: 'Java工程师 _ 上海 13-20K', parentRef: 'position' },
      ] : [{ ref: 'position', role: 'option', name: 'Java工程师', elementId: 'job-job123' }] : []),
        ...(scrolls && options.exhaustAfterDiscard ? [{ ref: 'end', role: 'div', name: '没有更多', bounds: { x: 100, y: 600, width: 100, height: 30 } }] : [])]
      : [{ ref: 'position', role: 'tab', name: 'Java工程师', elementId: options.dynamicId === undefined ? 'job-job123' : options.dynamicId, states: selected ? ['selected'] : [] },
        ...(options.duplicatePosition ? [{ ref: 'position2', role: 'tab', name: 'Java工程师', elementId: 'job-other456', states: [] }] : []),
        ...listItems()],
    ...(stale && !shell ? { items: [...(document ? documentItems() : listItems()),
      { ref: 'stale-close', role: 'div', tagName: 'div', name: '', bounds: { x: 1400, y: 6, width: 24, height: 24 } }] } : {}),
  } }
  const call = async (name, args) => {
    if (name === 'browser_list_tabs') return { tabs: [{ tabId: 1, url: entry }] }
    if (name === 'browser_list_frames') {
      if (stale) return { frames: [{ frameId: 0, documentId: `${entry}:111.222` },
        ...(options.frame ? [{ frameId: 1, documentId: `${frameEntry}:333.444` }] : []),
        { frameId: 2, documentId: 'https://www.zhipin.com/web/frame/c-resume/?source=recommend:old.1' }] }
      if (options.canvas && detail) return { frames: [{ frameId: 2, documentId: 'https://www.zhipin.com/web/frame/c-resume/?source=recommend:123.4' }] }
      if (options.frame && !frameMode) {
        const observed = options.frameJobId ? `https://www.zhipin.com/web/frame/recommend/?jobid=${options.frameJobId}` : frameEntry
        return { frames: [{ frameId: 0, documentId: `${entry}:111.222` }, { frameId: 1, documentId: `${observed}:333.444` }] }
      }
      return { frames: [{ frameId: 0, documentId: `${frameMode ? frameEntry : entry}:555.666` }] }
    }
    if (name === 'browser_navigate') {
      frameNavigations++
      assert.fail(`BOSS must keep its recommendation document embedded, received navigation: ${args.url}`)
    }
    if (name === 'browser_snapshot') {
      snapshots++; revision++
      visualMode = args.frameId === 2
      if (visualMode) {
        if (options.recoverCanvas && !stale && !canvasFailure) { canvasFailure = true; throw Error('PAGE_CHANGED') }
        return page()
      }
      if (args.frameId === 1) { frameReads++; frameMode = true }
      else { assert.equal(frameMode, false, 'refresh must retain the selected iframe') }
      if (options.truncatedClose && detail && !args.viewportOnly) return { ...page(), items: listItems(), truncated: true,
        coverage: { totalItems: 1268, returnedItems: 850, omittedItems: 418, nextOffset: 850 } }
      return page()
    }
    if (name === 'browser_capture_content') {
      assert.equal(stale, false, 'a previous task resume must never enter OCR or assessment')
      const captureId = 'image-' + images.size, png = new PNG({ width: 2, height: 1 })
      png.data.set([0, 0, 0, 0, Math.floor(canvasY / 256), canvasY % 256, 10, 255])
      const data = PNG.sync.write(png)
      images.set(captureId, data)
      return { captureId, mimeType: 'image/png', size: data.length }
    }
    if (name === 'artifact_read') {
      const data = images.get(args.captureId)
      return { captureId: args.captureId, offset: 0, totalSize: data.length, size: data.length, base64: data.toString('base64'), mimeType: 'image/png', fileName: 'capture.png', eof: true }
    }
    assert.equal(args.snapshotId, page().snapshotId)
    if (name === 'browser_inspect_element') return { item: page().items.find(item => item.ref === args.ref),
      element: { ref: args.ref, visible: true, attributes: { class: args.ref === 'card' ? 'card-inner' : args.ref === 'visual-close' || args.ref === 'stale-close' && !options.unverifiedStaleClose ? 'close-btn' : '' } },
      ancestors: args.ref === 'name' ? [{ ref: 'card', tagName: 'div', attributes: { class: 'card-inner' } }]
        : args.ref === 'card' ? [{ tagName: 'div', attributes: { class: 'candidate-card-wrap' } }]
        : ['visual-close', 'stale-close'].includes(args.ref) ? [{ tagName: 'div', attributes: { class: 'lib-standard-resume' } }] : [] }
    inputs.push({ name, ref: args.ref })
    if (name === 'browser_scroll') {
      if (visualMode) canvasY = Math.max(0, Math.min(800, canvasY + args.deltaY))
      else scrolls++
      revision++; return { dispatched: true, snapshot: page() }
    }
    assert.equal(name, 'browser_click')
    if (args.ref === 'job-title' || args.ref === 'job-title-inner') positionMenu = !positionMenu
    if (args.ref === 'position' && !options.selectionNoChange) { selected = true; positionMenu = false; frameJobId = 'job123' }
    if (args.ref === 'card') {
      assert.equal(stale, false, 'close the old resume before opening a newly selected candidate')
      if (options.unknownOpen) throw Error('TOOL_CALL_OUTCOME_UNKNOWN')
      if (!options.noDetailOpen) detail = true
    }
    if (args.ref === 'stale-close') {
      if (options.unknownStaleClose) throw Error('TOOL_CALL_OUTCOME_UNKNOWN')
      if (!options.staleCloseNoChange) stale = false
    }
    if (args.ref === 'close' || args.ref === 'visual-close') { detail = false; returned = true }
    if (args.ref === 'greet') {
      assert.equal(options.autoGreet, true)
      assert.equal(args.policy.riskLevel, 'business_write')
      greetings++
      contactMade = true
    }
    revision++; return { output: { dispatched: true, changed: true }, snapshot: page() }
  }
  const job = { id: 'boss-fixed-route', kind: 'talent_sourcing', jobId: 'host-job', jobName: 'Java工程师', platform: 'boss', platforms: ['boss'],
    sourceMode: 'recommend', searchFilters: options.filterReject ? { experience: '1–3年' } : {}, minimumScore: 60, limit: options.limit ?? 1, limitScope: 'per_platform',
    supplement: '', autoGreet: !!options.autoGreet, position: { id: 'host-job', name: 'Java工程师', description: 'Java开发' },
    platformJobs: { boss: [{ id: 'job123', name: 'Java工程师' }] },
    requirements: { keyword: 'Java', listCriteria: [{ field: 'education', requirement: '本科', quote: '本科' }], criteria: [{ id: 'java', label: 'Java开发', quote: 'Java开发', must: true, weight: 100 }] },
    candidates: [], results: [], greetings: [], channels: [{ platform: 'boss', status: 'running', detail: '' }], events: [] }
  const agent = async opts => {
    if (opts.inputImages?.length) {
      transcriptions++
      await opts.tools[0].execute({ candidateName: options.wrongImageName ? '其他人' : '张先生', text: full.replace('工作经历', '工作履历'), complete: !options.unreadableImages }, opts.signal)
      return { status: 'completed', message: 'transcribed', turns: 1, modelMs: 0, toolMs: 0 }
    }
    if (opts.tools[0]?.name !== 'sourcing_submit_assessments') {
      navigationCalls++; assert.equal(opts.maxTurns, 8)
      if (options.recoverCanvas) {
        await opts.tools.find(tool => tool.name === 'browser_snapshot').execute({ tabId: 1, frameId: 2, format: 'dom', viewportOnly: false }, opts.signal)
        if (options.recoverySkip) await opts.tools.find(tool => tool.name === 'sourcing_skip_candidate').execute({ reason: '详情暂不可读，跳过本次人选' }, opts.signal)
        if (options.recoveryClose) {
          await opts.tools.find(tool => tool.name === 'browser_snapshot').execute({ tabId: 1, frameId: options.frame ? 1 : 0, format: 'dom', viewportOnly: true }, opts.signal)
          await opts.tools.find(tool => tool.name === 'browser_inspect_element').execute({ tabId: 1, snapshotId: page().snapshotId, ref: 'visual-close' }, opts.signal)
          await opts.tools.find(tool => tool.name === 'browser_click').execute({ tabId: 1, snapshotId: page().snapshotId, ref: 'visual-close', purpose: 'navigation' }, opts.signal)
        }
        await opts.beforeTurn(opts.signal)
        return { status: opts.isComplete() ? 'completed' : 'stopped', message: 'recovered Canvas', turns: 1, modelMs: 0, toolMs: 0 }
      }
      return { status: 'stopped', message: 'unknown BOSS structure', turns: 1, modelMs: 0, toolMs: 0 }
    }
    assessments++
    assert.equal(opts.modelPurpose, 'assessment')
    assert.equal(opts.tools.length, 1)
    await opts.tools[0].execute({ candidates: opts.goal.candidates.map(source => ({ sourceId: source.sourceId,
      ...(opts.goal.mode === 'detail' ? { fields: [] } : {}),
        ...(opts.goal.mode === 'preview' ? { listAssessments: opts.goal.listCriteria.map(c => ({ field: c.field, state: 'match', evidenceId: 0, reason: '原文证据' })) } : {}),
      ...(opts.goal.mode === 'detail' ? { assessments: [{ criterionId: 'java', state: 'match', evidenceId: 0, reason: '原文明确Java职责' }],
        ...(options.filterReject ? { filterAssessments: [{ field: 'experience', state: 'mismatch', evidenceId: 0, reason: '6年经验超出1–3年范围' }] } : {}) } : {}) })) }, opts.signal)
    return { status: 'completed', message: 'assessed', turns: 1, modelMs: 0, toolMs: 0 }
  }
  try {
    const previous = new Set(options.legacyContactState ? [hash({ platform: 'boss', identity: normalized(`${text} ${options.legacyContactState}`) })] : [])
    const session = await createSourcingSession({ job, channel: job.channels[0], quota: job.limit, before: 0, previous, store,
      signal: new AbortController().signal, agent, call, listTools: async () => infos, save: async () => {}, progress: async (_job, _phase, message) => {
        messages.push(message)
        if (options.externalCloseAfterDiscard && /未保存本次人选/.test(message)) { detail = false; returned = true }
      },
      logger: { write: (_level, event, fields) => { if (event.startsWith('sourcing.fast_')) routes.push({ event, ...fields }) } } })
    const result = await session.run().catch(error => {
      if (!options.allowFailure) throw error
      return { status: 'failed', message: error.message }
    })
    return { result, job, inputs, routes, navigationCalls, assessments, greetings, snapshots, scrolls, frameNavigations, frameMode, frameReads, transcriptions, messages }
  } finally { await rm(dir, { recursive: true, force: true }) }
}

test('BOSS preflights the list, opens the real resume and saves only detail text as online evidence', async () => {
  const f = await fixture({ selected: false })
  assert.equal(f.result.status, 'completed', JSON.stringify({ message: f.result.message, routes: f.routes, inputs: f.inputs }))
  assert.equal(f.navigationCalls, 0)
  assert.equal(f.assessments, 2)
  assert.deepEqual(f.inputs.map(input => input.ref), ['position', 'card'])
  assert.equal(f.job.candidates.length, 1)
  assert.equal(f.job.candidates[0].scope, 'online')
  assert.match(f.job.candidates[0].resumeText, /工作经历/)
  assert.equal(f.greetings, 0)
  assert.ok(f.messages.some(message => /列表初筛：候选人\[张先生\]/.test(message)))
  assert.ok(f.messages.some(message => /候选人\[张先生\]列表初筛通过/.test(message)))
  assert.ok(f.messages.some(message => /候选人\[张先生\]已读取简历详情.*正在分析匹配度/.test(message)))
  assert.ok(!f.messages.some(message => /已读取当前候选人/.test(message)))
  assert.equal(f.routes.find(route => route.event === 'sourcing.fast_execution_finished').navigationTurns, 0)
})

test('BOSS Canvas detail is read through the end, transcribed once, verified again and saved as visual online evidence before greeting', async () => {
  const f = await fixture({ canvas: true, autoGreet: true })
  assert.equal(f.result.status, 'completed', JSON.stringify(f.routes))
  assert.equal(f.transcriptions, 1)
  assert.equal(f.job.candidates[0].scope, 'online')
  assert.equal(f.job.candidates[0].resumeEvidence.kind, 'visual')
  assert.equal(f.job.candidates[0].resumeEvidence.pages, 3)
  assert.equal(f.job.candidates[0].resumeEvidence.imageHashes.length, 3)
  assert.deepEqual(f.inputs.filter(input => input.name === 'browser_click').map(input => input.ref), ['card', 'visual-close', 'greet'])
  assert.ok(f.messages.some(message => /候选人\[张先生\]已读取简历详情.*图片识别/.test(message)))
  assert.ok(f.messages.some(message => /候选人\[张先生\]：正在识别简历图片/.test(message)))
})

test('BOSS greeting state changes do not reopen, rescore or count the same text-identity candidate twice', async () => {
  const f = await fixture({ frame: true, document: true, truncatedRoot: true, canvas: true, autoGreet: true,
    changingGreetingState: true, limit: 2, exhaustAfterDiscard: true })
  assert.equal(f.result.status, 'completed', JSON.stringify({ routes: f.routes, message: f.result.message }))
  assert.equal(f.navigationCalls, 0)
  assert.equal(f.job.candidates.length, 1)
  assert.equal(f.job.channels[0].candidateCount, 1)
  assert.equal(f.job.greetings.length, 1)
  assert.equal(f.greetings, 1)
  assert.equal(f.transcriptions, 1)
  assert.equal(f.assessments, 2)
  assert.equal(f.inputs.filter(input => input.name === 'browser_click' && input.ref === 'card').length, 1)
  assert.ok(f.scrolls > 0, 'continue looking for another person instead of fulfilling the quota with the same card')
})

test('BOSS Canvas snapshot with an outer recommendation URL uses its same-origin frame URL through capture and return', async () => {
  const f = await fixture({ frame: true, document: true, canvas: true, outerUrl: true, autoGreet: true })
  assert.equal(f.result.status, 'completed', JSON.stringify(f.routes))
  assert.equal(f.navigationCalls, 0)
  assert.equal(f.transcriptions, 1)
  assert.equal(f.job.candidates.length, 1)
  assert.equal(f.job.candidates[0].scope, 'online')
  assert.equal(f.job.candidates[0].resumeEvidence.kind, 'visual')
  assert.equal(f.job.candidates[0].resumeEvidence.pages, 3)
  assert.deepEqual(f.inputs.filter(input => input.name === 'browser_click').map(input => input.ref), ['card', 'visual-close', 'greet'])
})

test('BOSS recognizes old saved full-card keys across contact labels before opening a resume', async () => {
  for (const legacyContactState of ['打招呼', '继续沟通']) {
    const f = await fixture({ frame: true, document: true, truncatedRoot: true, canvas: true, autoGreet: true,
      legacyContactState, exhaustAfterDiscard: true })
    assert.equal(f.result.status, 'completed', JSON.stringify(f.routes))
    assert.equal(f.navigationCalls, 0)
    assert.equal(f.job.candidates.length, 0)
    assert.equal(f.greetings, 0)
    assert.equal(f.transcriptions, 0)
    assert.ok(!f.inputs.some(input => input.ref === 'card'))
  }
})

test('BOSS locates the visible close control when a long list truncates it out of the full DOM snapshot', async () => {
  const f = await fixture({ frame: true, document: true, canvas: true, truncatedClose: true, autoGreet: true })
  assert.equal(f.result.status, 'completed', JSON.stringify(f.routes))
  assert.equal(f.navigationCalls, 0)
  assert.equal(f.job.candidates.length, 1)
  assert.deepEqual(f.inputs.filter(input => input.name === 'browser_click').map(input => input.ref), ['card', 'visual-close', 'greet'])
})

test('a BOSS detail closed externally after a rejected candidate releases ownership without another close click', async () => {
  const f = await fixture({ frame: true, document: true, canvas: true, filterReject: true, externalCloseAfterDiscard: true, exhaustAfterDiscard: true })
  assert.equal(f.result.status, 'completed', JSON.stringify(f.routes))
  assert.equal(f.navigationCalls, 0)
  assert.equal(f.job.skippedByFilters, 1)
  assert.equal(f.job.candidates.length, 0)
  assert.deepEqual(f.inputs.filter(input => input.name === 'browser_click').map(input => input.ref), ['card'])
})

test('BOSS rebinds the selected candidate through verified evidence after recovery closed its owned Canvas', async () => {
  const f = await fixture({ frame: true, document: true, canvas: true, recoverCanvas: true, recoveryClose: true, autoGreet: true })
  assert.equal(f.result.status, 'completed', JSON.stringify(f.routes))
  assert.equal(f.navigationCalls, 1)
  assert.equal(f.transcriptions, 1)
  assert.equal(f.job.scanned, 1, 'reopening a verified selection cannot preflight or count it again')
  assert.equal(f.job.candidates.length, 1)
  assert.deepEqual(f.inputs.filter(input => input.name === 'browser_click').map(input => input.ref), ['card', 'visual-close', 'card', 'visual-close', 'greet'])
})

test('an explicit skip followed by external closing of the Canvas cannot leave stale modal ownership', async () => {
  const f = await fixture({ frame: true, document: true, canvas: true, recoverCanvas: true, recoverySkip: true, recoveryClose: true, exhaustAfterDiscard: true })
  assert.equal(f.result.status, 'completed', JSON.stringify(f.routes))
  assert.equal(f.navigationCalls, 1)
  assert.equal(f.transcriptions, 0)
  assert.equal(f.job.candidates.length, 0)
  assert.deepEqual(f.inputs.filter(input => input.name === 'browser_click').map(input => input.ref), ['card', 'visual-close'])
})

test('a new BOSS run closes an inspected leftover Canvas modal before preflight and opens only the new candidate', async () => {
  const f = await fixture({ frame: true, document: true, canvas: true, staleCanvas: true, autoGreet: true })
  assert.equal(f.result.status, 'completed', JSON.stringify(f.routes))
  assert.equal(f.navigationCalls, 0)
  assert.equal(f.transcriptions, 1)
  assert.equal(f.job.candidates.length, 1)
  assert.deepEqual(f.inputs.filter(input => input.name === 'browser_click').map(input => input.ref), ['stale-close', 'card', 'visual-close', 'greet'])
})

test('an unverified leftover close control cannot be clicked or followed by candidate assessment', async () => {
  const f = await fixture({ frame: true, document: true, staleCanvas: true, unverifiedStaleClose: true })
  assert.equal(f.result.status, 'stopped')
  assert.equal(f.assessments, 0)
  assert.deepEqual(f.inputs, [])
})

test('an unknown leftover-close outcome stops after one click without selecting or greeting', async () => {
  const f = await fixture({ frame: true, document: true, staleCanvas: true, unknownStaleClose: true, allowFailure: true, autoGreet: true })
  assert.match(f.result.message, /OUTCOME_UNKNOWN/)
  assert.equal(f.assessments, 0)
  assert.equal(f.navigationCalls, 0)
  assert.deepEqual(f.inputs.map(input => input.ref), ['stale-close'])
})

test('a leftover modal that did not close is observed without replaying its close click', async () => {
  const f = await fixture({ frame: true, document: true, staleCanvas: true, staleCloseNoChange: true })
  assert.equal(f.result.status, 'stopped')
  assert.equal(f.assessments, 0)
  assert.deepEqual(f.inputs.map(input => input.ref), ['stale-close'])
})

test('BOSS resumes its owned Canvas frame after recovery without reselecting or reopening the candidate', async () => {
  const f = await fixture({ canvas: true, recoverCanvas: true, autoGreet: true })
  assert.equal(f.result.status, 'completed', JSON.stringify(f.routes))
  assert.equal(f.transcriptions, 1)
  assert.equal(f.navigationCalls, 1)
  assert.equal(f.job.candidates.length, 1)
  assert.deepEqual(f.inputs.filter(input => input.name === 'browser_click').map(input => input.ref), ['card', 'visual-close', 'greet'])
})

test('an explicit skip during Canvas recovery closes the owned detail before continuing on the list', async () => {
  const f = await fixture({ frame: true, document: true, canvas: true, recoverCanvas: true, recoverySkip: true, exhaustAfterDiscard: true, autoGreet: true })
  assert.equal(f.result.status, 'completed', JSON.stringify(f.routes))
  assert.equal(f.transcriptions, 0)
  assert.equal(f.job.candidates.length, 0)
  assert.equal(f.greetings, 0)
  assert.deepEqual(f.inputs.filter(input => input.name === 'browser_click').map(input => input.ref), ['card', 'visual-close'])
})

test('an incompletely transcribed owned resume is skipped and closed while sourcing continues to observed exhaustion', async () => {
  const f = await fixture({ frame: true, document: true, canvas: true, unreadableImages: true, exhaustAfterDiscard: true, autoGreet: true })
  assert.equal(f.result.status, 'completed', JSON.stringify(f.routes))
  assert.equal(f.job.skippedUnverified, 1)
  assert.equal(f.assessments, 1)
  assert.equal(f.job.candidates.length, 0)
  assert.equal(f.greetings, 0)
  assert.equal(f.navigationCalls, 0)
  assert.deepEqual(f.inputs.filter(input => input.name === 'browser_click').map(input => input.ref), ['card', 'visual-close'])
  assert.ok(f.messages.some(message => /图片未完整识别，已跳过/.test(message)))
})

test('a different name in Canvas detail cannot be saved or greeted', async () => {
  const f = await fixture({ canvas: true, wrongImageName: true, autoGreet: true, allowFailure: true })
  assert.equal(f.job.candidates.length, 0)
  assert.equal(f.greetings, 0)
  assert.equal(f.assessments, 1)
})

test('BOSS reads the embedded recommendation list without navigating its document to the top level', async () => {
  const f = await fixture({ selected: false, frame: true })
  assert.equal(f.result.status, 'completed', f.result.message)
  assert.equal(f.navigationCalls, 0)
  assert.equal(f.frameMode, true)
  assert.equal(f.frameNavigations, 0)
  assert.ok(f.frameReads > 0)
  assert.equal(f.assessments, 2)
  assert.deepEqual(f.inputs.map(input => input.ref), ['position', 'card'])
  assert.equal(f.job.candidates.length, 1)
  assert.equal(f.job.candidates[0].sourceUrl, frameEntry)
})

test('BOSS recommendation document verifies the linked job by URL jobid and title without a selector', async () => {
  const f = await fixture({ frame: true, document: true })
  assert.equal(f.result.status, 'completed', f.result.message)
  assert.equal(f.navigationCalls, 0)
  assert.equal(f.frameMode, true)
  assert.equal(f.frameNavigations, 0)
  assert.deepEqual(f.inputs.map(input => input.ref), ['card'])
  assert.equal(f.job.candidates.length, 1)
  assert.equal(f.job.candidates[0].sourceUrl, frameEntry)
})

test('BOSS associates an outside greeting button with a truncated card root', async () => {
  const f = await fixture({ frame: true, document: true, truncatedRoot: true })
  assert.equal(f.result.status, 'completed', f.result.message)
  assert.equal(f.navigationCalls, 0)
  assert.deepEqual(f.inputs.map(input => input.ref), ['card'])
  assert.equal(f.job.candidates.length, 1)
  assert.equal(f.job.candidates[0].name, '张先生')
})

test('BOSS switches a recommendation frame showing another job to the linked platform job', async () => {
  const f = await fixture({ frame: true, document: true, frameJobId: 'other999' })
  assert.equal(f.result.status, 'completed', f.result.message)
  assert.equal(f.navigationCalls, 0)
  assert.equal(f.frameNavigations, 0)
  assert.deepEqual(f.inputs.map(input => input.ref), ['job-title', 'position', 'card'])
  assert.equal(f.job.candidates.length, 1)
})

test('real BOSS li dropdown with decorated names converges without toggling and verifies the frame URL', async () => {
  for (const menuInitiallyOpen of [false, true]) {
    const f = await fixture({ frame: true, document: true, realMenu: true, outerUrl: true, frameJobId: 'other999', menuInitiallyOpen })
    assert.equal(f.result.status, 'completed', f.result.message)
    assert.equal(f.navigationCalls, 0)
    assert.deepEqual(f.inputs.map(input => input.ref), [...(menuInitiallyOpen ? [] : ['job-title']), 'position', 'card'])
  }
})

test('missing or ineffective BOSS menu choices never toggle the header repeatedly', async () => {
  for (const extra of [{ missingTarget: true }, { selectionNoChange: true }]) {
    const f = await fixture({ frame: true, document: true, realMenu: true, frameJobId: 'other999', ...extra })
    assert.equal(f.result.status, 'stopped')
    assert.equal(f.inputs.filter(input => input.ref === 'job-title').length, 1)
    assert.ok(f.inputs.filter(input => input.ref === 'position').length <= 1)
    assert.equal(f.job.candidates.length, 0)
  }
})

test('BOSS document title alone cannot impersonate the linked job', async () => {
  const f = await fixture({ frame: true, document: true, titleName: 'Java工程师助理 _ 上海 13-20K' })
  assert.equal(f.result.status, 'stopped')
  assert.equal(f.navigationCalls, 1)
  assert.equal(f.greetings, 0)
  assert.equal(f.job.candidates.length, 0)
})

test('BOSS stops on an old extension without navigating or sending a greeting', async () => {
  const f = await fixture({ frame: true, document: true, legacyFrame: true, autoGreet: true, allowFailure: true })
  assert.match(f.result.message, /BOSS_FRAME_INTERACTION_UNSUPPORTED/)
  assert.equal(f.frameNavigations, 0)
  assert.equal(f.navigationCalls, 0)
  assert.equal(f.greetings, 0)
  assert.equal(f.assessments, 0)
  assert.deepEqual(f.inputs, [])
})

test('BOSS authorized greeting accepts the recommendation document position proof', async () => {
  const f = await fixture({ frame: true, document: true, autoGreet: true })
  assert.equal(f.result.status, 'completed', f.result.message)
  assert.equal(f.navigationCalls, 0)
  assert.deepEqual(f.inputs.map(input => input.ref), ['card', 'close', 'greet'])
  assert.equal(f.greetings, 1)
  assert.equal(f.job.greetings[0].stage, 'succeeded')
})

test('BOSS retains readable position evidence after a rejected candidate and continues to observed exhaustion', async () => {
  const f = await fixture({ frame: true, document: true, filterReject: true, exhaustAfterDiscard: true, returnedTitleState: 'occluded' })
  assert.equal(f.result.status, 'completed', JSON.stringify(f.routes))
  assert.equal(f.job.candidates.length, 0)
  assert.equal(f.job.skippedByFilters, 1)
  assert.equal(f.navigationCalls, 0)
  assert.equal(f.greetings, 0)
  assert.deepEqual(f.inputs.filter(input => input.name === 'browser_click').map(input => input.ref), ['card', 'close'])
  assert.ok(f.messages.some(message => /工作经验不符合.*1–3年/.test(message)))
  assert.ok(!f.messages.some(message => /学历不符合|学历尚无法确认/.test(message)))
})

test('BOSS can read an occluded position title but still rejects hidden or background-dialog evidence', async () => {
  const readable = await fixture({ frame: true, document: true, autoGreet: true, returnedTitleState: 'occluded' })
  assert.equal(readable.result.status, 'completed', JSON.stringify(readable.routes))
  assert.equal(readable.greetings, 1)
  for (const state of ['hidden', 'invisible', 'blocked_by_dialog']) {
    const unreadable = await fixture({ frame: true, document: true, autoGreet: true, returnedTitleState: state })
    assert.equal(unreadable.greetings, 0)
    assert.equal(unreadable.result.status, 'stopped')
  }
})

test('BOSS greeting follows detail assessment, closes the resume and returns to the same list card', async () => {
  const f = await fixture({ autoGreet: true })
  assert.equal(f.result.status, 'completed', f.result.message)
  assert.equal(f.navigationCalls, 0)
  assert.deepEqual(f.inputs.map(input => input.ref), ['card', 'close', 'greet'])
  assert.equal(f.greetings, 1)
  assert.equal(f.job.greetings[0].stage, 'succeeded')
})

test('changed BOSS card structure or an unexpected dialog invokes generic recovery once', async () => {
  for (const options of [{ missingName: true }, { unexpected: true }]) {
    const f = await fixture(options)
    assert.equal(f.result.status, 'stopped')
    assert.equal(f.navigationCalls, 1)
    assert.equal(f.assessments, 0)
    assert.equal(f.inputs.length, 0)
    assert.equal(f.job.candidates.length, 0)
  }
})

test('a stalled BOSS list hands off after two scrolls and does not run 150 repeated snapshot cycles', async () => {
  const f = await fixture({ limit: 2 })
  assert.equal(f.job.candidates.length, 1)
  assert.equal(f.scrolls, 2)
  assert.equal(f.navigationCalls, 1)
  assert.equal(f.assessments, 2)
  assert.ok(f.snapshots < 15, `snapshots=${f.snapshots}`)
  assert.ok(f.routes.some(route => route.reason === 'boss_list_no_progress'))
})

test('BOSS name-based fixed route survives missing or changed widget IDs with no navigation inference', async () => {
  for (const dynamicId of [null, 'changed-widget-456']) {
    const f = await fixture({ selected: false, dynamicId })
    assert.equal(f.result.status, 'completed', f.result.message)
    assert.equal(f.navigationCalls, 0)
    assert.deepEqual(f.inputs.map(input => input.ref), ['position', 'card'])
  }
})

test('an ambiguous resume-opening write stops without assessment, save or greeting', async () => {
  const f = await fixture({ unknownOpen: true, allowFailure: true, autoGreet: true })
  assert.match(f.result.message, /OUTCOME_UNKNOWN/)
  assert.equal(f.job.candidates.length, 0)
  assert.equal(f.greetings, 0)
  assert.equal(f.inputs.filter(input => input.ref === 'card').length, 1)
})

test('an unchanged list after opening cannot pass as resume detail', async () => {
  const f = await fixture({ noDetailOpen: true, autoGreet: true })
  assert.equal(f.result.status, 'stopped')
  assert.equal(f.job.candidates.length, 0)
  assert.equal(f.greetings, 0)
  assert.equal(f.assessments, 1, 'only the list preflight may run')
  assert.equal(f.inputs.filter(input => input.ref === 'card').length, 1)
})

test('BOSS never uses a DOM ID to guess between two same-name position tabs', async () => {
  const f = await fixture({ selected: false, duplicatePosition: true })
  assert.equal(f.navigationCalls, 1)
  assert.equal(f.assessments, 0)
  assert.deepEqual(f.inputs, [])
})
