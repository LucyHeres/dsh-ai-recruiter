import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, hash } from '../dist/lib/store.js'
import { createSourcingSession } from '../dist/lib/sourcing/session.js'
import { SourcingAgent } from '../dist/lib/sourcing-agent.js'
import { assertSourcingResumeDetail, mergeSourcingResumeParts, sourcingResumeParts } from '../dist/lib/sourcing-policy.js'
import { normalized } from '../dist/lib/page-actions.js'
import { LiepinSourcingDriver } from '../dist/lib/platforms/liepin/sourcing-driver.js'

const candidateName = '张先生'
const listText = '张先生 31岁 8年 本科 武汉 Java开发 工作经历：示例科技 Java工程师。'
const experience = '工作经历：示例科技，负责Java订单服务设计、接口开发及数据库优化。'
const project = '项目经历：交易系统，负责库存一致性与消息重试，完成服务上线。'
const education = '教育经历：示例大学 计算机科学 本科。'
const fullText = `${candidateName}\n${experience}\n${project}\n${education}`
const selection = { tabId: 1, url: 'https://lpt.liepin.com/search', documentId: 'doc' }
const detailPage = (text = fullText) => ({ ...selection, snapshotId: 's', items: [
  { ref: 'dialog', role: 'dialog', name: text.slice(0, 200), dialogRef: 'dialog' },
  { ref: 'name', role: 'StaticText', name: candidateName, parentRef: 'dialog' },
  { ref: 'section', role: 'article', name: experience, parentRef: 'dialog' },
  { ref: 'body', role: 'StaticText', name: project, parentRef: 'section' },
], dialogs: [{ ref: 'dialog', text }] })

test('candidate node names and repeated parent contexts produce one copy of list evidence', () => {
  const page = { ...selection, snapshotId: 's', items: [
    { ref: 'card', role: 'article', name: listText },
    { ref: 'name', role: 'text', name: candidateName, parentRef: 'card', context: { text: listText } },
    { ref: 'work', role: 'text', name: '示例科技 Java工程师。', parentRef: 'card', context: { text: listText } },
  ] }
  assert.deepEqual(sourcingResumeParts(page, candidateName, 'name', ['name', 'work', 'card']), [normalized(listText)])
  assert.throws(() => assertSourcingResumeDetail({ ...page, snapshotId: 'refreshed' }, 'card', selection), /SOURCING_RESUME_DETAIL_REQUIRED/)
})

test('foreground full text owns nested AX articles and survives a truncated name without importing parent summaries', () => {
  const page = detailPage('推荐职位说明。'.repeat(40) + fullText)
  page.items[0].context = { text: listText }
  assert.deepEqual(sourcingResumeParts(page, candidateName, 'dialog', ['dialog', 'name', 'body']), [page.dialogs[0].text])
  assert.doesNotThrow(() => assertSourcingResumeDetail(page, 'body', selection))
  page.items.push({ ref: 'foreign', role: 'article', name: '李先生 其他项目' })
  assert.throws(() => sourcingResumeParts(page, candidateName, 'name', ['foreign']), /RESUME_SCOPE_MISMATCH/)
  page.items[0].states = ['blocked_by_dialog']
  assert.throws(() => assertSourcingResumeDetail(page, 'body', selection), /UNREADABLE/)
})

test('scroll captures discard covered fragments and retain work, project and education order', () => {
  assert.deepEqual(mergeSourcingResumeParts([experience, project, `${experience}\n${project}`, education, fullText, project]), [fullText])
  assert.deepEqual(mergeSourcingResumeParts([experience, project, education, project]), [experience, project, education])
})

test('a standalone resume article requires a different observed URL; refreshing the list document is insufficient', () => {
  const page = { ...selection, snapshotId: 's', items: [{ ref: 'resume', role: 'article', name: fullText }] }
  assert.throws(() => assertSourcingResumeDetail(page, 'resume', selection), /DETAIL_REQUIRED/)
  assert.throws(() => assertSourcingResumeDetail({ ...page, documentId: 'refreshed-document' }, 'resume', selection), /DETAIL_REQUIRED/)
  assert.doesNotThrow(() => assertSourcingResumeDetail({ ...page, url: 'https://lpt.liepin.com/resume/observed' }, 'resume', selection))
})

