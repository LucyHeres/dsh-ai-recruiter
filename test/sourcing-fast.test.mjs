import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateSources, numberEvidence } from '../dist/lib/sourcing/evaluator.js'
import { runSourcingWorkflow } from '../dist/lib/sourcing/fast-runner.js'
import { SourcingHandoff } from '../dist/lib/sourcing/browser.js'
import { recruitmentMatchingSkill } from '../dist/lib/browser-skill.js'
import { hash } from '../dist/lib/store.js'

const requirements = { keyword: 'Java', listCriteria: [{ field: 'education', requirement: '本科', quote: '本科' }], criteria: [{ id: 'java', label: 'Java', quote: 'Java开发', weight: 100, must: true }] }
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
    const submit = args => options.tools[0].execute({ candidates: args.candidates.map(({ listAssessments, ...row }) => row) })
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

test('recovery reuses only exactly equal task-local assessment inputs, even when source refs/IDs change', async () => {
  let calls = 0
  const agent = async opts => {
    calls++
    await opts.tools[0].execute({ candidates: opts.goal.candidates.map(source => {
      const row = judgement(source)
      if (opts.goal.mode === 'preview') { delete row.fields; delete row.assessments; row.listAssessments = [{ field: 'education', state: 'match', evidenceId: 0, reason: '原文证据' }] }
      return row
    }) }, opts.signal)
    return done
  }
  const source = { sourceId: 'old-ref', name: '陈先生', text: 'Java开发' }
  const first = await evaluateSources(agent, requirements, [source], signal(), undefined, 'preview')
  first[0].listAssessments[0].reason = 'caller mutation'
  const recovered = await evaluateSources(agent, requirements, [{ ...source, sourceId: 'new-ref' }], signal(), undefined, 'preview')
  assert.equal(calls, 1)
  assert.equal(recovered[0].sourceId, 'new-ref')
  assert.notEqual(recovered[0].listAssessments[0].reason, 'caller mutation')
  await evaluateSources(agent, requirements, [{ ...source, text: 'Java开发与架构设计' }], signal(), undefined, 'preview')
  await evaluateSources(agent, requirements, [source], signal(), undefined, 'detail')
  assert.equal(calls, 3, 'changed text and detail mode require their own assessments')
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(evaluateSources(agent, requirements, [source], aborted.signal, undefined, 'preview'))
})

function fixture(overrides = {}) {
  let revision = 0, pending = overrides.pending, current, recorded = 0, needsGreeting = false, fallbackCalls = 0, assessmentCalls = 0, searchReady = overrides.searchReady ?? true
  const events = [], assessedBatches = [], selections = []
  let cardReads = 0
  const cards = [1, 2, 3].map(i => ({ sourceId: String(i), name: `陈${i}先生`, text: 'Java开发', ref: `name${i}`, evidenceRefs: [`card${i}`] }))
  const job = { requirements, candidates: [], searchFilters: {}, jobName: 'Java', limit: 2 }
  const page = () => ({ tabId: 1, snapshotId: `s${revision}`, items: [] })
  const broker = { currentPage: page, tools: [{ name: 'browser_snapshot', execute: async () => { revision++; return page() } }] }
  const driver = {
    recognizes: async () => true,
    prepareSearch: async () => ({ tabId: 1, snapshotId: 's0', ref: 'position', mode: 'position', filters: [] }),
    cards: async () => { revision++; cardReads++; return cards.map(c => ({ ...c, text: overrides.cardText?.(cardReads) ?? c.text, ref: `${c.ref}-s${revision}` })) },
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
      selections.push(structuredClone(args))
      if (overrides.rejected?.includes(args.name)) return { qualified: false }
      pending = args.name
      events.push('select:' + args.name)
      return { qualified: true }
    },
    sourcing_read_resume: async () => ({ capturedCharacters: 6 }),
    sourcing_skip_candidate: async () => { events.push('skip:' + pending); pending = undefined },
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
  const ops = { tools, recoveryTools: () => tools, preview: overrides.preview ?? (async card => ({ text: card.text, duplicate: false })), remaining: () => (overrides.limit ?? 2) - recorded, complete: () => recorded >= (overrides.limit ?? 2) && !needsGreeting,
    progress: async message => { events.push('progress:' + message) },
    state: () => ({ searchReady, pending, needsGreeting, selectedCandidate: pending ? overrides.selectedCandidate?.(pending) : undefined }),
    captured: () => pending ? { name: pending, text: 'Java开发', scope: 'online' } : undefined }
  const agent = async options => {
    if (options.tools.length === 1 && options.tools[0].name === 'sourcing_define_requirements') {
      overrides.onDefine?.(options)
      await options.tools[0].execute(requirements, options.signal)
      return done
    }
    if (options.tools[0]?.name !== 'sourcing_submit_assessments') {
      const collect = options.tools.find(tool => tool.name === 'sourcing_collect')
      try {
        await collect.execute({}, options.signal)
        return done
      } catch (error) {
        if (/OUTCOME_UNKNOWN|RESULT_UNKNOWN|TASK_STORAGE_UNAVAILABLE/.test(String(error))) throw error
        const recovery = await collect.recover(error, {}, options.signal)
        fallbackCalls++; events.push('fallback')
        return overrides.fallback?.({ ...options, goal: { ...options.goal, ...recovery } }, ops) ?? { ...done, status: 'stopped' }
      }
    }
    assessmentCalls++
    assessedBatches.push(options.goal.candidates.map(s => s.sourceId))
    await options.tools[0].execute({ candidates: options.goal.candidates.map(s => { const row = judgement(s); if (options.goal.mode === 'preview') { delete row.fields; delete row.assessments; row.listAssessments = [{ field: 'education', state: 'match', evidenceId: 0, reason: '原文证据' }] }; return row }) }, options.signal)
    return done
  }
  return { run: () => runSourcingWorkflow({ createSourcingDriver: () => driver }, { broker, job, signal: signal() }, ops, agent,
    { system: 'fallback', goal: {}, tools, signal: signal() }), driver, job, events, assessedBatches, selections, counts: () => ({ recorded, assessmentCalls, fallbackCalls }) }
}

