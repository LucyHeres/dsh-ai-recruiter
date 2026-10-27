import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store, hash } from '../dist/lib/store.js'
import { normalized } from '../dist/lib/page-actions.js'
import { SourcingAgent } from '../dist/lib/sourcing-agent.js'
import { assessCandidate, sourcingStartSpec, validateCriteria, assertSourcingNavigation, sourcingResumeParts, SourcingSearchTracker } from '../dist/lib/sourcing-policy.js'
import { readSourcingPosition, plainJobText } from '../dist/lib/sourcing-position.js'
import { Workbench } from '../dist/lib/workbench.js'
import { sourcingCriterionScore } from '../dist/shared/sourcing-score.js'
import { DeveloperLog } from '../dist/lib/developer-log.js'
import { recruitmentPlatform } from '../dist/lib/platforms/registry.js'
import { recruitmentMatchingSkill } from '../dist/lib/browser-skill.js'

const position = { id: 'job-1', name: 'Java 后端工程师', platforms: ['liepin', 'boss'], description: 'Java 后端开发，支付经验优先', city: '上海', department: '研发', fetchedAt: new Date().toISOString() }
const criteria = [{ id: 'java', label: 'Java 后端开发', quote: 'Java 后端开发', must: true, weight: 60 }, { id: 'pay', label: '支付经验', quote: '支付经验优先', must: false, weight: 40 }]
const assessments = [{ criterionId: 'java', state: 'match', quote: 'Java 后端开发', reason: '有明确项目职责' }, { criterionId: 'pay', state: 'unknown', quote: '', reason: '未提及支付项目' }]
// New task definitions separate the preferred payment experience from core ability.
const modelCriteria = [{ ...criteria[0], tier: 'core', must: false, weight: 100 }, { ...criteria[1], tier: 'bonus', weight: 10 }]
const defineCriteria = rows => rows === criteria ? modelCriteria : rows.map(row => ({ ...row, tier: row.tier ?? 'core', must: row.tier === 'must' }))
test('criterion contributions preserve half-points and round only the final total', () => {
  const criteria = [60, 15, 15, 10].map((weight, i) => ({ id: String(i), weight, must: false }))
  const assessments = ['match', 'partial', 'mismatch', 'unknown'].map((state, i) => ({ criterionId: String(i), state, quote: state === 'unknown' ? '' : 'Java' }))
  const contributions = criteria.map((criterion, i) => sourcingCriterionScore(criterion.weight, assessments[i].state))
  assert.deepEqual(contributions, [60, 7.5, 0, 0])
  assert.equal(assessCandidate(criteria, assessments, 'Java').score, Math.round(contributions.reduce((sum, value) => sum + value, 0)))
})
test('missing evidence never produces a normalized perfect score; must conflicts cannot be offset', () => {
  assert.deepEqual(assessCandidate(criteria, assessments, 'Java 后端开发'), { score: 60, coverage: 60, verdict: 'review' })
  assert.throws(() => assessCandidate(criteria, [{ ...assessments[0], quote: '杜撰项目' }, assessments[1]], 'Java 后端开发'), /证据/)
  assert.throws(() => assessCandidate(criteria, [assessments[0], assessments[0]], 'Java 后端开发'), /全部/)
  const out = assessCandidate(criteria, [{ ...assessments[0], state: 'mismatch' }, { ...assessments[1], state: 'match', quote: '支付项目' }], 'Java 后端开发 支付项目')
  assert.equal(out.verdict, 'unqualified')
  assert.throws(() => validateCriteria([{ ...criteria[0], quote: '未提及的学历' }, criteria[1]], position.description), /原文/)
  assert.throws(() => validateCriteria([{ id: 'age', label: '年龄', quote: '年龄不限', must: true, weight: 100 }], '年龄不限'), /岗位职责/)
  assert.equal(sourcingStartSpec.safeParse({ id: randomUUID(), jobId: 'job', platforms: ['boss', 'boss'], limit: 1, confirmed: true }).success, false)
})
test('position import preserves job identity and rich-text safety and imports explicit requirement enums', async () => {
  const jobs = [{ id: 'job-1', name: '真实职位名称' }]
  const xin = { call: async () => ({ ok: true, data: { jobId: 'job-1', jobDesc: '<p>职责</p><script>alert(1)</script><p>Java &amp; SQL</p>', workCity: '上海', workAge: 2, eduGrade: 5, salaryType: 1, minSalary: 25000, maxSalary: 35000 } }) }
  const out = await readSourcingPosition(xin, 'job-1', jobs)
  assert.equal(out.name, '真实职位名称'); assert.match(out.description, /职责\nJava & SQL/); assert.match(out.description, /3–5年/); assert.match(out.description, /学历要求：本科/); assert.match(out.description, /25000–35000/); assert.doesNotMatch(out.description, /script|alert/)
  await assert.rejects(readSourcingPosition(xin, 'another-job', jobs), /失效/)
  await assert.rejects(readSourcingPosition({ call: async () => ({ ok: true, data: { jobId: 'other' } }) }, 'job-1', jobs), /不一致/)
  assert.equal(plainJobText('<img src=x onerror=alert(1)>安全'), '安全')
  assert.match(out.descriptionHtml, /<p>职责<\/p>/)
  const encoded = await readSourcingPosition({ call: async () => ({ ok: true, data: { jobId: 'job-1', jobDesc: '&lt;p&gt;&lt;strong&gt;任职要求&lt;/strong&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Java &amp;amp; SQL&lt;/li&gt;&lt;/ul&gt;' } }) }, 'job-1', jobs)
  assert.equal(encoded.description, '任职要求\nJava & SQL')
  assert.match(encoded.descriptionHtml, /<strong>任职要求<\/strong>/)
  assert.doesNotMatch(encoded.description, /<\/?(?:p|li|ul|strong)>/)
  assert.equal(plainJobText('&lt;script&gt;alert(1)&lt;/script&gt;&lt;p&gt;Java&lt;/p&gt;'), 'Java')
})
test('sourcing permits readable custom navigation but rejects business writes, unsafe inputs and blank targets', () => {
  const page = { snapshotId: 's', items: [{ ref: 'send', role: 'button', name: '立即沟通' }, { ref: 'custom', role: 'button', name: '展开更多经历' }, { ref: 'blank', role: 'button', name: '' }, { ref: 'chat', role: 'textbox', name: '输入消息' }, { ref: 'query', role: 'searchbox', name: '搜索人才' }] }
  const call = (name, ref, purpose = 'navigation') => ({ name, args: { ref }, readOnly: false, purpose })
  assert.throws(() => assertSourcingNavigation(call('browser_click', 'send'), page), /READ_ONLY/)
  assert.throws(() => assertSourcingNavigation(call('browser_click', 'send'), page, '立即沟通'), /READ_ONLY/)
  assert.throws(() => assertSourcingNavigation(call('browser_click', 'query', 'business_write'), page), /READ_ONLY/)
  assert.throws(() => assertSourcingNavigation(call('browser_type', 'chat'), page), /SEARCH_INPUT/)
  assert.doesNotThrow(() => assertSourcingNavigation(call('browser_click', 'custom'), page))
  assert.throws(() => assertSourcingNavigation(call('browser_click', 'blank'), page), /UNVERIFIED/)
  assert.doesNotThrow(() => assertSourcingNavigation(call('browser_type', 'query'), page))
})