test('quoted experience text beyond a capped dialog header is retained without its repeated parent context', () => {
  const page = detailPage()
  page.dialogs[0].text = `${candidateName}\n${experience}`
  page.items.find(item => item.ref === 'body').context = { text: page.dialogs[0].text }
  assert.deepEqual(sourcingResumeParts(page, candidateName, 'name', ['dialog', 'body']), [page.dialogs[0].text, normalized(project)])
})

const done = { status: 'completed', message: 'done', turns: 1, modelMs: 1, toolMs: 1 }
const toolInfo = (name, readOnly, properties) => ({ name, inputSchema: { type: 'object', properties, additionalProperties: false },
  annotations: { readOnlyHint: readOnly }, _meta: { browserAgent: { available: true } } })
const properties = { tabId: { type: 'integer' }, snapshotId: { type: 'string' }, ref: { type: 'string' } }
const infos = [toolInfo('browser_list_tabs', true, {}), toolInfo('browser_snapshot', true, { tabId: properties.tabId, format: { type: 'string' } }),
  toolInfo('browser_click', false, properties), toolInfo('browser_type', false, { ...properties, text: { type: 'string' }, clear: { type: 'boolean' } })]

async function sessionFixture(action, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sourcing-resume-detail-'))
  const store = new Store(dir, 'test'); await store.init()
  let revision = 0, keyword = '', detail = false, currentText = options.text ?? fullText
  const assessments = [], clicks = []
  const page = () => detail ? { ...detailPage(currentText), snapshotId: `s${revision}`, items: [...detailPage(currentText).items,
    { ref: 'greet', role: 'button', name: '立即沟通', dialogRef: 'dialog', context: { text: currentText } },
    { ref: 'position', role: 'tab', name: 'Java开发', states: ['selected'], dialogRef: 'dialog' },
    { ref: 'close', role: 'button', name: '关闭', dialogRef: 'dialog' },
  ] } : {
    ...selection, snapshotId: `s${revision}`, format: 'dom', items: [
      { ref: 'query', role: 'searchbox', name: '搜索人才', value: keyword },
      { ref: 'search', role: 'button', name: '搜索' },
      { ref: 'card', role: 'article', name: listText, context: { text: listText } },
      { ref: 'open', role: 'button', name: '查看简历', context: { text: listText } },
    ], dialogs: [],
  }
  const call = async (name, args) => {
    if (name === 'browser_finish') return {}
    if (name === 'browser_list_tabs') return { tabs: [{ tabId: 1, url: selection.url }] }
    if (name === 'browser_snapshot') { revision++; return page() }
    if (name === 'browser_type') keyword = args.text
    else if (name === 'browser_click') {
      clicks.push(args.ref)
      if (args.ref === 'open') detail = true
      if (args.ref === 'close') detail = false
      if (args.ref === 'greet') {
        assert.equal(detail, true, 'greet in the verified foreground before closing it')
        if (options.greetingError) throw Error(options.greetingError)
      }
    }
    else throw Error(`Unexpected browser call ${name}`)
    revision++; return { dispatched: true, snapshot: page() }
  }
  const job = { id: 'resume-detail-regression', kind: 'talent_sourcing', jobId: 'job', jobName: 'Java开发', platform: 'liepin', platforms: ['liepin'],
    sourceMode: 'search', searchFilters: {}, minimumScore: 60, limit: 1, limitScope: 'per_platform', supplement: '', autoGreet: !!options.autoGreet,
    position: { id: 'job', name: 'Java开发', description: 'Java开发' },
    requirements: { keyword: 'Java', listCriteria: [{ field: 'education', requirement: '本科', quote: '本科' }], criteria: [{ id: 'java', label: 'Java开发', quote: 'Java开发', must: true, weight: 100 }] },
    candidates: [], results: [], greetings: [], channels: [{ platform: 'liepin', status: 'running', detail: '' }], events: [] }
  const agent = async opts => {
    if (opts.tools[0]?.name === 'sourcing_submit_assessments') {
      assessments.push({ mode: opts.goal.mode, text: opts.goal.candidates.map(c => c.evidence.map(e => e.text).join('')).join('\n') })
      await opts.tools[0].execute({ candidates: opts.goal.candidates.map(c => ({ sourceId: c.sourceId,
        ...(opts.goal.mode === 'detail' ? { fields: [] } : {}),
        ...(opts.goal.mode === 'preview' ? { listAssessments: opts.goal.listCriteria.map(c => ({ field: c.field, state: 'match', evidenceId: 0, reason: '原文证据' })) } : {}),
        ...(opts.goal.mode === 'detail' ? { assessments: [{ criterionId: 'java', state: 'match', evidenceId: 0, reason: '原文列明Java开发职责' }] } : {}),
      })) }, opts.signal)
      return done
    }
    const execute = (name, args) => opts.tools.find(tool => tool.name === name).execute(args, opts.signal)
    const locator = (identityRef = detail ? 'dialog' : 'card') => ({ tabId: 1, snapshotId: page().snapshotId, identityRef, resumeRefs: [identityRef] })
    await execute('browser_type', { tabId: 1, snapshotId: page().snapshotId, ref: 'query', text: 'Java' })
    await execute('browser_click', { tabId: 1, snapshotId: page().snapshotId, ref: 'search' })
    await execute('sourcing_confirm_search', { tabId: 1, snapshotId: page().snapshotId, ref: 'query', filters: [] })
    const selected = await execute('sourcing_select_candidate', { tabId: 1, snapshotId: page().snapshotId, ref: 'card', name: candidateName, evidenceRefs: [] })
    await action({ execute, locator, job, assessments, selected, previousCount: opts.goal.previousCount, complete: opts.isComplete,
      greet: candidateKey => execute('sourcing_greet_candidate', { tabId: 1, snapshotId: page().snapshotId, candidateKey,
        ref: 'greet', identityRef: 'dialog', evidenceRefs: [], position: { ref: 'position' } }),
      close: () => execute('browser_click', { tabId: 1, snapshotId: page().snapshotId, ref: 'close' }),
      open: () => execute('browser_click', { tabId: 1, snapshotId: page().snapshotId, ref: 'open' }),
      setText: text => { currentText = text },
      returnToList: async () => { detail = false; await execute('browser_snapshot', { tabId: 1 }) },
    })
    return done
  }
  const signal = new AbortController().signal
  try {
    if (options.historyScope) {
      await store.put('sourcing-old-summary', { ...job, id: 'old-summary',
        candidates: [{ key: hash({ platform: 'liepin', identity: normalized(listText) }), name: candidateName, scope: options.historyScope, resumeText: listText }] })
      let actionError
      const executor = new SourcingAgent(store, call, async () => {}, async () => infos, () => async opts => {
        try { return await agent(opts) } catch (error) { actionError = error; throw error }
      }, async () => job.position)
      await executor.run(job, signal)
      if (actionError) throw actionError
      return { job, assessments }
    }
    const session = await createSourcingSession({ job, channel: job.channels[0], quota: 1, before: 0, previous: new Set(), store, signal, agent, call,
      listTools: async () => infos, save: async () => {}, progress: async () => {} })
    await session.run()
    return { job, assessments, clicks }
  } finally { await rm(dir, { recursive: true, force: true }) }
}

