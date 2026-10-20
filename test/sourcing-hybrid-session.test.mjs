import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/lib/store.js'
import { SourcingAgent } from '../dist/lib/sourcing-agent.js'
import { recruitmentPlatform } from '../dist/lib/platforms/registry.js'
import { LiepinSourcingDriver } from '../dist/lib/platforms/liepin/sourcing-driver.js'

const captured = JSON.parse(readFileSync(new URL('./fixtures/liepin-search-controls.json', import.meta.url)))
const degrees = JSON.parse(readFileSync(new URL('./fixtures/liepin-education-selected.json', import.meta.url)))
const properties = { tabId: { type: 'integer' }, snapshotId: { type: 'string' }, ref: { type: 'string' } }
const info = (name, readOnly, properties, required = []) => ({ name, inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly }, _meta: { browserAgent: { available: true } } })
const infos = [info('browser_list_tabs', true, {}), info('browser_snapshot', true, { tabId: properties.tabId, format: { type: 'string' }, viewportOnly: { type: 'boolean' } }),
  info('browser_inspect_element', true, properties), info('browser_click', false, properties), info('browser_scroll', false, { tabId: properties.tabId, deltaY: { type: 'number' } })]

async function runFixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sourcing-hybrid-'))
  const store = new Store(dir, 'company'); await store.init()
  const jobName = captured.position.item.name
  const sourceMode = options.sourceMode ?? 'search'
  const entryUrl = 'https://lpt.liepin.com/' + (sourceMode === 'recommend' ? 'recommend' : 'search')
  const criteria = [{ id: 'java', label: 'Java开发', quote: 'Java开发', weight: 100, must: true }]
  let revision = 0, detail = false, released = false, fallbackCalls = 0, batches = 0, greetingClicks = 0, scrollY = options.scrollY ?? 0
  let resultSnapshots = 0, listFailureRaised = false, positionOpen = !!options.positionOpen, draftSelected = !!options.draftSelected, positionApplied = !options.unselectedPosition
  const diagnostics = []
  const clicks = [], native = [], selected = new Set(options.selectedDegrees ?? [])
  const candidateName = options.name ?? '陈先生'
  let activeName = candidateName, documentEpoch = 0, lastFormat, returnedFromDetail = false
  const cardText = candidateName + ' 30岁 6年经验 本科 武汉 Java开发 工作经历：测试公司负责Java开发。'
  const resumeText = candidateName + ' 30岁 工作6年 武汉 本科 工作经历：在测试公司负责Java开发，开发订单服务和数据库维护。项目经历：Java开发订单管理系统，负责服务设计、接口维护、需求评审和代码检查。' + 'Java开发项目职责和技术经历。'.repeat(12)
  const detailText = () => (options.detailGreeting ? `推荐职位：\n${jobName}\n` : '') + resumeText.replaceAll(candidateName, activeName)
  const base = () => options.recommendTabs ? [
    { ref: 'recommend-position', role: 'tab', name: jobName + (options.recommendBadge ? ' 高交付' : ''), elementId: 'rc-tabs-2-tab-83698185', states: positionApplied ? ['selected'] : [] },
    { ref: 'recommend-city', role: 'combobox', tagName: 'div', name: '期望城市', value: '武汉', states: [] },
    { ref: 'recommend-education', role: 'button', name: '学历：本科及以上', states: [] },
    ...(options.exhausted ? [{ ref: 'recommend-end', role: 'text', name: '没有更多推荐人才', states: [] }] : []),
  ] : [{ ...structuredClone(captured.position.item), name: positionApplied ? jobName : '不限职位' },
    ...(options.nestedPosition ? [{ ref: 'nested-position', ...(options.separatePosition ? {} : { parentRef: captured.position.item.ref }), name: positionApplied ? jobName : '不限职位', role: 'div', states: [] }] : []),
    ...(positionOpen ? [{ ref: 'job-option', role: 'StaticText', name: jobName, states: [] }, { ref: 'job-confirm', role: 'button', name: '确定', states: [] },
      { ref: 'wrong-confirm', role: 'button', name: '确定', states: [] }] : []), structuredClone(captured.city.item),
    ...degrees.map(d => ({ ...structuredClone(d.item), states: [] })), { ref: 'search', role: 'button', name: '搜索', states: [] }]
  const card = () => [{ ref: 'root', role: 'div', name: cardText, states: [] },
    { ref: 'name', role: 'StaticText', name: candidateName, parentRef: 'root', context: { text: cardText }, states: [] },
    { ref: 'greet', role: 'button', name: '立即沟通', parentRef: 'root', context: { text: cardText }, states: [] },
    ...(options.twoCandidates ? [{ ref: 'root2', role: 'div', name: cardText.replaceAll(candidateName, '李明'), states: [] },
      { ref: 'name2', role: 'StaticText', name: '李明', parentRef: 'root2', context: { text: cardText.replaceAll(candidateName, '李明') }, states: [] },
      { ref: 'greet2', role: 'button', name: '立即沟通', parentRef: 'root2', context: { text: cardText.replaceAll(candidateName, '李明') }, states: [] }] : [])]
  const page = () => ({ tabId: 1, snapshotId: `s${revision}`, documentId: options.renewDocument ? `doc-${documentEpoch}` : 'doc', format: 'dom', url: entryUrl,
    viewport: { width: 1440, height: 704, scrollY },
    items: detail ? [{ ref: 'dialog', role: 'dialog', name: detailText().slice(0, 200), dialogRef: 'dialog', states: [] },
      ...(options.detailGreeting ? [{ ref: 'greet', role: 'button', name: '立即沟通', context: { text: detailText() }, dialogRef: 'dialog', states: [] }] : []),
      { ref: 'close', role: 'img', name: 'close', dialogRef: 'dialog', states: [] }] : [...base(), ...(options.exhausted ? [] : card())],
    dialogs: detail ? [{ ref: 'dialog', text: detailText() }] : [] })
  const call = async (name, args) => {
    native.push(name)
    if (name === 'browser_finish') { released = true; return {} }
    if (name === 'browser_list_tabs') return { tabs: [{ tabId: 1, url: entryUrl }] }
    if (name === 'browser_snapshot') {
      lastFormat = args.format
      if (options.recoverFromList && !listFailureRaised && args.format === 'dom' && args.viewportOnly === false) {
        listFailureRaised = true
        throw Error('SOURCING_HANDOFF: list_no_progress')
      }
      revision++
      const snapshot = page()
      if (!detail && options.clippedViewport && args.viewportOnly) snapshot.items = snapshot.items.filter(i => i.ref !== 'name' && i.ref !== 'root')
      if (!detail && options.delayedResults && ++resultSnapshots <= 2) snapshot.items = base()
      return snapshot
    }
    if (name === 'browser_scroll') { scrollY = Math.max(0, scrollY + args.deltaY); revision++; return { dispatched: true, snapshot: page() } }
    assert.equal(args.snapshotId, page().snapshotId)
    if (name === 'browser_inspect_element') {
      if (args.ref === captured.position.item.ref || args.ref === 'nested-position') { const copy = structuredClone(captured.position.inspection); copy.element.visible = scrollY === 0; copy.item.name = positionApplied ? jobName : '不限职位';
        copy.item.ref = args.ref
        if (args.ref === 'nested-position' && !options.separatePosition) copy.item.parentRef = captured.position.item.ref
        if (positionOpen) copy.ancestors[0].attributes.class += ' ant-lpt-dropdown-open'; return copy }
      if (args.ref === 'job-option') return { element: { tagName: 'div', attributes: { class: 'job-title' }, visible: true }, ancestors: [{ attributes: { class: 'jobs-item' + (draftSelected ? ' active' : '') } }, { attributes: { class: 'jobs-list' } }] }
      if (args.ref === 'job-confirm') return { element: { tagName: 'button', visible: true }, ancestors: [{ attributes: { class: 'jobs-handle' } }, { attributes: { class: 'select-jobs-content-wrap' } }] }
      if (args.ref === 'wrong-confirm') return { element: { tagName: 'button', visible: false }, ancestors: [{ attributes: { class: 'inputGroup' } }] }
      if (args.ref === captured.city.item.ref) return structuredClone(captured.city.inspection)
      const degree = degrees.find(d => d.item.ref === args.ref)
      if (degree && options.domFilterRowsMissing && returnedFromDetail && lastFormat === 'dom') return { element: { tagName: 'label', visible: true }, ancestors: [] }
      if (degree) { const copy = structuredClone(degree.inspection); copy.element.attributes.class = selected.has(degree.item.name) ? 'search-page-filter-item-active' : 'search-page-filter-item'; return copy }
      if (args.ref === 'search') return { element: { tagName: 'button', visible: true }, ancestors: [{ attributes: { class: 'searchInputBox--hash' } }] }
      if (args.ref === 'close') return { element: { tagName: 'span', visible: true }, ancestors: [{ attributes: { class: 'closeBtn--hash' } }] }
      return { item: page().items.find(i => i.ref === args.ref), element: { tagName: 'span', visible: true }, ancestors: [] }
    }
    if (name === 'browser_click') {
      clicks.push(args.ref)
      if (args.ref === 'recommend-position') positionApplied = true
      if (args.ref === captured.position.item.ref) positionOpen = true
      if (args.ref === 'job-option') draftSelected = !draftSelected
      if (args.ref === 'job-confirm') { assert.equal(draftSelected, true); positionApplied = true; positionOpen = false }
      if (args.ref === 'wrong-confirm') throw Error('wrong confirmation')
      if ((args.ref === captured.city.item.ref || degrees.some(d => d.item.ref === args.ref)) && positionOpen) throw Error('ELEMENT_OCCLUDED: position panel is still open')
      if (args.ref === 'greet') {
        greetingClicks++
        assert.equal(options.autoGreet, true, 'read-only run must not greet')
        assert.equal(args.policy.riskLevel, 'business_write')
        if (options.greetingError) throw Error(options.greetingError)
      }
      if (args.ref === 'name' || args.ref === 'name2') { if (options.openError) throw Error(options.openError); detail = true; activeName = args.ref === 'name' ? candidateName : '李明'; documentEpoch++ }
      if (args.ref === 'close') { if (options.closeError) throw Error(options.closeError); detail = false; returnedFromDetail = true; if (options.domFilterRowsMissing) lastFormat = 'semantic' }
      const d = degrees.find(d => d.item.ref === args.ref)
      if (d) selected.has(d.item.name) ? selected.delete(d.item.name) : selected.add(d.item.name)
      revision++; return { dispatched: true, snapshot: page() }
    }
    throw Error('unexpected ' + name)
  }
  const agent = async opts => {
    if (opts.tools[0]?.name !== 'sourcing_submit_assessments') {
      fallbackCalls++
      if (options.recoverFromList) {
        const execute = (name, args) => opts.tools.find(t => t.name === name).execute(args, opts.signal)
        if (sourceMode === 'recommend') {
          assert.equal(opts.goal.sourceMode, 'recommend')
          assert.equal(opts.goal.entryUrl, 'https://lpt.liepin.com/recommend')
          assert.doesNotMatch(opts.system, /然后从已有平台页的实际搜索入口进入人才搜索/)
          await assert.rejects(execute('sourcing_search', { tabId: 1, snapshotId: page().snapshotId, inputRef: 'query' }), /SOURCING_RECOMMENDATION_REQUIRED/)
        }
        const select = opts.tools.find(t => t.name === 'sourcing_select_candidate')
        const record = opts.tools.find(t => t.name === 'sourcing_record_candidate')
        assert.equal(select.inputSchema.properties.assessments, undefined)
        for (const key of ['fields', 'assessments', 'analysis']) assert.equal(record.inputSchema.properties[key], undefined)
        await execute('browser_snapshot', { tabId: 1, format: 'dom' })
        const selected = await execute(select.name, { tabId: 1, snapshotId: page().snapshotId, name: candidateName, ref: 'greet', evidenceRefs: ['name'] })
        assert.equal(selected.qualified, true)
        await execute('browser_snapshot', { tabId: 1, format: 'dom' })
        await execute('browser_click', { tabId: 1, snapshotId: page().snapshotId, ref: 'name', purpose: 'navigation' })
        await execute(record.name, { tabId: 1, snapshotId: page().snapshotId, identityRef: 'dialog', resumeRefs: ['dialog'], scope: 'online' })
        assert.equal(opts.isComplete(), true)
        return { status: 'completed', message: 'recovered', turns: 3, modelMs: 30, toolMs: 0 }
      }
      return { status: 'stopped', message: 'fallback', turns: 0, modelMs: 0, toolMs: 0 }
    }
    batches++
    await opts.tools[0].execute({ candidates: opts.goal.candidates.map(s => ({ sourceId: s.sourceId, ...(opts.goal.mode === 'detail' ? { fields: [{ label: '学历', value: '本科' }, ...(options.ungroundedSalary ? [{ label: '期望薪资', value: '30-50K' }] : [])] } : {}),
      ...(opts.goal.candidateFilters ? { filterAssessments: Object.keys(opts.goal.candidateFilters).map(field => ({ field, state: options.filterState ?? 'match', evidenceId: options.filterState === 'unknown' ? null : 0, reason: 'Candidate source evidence' })) } : {}),
      assessments: [{ criterionId: 'java', state: options.lowScore ? 'unknown' : 'match', evidenceId: options.lowScore ? null : 0, reason: '原文明确列出Java开发' }] })) }, opts.signal)
    return { status: 'completed', message: 'done', turns: 1, modelMs: 10, toolMs: 1 }
  }
  const executor = new SourcingAgent(store, call, async () => {}, async () => infos, () => agent, async () => ({
    id: 'job', name: jobName, city: '武汉', department: '研发', description: 'Java开发，学历要求：本科', platforms: ['liepin'], fetchedAt: new Date().toISOString(), searchFields: { education: '本科' },
  }), { write: (_level, event, fields) => diagnostics.push({event,...fields}), updateContext: () => {} },
    options.recommendTabs ? { loadPlatformJobs: async () => [{ id: '83698185', name: jobName }] } : {})
  const controller = new AbortController()
  try {
    const job = executor.create({ id: '32cfb184-78bc-4817-aa0b-4f6da48fc942', jobId: 'job', platforms: ['liepin'], sourceMode, limit: options.twoCandidates ? 2 : 1, minimumScore: 40, autoGreet: !!options.autoGreet, confirmed: true })
    await executor.prepare(job, controller.signal)
    job.requirements = { keyword: 'Java', criteria }
    await executor.run(job, controller.signal)
    return { job, diagnostics, clicks, native, batches, fallbackCalls, released, selected: [...selected], greetingClicks, scrollY }
  } finally { await rm(dir, { recursive: true, force: true }) }
}

