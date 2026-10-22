import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSourcingSession } from '../dist/lib/sourcing/session.js'
import { Store } from '../dist/lib/store.js'

const entry = 'https://www.zhipin.com/web/chat/recommend'
const props = { tabId: { type: 'integer' }, snapshotId: { type: 'string' }, ref: { type: 'string' } }
const info = (name, readOnly, properties, required = []) => ({ name,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly }, _meta: { browserAgent: { available: true } } })
const observe = { type: 'object', properties: { wait: { enum: ['none', 'dom_quiet'] },
  returnSnapshot: { enum: ['none', 'viewport', 'full'] }, timeoutMs: { type: 'integer' }, requireChange: { type: 'boolean' } } }
const infos = [info('browser_list_tabs', true, {}),
  info('browser_snapshot', true, { tabId: props.tabId, format: { enum: ['dom', 'semantic'] }, viewportOnly: { type: 'boolean' } }, ['tabId']),
  info('browser_click', false, { ...props, observe }, ['tabId', 'snapshotId', 'ref']),
  info('browser_scroll', false, { ...props, deltaY: { type: 'number' } }, ['tabId']),
  info('browser_inspect_element', true, props, ['tabId', 'snapshotId', 'ref'])]

async function fixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'boss-fixed-route-'))
  const store = new Store(dir, 'test'); await store.init()
  let revision = 0, detail = false, selected = options.selected !== false
  let navigationCalls = 0, assessments = 0, greetings = 0, snapshots = 0, scrolls = 0
  const inputs = [], routes = []
  const text = '张先生 30岁 6年经验 本科 Java开发 工作经历：负责订单服务。'
  const full = '张先生 Java开发 工作经历：在甲公司负责Java订单服务的设计、开发和上线。项目经历：参与支付系统，负责数据库优化、服务接口实现、故障分析与持续交付。'
  const page = () => ({ tabId: 1, snapshotId: `s${revision}`, documentId: 'boss-document', format: 'dom', url: entry,
    viewport: { width: 1440, height: 800, scrollY: 0 }, selectedTabs: selected ? [{ name: 'Java工程师', elementId: options.dynamicId === undefined ? 'job-job123' : options.dynamicId }] : [],
    dialogs: detail ? [{ ref: 'resume', text: full, closeRef: 'close' }] : options.unexpected ? [{ ref: 'unexpected', text: '新的业务提示，请理解后处理' }] : [],
    items: detail ? [{ ref: 'resume', role: 'dialog', name: full, dialogRef: 'resume' },
      { ref: 'close', role: 'button', name: '关闭', dialogRef: 'resume' }]
      : [{ ref: 'position', role: 'tab', name: 'Java工程师', elementId: options.dynamicId === undefined ? 'job-job123' : options.dynamicId, states: selected ? ['selected'] : [] },
        ...(options.duplicatePosition ? [{ ref: 'position2', role: 'tab', name: 'Java工程师', elementId: 'job-other456', states: [] }] : []),
        { ref: 'card', role: 'article', name: text, bounds: { x: 100, y: 150, width: 650, height: 200 } },
        ...(options.missingName ? [] : [{ ref: 'name', role: 'link', name: '张先生', parentRef: 'card',
          href: 'https://www.zhipin.com/web/geek/resume?geekId=observed123', context: { text }, bounds: { x: 120, y: 170, width: 70, height: 30 } }]),
        { ref: 'greet', role: 'button', name: '立即沟通', parentRef: 'card', context: { text }, bounds: { x: 500, y: 200, width: 100, height: 30 } }],
  })
  const call = async (name, args) => {
    if (name === 'browser_list_tabs') return { tabs: [{ tabId: 1, url: entry }] }
    if (name === 'browser_snapshot') { snapshots++; revision++; return page() }
    assert.equal(args.snapshotId, page().snapshotId)
    if (name === 'browser_inspect_element') return { item: page().items.find(item => item.ref === args.ref), element: { visible: true } }
    inputs.push({ name, ref: args.ref })
    if (name === 'browser_scroll') { scrolls++; revision++; return { dispatched: true, snapshot: page() } }
    assert.equal(name, 'browser_click')
    if (args.ref === 'position') selected = true
    if (args.ref === 'name') {
      if (options.unknownOpen) throw Error('TOOL_CALL_OUTCOME_UNKNOWN')
      detail = true
    }
    if (args.ref === 'close') detail = false
    if (args.ref === 'greet') {
      assert.equal(options.autoGreet, true)
      assert.equal(args.policy.riskLevel, 'business_write')
      greetings++
    }
    revision++; return { output: { dispatched: true, changed: true }, snapshot: page() }
  }
  const job = { id: 'boss-fixed-route', kind: 'talent_sourcing', jobId: 'host-job', jobName: 'Java工程师', platform: 'boss', platforms: ['boss'],
    sourceMode: 'recommend', searchFilters: {}, minimumScore: 60, limit: options.limit ?? 1, limitScope: 'per_platform',
    supplement: '', autoGreet: !!options.autoGreet, position: { id: 'host-job', name: 'Java工程师', description: 'Java开发' },
    platformJobs: { boss: [{ id: 'job123', name: 'Java工程师' }] },
    requirements: { keyword: 'Java', listCriteria: [{ field: 'education', requirement: '本科', quote: '本科' }], criteria: [{ id: 'java', label: 'Java开发', quote: 'Java开发', must: true, weight: 100 }] },
    candidates: [], results: [], greetings: [], channels: [{ platform: 'boss', status: 'running', detail: '' }], events: [] }
  const agent = async opts => {
    if (opts.tools[0]?.name !== 'sourcing_submit_assessments') {
      navigationCalls++; assert.equal(opts.maxTurns, 8)
      return { status: 'stopped', message: 'unknown BOSS structure', turns: 1, modelMs: 0, toolMs: 0 }
    }
    assessments++
    assert.equal(opts.modelPurpose, 'assessment')
    assert.equal(opts.tools.length, 1)
    await opts.tools[0].execute({ candidates: opts.goal.candidates.map(source => ({ sourceId: source.sourceId,
      ...(opts.goal.mode === 'detail' ? { fields: [] } : {}),
        ...(opts.goal.mode === 'preview' ? { listAssessments: opts.goal.listCriteria.map(c => ({ field: c.field, state: 'match', evidenceId: 0, reason: '原文证据' })) } : {}),
      ...(opts.goal.mode === 'detail' ? { assessments: [{ criterionId: 'java', state: 'match', evidenceId: 0, reason: '原文明确Java职责' }] } : {}) })) }, opts.signal)
    return { status: 'completed', message: 'assessed', turns: 1, modelMs: 0, toolMs: 0 }
  }
  try {
    const session = await createSourcingSession({ job, channel: job.channels[0], quota: job.limit, before: 0, previous: new Set(), store,
      signal: new AbortController().signal, agent, call, listTools: async () => infos, save: async () => {}, progress: async () => {},
      logger: { write: (_level, event, fields) => { if (event.startsWith('sourcing.fast_')) routes.push({ event, ...fields }) } } })
    const result = await session.run()
    return { result, job, inputs, routes, navigationCalls, assessments, greetings, snapshots, scrolls }
  } finally { await rm(dir, { recursive: true, force: true }) }
}