function ownDetails(f) {
  let opened
  const open = f.driver.open, close = f.driver.returnToList
  f.driver.open = async card => { const locator = await open(card); opened = card.name; return locator }
  f.driver.hasOpenResume = name => !!opened && (!name || name === opened)
  f.driver.returnToList = async () => { const result = await close(); opened = undefined; return result }
}

for (const code of ['RESUME_IMAGE_UNREADABLE', 'RESUME_IMAGE_INCOMPLETE']) test(`a single ${code} owned resume is skipped and the next candidate can complete the quota`, async () => {
  let reads = 0
  const f = fixture({ limit: 1, hooks: { sourcing_read_resume: async () => {
    if (++reads === 1) throw Error(`${code}: 当前图片未完整识别`)
    return { capturedCharacters: 6 }
  } } })
  ownDetails(f)
  assert.equal((await f.run()).status, 'completed')
  assert.equal(f.counts().recorded, 1)
  assert.equal(f.counts().fallbackCalls, 0)
  assert.ok(f.events.indexOf('skip:陈1先生') < f.events.indexOf('select:陈2先生'))
})

for (const code of ['RESUME_IMAGE_UNREADABLE', 'RESUME_IMAGE_INCOMPLETE']) test(`three consecutive ${code} owned resumes stop explicitly without navigation inference or recounting them`, async () => {
  const f = fixture({ hooks: { sourcing_read_resume: async () => { throw Error(`${code}: 当前图片未完整识别`) } } })
  ownDetails(f)
  await assert.rejects(f.run(), /RESUME_IMAGE_REPEATED_UNREADABLE/)
  assert.equal(f.counts().recorded, 0)
  assert.equal(f.counts().fallbackCalls, 0)
  assert.equal(f.events.filter(event => event.startsWith('skip:')).length, 3)
  assert.equal(f.events.filter(event => event === 'return').length, 3)
})

test('a missing vision model is a configuration failure and cannot skip through the whole candidate list', async () => {
  const f = fixture({ hooks: { sourcing_read_resume: async () => { throw Error('RESUME_VISION_MODEL_REQUIRED: 当前模型不支持图片') } } })
  ownDetails(f)
  await assert.rejects(f.run(), /RESUME_VISION_MODEL_REQUIRED/)
  assert.equal(f.events.filter(event => event.startsWith('skip:')).length, 0)
  assert.equal(f.events.filter(event => event.startsWith('open:')).length, 1)
})