test('real session uses captured Liepin filter components, batch judgement and host persistence without model navigation', async () => {
  const f = await runFixture()
  assert.equal(f.job.status, 'completed', f.job.detail)
  assert.equal(f.job.candidates.length, 1)
  assert.equal(f.job.candidates[0].scope, 'online')
  assert.equal(f.job.candidates[0].score, 100)
  assert.deepEqual(f.selected.sort(), ['本科', '硕士', '博士/博士后'].sort())
  assert.equal(f.clicks.filter(c => c === 'name').length, 1)
  assert.equal(f.batches, 2)
  assert.equal(f.fallbackCalls, 0)
  assert.equal(f.greetingClicks, 0)
  assert.equal(f.released, true)
})

test('already selected degrees are reused rather than toggled off', async () => {
  const f = await runFixture({ selectedDegrees: ['本科', '硕士', '博士/博士后'] })
  assert.equal(f.job.status, 'completed', f.job.detail)
  assert.equal(f.clicks.some(ref => degrees.some(d => d.item.ref === ref)), false)
})

test('continuing from a scrolled list restores the observed search header before preparing filters', async () => {
  const f = await runFixture({ scrollY: 510 })
  assert.equal(f.job.status, 'completed', f.job.detail)
  assert.equal(f.fallbackCalls, 0)
  assert.equal(f.scrollY, 0)
})