test('saving summary or refreshed list evidence cannot evaluate details, satisfy quota or queue a greeting', async () => {
  const f = await sessionFixture(async t => {
    for (const scope of ['summary', 'online']) {
      await t.execute('browser_snapshot', { tabId: 1 })
      await assert.rejects(t.execute('sourcing_record_candidate', { ...t.locator(), scope }), /SOURCING_RESUME_DETAIL_REQUIRED/)
      await assert.rejects(t.execute('sourcing_read_resume', t.locator()), /SOURCING_RESUME_DETAIL_REQUIRED/)
    }
    assert.equal(t.assessments.length, 1, 'only the list preflight may have been assessed')
    assert.equal(t.complete(), false)
    assert.deepEqual(t.job.candidates, []); assert.deepEqual(t.job.results, []); assert.deepEqual(t.job.greetings, [])
    await t.open()
    await t.execute('sourcing_record_candidate', { ...t.locator(), scope: 'online' })
    assert.equal(t.complete(), true)
  })
  assert.equal(f.job.candidates[0].scope, 'online')
  assert.equal(f.job.candidates[0].resumeText, fullText)
  assert.equal(f.assessments[1].text, fullText)
})

test('a foreground shell repeating only list summary remains pending and can be explicitly skipped', async () => {
  const f = await sessionFixture(async t => {
    await t.open()
    await assert.rejects(t.execute('sourcing_record_candidate', { ...t.locator(), scope: 'online' }), /SOURCING_RESUME_DETAIL_REQUIRED/)
    assert.equal(t.assessments.length, 1)
    assert.equal(t.complete(), false)
    await t.execute('sourcing_skip_candidate', { reason: '详情没有加载出超出摘要的原文' })
  }, { text: listText })
  assert.equal(f.job.candidates.length, 0)
  assert.equal(f.job.skippedUnverified, 1)
})