const props = { tabId: { type: 'integer' }, snapshotId: { type: 'string' }, ref: { type: 'string' } }
const info = (name, readOnly, properties, required = []) => ({ name, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { readOnlyHint: readOnly }, _meta: { browserAgent: { available: true, capability: name.replace('_', '.') } } })
const infos = [info('browser_list_tabs', true, {}), info('browser_snapshot', true, { tabId: props.tabId, format: { type: 'string' } }, ['tabId']), info('browser_type', false, { ...props, text: { type: 'string' }, clear: { type: 'boolean' } }, ['tabId', 'snapshotId', 'ref', 'text']), info('browser_click', false, props, ['tabId', 'snapshotId', 'ref']), info('browser_press_key', false, { tabId: props.tabId, key: { type: 'string' } }, ['tabId', 'key'])]
async function fixture(action, options = {}) {
  // This fixture tests generic navigation/business policy decisions. Dedicated
  // hybrid-session fixtures exercise the real per-platform fixed routes.
  const adapters = ['liepin', 'boss'].map(name => ({ adapter: recruitmentPlatform(name), factory: recruitmentPlatform(name).createSourcingDriver }))
  for (const { adapter } of adapters) adapter.createSourcingDriver = () => ({ recognizes: async () => false })
  const dir = await mkdtemp(join(tmpdir(), 'sourcing-')); const store = new Store(dir, 'company'); await store.init()
  const sourceMode = options.sourceMode ?? (options.platforms?.includes('boss') ? 'recommend' : 'search')
  let snapshots = 0, keyword = options.initialKeyword ?? '', currentOrigin = '', released = 0, detail = false
  let body = '陈先生 Java 后端开发 工作经历：负责订单服务和数据库优化。'
  const fullText = () => body + '\n项目经历：参与Java订单系统的设计与开发，负责接口实现、数据库优化、上线与维护。'
  const page = () => ({ tabId: 1, snapshotId: `s${snapshots}`, documentId: 'doc', format: 'dom', url: currentOrigin + (options.pagePath || (sourceMode === 'search' ? '/search' : currentOrigin.includes('zhipin') ? '/web/chat/recommend' : '/recommend')), items: [
    { ref: 'query', role: 'searchbox', name: '搜索人才', value: keyword }, { ref: 'search', role: 'button', name: '搜索' },
    { ref: 'city', role: 'combobox', name: '期望城市', value: '上海' },
    { ref: 'end', role: 'text', name: '没有更多结果' }, ...(options.searchItems ?? []),
    { ref: 'card', role: 'article', name: options.splitEvidence ? '陈先生' : body, bounds: { x: 0, y: 0, width: 600, height: 150 } }, { ref: 'resume', role: 'article', name: body }, { ref: 'other', role: 'article', name: '李先生 支付项目负责人' },
    ...(options.splitEvidence ? [{ ref: 'skills', role: 'text', name: 'Java 后端开发', bounds: { x: 30, y: 30, width: 120, height: 20 } }, { ref: 'degree', role: 'text', name: '学历：本科', bounds: { x: 30, y: 60, width: 100, height: 20 } }, { ref: 'otherDegree', role: 'text', name: '学历：博士', bounds: { x: 30, y: 300, width: 100, height: 20 } }] : []),
    { ref: 'send', role: 'button', name: options.contacted ? '继续沟通' : '立即沟通', context: {text: options.wrongIdentity ? '李先生 支付项目负责人' : body} },
    { ref: 'position', role: 'tab', name: options.wrongPosition ? '产品经理' : position.name, states: ['selected'] },
    { ref: 'detail', role: 'button', name: '查看简历', context: {text:body} },
    { ref: 'avatar', role: 'img', tagName: 'span', name: '头像', states: ['occluded'], context: {text:body}, ancestorControls: [{tagName:'div',role:'generic',name:'不应记录的候选人文案'}] },
    { ref: 'delete', role: 'button', name: '删除', context: {text:body} },
    { ref: 'close-detail', role: 'button', name: '关闭' },
    { ref: 'foreignProfile', role: 'link', name: '李先生', href: currentOrigin+'/profile/other', context:{text:'李先生 支付项目负责人'} },
  ].map(item => detail && ['card', 'resume', 'detail', 'avatar', 'delete', 'close-detail', ...(options.wrongIdentity ? [] : ['send'])].includes(item.ref) ? { ...item, dialogRef: 'detail-dialog' } : item)
    .concat(detail ? [{ ref: 'detail-dialog', role: 'dialog', name: '简历详情' }] : []),
    dialogs: detail ? [{ ref: 'detail-dialog', text: fullText(), closeRef: 'close-detail' }] : [],
  })
  const calls = []
  const call = async (name, args) => {
    calls.push(name)
    if (name === 'browser_finish') { released++; return {} }
    currentOrigin = args.policy.allowedOrigins[0]
    if (name === 'browser_list_tabs') { detail = false; return { tabs: [{ tabId: 1, url: currentOrigin + (options.pagePath || (sourceMode === 'search' ? '/search' : currentOrigin.includes('zhipin') ? '/web/chat/recommend' : '/recommend')) }] } }
    if (name === 'browser_snapshot') { snapshots++; return options.transformPage ? options.transformPage(page()) : page() }
    if (name === 'browser_inspect_element') {
      const id = typeof options.resumeId === 'function' ? options.resumeId() : options.resumeId
      return { element: { attributes: { class: id ? 'xpath-resume-item-wrap xpath-resume-item-wrap-' + id : '' } }, ancestors: [] }
    }
    if (name === 'browser_click' && args.ref === 'send') { calls.push('greeting_click'); if (options.clickError) throw new Error(options.clickError) }
    if (name === 'browser_click' && args.ref === 'detail') detail = true
    if (name === 'browser_click' && args.ref === 'close-detail') detail = false
    if (name === 'browser_click') options.onClick?.(args.ref)
    if (name === 'browser_type') keyword = options.appendByDefault && args.clear !== true ? keyword + args.text : args.text
    if (name === 'browser_type' || name === 'browser_click' || name === 'browser_press_key') { snapshots++; return { dispatched: true, snapshot: page() } }
    throw Error('Unexpected transport: ' + name)
  }
  const control = new AbortController()
  // Navigation tests prescribe decisions for the separate assessment model.
  // Quotes in test plans are mapped to source IDs here; the navigation API
  // itself accepts locators only, just like the production recovery agent.
  const listCriteria = options.listCriteria ?? [{ field: 'city', requirement: '上海', quote: '上海' }]
  let evaluationPlan, listEvaluationPlan
  const runner = async opts => {
    if (opts.tools.length === 1 && opts.tools[0].name === 'sourcing_define_requirements') {
      await opts.tools[0].execute({ keyword: 'Java', criteria: options.criteria ?? modelCriteria, listCriteria, supplementCoverage: options.supplementCoverage ?? [] }, opts.signal)
      return { status: 'completed', message: 'defined', turns: 1, modelMs: 0, toolMs: 0 }
    }
    if (opts.tools[0]?.name === 'sourcing_submit_assessments') {
      const planned = evaluationPlan ?? { assessments }
      await opts.tools[0].execute({ candidates: opts.goal.candidates.map(source => ({ sourceId: source.sourceId,
        ...(opts.goal.mode === 'detail' ? { fields: planned.fields ?? [] } : {}),
        ...(opts.goal.candidateFilters ? { filterAssessments: Object.keys(opts.goal.candidateFilters).map(field => ({ field, state: options.filterState ?? 'match', evidenceId: options.filterState === 'unknown' ? null : 0, reason: 'Candidate source evidence' })) } : {}),
        ...(opts.goal.mode === 'preview' ? { listAssessments: opts.goal.listCriteria.map(criterion => {
          const planned = listEvaluationPlan?.find(row => row.field === criterion.field)
          const state = planned?.state ?? options.listState ?? options.filterState ?? 'match'
          return { field: criterion.field, state, reason: planned?.reason ?? 'Explicit list evidence', evidenceId: state === 'unknown' ? null : planned?.quote ? source.evidence.find(e => normalized(e.text).includes(normalized(planned.quote)))?.id ?? 999 : 0 }
        }) } : { assessments: planned.assessments.map(({ quote, ...row }) => ({ ...row, ...(opts.goal.rubricVersion === 2 ? { evidenceKind: row.evidenceKind ?? 'direct', confidence: row.confidence ?? (row.state === 'unknown' ? 'low' : 'high') } : {}),
          evidenceId: row.state === 'unknown' ? null : source.evidence.find(e => e.text.includes(quote))?.id ?? 999,
        })) }),
      })) }, opts.signal)
      return { status: 'completed', message: 'assessed', turns: 1, modelMs: 0, toolMs: 0 }
    }
    const execute = (name, args = {}) => {
      const tool = opts.tools.find(row => row.name === name); assert.ok(tool, name)
      if (name === 'sourcing_define_requirements') return tool.execute({ listCriteria, ...args, criteria: options.criteria ?? defineCriteria(args.criteria ?? criteria), supplementCoverage: options.supplementCoverage ?? [] }, opts.signal)
      if (['sourcing_select_candidate', 'sourcing_record_candidate'].includes(name)) {
        evaluationPlan = { assessments: args.assessments ?? assessments, fields: args.fields ?? [] }
        if (name === 'sourcing_select_candidate') listEvaluationPlan = args.listAssessments
        const { assessments: ignoredAssessment, listAssessments: ignoredListAssessment, fields: ignoredFields, analysis: ignoredAnalysis, ...locator } = args
        return tool.execute(locator, opts.signal)
      }
      return tool.execute(args, opts.signal)
    }
    const identity = () => ({ tabId: 1, snapshotId: `s${snapshots}` })
    detail = false
    const openResume = async () => { if (!detail) await execute('browser_click', { ...identity(), ref: 'detail' }) }
    const returnToList = async () => { if (detail) await execute('browser_click', { ...identity(), ref: 'close-detail' }) }
    await action({ execute, identity, control, opts, store, body, openResume, returnToList, setBody: value => { body = value } })
    return options.result ?? { status: 'completed', message: 'done', turns: 1, modelMs: 0, toolMs: 0 }
  }
  const logger = options.logging ? new DeveloperLog(dir, 'info', 'test') : undefined
  const executor = new SourcingAgent(store, call, async () => {}, async () => options.resumeId ? [...infos, info('browser_inspect_element', true, props, ['tabId', 'snapshotId', 'ref'])] : infos, () => runner, async () => options.position ?? position, logger, { loadPlatformJobs: options.loadPlatformJobs })
  const create = async platforms => { const job = executor.create({ id: randomUUID(), jobId: position.id, platforms, limit: options.limit ?? 1, sourceMode, autoGreet: !!options.autoGreet, supplement: options.supplement ?? '', ...(options.minimumScore === undefined ? {} : {minimumScore:options.minimumScore}), confirmed: true }); await executor.prepare(job, control.signal); await store.put('sourcing-' + job.id, job); return job }
  try { if (options.run) return await options.run({ executor, store, create, control, calls, released: () => released }); return await (async () => { const job = await create(options.platforms ?? ['liepin']); await executor.run(job, control.signal); const log = await logger?.read(); return { job, calls, released, diagnostics: log?.lines.map(line => JSON.parse(line)) } })() }
  finally { for (const { adapter, factory } of adapters) adapter.createSourcingDriver = factory; await rm(dir, { recursive: true, force: true }) }
}
async function search({ execute, identity, opts }) {
  await execute('sourcing_define_requirements', { keyword: 'Java', criteria })
  if (opts.goal.sourceMode === 'recommend') {
    await execute('sourcing_confirm_search', { ...identity(), mode: 'position', ref: 'position', filters: [{ field: 'city', ref: 'city', quote: '上海' }] })
  } else {
    await execute('browser_type', { ...identity(), ref: 'query', text: 'Java' })
    await execute('browser_click', { ...identity(), ref: 'search' })
    await confirmKeyword({ execute, identity })
  }
}
const confirmKeyword = tools => tools.execute('sourcing_confirm_search', { ...tools.identity(), ref: 'query', filters: [{ field: 'city', ref: 'city', quote: '上海' }] })
const finishExhausted = (tools, reason) => tools.execute('sourcing_finish', { status: 'completed', reason, exhaustion: { ...tools.identity(), ref: 'end', quote: '没有更多结果' } })
const select = async ({ execute, identity, returnToList }) => { await returnToList(); return execute('sourcing_select_candidate', { ...identity(), ref: 'card', name: '陈先生', evidenceRefs: [], assessments }) }
const record = async ({ execute, identity, openResume }, refs = ['resume']) => { await openResume(); return execute('sourcing_record_candidate', { ...identity(), identityRef: 'resume', resumeRefs: refs, scope: 'online', fields: [{ label: '当前职位', value: 'Java 后端开发' }], assessments, analysis: 'Java职责匹配，支付经历待核实。' }) }

test('starting rejects a platform not connected to the current job before browser activity or platform lookups', async () => {
  let lookups = 0
  await fixture(async () => { assert.fail('browser must not run') }, {
    position: { ...position, platforms: ['liepin', 'boss'], publishedChannels: [{ id: '4', name: '猎聘' }] }, loadPlatformJobs: async () => { lookups++; return [] },
    run: async ({ create, calls }) => {
      await assert.rejects(create(['boss']), /SOURCING_PLATFORM_NOT_CONNECTED.*BOSS/)
      assert.equal(lookups, 0); assert.equal(calls.length, 0)
      const allowed = await create(['liepin'])
      assert.deepEqual(allowed.platforms, ['liepin']); assert.equal(lookups, 1)
    },
  })
})