test('fast greeting uses the same host authorization and stable card identity after closing details', async () => {
  const f = await runFixture({ autoGreet: true })
  assert.equal(f.job.status, 'completed', f.job.detail)
  assert.equal(f.job.greetings[0].stage, 'succeeded')
  assert.equal(f.greetingClicks, 1)
  assert.equal(f.fallbackCalls, 0)
  assert.ok(f.clicks.indexOf('close') < f.clicks.indexOf('greet'))
})

test('unknown fast greeting is retained for reconciliation and never replayed by AI fallback', async () => {
  const f = await runFixture({ autoGreet: true, greetingError: 'TOOL_CALL_OUTCOME_UNKNOWN' })
  assert.equal(f.job.status, 'unknown', f.job.detail)
  assert.equal(f.job.candidates.length, 1)
  assert.equal(f.job.greetings[0].stage, 'unknown')
  assert.equal(f.greetingClicks, 1)
  assert.equal(f.fallbackCalls, 0)
})

test('unknown detail click cannot hand off or create a candidate, and releases execution ownership', async () => {
  const f = await runFixture({ openError: 'TOOL_CALL_OUTCOME_UNKNOWN' })
  assert.equal(f.job.status, 'unknown', f.job.detail)
  assert.equal(f.job.candidates.length, 0)
  assert.equal(f.fallbackCalls, 0)
  assert.equal(f.clicks.filter(c => c === 'name').length, 1)
  assert.equal(f.released, true)
})