test('successive detail reads retain earlier sections once and cannot commit from a background list', async () => {
  const f = await sessionFixture(async t => {
    await t.open()
    t.setText(`${candidateName}\n${experience}`)
    await t.execute('browser_snapshot', { tabId: 1 })
    await t.execute('sourcing_read_resume', t.locator())
    t.setText(fullText)
    await t.execute('browser_snapshot', { tabId: 1 })
    await t.execute('sourcing_read_resume', { ...t.locator(), resumeRefs: ['dialog', 'name', 'body'] })
    await t.returnToList()
    await assert.rejects(t.execute('sourcing_record_candidate', { ...t.locator(), scope: 'online' }), /SOURCING_RESUME_DETAIL_REQUIRED/)
    await t.open()
    await t.execute('sourcing_record_candidate', { ...t.locator(), scope: 'online' })
  })
  assert.equal(f.job.candidates[0].resumeText, fullText)
})

test('a changed online hint replaces the reread resume, then greets in detail before returning to the list', async () => {
  const original = `${fullText}\n${experience}\n当前候选人负责服务架构、交易系统的数据库设计和生产问题排查。\n立即沟通\n关闭`
  const latest = original.replace('立即沟通', 'Ta在线，回复更快～\n立即沟通')
  const f = await sessionFixture(async t => {
    await t.open()
    await t.execute('sourcing_read_resume', t.locator())
    t.setText(latest)
    await t.execute('browser_snapshot', { tabId: 1 })
    const saved = await t.execute('sourcing_record_candidate', { ...t.locator(), scope: 'online' })
    assert.equal(saved.needsGreeting, true)
    assert.equal(t.complete(), false)
    assert.equal(t.job.candidates[0].resumeText, latest)
    assert.equal(t.assessments[1].text, latest, 'assess only the current source version')
    // The same activity hint can disappear again after recording. It must not
    // make this verified candidate into a different person at greeting time.
    t.setText(original)
    await t.execute('browser_snapshot', { tabId: 1 })
    assert.equal((await t.greet(saved.candidateKey)).clicked, true)
    assert.equal(t.complete(), true)
    await t.close()
    assert.equal(t.locator().identityRef, 'card')
  }, { text: original, autoGreet: true })
  assert.deepEqual(f.clicks, ['search', 'open', 'greet', 'close'])
  assert.equal(f.job.greetings[0].stage, 'succeeded')
})