test('fixed-flow requirement extraction loads the bundled skill independently of the main conversation', async () => {
  let calls = 0
  const f = fixture({ onDefine: opts => {
    calls++
    assert.ok(opts.system.includes(recruitmentMatchingSkill().content))
    assert.deepEqual(opts.goal.supplementParts, ['优先上一段任职超过2年'])
    assert.equal(opts.goal.position.description, 'Java开发')
  }, hooks: { sourcing_define_requirements: async input => { f.job.requirements = input } } })
  f.job.requirements = undefined
  f.job.position = { name: 'Java开发', description: 'Java开发' }
  f.job.supplement = '优先上一段任职超过2年'
  assert.equal((await f.run()).status, 'completed')
  assert.equal(calls, 1)
})

test('one batch preview and one assessment per accepted candidate, with fresh refs and serial greeting', async () => {
  const f = fixture({ autoGreet: true })
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.deepEqual(f.counts(), { recorded: 2, assessmentCalls: 3, fallbackCalls: 0 })
  assert.equal(f.assessedBatches[0].length, 3)
  assert.ok(f.events.indexOf('greet:1') < f.events.indexOf('select:陈2先生'))
  assert.ok(f.events.some(event => event.includes('列表初筛：候选人[陈1先生]、候选人[陈2先生]、候选人[陈3先生]')))
})

test('returning to a different visible window leaves unselected assessed cards for later instead of handing off', async () => {
  let returned = false
  const card = i => ({ sourceId: String(i), name: `陈${i}先生`, text: 'Java开发', ref: `name${i}-s0`, evidenceRefs: [`card${i}`] })
  const f = fixture({ driver: {
    cards: async () => returned ? [card(3)] : [card(1), card(2)],
    resume: async () => ({ tabId: 1, snapshotId: 's0', identityRef: 'resume', resumeRefs: ['resume'] }),
    returnToList: async () => { returned = true },
  } })
  assert.equal((await f.run()).status, 'completed')
  assert.equal(f.counts().recorded, 2)
  assert.equal(f.counts().fallbackCalls, 0)
  assert.ok(f.events.includes('select:陈1先生'))
  assert.ok(f.events.includes('select:陈3先生'))
  assert.equal(f.events.includes('select:陈2先生'), false)
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

test('an AI-selected pending candidate resumes from the canonical key and full verified evidence rather than raw card text or a truncated quote', async () => {
  const verified = 'Java开发，本科，负责订单与支付服务。'.repeat(180)
  const f = fixture({ limit: 1, pending: '陈1先生',
    selectedCandidate: name => ({ name, candidateKey: 'canonical-key', verifiedListText: verified.slice(0, 2400), listEvidenceHash: hash(verified), resumeCharacters: 0, stage: 'selected' }),
    preview: async () => ({ text: verified, candidateKey: 'canonical-key', duplicate: false }) })
  assert.equal((await f.run()).status, 'completed')
  assert.equal(f.counts().fallbackCalls, 0)
  assert.equal(f.counts().recorded, 1)
  assert.equal(f.events.filter(event => event.startsWith('select:')).length, 0)
  assert.deepEqual(f.events.filter(event => event.startsWith('open:')), ['open:1'])
})

test('identical masked names and text never allow a different canonical candidate key to be opened', async () => {
  const f = fixture({ limit: 1, pending: '陈先生',
    selectedCandidate: name => ({ name, candidateKey: 'person-two', verifiedListText: 'Java开发', listEvidenceHash: hash('Java开发'), resumeCharacters: 0, stage: 'selected' }),
    driver: { cards: async () => [1, 2].map(i => ({ sourceId: String(i), name: '陈先生', text: 'Java开发', ref: 'name' + i, evidenceRefs: ['card' + i] })) },
    preview: async card => ({ text: card.text, candidateKey: card.sourceId === '2' ? 'person-two' : 'person-one', duplicate: false }) })
  assert.equal((await f.run()).status, 'completed')
  assert.equal(f.counts().fallbackCalls, 0)
  assert.deepEqual(f.events.filter(event => event.startsWith('open:')), ['open:2'])
})

for (const reason of ['different-key', 'changed-text', 'missing-card']) test(`a ${reason} selection is explicitly abandoned without saving or opening an unverified person`, async () => {
  const selectedName = reason === 'missing-card' ? '消失的先生' : '陈1先生'
  const f = fixture({ limit: 1, pending: selectedName, rejected: ['陈1先生'],
    selectedCandidate: name => ({ name, candidateKey: 'expected-key', verifiedListText: 'Java开发', listEvidenceHash: hash('Java开发'), resumeCharacters: 0, stage: 'selected' }),
    preview: async card => ({ text: reason === 'changed-text' && card.sourceId === '1' ? 'Java开发，已变更的履历' : 'Java开发',
      candidateKey: reason === 'different-key' ? 'different-key' : 'expected-key', duplicate: false }) })
  assert.equal((await f.run()).status, 'completed')
  assert.equal(f.counts().fallbackCalls, 0)
  assert.equal(f.counts().recorded, 1)
  assert.ok(f.events.indexOf('skip:' + selectedName) >= 0)
  assert.ok(f.events.indexOf('skip:' + selectedName) < f.events.indexOf('open:2'))
  assert.equal(f.events.includes('open:1'), false)
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
  const result = await evaluateSources(runner, requirements, sources, signal(), undefined, 'detail', { city: '武汉', education: '本科' })
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
  }, requirements, sources, signal(), undefined, 'detail', { city: '武汉', education: '本科' })
  assert.deepEqual(result[0].filterAssessments.map(row => [row.field, row.state, row.quote]), [['city', 'unknown', ''], ['education', 'unknown', '']])
})