test('platform configuration and drivers are selected in the registry, unknown BOSS sourcing uses AI', () => {
  assert.equal(typeof recruitmentPlatform('liepin').createSourcingDriver, 'function')
  assert.equal(recruitmentPlatform('boss').createSourcingDriver, undefined)
  assert.equal(recruitmentPlatform('boss').sourcingEntry, 'https://www.zhipin.com/web/chat/recommend')
  for (const path of ['../src/lib/sourcing-agent.ts', '../src/lib/sourcing/session.ts', '../src/lib/sourcing/fast-runner.ts', '../src/lib/sourcing-greeting.ts']) {
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), 'utf8'), /channel\.platform === ['"](?:liepin|boss)|https:\/\/lpt\.liepin|LIEPIN_POSITION_ROUTE|new Liepin/)
  }
})

test('nested name markup is one entry, while identical masked names on different cards stay separate', async () => {
  const items = [1, 2].flatMap(n => {
    const text = `李** 30岁 6年 本科 武汉 Java开发 第${n}家公司，负责订单服务开发和数据库优化。`
    return [{ ref: `root${n}`, role: 'div', name: text },
      { ref: `outer${n}`, parentRef: `root${n}`, role: 'div', name: '李**' },
      { ref: `inner${n}`, parentRef: `outer${n}`, role: 'em', name: '李**' },
      { ref: `action-wrap${n}`, parentRef: `root${n}`, role: 'span', name: '立即沟通' },
      { ref: `action${n}`, parentRef: `action-wrap${n}`, role: 'button', name: '立即沟通', context: { text } }]
  })
  const page = { tabId: 1, snapshotId: 's', url: 'https://lpt.liepin.com/search', format: 'dom', items }
  const broker = { currentPage: () => page, tools: [{ name: 'browser_snapshot', execute: async () => page }] }
  const driver = new LiepinSourcingDriver({ broker, job: { sourceMode: 'search' }, signal: new AbortController().signal })
  const cards = await driver.cards()
  assert.equal(cards.length, 2)
  assert.deepEqual(cards.map(c => c.openRef), ['outer1', 'outer2'])
  assert.deepEqual(cards.map(c => c.ref), ['action1', 'action2'])
  assert.notEqual(cards[0].sourceId, cards[1].sourceId)
})