test('BOSS fixed route selects job, opens its name, assesses details and persists a real resume without navigation inference', async () => {
  const f = await fixture({ selected: false })
  assert.equal(f.result.status, 'completed', f.result.message)
  assert.equal(f.navigationCalls, 0)
  assert.equal(f.assessments, 2)
  assert.deepEqual(f.inputs.map(input => input.ref), ['position', 'name'])
  assert.equal(f.job.candidates.length, 1)
  assert.equal(f.job.candidates[0].scope, 'online')
  assert.match(f.job.candidates[0].resumeText, /支付系统/)
  assert.equal(f.greetings, 0)
  assert.equal(f.routes.find(route => route.event === 'sourcing.fast_execution_finished').navigationTurns, 0)
})

test('BOSS authorized greeting uses the same verified card after closing its own resume', async () => {
  const f = await fixture({ autoGreet: true })
  assert.equal(f.result.status, 'completed', f.result.message)
  assert.equal(f.navigationCalls, 0)
  assert.deepEqual(f.inputs.map(input => input.ref), ['name', 'close', 'greet'])
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

test('unknown BOSS detail input stops without generic recovery or replay', async () => {
  await assert.rejects(fixture({ unknownOpen: true }), /OUTCOME_UNKNOWN/)
})


test('BOSS name-based fixed route survives missing or changed widget IDs with no navigation inference', async () => {
  for (const dynamicId of [null, 'changed-widget-456']) {
    const f = await fixture({ selected: false, dynamicId })
    assert.equal(f.result.status, 'completed', f.result.message)
    assert.equal(f.navigationCalls, 0)
    assert.deepEqual(f.inputs.map(input => input.ref), ['position', 'name'])
  }
})

test('BOSS never uses a DOM ID to guess between two same-name position tabs', async () => {
  const f = await fixture({ selected: false, duplicatePosition: true })
  assert.equal(f.navigationCalls, 1)
  assert.equal(f.assessments, 0)
  assert.deepEqual(f.inputs, [])
})