test('reread details still reject a different same-name resume without dispatching a greeting', async () => {
  const original = `${fullText}\n${experience}\n当前候选人负责服务架构、交易系统的数据库设计和生产问题排查。`
  const f = await sessionFixture(async t => {
    await t.open()
    await t.execute('sourcing_read_resume', t.locator())
    const saved = await t.execute('sourcing_record_candidate', { ...t.locator(), scope: 'online' })
    t.setText(`${candidateName}\n工作经历：另一家公司，负责完全不同的产品推广和内容运营。`.repeat(8))
    await t.execute('browser_snapshot', { tabId: 1 })
    await assert.rejects(t.greet(saved.candidateKey), /GREETING_DETAIL_UNVERIFIED/)
    assert.equal(t.job.greetings[0].attemptedAt, undefined)
  }, { text: original, autoGreet: true })
  assert.equal(f.clicks.includes('greet'), false)
})

test('an unknown detail greeting after a changed reread remains unknown and cannot be sent again', async () => {
  const original = `${fullText}\n${experience}\n当前候选人负责服务架构、交易系统的数据库设计和生产问题排查。\n立即沟通`
  const f = await sessionFixture(async t => {
    await t.open()
    await t.execute('sourcing_read_resume', t.locator())
    t.setText(original.replace('立即沟通', 'Ta在线，回复更快～\n立即沟通'))
    await t.execute('browser_snapshot', { tabId: 1 })
    const saved = await t.execute('sourcing_record_candidate', { ...t.locator(), scope: 'online' })
    await assert.rejects(t.greet(saved.candidateKey), /GREETING_OUTCOME_UNKNOWN/)
    await assert.rejects(t.greet(saved.candidateKey), /GREETING_OUTCOME_UNKNOWN/)
    assert.equal(t.job.greetings[0].stage, 'unknown')
    assert.ok(t.job.greetings[0].attemptedAt)
    assert.equal(t.complete(), false)
  }, { text: original, autoGreet: true, greetingError: 'TOOL_CALL_OUTCOME_UNKNOWN' })
  assert.equal(f.clicks.filter(ref => ref === 'greet').length, 1)
})

test('historical list-only results do not prevent collecting the real resume in a new round', async () => {
  const f = await sessionFixture(async t => {
    assert.equal(t.previousCount, 0)
    assert.equal(t.selected.qualified, true)
    await t.open()
    await t.execute('sourcing_record_candidate', { ...t.locator(), scope: 'online' })
  }, { historyScope: 'summary' })
  assert.equal(f.job.status, 'completed', f.job.detail)
  assert.equal(f.job.candidates.length, 1)
  assert.equal(f.job.candidates[0].resumeText, fullText)
})

test('historical online resumes retain their cross-round deduplication', async () => {
  const f = await sessionFixture(async t => {
    assert.equal(t.previousCount, 1)
    assert.equal(t.selected.duplicate, true)
    assert.equal(t.complete(), false)
  }, { historyScope: 'online' })
  assert.equal(f.job.candidates.length, 0)
  assert.equal(f.assessments.length, 0)
})

test('Liepin waits for asynchronous detail content and reads beyond viewport-only DOM names', async () => {
  let reads = 0, current = { ...selection, snapshotId: 'list', items: [] }
  const broker = { currentPage: () => current, tools: [{ name: 'browser_snapshot', execute: async args => {
    assert.equal(args.format, 'dom'); assert.equal(args.viewportOnly, false)
    current = ++reads < 3 ? { ...selection, snapshotId: `loading-${reads}`, items: [], dialogs: [] } : detailPage('推荐职位说明。'.repeat(40) + fullText)
    return current
  } }] }
  const driver = new LiepinSourcingDriver({ broker, job: { sourceMode: 'search' }, signal: new AbortController().signal })
  const locator = await driver.resume(candidateName)
  assert.equal(reads, 3)
  assert.equal(locator.identityRef, 'dialog')
  assert.deepEqual(sourcingResumeParts(current, candidateName, locator.identityRef, locator.resumeRefs), [current.dialogs[0].text])
})