test('viewport clipping does not separate candidate name from its card identity', async () => {
  const f = await runFixture({ clippedViewport: true })
  assert.equal(f.job.status, 'completed', f.job.detail)
  assert.equal(f.fallbackCalls, 0)
  assert.equal(f.job.candidates.length, 1)
})

test('unmasked names and asynchronous results use the same verified fast path', async () => {
  const f = await runFixture({ name: '陈明', delayedResults: true })
  assert.equal(f.job.status, 'completed', f.job.detail)
  assert.equal(f.fallbackCalls, 0)
  assert.equal(f.job.candidates[0].name, '陈明')
})


test('list handoff retains isolated assessment and persistence; salary invention cannot cause a retry loop', async () => {
  const f = await runFixture({ recoverFromList: true, ungroundedSalary: true })
  assert.equal(f.job.status, 'completed', f.job.detail)
  assert.equal(f.fallbackCalls, 1)
  assert.equal(f.batches, 2)
  assert.equal(f.job.candidates.length, 1)
  assert.equal(f.job.candidates[0].scope, 'online')
  assert.equal(f.job.candidates[0].fields.some(f => f.label === '期望薪资'), false)
  assert.equal(f.greetingClicks, 0)
})


test('position option requires its own confirm before any filter; selected draft is never toggled off', async () => {
  for (const draftSelected of [false, true]) {
    const f = await runFixture({ unselectedPosition: true, positionOpen: draftSelected, draftSelected })
    assert.equal(f.job.status, 'completed', f.job.detail)
    assert.equal(f.fallbackCalls, 0)
    assert.equal(f.clicks.filter(r => r === 'job-option').length, draftSelected ? 0 : 1)
    assert.equal(f.clicks.filter(r => r === 'job-confirm').length, 1)
    assert.equal(f.clicks.includes('wrong-confirm'), false)
    assert.ok(f.clicks.indexOf('job-confirm') < f.clicks.indexOf(degrees[0].item.ref))
  }
})