test('the same agent explicitly resumes collection after preparing the page, without replaying candidate or greeting actions', async () => {
  let preparations = 0
  const f = fixture({ searchReady: false, driver: { prepareSearch: async () => {
    if (++preparations === 1) throw new SourcingHandoff('unknown_startup_dialog')
    return { tabId: 1, snapshotId: 's0', ref: 'position', mode: 'position', filters: [] }
  } }, fallback: async options => {
    await options.tools.find(tool => tool.name === 'sourcing_confirm_search').execute({})
    assert.equal(options.isComplete(), false, 'preparing a page is not completion of the candidate quota')
    await options.tools.find(tool => tool.name === 'sourcing_collect').execute({}, options.signal)
    assert.equal(options.isComplete(), true)
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


test('the final vacancy still screens three visible cards together and never saves over quota', async () => {
  const f = fixture({ limit: 1, rejected: ['陈1先生', '陈2先生'] })
  assert.equal((await f.run()).status, 'completed')
  assert.deepEqual(f.assessedBatches[0], ['1', '2', '3'])
  assert.equal(f.counts().assessmentCalls, 2, 'one batch screening plus the accepted resume')
  assert.equal(f.counts().recorded, 1)
  assert.equal(f.counts().fallbackCalls, 0)
  assert.deepEqual(f.events.filter(event => event.startsWith('open:')), ['open:3'])
})

test('changed card evidence is reassessed against fresh text without a navigation handoff or stale quotes', async () => {
  for (const updated of ['Java开发 本周活跃', 'Java开发 学历：硕士']) {
    const f = fixture({ limit: 1, cardText: reads => reads === 1 ? 'Java开发' : updated })
    assert.equal((await f.run()).status, 'completed')
    assert.equal(f.counts().fallbackCalls, 0)
    assert.equal(f.counts().assessmentCalls, 3, 'batch, changed source, detail')
    assert.equal(f.selections[0].listAssessments[0].quote, updated)
    assert.equal(f.counts().recorded, 1)
  }
})

test('continuously changing evidence has bounded reassessment and never selects with stale evidence', async () => {
  const f = fixture({ cardText: reads => `Java开发 变动${reads}` })
  assert.equal((await f.run()).status, 'stopped')
  assert.equal(f.counts().assessmentCalls, 3)
  assert.equal(f.counts().fallbackCalls, 1)
  assert.deepEqual(f.selections, [])
  assert.equal(f.counts().recorded, 0)
})


test('navigation budget reports the last fixed-route failure instead of hiding it behind a generic turn limit', async () => {
  const f = fixture({ driver: { open: async () => { throw new SourcingHandoff('candidate_detail_unknown') } },
    fallback: async () => ({ ...done, status: 'budget', message: 'BROWSER_AGENT_TURN_BUDGET: 已达到本次推理轮数上限' }) })
  const result = await f.run()
  assert.equal(result.status, 'budget')
  assert.match(result.message, /BROWSER_AGENT_TURN_BUDGET.*最近固定流程问题：candidate_detail_unknown/)
  assert.equal(f.counts().recorded, 0)
})