test('platform job selection precedes filters and candidate reads, even with auto greeting off', async () => {
  const selector = { ref: 'job-selector', role: 'combobox', tagName: 'div', name: '职位', value: '不限职位' }
  const searchItems = [selector, { ref: 'job-choice', parentRef: 'job-selector', role: 'option', name: '平台Java研发工程师' },
    { ref: 'exp', role: 'button', name: '工作经验：3-5年' }, { ref: 'edu', role: 'button', name: '学历：本科及以上' }]
  const out = await fixture(async tools => {
    await tools.execute('sourcing_define_requirements', { keyword: 'Java', criteria })
    assert.deepEqual(tools.opts.goal.platformJobs, [{ id: 'platform-job', name: '平台Java研发工程师' }])
    assert.deepEqual(tools.opts.goal.searchFilters, { city: '上海', experience: '3-5年', education: '本科' })
    await assert.rejects(tools.execute('sourcing_search', { ...tools.identity(), inputRef: 'query' }), /POSITION_SELECTION_REQUIRED/)
    await assert.rejects(tools.execute('browser_type', { ...tools.identity(), ref: 'query', text: 'Java' }), /POSITION_SELECTION_REQUIRED/)
    await tools.execute('browser_click', { ...tools.identity(), ref: 'job-choice' })
    const confirmation = { ...tools.identity(), mode: 'position', ref: 'job-selector', filters: [{ field: 'city', ref: 'city', quote: '上海' }, { field: 'experience', ref: 'exp', quote: '3-5年' }, { field: 'education', ref: 'edu', quote: '本科及以上' }] }
    await assert.rejects(tools.execute('sourcing_confirm_search', { ...confirmation, filters: confirmation.filters.slice(0, 1) }), /SEARCH_CONDITIONS_UNVERIFIED/)
    await assert.rejects(select(tools), /SEARCH_CONDITIONS_UNVERIFIED/)
    const confirmed = await tools.execute('sourcing_confirm_search', confirmation)
    assert.equal(confirmed.searchReady, true)
    await tools.execute('browser_click', { ...tools.identity(), ref: 'exp' })
    await assert.rejects(select(tools), /SEARCH_CONDITIONS_UNVERIFIED/, 'changing filters invalidates the prepared list')
    await tools.execute('sourcing_confirm_search', { ...confirmation, ...tools.identity() })
    await select(tools); await record(tools)
  }, { searchItems, position: { ...position, searchFields: { experience: '3-5年', education: '本科' } },
    onClick: ref => { if (ref === 'job-choice') selector.value = '平台Java研发工程师' },
    loadPlatformJobs: async () => [{ id: 'platform-job', name: '平台Java研发工程师' }], logging: true })
  assert.equal(out.job.status, 'completed')
  assert.equal(out.calls.includes('browser_type'), false)
  assert.equal(out.diagnostics.filter(row => row.event === 'sourcing.search_prepared').length, 2)
})

test('Liepin guides the top recruiting-position route and verifies its result while allowing model navigation', async () => {
  const selector = { ref: 'top-job', role: 'div', name: '不限职位', hasPopup: 'listbox', bounds: { x: 40, y: 42, width: 100, height: 30 } }
  const searchItems = [selector,
    { ref: 'resume-job', role: 'combobox', tagName: 'input', name: '搜索职位名称', value: '' },
    { ref: 'top-choice', role: 'StaticText', name: '平台Java研发工程师' },
    { ref: 'unrelated-job', role: 'StaticText', name: '产品经理' }]
  const out = await fixture(async tools => {
    assert.match(tools.opts.system, /顶部大搜索框最左侧/)
    await tools.execute('sourcing_define_requirements', { keyword: 'Java', criteria })
    await tools.execute('browser_click', { ...tools.identity(), ref: 'resume-job' })
    await assert.rejects(select(tools), /SEARCH_CONDITIONS_UNVERIFIED/)
    await tools.execute('browser_click', { ...tools.identity(), ref: 'top-job' })
    await tools.execute('browser_click', { ...tools.identity(), ref: 'top-choice' })
    await tools.execute('sourcing_confirm_search', { ...tools.identity(), mode: 'position', ref: 'top-job', filters: [{ field: 'city', ref: 'city', quote: '上海' }] })
    await select(tools); await record(tools)
  }, { searchItems, loadPlatformJobs: async () => [{ id: 'platform-job', name: '平台Java研发工程师' }],
    onClick: ref => { if (ref === 'top-choice') selector.name = '平台Java研发工程师' } })
  assert.equal(out.job.status, 'completed')
  assert.equal(out.calls.includes('browser_type'), false)
})

test('five means five accepted candidates on each platform and early completion is rejected', async () => {
  const order = []
  const out = await fixture(async tools => {
    order.push(tools.opts.goal.platform)
    assert.equal(tools.opts.goal.channelLimit, 5); assert.equal(tools.opts.goal.totalLimit, 10)
    await search(tools)
    for (let i = 0; i < 5; i++) {
      tools.setBody(`陈先生 Java 后端开发 工作经历：第${i}个独立候选人。`)
      await tools.execute('browser_snapshot', { tabId: 1 })
      await select(tools); await record(tools)
      assert.equal(tools.opts.isComplete(), i === 4)
      if (i === 0) await assert.rejects(tools.execute('sourcing_finish', { status: 'completed', reason: '已经找到一个，去下个平台' }), /SOURCING_QUOTA_NOT_REACHED/)
    }
  }, { platforms: ['liepin', 'boss'], limit: 5 })
  assert.deepEqual(order, ['liepin', 'boss'])
  assert.deepEqual(out.job.candidates.map(row => row.platform), [...Array(5).fill('liepin'), ...Array(5).fill('boss')])
  assert.deepEqual(out.job.channels.map(row => [row.status, row.candidateCount, row.limit]), [['completed', 5, 5], ['completed', 5, 5]])
  assert.equal(out.job.status, 'completed')
})

test('unresolved greeting on the first platform stops the round and never opens the next platform', async () => {
  let runs = 0
  const out = await fixture(async tools => {
    runs++
    await search(tools); await select(tools); await record(tools)
    await assert.rejects(tools.execute('sourcing_finish', { status: 'completed', reason: '已读一人' }), /TASK_RESULT_REQUIRED/)
    await tools.execute('sourcing_finish', { status: 'stopped', reason: '无法核对招呼身份，尚未派发' })
  }, { platforms: ['liepin', 'boss'], limit: 5, autoGreet: true })
  assert.equal(runs, 1); assert.equal(out.job.candidates.length, 1)
  assert.equal(out.job.status, 'stopped'); assert.equal(out.calls.includes('greeting_click'), false)
  assert.match(out.job.channels[1].detail, /尚未开始/)
})

test('verified exhausted results may complete below target before the next platform starts', async () => {
  let runs = 0
  const out = await fixture(async tools => {
    runs++
    await search(tools); await select(tools); await record(tools)
    await assert.rejects(tools.execute('sourcing_finish', { status: 'completed', reason: '已经遍历', exhaustion: { ...tools.identity(), ref: 'card', quote: '陈先生' } }), /SOURCING_EXHAUSTION_UNVERIFIED/)
    await finishExhausted(tools, '页面明确显示没有更多结果')
  }, { platforms: ['liepin', 'boss'], limit: 5 })
  assert.equal(runs, 2); assert.equal(out.job.candidates.length, 2)
  assert.equal(out.job.status, 'completed')
  assert.deepEqual(out.job.channels.map(row => row.candidateCount), [1, 1])
})

test('sourcing diagnostics explain a rejected entry and an unsaved candidate without copying page text', async () => {
  const out = await fixture(async tools => {
    tools.setBody('陈先生 Java 后端开发 工作经历：负责业务服务。 private-contact@example.test 13912345678')
    await search(tools); await select(tools)
    await tools.openResume()
    await tools.execute('sourcing_read_resume', { ...tools.identity(), identityRef:'resume',resumeRefs:['resume'] })
    await assert.rejects(tools.execute('browser_click',{...tools.identity(),ref:'delete'}), /SOURCING_READ_ONLY/)
    await tools.execute('sourcing_finish',{status:'stopped',reason:'入口校验未通过'})
  }, {logging:true})
  const rejected=out.diagnostics.find(row=>row.event==='sourcing.navigation_rejected')
  assert.equal(rejected.inputDispatched,false);assert.equal(rejected.validationStage,'navigation_policy')
  assert.equal(rejected.target.ref,'delete');assert.equal(rejected.target.targetRole,'button')
  assert.equal(rejected.target.candidateRelation,'context-contains')
  assert.ok(rejected.target.targetLabelKey)
  assert.equal(out.calls.filter(name=>name==='browser_click').length,2,'only search and opening details are dispatched')
  const read=out.diagnostics.find(row=>row.event==='sourcing.resume_read')
  assert.equal(read.saved,false);assert.equal(read.scope,'online');assert.ok(read.capturedCharacters>0)
  const end=out.diagnostics.find(row=>row.event==='sourcing.channel_finished')
  assert.equal(end.candidateCount,0);assert.equal(end.candidatePending,true);assert.equal(end.pendingResumeCharacters,read.capturedCharacters)
  assert.equal(end.candidateKey,rejected.candidateKey)
  const encoded=JSON.stringify(out.diagnostics)
  for(const secret of ['陈先生','private-contact@example.test','13912345678','负责业务服务','不应记录的候选人文案'])assert.ok(!encoded.includes(secret),secret)
})

test('sourcing diagnostics distinguish missing list evidence, unverified skips and persisted results',async()=>{
  const skipped=await fixture(async tools=>{
    await search(tools)
    await assert.rejects(tools.execute('sourcing_select_candidate',{...tools.identity(),ref:'card',name:'陈先生',evidenceRefs:[],listAssessments:[{field:'city',state:'match',quote:'不存在的候选人原文',reason:'城市依据'}]}),/EVIDENCE_MISSING/)
    const result=await tools.execute('sourcing_select_candidate',{...tools.identity(),ref:'card',name:'陈先生',evidenceRefs:[],listAssessments:[{field:'city',state:'unknown',quote:'',reason:'列表未展示期望城市'}]})
    assert.equal(result.skipped,true)
    await finishExhausted(tools, '平台已明确没有更多结果')
  },{logging:true})
  const rejected=skipped.diagnostics.find(row=>row.event==='sourcing.assessment_rejected')
  assert.deepEqual(rejected.listConditions,[{field:'city'}]);assert.ok(rejected.evidenceCharacters>0)
  assert.ok(!JSON.stringify(skipped.diagnostics).includes('不存在的候选人原文'))
  const preview=skipped.diagnostics.find(row=>row.event==='sourcing.candidate_preflight')
  assert.equal(preview.decision,'skip_unverified');assert.equal(preview.score,0);assert.equal(preview.matchedCount,0);assert.equal(preview.requiredCount,1)
  const saved=await fixture(async tools=>{await search(tools);await select(tools);await record(tools)},{logging:true})
  const result=saved.diagnostics.find(row=>row.event==='sourcing.candidate_recorded')
  assert.equal(result.saved,true);assert.equal(result.score,100);assert.equal(result.candidateCount,1)
  assert.equal(saved.diagnostics.find(row=>row.event==='sourcing.channel_finished').candidatePending,false)
})