test('verified return from resume renews search proof across a document identity change before the next person', async () => {
  const f = await runFixture({ twoCandidates: true, renewDocument: true })
  assert.equal(f.job.status, 'completed', f.job.detail)
  assert.equal(f.job.candidates.length, 2)
  assert.equal(f.fallbackCalls, 0)
  assert.equal(f.batches, 3)
  assert.deepEqual(f.job.candidates.map(p => p.name).sort(), ['李明', '陈先生'].sort())
})


test('greeting resolves nested DOM position once after full search revalidation, without requiring DOM filter-row text', async () => {
  const f = await runFixture({ autoGreet: true, nestedPosition: true, domFilterRowsMissing: true })
  assert.equal(f.job.status, 'completed', f.job.detail + JSON.stringify(f.diagnostics.filter(d => d.event === 'sourcing.fast_handoff')))
  assert.equal(f.greetingClicks, 1)
  assert.equal(f.fallbackCalls, 0)
  assert.equal(f.job.greetings[0].stage, 'succeeded')
})


test('two independent matching position controls remain ambiguous and never authorize greeting', async () => {
  const f = await runFixture({ autoGreet: true, nestedPosition: true, separatePosition: true })
  assert.equal(f.job.status, 'stopped')
  assert.equal(f.fallbackCalls, 1)
  assert.equal(f.greetingClicks, 0)
  assert.equal(f.job.candidates.length, 0)
})

test('recommendation tabs and applied summaries use the fast path without search submission or AI navigation', async () => {
  const f = await runFixture({ sourceMode: 'recommend', recommendTabs: true })
  assert.equal(f.job.status, 'completed', f.job.detail)
  assert.equal(f.job.candidates.length, 1)
  assert.equal(f.job.candidates[0].sourceUrl, 'https://lpt.liepin.com/recommend')
  assert.equal(f.fallbackCalls, 0)
  assert.equal(f.batches, 2)
  assert.deepEqual(f.clicks, ['name'])
  assert.ok(f.native.filter(n => n === 'browser_inspect_element').length < 10)
})

test('recommendation switches the observed job tab once and skips search-page confirmation', async () => {
  const f = await runFixture({ sourceMode: 'recommend', recommendTabs: true, unselectedPosition: true })
  assert.equal(f.job.status, 'completed', f.job.detail)
  assert.equal(f.fallbackCalls, 0)
  assert.deepEqual(f.clicks, ['recommend-position', 'name'])
})

test('recommendation exhaustion completes below quota and retains the shortage in the task summary', async () => {
  const f = await runFixture({ sourceMode: 'recommend', recommendTabs: true, exhausted: true })
  assert.equal(f.job.status, 'completed', f.job.detail)
  assert.equal(f.job.candidates.length, 0)
  assert.match(f.job.detail, /0\/1/)
  assert.equal(f.fallbackCalls, 0)
  assert.equal(f.batches, 0)
  assert.deepEqual(f.clicks, [])
})

test('AI recovery retains the recommendation source and cannot invoke keyword search', async () => {
  const f = await runFixture({ sourceMode: 'recommend', recommendTabs: true, recoverFromList: true })
  assert.equal(f.job.status, 'completed', f.job.detail)
  assert.equal(f.fallbackCalls, 1)
  assert.equal(f.job.candidates.length, 1)
  assert.equal(f.clicks.includes('search'), false)
})

test('returning from a recommended resume renews the position proof and uses no search click', async () => {
  const f = await runFixture({ sourceMode: 'recommend', recommendTabs: true, twoCandidates: true, renewDocument: true })
  assert.equal(f.job.status, 'completed', f.job.detail)
  assert.equal(f.job.candidates.length, 2)
  assert.equal(f.fallbackCalls, 0)
  assert.deepEqual(f.clicks, ['name', 'close', 'name2'])
})

test('a real-style job tab badge does not turn an ID-verified recommendation position into an unknown job', async () => {
  const f = await runFixture({ sourceMode: 'recommend', recommendTabs: true, recommendBadge: true })
  assert.equal(f.job.status, 'completed', f.job.detail)
  assert.equal(f.fallbackCalls, 0)
  assert.equal(f.job.candidates.length, 1)
})

test('verified recommendation detail greets without first closing an occluded detail control',async()=>{
 const f=await runFixture({sourceMode:'recommend',recommendTabs:true,autoGreet:true,detailGreeting:true,closeError:'ELEMENT_OCCLUDED'})
 assert.equal(f.job.status,'completed',f.job.detail)
 assert.equal(f.job.candidates.length,1)
 assert.equal(f.greetingClicks,1)
 assert.equal(f.fallbackCalls,0)
 assert.deepEqual(f.clicks,['name','greet'])
 assert.equal(f.job.greetings[0].stage,'succeeded')
})
test('unknown result from a foreground detail greeting still stops without replay',async()=>{
 const f=await runFixture({sourceMode:'recommend',recommendTabs:true,autoGreet:true,detailGreeting:true,greetingError:'TOOL_CALL_OUTCOME_UNKNOWN'})
 assert.equal(f.job.status,'unknown',f.job.detail)
 assert.equal(f.greetingClicks,1)
 assert.equal(f.job.greetings[0].stage,'unknown')
 assert.equal(f.fallbackCalls,0)
})