test('preflight verifies related basic-information evidence separately from the name identity fragment', async () => {
  const bachelorCriteria = [criteria[0], { id: 'bachelor', label: '本科学历', quote: '本科', must: true, weight: 40 }]
  const out = await fixture(async tools => {
    await tools.execute('sourcing_define_requirements', { keyword: 'Java', criteria: bachelorCriteria, listCriteria: [{field:'education',requirement:'本科',quote:'本科'}] })
    await tools.execute('browser_type', { ...tools.identity(), ref: 'query', text: 'Java' })
    await tools.execute('browser_click', { ...tools.identity(), ref: 'search' })
    await confirmKeyword(tools)
    const selected = await tools.execute('sourcing_select_candidate', { ...tools.identity(), ref: 'card', name: '陈先生', evidenceRefs: ['skills', 'degree'], listAssessments: [{field:'education',state:'match',quote:'本科',reason:'同一卡片已披露学历'}] })
    assert.equal(selected.qualified, true); assert.equal(selected.score, 100)
    await tools.execute('sourcing_finish', { status: 'stopped', reason: '本测试仅核验列表初筛，不打开履历' })
  }, { splitEvidence: true, position: { ...position, description: 'Java 后端开发，本科' } })
  assert.equal(out.job.scanned, 1); assert.equal(out.job.candidates.length, 0); assert.equal(out.job.status, 'stopped')
})

test('failed preflight returns its verified source for correction and rejects another card', async () => {
  const out = await fixture(async tools => {
    await search(tools)
    const tool = tools.opts.tools.find(row => row.name === 'sourcing_select_candidate')
    const request = { ...tools.identity(), ref: 'card', name: '陈先生', evidenceRefs: ['skills', 'degree'], listAssessments: [{field:'city',state:'match',quote:'Java 后端开发 本科',reason:'测试逐字引用'}] }
    let failure
    try { await tools.execute(tool.name, request) } catch (error) { failure = error }
    assert.match(failure.message, /SOURCING_ASSESSMENT_EVIDENCE_MISSING/)
    const feedback = await tool.recover(failure, request, tools.control.signal)
    assert.match(feedback.candidateEvidence.text, /学历[:：]本科/)
    assert.match(feedback.candidateEvidence.text, /Java 后端开发/)
    assert.doesNotMatch(feedback.candidateEvidence.text, /博士/)
    await assert.rejects(tools.execute(tool.name, { ...request, evidenceRefs: ['otherDegree'] }), /CANDIDATE_EVIDENCE_INVALID/)
    const invalid = await tool.recover(new Error('CANDIDATE_EVIDENCE_INVALID'), request, tools.control.signal)
    assert.equal(invalid.candidateEvidence, undefined)
    const corrected = await tools.execute(tool.name, { ...request, listAssessments: [{field:'city',state:'match',quote:'本科',reason:'修正为当前卡片原文'}] })
    assert.equal(corrected.qualified, true)
    await tools.execute('sourcing_finish', { status: 'stopped', reason: '仅验证纠正后的初筛，不保存候选人' })
  }, { splitEvidence: true })
  assert.equal(out.job.candidates.length, 0)
  assert.equal(out.job.scanned, 1); assert.equal(out.job.status, 'stopped')
  assert.doesNotMatch(JSON.stringify(out.job), /学历[:：]本科/)
  const { events, ...record } = out.job
  assert.doesNotMatch(JSON.stringify(record), /陈先生/)
  assert.ok(events.some(event => /候选人\[陈先生\]列表初筛通过/.test(event.message)))
})

test('expanded list evidence still recognizes candidates recorded with legacy identity hashes', async () => {
  await fixture(async tools => {
    await search(tools)
    const selected = await tools.execute('sourcing_select_candidate', { ...tools.identity(), ref: 'card', name: '陈先生', evidenceRefs: ['skills', 'degree'], assessments })
    assert.equal(selected.duplicate, true)
    await finishExhausted(tools, '本测试确认旧版记录不会重复采集')
  }, { splitEvidence: true, run: async ({ executor, create, store, control }) => {
    const prior = await create(['liepin'])
    prior.status = 'completed'; prior.candidates = [{ key: hash({ platform: 'liepin', identity: '陈先生' }) }]
    await store.put('sourcing-' + prior.id, prior)
    const current = await create(['liepin']); await executor.run(current, control.signal)
    assert.equal(current.status, 'completed'); assert.equal(current.scanned, 0); assert.equal(current.candidates.length, 0)
  } })
})

test('returned unknown browser outcomes stop later channels and preserve the actual failure', async () => {
  let runs = 0
  const out = await fixture(async () => { runs++ }, {
    platforms: ['boss', 'liepin'],
    result: { status: 'stopped', message: 'BROWSER_WRITE_OUTCOME_UNKNOWN: TIMEOUT', turns: 1, modelMs: 0, toolMs: 0 },
  })
  assert.equal(runs, 1)
  assert.equal(out.job.status, 'unknown')
  assert.match(out.job.detail, /BOSS 直聘页面操作超时/)
  assert.match(out.job.channels[0].detail, /BROWSER_WRITE_OUTCOME_UNKNOWN: TIMEOUT/)
  assert.equal(out.job.channels[0].status, 'stopped')
  assert.equal(out.job.channels[1].status, 'stopped')
  assert.match(out.job.channels[1].detail, /尚未开始/)
  assert.equal(out.released, 1)
})

test('a normal interrupted channel exposes its reason in the task summary', async () => {
  const out = await fixture(async tools => {
    await tools.execute('sourcing_finish', { status: 'stopped', reason: '登录验证阻止继续搜索' })
  })
  assert.equal(out.job.status, 'stopped')
  assert.match(out.job.detail, /猎聘：登录验证阻止继续搜索/)
})

test('executor requires actual search submission and rejects borrowed resume evidence; results survive both channels', async () => {
  const out = await fixture(async tools => {
    await assert.rejects(select(tools), /SEARCH_CONDITIONS_UNVERIFIED/)
    await assert.rejects(tools.execute('sourcing_confirm_search', { ...tools.identity(), ref: 'query' }), /SEARCH_CONDITIONS_UNVERIFIED|SOURCING_POSITION_SELECTION_REQUIRED/)
    await assert.rejects(tools.execute('browser_click', { ...tools.identity(), ref: 'send', purpose: 'navigation' }), /READ_ONLY/)
    await search(tools); await select(tools)
    await assert.rejects(record(tools, ['other']), /CANDIDATE_EVIDENCE_INVALID/)
    await record(tools)
    assert.equal(tools.opts.isComplete(), true)
  }, { platforms: ['liepin', 'boss'] })
  assert.equal(out.job.status, 'completed'); assert.equal(out.job.candidates.length, 2)
  assert.deepEqual(out.job.candidates.map(row => row.platform), ['liepin', 'boss'])
  assert.equal(out.job.candidates[0].score, 100); assert.equal(out.job.candidates[0].coverage, 100)
  assert.equal(out.released, 1); assert.equal(out.job.results.length, 2)
})
test('new batches deduplicate previously captured identities without merging distinct platforms', async () => {
  await fixture(async tools => { await search(tools); const selected = await select(tools); if (!selected.duplicate) await record(tools); else await finishExhausted(tools, '平台确认没有更多人选') }, {
    run: async ({ executor, create, control }) => {
      const first = await create(['liepin']); await executor.run(first, control.signal)
      const second = await create(['liepin']); await executor.run(second, control.signal)
      assert.equal(first.candidates.length, 1); assert.equal(second.candidates.length, 0)
      assert.deepEqual(second.requirements, first.requirements)
    },
  })
})
test('cancellation stops recording and releases browser ownership while retaining completed results', async () => {
  const out = await fixture(async tools => { await search(tools); await select(tools); tools.control.abort(); await record(tools) }, {logging:true})
  assert.equal(out.job.status, 'stopped'); assert.equal(out.job.candidates.length, 0); assert.equal(out.released, 1)
  const end=out.diagnostics.find(row=>row.event==='sourcing.channel_finished')
  assert.equal(end.aborted,true);assert.equal(end.candidatePending,true);assert.equal(end.candidateCount,0)
})
test('resume fragments survive scrolling and analyses can cite earlier verified chunks', async () => {
  const out = await fixture(async tools => {
    await search(tools); await select(tools)
    await tools.openResume()
    tools.setBody('陈先生 工作经历：Java 后端开发。' + '负责订单服务设计、上线和数据库优化，参与核心服务交付。'.repeat(5))
    await tools.execute('browser_snapshot', { tabId: 1 })
    await tools.execute('sourcing_read_resume', { ...tools.identity(), identityRef: 'resume', resumeRefs: ['resume'] })
    tools.setBody('陈先生 教育经历：计算机专业本科。')
    await tools.execute('browser_snapshot', { tabId: 1 })
    await record(tools)
  })
  assert.equal(out.job.candidates[0].scope, 'online')
  assert.match(out.job.candidates[0].resumeText, /Java 后端开发/)
  assert.match(out.job.candidates[0].resumeText, /计算机专业本科/)
})
test('a later unavailable channel retains results from the completed first platform', async () => {
  let run = 0
  const out = await fixture(async tools => {
    if (++run === 2) throw new Error('LOGIN_REQUIRED: 请登录BOSS')
    await search(tools); await select(tools); await record(tools)
    await tools.execute('sourcing_finish', { status: 'completed', reason: '已读取本渠道可访问的人选' })
  }, { platforms: ['liepin', 'boss'] })
  assert.equal(out.job.status, 'stopped')
  assert.equal(out.job.channels[0].status, 'completed')
  assert.equal(out.job.channels[1].status, 'failed')
  assert.equal(out.job.candidates.length, 1)
})
test('candidate reads reject cross-position records and never overwrite an active batch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sourcing-review-'))
  try {
    const store = new Store(dir, 'company'); await store.init()
    const id = randomUUID(), key = 'a'.repeat(64), workbench = Object.create(Workbench.prototype)
    workbench.store = store
    const job = { id, kind: 'talent_sourcing', jobId: 'one', status: 'running', candidates: [{ key, name: '候选人' }] }
    await store.put('sourcing-' + id, job)
    await assert.rejects(workbench.sourcingBatch({ id, jobId: 'two' }), /没有/)
    assert.equal(workbench.sourcingSaveCandidate, undefined)
    assert.equal((await workbench.sourcingBatch({ id, jobId: 'one' })).candidates[0].key, key)
    assert.deepEqual(await store.get('sourcing-' + id), job)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('foreground dialog text is preserved beyond the DOM 200-character node name without borrowing another dialog', () => {
  const full = '陈先生 工作经历：' + '负责Java系统开发与数据库优化。'.repeat(20) + '教育经历：硕士研究生，海外留学经历。'
  const page = { snapshotId: 'live-dom-shape', items: [
    { ref: 'dialog', role: 'dialog', name: full.slice(0, 200), dialogRef: 'dialog', states: ['enabled'] },
    { ref: 'name', role: 'span', name: '陈先生', dialogRef: 'dialog', states: ['enabled'] },
    { ref: 'other', role: 'dialog', name: '李先生', dialogRef: 'other', states: ['enabled'] },
  ], dialogs: [{ ref: 'dialog', text: full }, { ref: 'other', text: '李先生 其他人的经历' }] }
  const parts = sourcingResumeParts(page, '陈先生', 'name', ['dialog'])
  assert.deepEqual(parts, [full])
  assert.doesNotThrow(() => assessCandidate([{ id: 'master', label: '硕士', weight: 100, must: false }], [{ criterionId: 'master', state: 'match', quote: '教育经历：硕士研究生，海外留学经历。', reason: '有明确原文' }], parts.join('\n')))
  assert.throws(() => sourcingResumeParts(page, '陈先生', 'name', ['other']), /CANDIDATE_EVIDENCE_INVALID/)
  page.items[0].states.push('blocked_by_dialog')
  assert.throws(() => sourcingResumeParts(page, '陈先生', 'name', ['dialog']), /UNREADABLE/)
})

test('separate AX name and resume nodes use their real foreground scope without accepting another candidate', () => {
  const page = { snapshotId: 's', items: [
    { ref: 'root', role: 'RootWebArea', name: '推荐人才' },
    { ref: 'dialog', role: 'dialog', parentRef: 'root', name: '简历详情' },
    { ref: 'name', role: 'StaticText', parentRef: 'dialog', name: '陈 先 生' },
    { ref: 'section', role: 'region', parentRef: 'dialog', name: '工作经历' },
    { ref: 'paragraph', role: 'StaticText', parentRef: 'section', name: 'Java后端开发，负责订单服务' },
    { ref: 'foreign', role: 'article', parentRef: 'root', name: '陈先生' },
    { ref: 'foreign-body', role: 'StaticText', parentRef: 'foreign', name: '其他人的项目' },
  ] }
  assert.deepEqual(sourcingResumeParts(page, '陈先生', 'name', ['paragraph']), ['Java后端开发,负责订单服务'])
  page.items.find(item => item.ref === 'section').role = 'article'
  assert.doesNotThrow(() => sourcingResumeParts(page, '陈先生', 'name', ['paragraph']), 'nested resume sections still belong to the foreground dialog')
  page.items.find(item => item.ref === 'section').role = 'region'
  assert.throws(() => sourcingResumeParts(page, '陈先生', 'name', ['foreign-body']), /RESUME_SCOPE_MISMATCH/)
  page.items[1].role = 'generic'
  assert.throws(() => sourcingResumeParts(page, '陈先生', 'name', ['paragraph']), /RESUME_FRAGMENT_UNRELATED/)
  assert.throws(() => sourcingResumeParts(page, '李先生', 'name', ['paragraph']), /IDENTITY_NAME_MISMATCH/)
})

test('resume collection selects inspected candidate context just as list preflight does', async () => {
  let separate = false
  const out = await fixture(async tools => {
    await search(tools); await select(tools)
    separate = true
    await tools.openResume()
    await tools.execute('browser_snapshot', { tabId: 1 })
    const result = await tools.execute('sourcing_read_resume', { ...tools.identity(), identityRef: 'card', resumeRefs: ['resume'] })
    assert.ok(result.capturedCharacters > 0)
    await tools.execute('sourcing_record_candidate', { ...tools.identity(), identityRef: 'card', resumeRefs: ['resume'], scope: 'online', assessments, fields: [], analysis: '原文核验' })
  }, { transformPage: page => {
    if (separate) Object.assign(page.items.find(item => item.ref === 'resume'), { role: 'text', name: 'Java 后端开发', contextCandidates: [{ text: '陈先生 Java 后端开发 工作经历：负责订单服务和数据库优化。' }] })
    return page
  } })
  assert.equal(out.job.candidates.length, 1)
})

test('resume recovery returns fresh refs and fine-grained reasons; changed evidence has its own bounded budget', async () => {
  const out = await fixture(async tools => {
    await search(tools); await select(tools)
    await tools.openResume()
    const tool = tools.opts.tools.find(tool => tool.name === 'sourcing_record_candidate')
    const request = { ...tools.identity(), identityRef: 'resume', resumeRefs: ['other'], scope: 'online' }
    const priorKey = tool.failureKey(request)
    let error
    try { await tools.execute(tool.name, request) } catch (failure) { error = failure }
    assert.match(error.message, /RESUME_SCOPE_MISMATCH/)
    const recovery = await tool.recover(error, request, tools.control.signal)
    assert.equal(recovery.correction.selectedCandidate.name, '陈先生')
    assert.equal(recovery.correction.reason, 'RESUME_SCOPE_MISMATCH')
    assert.notEqual(recovery.correction.observation.snapshotId, request.snapshotId)
    assert.equal(tool.maxRecoverableFailures, 5)
    assert.equal(tool.failureKey({ ...request, ...tools.identity() }), priorKey, 'refresh alone is not new evidence')
    assert.notEqual(tool.failureKey({ ...request, ...tools.identity(), resumeRefs: ['resume'] }), priorKey)
    await record(tools)
  })
  assert.equal(out.job.candidates.length, 1)
})

test('AI may discard an unresolved candidate and continue without saving it or satisfying quota', async () => {
  const out = await fixture(async tools => {
    await search(tools); await select(tools)
    await tools.openResume()
    await tools.execute('sourcing_read_resume', { ...tools.identity(), identityRef: 'resume', resumeRefs: ['resume'] })
    const skipped = await tools.execute('sourcing_skip_candidate', { reason: '详情关联无法确认' })
    assert.equal(skipped.skipped, true); assert.equal(skipped.saved, false); assert.ok(skipped.discardedCharacters > 0)
    assert.equal(tools.opts.isComplete(), false)
    assert.equal((await select(tools)).duplicate, true)
    tools.setBody('王女士 Java 后端开发 工作经历：负责订单服务和数据库优化。')
    await tools.execute('browser_snapshot', { tabId: 1 })
    await tools.execute('sourcing_select_candidate', { ...tools.identity(), ref: 'card', name: '王女士', assessments })
    await record(tools)
  })
  assert.equal(out.job.status, 'completed'); assert.equal(out.job.skippedUnverified, 1)
  assert.deepEqual(out.job.candidates.map(row => row.name), ['王女士'])
  assert.equal(out.job.greetings?.length ?? 0, 0)
})

test('skip cannot discard a pending greeting or clear its protection', async () => {
  const out = await fixture(async tools => {
    await search(tools); await select(tools); await record(tools)
    await assert.rejects(tools.execute('sourcing_skip_candidate', { reason: '不能以跳过解除招呼保护' }), /TASK_RESULT_REQUIRED/)
    assert.equal(tools.opts.isComplete(), false)
    await tools.execute('sourcing_finish', { status: 'stopped', reason: '本测试不执行招呼' })
  }, { autoGreet: true })
  assert.equal(out.job.candidates.length, 1); assert.equal(out.job.skippedUnverified ?? 0, 0)
  assert.equal(out.calls.filter(name => name === 'greeting_click').length, 0)
})

test('AI legacy scoring arguments are ignored instead of blocking navigation or overriding host assessments', async () => {
  const out = await fixture(async tools => {
    await search(tools)
    const selectTool = tools.opts.tools.find(row => row.name === 'sourcing_select_candidate')
    const selected = await selectTool.execute({ ...tools.identity(), ref: 'card', name: '陈先生', assessments: [{ forged: '模型自报100分' }], filterAssessments: [] }, tools.control.signal)
    assert.equal(selected.score, 100)
    await tools.openResume()
    const recordTool = tools.opts.tools.find(row => row.name === 'sourcing_record_candidate')
    await recordTool.execute({ ...tools.identity(), identityRef: 'resume', resumeRefs: ['resume'], scope: 'online',
      fields: [{ label: '公司', value: '伪造公司' }], analysis: '伪造结论', assessments: [{ forged: '模型自报100分' }] }, tools.control.signal)
  })
  assert.equal(out.job.candidates[0].score, 100)
  assert.doesNotMatch(JSON.stringify(out.job.candidates), /伪造|100分/)
})
test('native Enter has no ref and is authorized only after a successful focused keyword input', async () => {
  const tracker = new SourcingSearchTracker(() => 'Java')
  const page = { snapshotId: 's', documentId: 'doc', items: [{ ref: 'query', role: 'searchbox', name: '搜索人才', value: 'Java', states: ['enabled'] }] }
  const enter = { name: 'browser_press_key', args: { tabId: 1, key: 'Enter' }, readOnly: false, purpose: 'navigation' }
  const type = { name: 'browser_type', args: { tabId: 1, ref: 'query', text: 'Java' }, readOnly: false, purpose: 'navigation' }
  assert.throws(() => assertSourcingNavigation(enter, page), /FOCUS_REQUIRED/)
  await tracker.dispatch(type, page, async () => ({}), () => page)
  await tracker.dispatch({ name: 'browser_snapshot', args: { tabId: 1 }, readOnly: true }, page, async () => page, () => page)
  assert.equal(tracker.hasFocusedSearch(enter, page), true)
  page.items[0].name = '焦点输入框'
  page.items[0].states.push('focused')
  assert.equal(tracker.hasFocusedSearch(enter, page), true, 'DOM placeholder and accessibility labels may differ, but the typed field remains focused')
  page.items[0].value = 'JavaJava'
  assert.equal(tracker.hasFocusedSearch(enter, page), false, 'an appended query is not the requested search')
  page.items[0].value = 'Java'
  assert.doesNotThrow(() => assertSourcingNavigation(enter, page, undefined, tracker.hasFocusedSearch(enter, page)))
  await tracker.dispatch(enter, page, async () => ({}), () => page)
  assert.doesNotThrow(() => tracker.assertSubmitted(1))
  assert.throws(() => tracker.assertSubmitted(2), /UNVERIFIED/)
  await assert.rejects(tracker.dispatch(type, page, async () => { throw Error('PAGE_CHANGED') }, () => page))
  assert.equal(tracker.hasFocusedSearch(enter, page), false)
  assert.throws(() => tracker.assertSubmitted(1), /UNVERIFIED/)
  await tracker.dispatch(type, page, async () => ({}), () => page)
  await tracker.dispatch({ name: 'browser_click', args: { tabId: 1, ref: 'query' }, readOnly: false }, page, async () => ({}), () => page)
  assert.equal(tracker.hasFocusedSearch(enter, page), false)
})
test('sourcing search executes fill, native Enter and confirmation with the actual no-ref key schema', async () => {
  const out = await fixture(async tools => {
    await tools.execute('sourcing_define_requirements', { keyword: 'Java', criteria })
    const searched = await tools.execute('sourcing_search', { ...tools.identity(), inputRef: 'query' })
    assert.ok(searched.observation)
    assert.equal(searched.searchReady, false)
    await assert.rejects(select(tools), /SEARCH_CONDITIONS_UNVERIFIED/)
    await confirmKeyword(tools)
    await select(tools); await record(tools)
  }, { initialKeyword: 'old query', appendByDefault: true })
  assert.equal(out.job.candidates.length, 1)
  assert.equal(out.job.status, 'completed')
  assert.ok(out.calls.includes('browser_press_key'))
})

const greet = async (tools, candidateKey) => tools.execute('sourcing_greet_candidate', {...tools.identity(), candidateKey, ref:'send', identityRef:'card', evidenceRefs:[], position:{ref:'position'}})
test('minimum score is validated, defaults to 60, and accepts both 0 and 100',()=>{
 const input={id:randomUUID(),jobId:'job',platforms:['liepin'],limit:1,confirmed:true}
 assert.equal(sourcingStartSpec.parse(input).minimumScore,60)
 for(const minimumScore of [0,30,100])assert.equal(sourcingStartSpec.parse({...input,minimumScore}).minimumScore,minimumScore)
 for(const minimumScore of [-1,101,30.5,'30',null,NaN])assert.equal(sourcingStartSpec.safeParse({...input,minimumScore}).success,false)
})
test('sourcing task targets allow 1 to 100 per platform and reject larger or non-integer values',()=>{
 const input={id:randomUUID(),jobId:'job',platforms:['liepin','boss'],confirmed:true}
 for(const limit of [1,51,100])assert.equal(sourcingStartSpec.parse({...input,limit}).limit,limit)
 for(const limit of [0,101,1.5,'100',NaN])assert.equal(sourcingStartSpec.safeParse({...input,limit}).success,false)
})
for(const minimumScore of [30,6]) test(`configured threshold ${minimumScore} governs detail persistence and greeting without changing list screening`,async()=>{
 const partial=[{...assessments[0],state:'partial'},assessments[1]]
 const out=await fixture(async tools=>{
  assert.equal(tools.opts.goal.minimumScore,minimumScore);assert.ok(!tools.opts.system.includes('低于60分'))
  await search(tools)
  const selected=await tools.execute('sourcing_select_candidate',{...tools.identity(),ref:'card',name:'陈先生',evidenceRefs:[],assessments:partial})
  assert.equal(selected.qualified,true);assert.equal(selected.score,100)
  await tools.openResume()
  const saved=await tools.execute('sourcing_record_candidate',{...tools.identity(),identityRef:'card',resumeRefs:['card'],scope:'online',fields:[],assessments:partial,analysis:'部分符合'})
  assert.equal(saved.recorded,1)
  await greet(tools,saved.candidateKey)
 },{minimumScore,autoGreet:true,logging:true})
 assert.equal(out.job.minimumScore,minimumScore);assert.equal(out.job.candidates[0].score,50);assert.ok(out.calls.includes('greeting_click'))
 assert.equal(out.diagnostics.find(row=>row.event==='sourcing.candidate_preflight').minimumScore,undefined)
})

test('fixed fields fill an omitted experience check before opening details even at a six-point threshold', async () => {
 const jobPosition={...position,basicRequirements:{experience:'1–3年',education:'大专',city:'上海'},
  searchFields:{experience:'1–3年',education:'大专',city:'上海'},description:position.description+'；3年以上相关软件开发经验；本科及以上学历'}
 const body='陈先生，6年工作经验，大专学历，期望工作城市上海，Java 后端开发，负责订单系统。'
 const out=await fixture(async tools=>{
  tools.setBody(body);await tools.execute('browser_snapshot',{tabId:1})
  const resolved=await tools.execute('sourcing_define_requirements',{keyword:'Java',criteria})
  assert.deepEqual(resolved.listCriteria.map(row=>[row.field,row.requirement]),[['city','上海'],['experience','1–3年'],['education','大专及以上']])
  await tools.execute('sourcing_confirm_search',{...tools.identity(),ref:'position',mode:'position',filters:[]})
  const selected=await tools.execute('sourcing_select_candidate',{...tools.identity(),ref:'card',name:'陈先生',evidenceRefs:[],
   listAssessments:resolved.listCriteria.map(row=>({field:row.field,state:row.field==='experience'?'mismatch':'match',quote:body,reason:row.field==='experience'?'6年超出固定字段1–3年':'原文符合固定字段'}))})
  assert.equal(selected.qualified,false);assert.equal(selected.requiredCount,3);assert.equal(selected.matchedCount,2)
  await assert.rejects(tools.openResume(),/PREFLIGHT_REQUIRED/)
  await finishExhausted(tools,'平台已无更多结果')
 },{position:jobPosition,sourceMode:'recommend',minimumScore:6,logging:true,
  listCriteria:[{field:'education',requirement:'本科及以上',quote:'本科及以上学历'},{field:'city',requirement:'上海',quote:'上海'}]})
 assert.equal(out.job.minimumScore,6);assert.equal(out.job.skippedByFilters,1);assert.equal(out.job.skippedLowScore,0)
 assert.equal(out.job.candidates.length,0)
 assert.match(out.job.events.find(row=>row.message.includes('列表初筛 2/3')).message,/工作经验年限不符合.*1–3年.*6年/)
 assert.match(out.job.detail,/已初筛 1 人，已保存 0 人/)
})
test('raising the detail threshold never blocks a qualified list card, but rejects its low final score',async()=>{
 const high=await fixture(async tools=>{await search(tools);assert.equal((await select(tools)).qualified,true);await tools.openResume();const saved=await tools.execute('sourcing_record_candidate',{...tools.identity(),identityRef:'card',resumeRefs:['card'],scope:'online',fields:[],assessments:[{...assessments[0],state:'partial'},assessments[1]],analysis:'部分符合'});assert.equal(saved.skipped,true);await finishExhausted(tools, '平台确认没有更多结果')},{minimumScore:80})
 assert.equal(high.job.candidates.length,0);assert.equal(high.job.skippedLowScore,1)
 const lower=await fixture(async tools=>{
  await search(tools);await select(tools)
  await tools.openResume()
  const saved=await tools.execute('sourcing_record_candidate',{...tools.identity(),identityRef:'card',resumeRefs:['card'],scope:'online',fields:[],assessments:[{...assessments[0],state:'partial'},assessments[1]],analysis:'部分符合'})
  assert.equal(saved.skipped,true);await finishExhausted(tools, '平台确认没有更多结果')
 },{minimumScore:55,autoGreet:true})
 assert.equal(lower.job.candidates.length,0);assert.equal(lower.calls.includes('greeting_click'),false)
 const zero=await fixture(async tools=>{
  await search(tools)
  const unknown=assessments.map(row=>({...row,state:'unknown',quote:''}))
  assert.equal((await tools.execute('sourcing_select_candidate',{...tools.identity(),ref:'card',name:'陈先生',evidenceRefs:[],assessments:unknown})).qualified,true)
  await tools.openResume()
  await tools.execute('sourcing_record_candidate',{...tools.identity(),identityRef:'card',resumeRefs:['card'],scope:'online',fields:[],assessments:unknown,analysis:'尚无已证实匹配项'})
 },{minimumScore:0})
 assert.equal(zero.job.candidates.length,0);assert.equal(zero.job.skippedUnverified,1)
})
test('unknown required list evidence logs the candidate name but retains no resume or result and cannot open details',async()=>{
 const out=await fixture(async tools=>{
  await search(tools)
  await assert.rejects(tools.execute('browser_click',{...tools.identity(),ref:'detail'}),/PREFLIGHT_REQUIRED/)
  const low=await tools.execute('sourcing_select_candidate',{...tools.identity(),ref:'card',name:'陈先生',evidenceRefs:[],listAssessments:[{field:'city',state:'unknown',quote:'',reason:'列表未展示期望城市'}]})
  assert.equal(low.skipped,true);assert.equal(low.score,0)
  await assert.rejects(tools.execute('browser_click',{...tools.identity(),ref:'detail'}),/PREFLIGHT_REQUIRED/)
  await assert.rejects(tools.execute('sourcing_read_resume',{...tools.identity(),identityRef:'card',resumeRefs:['card']}),/先选择/)
  await finishExhausted(tools, '平台确认没有更多结果')
 })
 assert.equal(out.job.candidates.length,0);assert.equal(out.job.results.length,0);assert.equal(out.job.skippedUnverified,1)
 const {events,...record}=out.job
 assert.doesNotMatch(JSON.stringify(record),/陈先生|订单服务/)
 assert.doesNotMatch(JSON.stringify(events),/订单服务/)
 assert.ok(events.some(event=>/候选人\[陈先生\]列表初筛.*尚无法确认/.test(event.message)))
})

for (const sourceMode of ['recommend', 'search']) test(sourceMode+' list screening requires all four JD conditions and never uses the detail threshold', async () => {
 const listCriteria = [
  {field:'age',requirement:'35岁以下',quote:'年龄35岁以下'},
  {field:'experience',requirement:'5-10年',quote:'工作经验5-10年'},
  {field:'city',requirement:'北京',quote:'期望工作城市北京'},
  {field:'education',requirement:'本科',quote:'学历本科'},
 ]
 const jobPosition = {...position,description:position.description+'；年龄35岁以下；工作经验5-10年；期望工作城市北京；学历本科'}
 const body = '陈先生，32岁，工作经验8年，期望工作城市北京，学历本科'
 for (const state of ['match','mismatch','unknown']) {
  const out = await fixture(async tools => {
   tools.setBody(body)
   await tools.execute('browser_snapshot',{tabId:1})
   await tools.execute('sourcing_define_requirements',{keyword:'Java',criteria})
   if(sourceMode==='recommend') await tools.execute('sourcing_confirm_search',{...tools.identity(),ref:'position',mode:'position',filters:[]})
   else {
    await tools.execute('browser_type',{...tools.identity(),ref:'query',text:'Java'})
    await tools.execute('browser_click',{...tools.identity(),ref:'search'})
    await tools.execute('sourcing_confirm_search',{...tools.identity(),ref:'query',filters:[{field:'city',ref:'city',quote:'上海'},{field:'experience',ref:'experience',quote:'5-10年'},{field:'education',ref:'education',quote:'本科'}]})
   }
   const selected = await tools.execute('sourcing_select_candidate',{...tools.identity(),ref:'card',name:'陈先生',evidenceRefs:[],
    listAssessments:listCriteria.map(c=>({field:c.field,state:c.field==='age'?state:'match',quote:c.field==='age'&&state==='unknown'?'':body,reason:'列表条件核验'})),
    assessments:assessments.map(row=>({...row,state:'unknown',quote:''})),
   })
   assert.equal(selected.requiredCount,4)
   assert.equal(selected.matchedCount,state==='match'?4:3)
   assert.equal(selected.score,state==='match'?100:75)
   assert.equal(selected.qualified,state==='match')
   if(selected.qualified) await tools.openResume()
   else await assert.rejects(tools.openResume(),/PREFLIGHT_REQUIRED/)
   await tools.execute('sourcing_finish',{status:'stopped',reason:'仅核验四维列表初筛，不保存简历'})
  },{sourceMode,position:jobPosition,listCriteria,minimumScore:state==='match'?100:0,logging:true,searchItems:[{ref:'experience',role:'combobox',name:'工作经验',value:'5-10年'},{ref:'education',role:'combobox',name:'学历',value:'本科及以上'}]})
  assert.equal(out.job.status,'stopped',out.job.detail)
  assert.equal(out.job.candidates.length,0)
  assert.equal(out.diagnostics.find(row=>row.event==='sourcing.candidate_preflight').requiredCount,4)
  assert.equal(out.job.skippedLowScore??0,0)
 }
})

test('no explicit basic-information requirements allows detail reading despite zero list skill evidence',async()=>{
 const out=await fixture(async tools=>{
  tools.setBody('陈先生，列表仅有姓名及基本信息')
  await search(tools)
  const selected=await select(tools)
  assert.equal(selected.qualified,true);assert.equal(selected.requiredCount,0);assert.equal(selected.score,null)
  await tools.openResume()
  await tools.execute('sourcing_finish',{status:'stopped',reason:'不限制列表条件，进入详情评估'})
 },{position:{...position,city:''},listCriteria:[],minimumScore:100})
 assert.equal(out.job.status,'stopped',out.job.detail)
})
test('missing core evidence is skipped without saving an intermediate candidate or consuming quota',async()=>{
 const out=await fixture(async tools=>{
  await search(tools);await select(tools)
  await tools.openResume()
  const saved=await tools.execute('sourcing_record_candidate',{...tools.identity(),identityRef:'card',resumeRefs:['card'],scope:'online',fields:[],assessments:assessments.map(row=>({...row,state:'unknown',quote:''})),analysis:'缺少证据'})
  assert.equal(saved.skipped,true);assert.equal(saved.qualified,false);assert.equal(tools.opts.isComplete(),false)
  await finishExhausted(tools, '平台确认没有更多结果')
 },{autoGreet:true})
 assert.equal(out.job.candidates.length,0);assert.equal(out.job.skippedUnverified,1);assert.equal(out.job.greetings.length,0);assert.equal(out.calls.includes('greeting_click'),false)
 assert.ok(out.job.events.some(row=>/证据不足.*已跳过/.test(row.message)))
})
test('an unknown core item does not block greeting when overall evidence and score qualify',async()=>{
 const out=await fixture(async tools=>{
  await search(tools);await select(tools);const saved=await record(tools)
  assert.equal(saved.needsGreeting,true)
  await greet(tools,saved.candidateKey)
 },{autoGreet:true,position:{...position,description:'Java 后端开发，支付经验'},criteria:criteria.map((row,index)=>({...row,quote:index?'支付经验':row.quote,tier:'core',must:false,weight:index?30:70}))})
 assert.equal(out.job.candidates.length,1,out.job.detail)
 assert.equal(out.job.candidates[0].coverage,70)
 assert.equal(out.job.candidates[0].scoring.needsReview,false)
 assert.equal(out.job.greetings[0].stage,'succeeded')
 assert.equal(out.calls.filter(call=>call==='greeting_click').length,1)
})
test('last accepted candidate is greeted before quota completion and actual click is persisted',async()=>{
 const out=await fixture(async tools=>{
  await search(tools);await select(tools);const saved=await record(tools)
  assert.equal(saved.needsGreeting,true);assert.equal(tools.opts.isComplete(),false)
  await assert.rejects(select(tools),/TASK_RESULT_REQUIRED/)
  await assert.rejects(tools.execute('browser_click',{...tools.identity(),ref:'send',purpose:'business_write'}),/READ_ONLY/)
  const receipt=await greet(tools,saved.candidateKey);assert.equal(receipt.clicked,true)
  assert.equal(tools.opts.isComplete(),true)
 },{autoGreet:true})
 assert.equal(out.job.status,'completed');assert.equal(out.job.greetings[0].stage,'succeeded');assert.ok(out.job.greetings[0].clickedAt)
 assert.equal(out.calls.filter(call=>call==='greeting_click').length,1)
})
for(const [label,options,pattern] of [['wrong position',{wrongPosition:true},/POSITION_EVIDENCE/],['wrong candidate',{wrongIdentity:true},/CANDIDATE_EVIDENCE/]]) test('auto greet refuses '+label,async()=>{
 const out=await fixture(async tools=>{await search(tools);await select(tools);const saved=await record(tools);await assert.rejects(greet(tools,saved.candidateKey),pattern);await tools.execute('sourcing_finish',{status:'stopped',reason:'无法核验'})},{autoGreet:true,...options})
 assert.equal(out.calls.includes('greeting_click'),false);assert.equal(out.job.greetings[0].stage,'skipped')
})
test('automatic greeting off rejects the write tool even for accepted candidates',async()=>{
 const out=await fixture(async tools=>{await search(tools);await select(tools);await record(tools);await assert.rejects(greet(tools,'a'.repeat(64)),/NOT_AUTHORIZED/)})
 assert.equal(out.calls.includes('greeting_click'),false)
})
test('unknown greeting click stops the task and cannot be replayed',async()=>{
 const out=await fixture(async tools=>{await search(tools);await select(tools);const saved=await record(tools);await greet(tools,saved.candidateKey)},{autoGreet:true,clickError:'TOOL_CALL_OUTCOME_UNKNOWN: disconnected'})
 assert.equal(out.job.status,'unknown');assert.equal(out.job.greetings[0].stage,'unknown');assert.ok(out.job.greetings[0].attemptedAt)
 assert.equal(out.calls.filter(call=>call==='greeting_click').length,1)
})
test('guaranteed pre-dispatch greeting failure does not consume quota or imply contact',async()=>{
 const out=await fixture(async tools=>{await search(tools);await select(tools);const saved=await record(tools);await assert.rejects(greet(tools,saved.candidateKey),/ELEMENT_OCCLUDED/);await tools.execute('sourcing_finish',{status:'stopped',reason:'按钮被遮挡'})},{autoGreet:true,clickError:'ELEMENT_OCCLUDED'})
 assert.equal(out.job.greetings[0].attemptedAt,undefined);assert.equal(out.job.greetings[0].stage,'skipped')
})
test('already contacted platform state skips greeting without dispatch',async()=>{
 const out=await fixture(async tools=>{await search(tools);await select(tools);const saved=await record(tools);const receipt=await greet(tools,saved.candidateKey);assert.equal(receipt.knownContacted,true)},{autoGreet:true,contacted:true})
 assert.equal(out.calls.includes('greeting_click'),false);assert.equal(out.job.greetings[0].knownContacted,true)
})

for (const [stage, expected] of [['succeeded','skipped'],['unknown','skipped']]) test('auto greet reconciles existing '+stage+' history across workflows before dispatch',async()=>{
 const out=await fixture(async tools=>{
  await search(tools);await select(tools);const saved=await record(tools)
  await tools.store.put('greeting-prior',{id:'prior',kind:'greeting',platform:'liepin',createdAt:'2025-01-01',results:[{key:hash(['liepin',normalized(tools.body)]),name:'陈先生',identityKind:'text',stage,attemptedAt:'2025-01-01',...(stage==='succeeded'?{clickedAt:'2025-01-01'}:{}),updatedAt:'2025-01-01'}]})
  if(stage==='unknown') await greet(tools,saved.candidateKey)
  else assert.equal((await greet(tools,saved.candidateKey)).knownContacted,true)
 },{autoGreet:true})
 assert.equal(out.calls.includes('greeting_click'),false)
 assert.equal(out.job.status,stage==='unknown'?'unknown':'completed')
 assert.equal(out.job.greetings[0].stage,expected)
})
test('shared daily quota includes prior sourcing greetings and blocks new dispatch',async()=>{
 const out=await fixture(async tools=>{
  await search(tools);await select(tools);const saved=await record(tools)
  await tools.store.put('sourcing-prior',{id:'prior',kind:'talent_sourcing',jobId:'other-job',createdAt:new Date().toISOString(),candidates:[],results:[],greetings:Array.from({length:100},(_,i)=>({key:'other-'+i,candidateKey:'other-'+i,platform:'liepin',name:'其他人'+i,stage:'succeeded',attemptedAt:new Date().toISOString(),clickedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}))})
  await assert.rejects(greet(tools,saved.candidateKey),/TASK_DAILY_LIMIT_REACHED/)
  await tools.execute('sourcing_finish',{status:'stopped',reason:'今日额度用尽'})
 },{autoGreet:true})
 assert.equal(out.calls.includes('greeting_click'),false);assert.equal(out.job.greetings[0].attemptedAt,undefined)
})

test('restart keeps attempted sourcing greetings unknown and never replays queued writes',async()=>{
 await fixture(async()=>{}, {autoGreet:true,run:async({store,create})=>{
  const job=await create(['liepin']);job.status='running';job.greetings=[{key:'sent',candidateKey:'one',platform:'liepin',name:'一',stage:'sending',attemptedAt:new Date().toISOString(),updatedAt:new Date().toISOString()},{key:'queued',candidateKey:'two',platform:'liepin',name:'二',stage:'sending',updatedAt:new Date().toISOString()}]
  await store.put('sourcing-'+job.id,job)
  const service=Object.create(Workbench.prototype);Object.assign(service,{store,executors:new Map([['talent_sourcing',{kind:'talent_sourcing',storagePrefix:'sourcing-'}]])})
  await service.initialize()
  const restored=await store.get('sourcing-'+job.id)
  assert.equal(restored.status,'unknown');assert.equal(restored.greetings[0].stage,'unknown');assert.equal(restored.greetings[1].stage,'skipped')
 }})
})

test('qualified selection cannot authorize opening another candidate profile',async()=>{
 const out=await fixture(async tools=>{
  await search(tools);await select(tools)
  await assert.rejects(tools.execute('browser_click',{...tools.identity(),ref:'foreignProfile'}),/CANDIDATE_EVIDENCE_INVALID/)
  await tools.execute('browser_click',{...tools.identity(),ref:'detail'})
  await record(tools)
 })
 assert.equal(out.job.candidates.length,1);assert.equal(out.job.candidates[0].name,'陈先生')
})

test('recommendation session blocks keyword tools and observed search destinations before native dispatch', async () => {
  const out = await fixture(async tools => {
    await search(tools)
    await assert.rejects(tools.execute('sourcing_search', { ...tools.identity(), inputRef: 'query' }), /RECOMMENDATION_REQUIRED/)
    await assert.rejects(tools.execute('browser_type', { ...tools.identity(), ref: 'query', text: 'Java' }), /RECOMMENDATION_REQUIRED/)
    await assert.rejects(tools.execute('browser_click', { ...tools.identity(), ref: 'search-route' }), /RECOMMENDATION_REQUIRED/)
    await select(tools)
    await assert.rejects(tools.execute('browser_click', { ...tools.identity(), ref: 'search-route' }), /RECOMMENDATION_REQUIRED/)
    await record(tools)
  }, { sourceMode: 'recommend', searchItems: [{ ref: 'search-route', role: 'link', name: '高级筛选', href: 'https://lpt.liepin.com/search' }] })
  assert.equal(out.job.status, 'completed', out.job.detail)
  assert.equal(out.job.candidates.length, 1)
  assert.equal(out.calls.filter(name => name === 'browser_click').length, 1, 'only the selected resume is opened')
  assert.equal(out.calls.includes('browser_type'), false)
})

test('an unexpected redirect to search invalidates recommendation reads and cannot fake exhaustion', async () => {
  const options = { sourceMode: 'recommend' }
  const out = await fixture(async tools => {
    await search(tools)
    options.pagePath = '/search'
    await tools.execute('browser_snapshot', { tabId: 1 })
    await assert.rejects(select(tools), /RECOMMENDATION_REQUIRED/)
    await assert.rejects(finishExhausted(tools, 'no results'), /RECOMMENDATION_REQUIRED/)
    await tools.execute('sourcing_finish', { status: 'stopped', reason: 'Unexpected source redirect' })
  }, options)
  assert.equal(out.job.status, 'stopped')
  assert.equal(out.job.candidates.length, 0)
})

test('recommendation without a city UI filter proceeds only with per-candidate condition evidence', async () => {
  const out = await fixture(async tools => {
    await tools.execute('sourcing_define_requirements', { keyword: 'Java', criteria })
    await tools.execute('sourcing_confirm_search', { ...tools.identity(), ref: 'position', mode: 'position', filters: [] })
    await select(tools); await record(tools)
  }, { sourceMode: 'recommend' })
  assert.equal(out.job.status, 'completed', out.job.detail)
  assert.equal(out.job.candidates.length, 1)
  assert.deepEqual(out.job.candidates[0].filterAssessments.map(row => [row.field, row.state]), [['city', 'match']])
})

for (const state of ['unknown', 'mismatch']) test('recommendation '+state+' conditions cannot be saved or greeted even with a passing skill score', async () => {
  const out = await fixture(async tools => {
    await search(tools)
    const selected = await select(tools)
    if (selected.qualified) {
      const saved = await record(tools)
      assert.equal(saved.skipped, true)
    } else assert.equal(selected.skipped, true)
    await finishExhausted(tools, 'Verified end of recommendation list')
  }, { sourceMode: 'recommend', filterState: state, autoGreet: true })
  assert.equal(out.job.status, 'completed', out.job.detail)
  assert.equal(out.job.candidates.length, 0)
  assert.equal((out.job.skippedByFilters ?? 0) + (out.job.skippedUnverified ?? 0), 1)
  assert.equal(out.calls.includes('greeting_click'), false)
})

test('same masked name with a different legacy key never blocks a new greeting',async()=>{
 const out=await fixture(async tools=>{
  await search(tools);await select(tools);const saved=await record(tools)
  await tools.store.put('greeting-prior',{id:'prior',kind:'greeting',platform:'liepin',createdAt:'2025-01-01',results:[{key:hash('another-person'),name:'陈先生',stage:'succeeded',attemptedAt:'2025-01-01',updatedAt:'2025-01-01'}]})
  assert.equal((await greet(tools,saved.candidateKey)).clicked,true)
 },{autoGreet:true})
 assert.equal(out.job.status,'completed',out.job.detail);assert.equal(out.calls.filter(c=>c==='greeting_click').length,1)
})
test('exact legacy success without clickedAt skips rather than becomes unknown',async()=>{
 const out=await fixture(async tools=>{
  await search(tools);await select(tools);const saved=await record(tools)
  await tools.store.put('greeting-prior',{id:'prior',kind:'greeting',platform:'liepin',createdAt:'2025-01-01',results:[{key:hash(['liepin',normalized(tools.body)]),name:'陈先生',stage:'succeeded',attemptedAt:'2025-01-01',updatedAt:'2025-01-01'}]})
  assert.equal((await greet(tools,saved.candidateKey)).knownContacted,true)
 },{autoGreet:true})
 assert.equal(out.job.status,'completed');assert.equal(out.calls.includes('greeting_click'),false)
})
test('observed resume ID is saved, rechecked for greeting and deduplicates changed card text',async()=>{
 const out=await fixture(async tools=>{
  await search(tools);await select(tools);const saved=await record(tools)
  assert.equal((await greet(tools,saved.candidateKey)).clicked,true)
  tools.setBody(tools.body+' 最新活跃状态：刚刚在线。')
  assert.equal((await select(tools)).duplicate,true)
  await tools.execute('sourcing_finish',{status:'stopped',reason:'同一ID已处理'})
 },{autoGreet:true,resumeId:'opaqueResume123',limit:2})
 assert.equal(out.job.candidates.length,1,out.job.detail)
 assert.deepEqual(out.job.candidates[0].platformIdentity,{kind:'resume',id:'opaqueResume123',source:'card_class'})
 assert.equal(out.job.greetings[0].platformIdentity.id,'opaqueResume123')
 assert.equal(out.job.greetings[0].identityKind,'platform_id')
 assert.equal(out.calls.filter(c=>c==='greeting_click').length,1)
})
test('a duplicate gives a next-list action and a no-op skip cannot reset repeated duplicate selection',async()=>{
 const out=await fixture(async tools=>{
  await search(tools);await select(tools);await record(tools)
  await tools.returnToList()
  const duplicate=await select(tools)
  assert.equal(duplicate.duplicate,true)
  assert.ok(duplicate.candidateKey)
  assert.match(duplicate.next,/无需调用skip/)
  assert.equal((await tools.execute('sourcing_skip_candidate',{reason:'重复人选不应创建待处理状态'})).skipped,false)
  await assert.rejects(select(tools),/SOURCING_DUPLICATE_REPEAT/)
  await tools.execute('sourcing_finish',{status:'stopped',reason:'重复人选已明确处理'})
 },{resumeId:'observedResume123',limit:2})
 assert.equal(out.job.candidates.length,1)
 assert.equal(out.job.scanned,1)
})
test('different resume IDs with identical display text do not inherit unknown history',async()=>{
 const out=await fixture(async tools=>{
  await search(tools);await select(tools);const saved=await record(tools)
  await tools.store.put('greeting-prior',{id:'prior',kind:'greeting',platform:'liepin',createdAt:'2025-01-01',results:[{key:hash('old-person'),name:'陈先生',identityAliases:[hash(['liepin',normalized(tools.body)])],platformIdentity:{kind:'resume',id:'differentResume456',source:'card_class'},stage:'unknown',attemptedAt:'2025-01-01',updatedAt:'2025-01-01'}]})
  assert.equal((await greet(tools,saved.candidateKey)).clicked,true)
 },{autoGreet:true,resumeId:'currentResume123'})
 assert.equal(out.job.status,'completed',out.job.detail);assert.equal(out.calls.filter(c=>c==='greeting_click').length,1)
})
test('a changed observed resume ID cannot authorize greeting for a saved candidate',async()=>{
 let current='resumeBefore123'
 const out=await fixture(async tools=>{
  await search(tools);await select(tools);const saved=await record(tools)
  current='resumeAfter456'
  await tools.execute('browser_snapshot',{tabId:1})
  await assert.rejects(greet(tools,saved.candidateKey),/CANDIDATE_EVIDENCE_INVALID/)
  await tools.execute('sourcing_finish',{status:'stopped',reason:'身份发生改变'})
 },{autoGreet:true,resumeId:()=>current})
 assert.equal(out.job.candidates.length,1,out.job.detail)
 assert.equal(out.calls.includes('greeting_click'),false)
})

test('list resume ID can authorize the already evaluated foreground detail without comparing summary and full text',async()=>{
 let detail=false
 const full='陈先生 Java 后端开发 工作经历：负责订单和数据库系统开发，使用Java技术实现接口及服务。'.repeat(10)
 const out=await fixture(async tools=>{
  await search(tools);await select(tools)
  detail=true;tools.setBody(full);await tools.execute('browser_snapshot',{tabId:1})
  const saved=await record(tools)
  const receipt=await greet(tools,saved.candidateKey)
  assert.equal(receipt.clicked,true)
 },{autoGreet:true,resumeId:()=>detail?undefined:'savedResume123',transformPage:p=>detail?{...p,dialogs:[{ref:'foreground',text:full}],items:[...p.items.map(i=>['card','resume','send','position'].includes(i.ref)?{...i,dialogRef:'foreground'}:i),{ref:'foreground',role:'dialog',name:full}]}:p})
 assert.equal(out.job.status,'completed',out.job.detail)
 assert.equal(out.job.candidates[0].platformIdentity.id,'savedResume123')
 assert.equal(out.calls.filter(c=>c==='greeting_click').length,1)
})


test('supplement coverage is enforced before navigation and previous-role stability remains an independent bonus', async () => {
  const supplement = '优先上一段工作经历时间超过2年的'
  const tenure = { id: 'tenure', label: '上一段任职超过2年', quote: supplement, tier: 'bonus', must: false, weight: 5 }
  const standard = [{ ...modelCriteria[0] }, { ...modelCriteria[1], weight: 5 }, tenure]
  const coverage = [{ quote: supplement, criterionIds: ['tenure'], listFields: [] }]
  const out = await fixture(async tools => {
    assert.ok(tools.opts.system.includes(recruitmentMatchingSkill().content))
    assert.deepEqual(tools.opts.goal.supplementParts, [supplement])
    const define = tools.opts.tools.find(tool => tool.name === 'sourcing_define_requirements')
    await assert.rejects(define.execute({ keyword: 'Java', criteria: standard, listCriteria: [], supplementCoverage: [] }, tools.control.signal), /SUPPLEMENT_UNCOVERED/)
    await search(tools)
    assert.deepEqual(tools.opts.goal.searchFilters, { city: '上海' })
    tools.setBody('陈先生 Java 后端开发 本科 上海 工作经历：上家公司2020.01—2024.06，负责Java 后端开发及订单服务。')
    await select(tools); await tools.openResume()
    const saved = await tools.execute('sourcing_record_candidate', { ...tools.identity(), identityRef: 'resume', resumeRefs: ['resume'], scope: 'online', fields: [],
      assessments: [{ ...assessments[0], state: 'partial' }, assessments[1], { criterionId: 'tenure', state: 'match', quote: '上家公司2020.01—2024.06', reason: '上一段任职超过4年', evidenceKind: 'direct', confidence: 'high' }], analysis: '核心能力部分符合，上一段任职稳定性加分' })
    assert.equal(saved.recorded, 1)
    assert.equal(saved.needsGreeting, false)
  }, { supplement, criteria: standard, supplementCoverage: coverage, minimumScore: 50 })
  assert.equal(out.job.status, 'completed', out.job.detail)
  assert.equal(out.job.candidates[0].score, 55)
  assert.equal(out.job.candidates[0].scoring.bonusScore, 5)
  assert.equal(out.job.requirements.rubricVersion, 2)
  assert.deepEqual(out.job.requirements.supplementCoverage, coverage)
})
