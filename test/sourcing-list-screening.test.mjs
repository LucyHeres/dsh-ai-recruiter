import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessListCandidate, validateListCriteria } from '../dist/lib/sourcing/list-screening.js'
import { requirementsSpec } from '../dist/lib/sourcing/contracts.js'
import { evaluateSources } from '../dist/lib/sourcing/evaluator.js'

const source = '年龄35岁以下；工作经验5-10年；期望工作城市北京；学历本科；有甲公司任职经历；期望月薪20-30K'
const criteria = [
  { field: 'age', requirement: '35岁以下', quote: '年龄35岁以下' },
  { field: 'experience', requirement: '5-10年', quote: '工作经验5-10年' },
  { field: 'city', requirement: '北京', quote: '期望工作城市北京' },
  { field: 'education', requirement: '本科', quote: '学历本科' },
  { field: 'company', requirement: '有甲公司任职经历', quote: '有甲公司任职经历' },
  { field: 'salary', requirement: '期望月薪20-30K', quote: '期望月薪20-30K' },
]
const card = '王女士，32岁，8年工作经验，期望工作城市北京，学历本科，曾就职甲公司，期望月薪25K'
const rows = () => criteria.map(c => ({ field: c.field, state: 'match', quote: card, reason: '列表有明确依据' }))
const done = { status: 'completed', message: 'done', turns: 1, modelMs: 0, toolMs: 0 }
const signal = () => new AbortController().signal

test('the four requested list conditions must all match, independently of skill evidence', () => {
  const four = criteria.slice(0, 4), assessments = rows().slice(0, 4)
  assert.deepEqual(assessListCandidate(four, assessments, card), { qualified: true, score: 100, matchedCount: 4, requiredCount: 4, mismatch: false, unknown: false })
  for (const field of four.map(c => c.field)) for (const state of ['mismatch', 'unknown']) {
    const result = assessListCandidate(four, assessments.map(row => row.field === field ? { ...row, state, quote: state === 'unknown' ? '' : card } : row), card)
    assert.equal(result.qualified, false, `${field}/${state}`)
    assert.equal(result.matchedCount, 3); assert.equal(result.requiredCount, 4); assert.equal(result.score, 75)
  }
})

test('all six permitted dimensions participate only when explicitly configured', () => {
  validateListCriteria(criteria, source)
  assert.equal(assessListCandidate(criteria, rows(), card).qualified, true)
  for (const field of ['company', 'salary']) assert.equal(assessListCandidate(criteria, rows().map(row => row.field === field ? { ...row, state: 'mismatch' } : row), card).qualified, false)
  assert.equal(assessListCandidate([criteria[3]], [rows()[3]], card).qualified, true, 'unrequested age, city, salary and company never add conditions')
  assert.deepEqual(assessListCandidate([], [], card), { qualified: true, score: null, matchedCount: 0, requiredCount: 0, mismatch: false, unknown: false })
  assert.throws(() => assessListCandidate(undefined, [], card), /LIST_REQUIREMENTS_REQUIRED/)
  assert.throws(() => assessListCandidate(criteria, [...rows().slice(1), rows()[1]], card), /LIST_ASSESSMENT_REQUIRED/)
  assert.throws(() => assessListCandidate(criteria, rows().map(row => ({ ...row, quote: '另一个人的信息' })), card), /EVIDENCE_MISSING/)
  assert.throws(() => assessListCandidate(criteria, rows().map(row => ({ ...row, state: 'partial' })), card), /LIST_ASSESSMENT_REQUIRED/)
})

test('new standards require explicit list criteria and source quotes; unsupported dimensions cannot enter', () => {
  const standard = { keyword: 'Java', criteria: [{ id: 'java', label: 'Java', quote: 'Java', weight: 100, must: true }] }
  assert.equal(requirementsSpec.safeParse(standard).success, false)
  assert.equal(requirementsSpec.safeParse({ ...standard, listCriteria: criteria }).success, true)
  assert.equal(requirementsSpec.safeParse({ ...standard, listCriteria: [{ ...criteria[0], field: 'gender' }] }).success, false)
  assert.throws(() => validateListCriteria([criteria[0], criteria[0]], source), /LIST_REQUIREMENTS_INVALID/)
  assert.throws(() => validateListCriteria([{ ...criteria[0], quote: '年龄30岁以下' }], source), /LIST_REQUIREMENTS_INVALID/)
})

test('preview model only receives six-dimensional list requirements, never detail skill weights or threshold', async () => {
  const requirements = { keyword: 'Java', criteria: [{ id: 'java', label: 'Java项目', weight: 100, must: true }], listCriteria: criteria.slice(0, 4) }
  const sources = [{ sourceId: 'first', name: '王女士', text: card }, { sourceId: 'second', name: '李先生', text: '李先生，36岁，8年工作经验，期望北京，本科' }]
  const result = await evaluateSources(async options => {
    assert.equal(options.goal.criteria, undefined)
    assert.equal(options.goal.minimumScore, undefined)
    assert.deepEqual(options.goal.listCriteria, requirements.listCriteria)
    assert.equal(options.tools[0].inputSchema.properties.candidates.items.properties.assessments, undefined)
    assert.match(options.system, /不能把现居城市当作工作意向/)
    assert.match(options.system, /不能仅凭区间有交集/)
    const candidates = options.goal.candidates.map(s => ({ sourceId: s.sourceId, listAssessments: requirements.listCriteria.map(c => ({ field: c.field, state: s.sourceId === 'second' && c.field === 'age' ? 'mismatch' : 'match', evidenceId: 0, reason: 'Explicit list evidence' })) }))
    await assert.rejects(options.tools[0].execute({ candidates: [candidates[0], candidates[0]] }), /SOURCE_MISMATCH/)
    await assert.rejects(options.tools[0].execute({ candidates: candidates.map(c => ({ ...c, listAssessments: c.listAssessments.map(r => ({ ...r, evidenceId: 999 })) })) }), /EVIDENCE_MISSING/)
    await options.tools[0].execute({ candidates })
    return done
  }, requirements, sources, signal(), undefined, 'preview')
  assert.equal(assessListCandidate(requirements.listCriteria, result[0].listAssessments, card).qualified, true)
  assert.equal(assessListCandidate(requirements.listCriteria, result[1].listAssessments, sources[1].text).qualified, false)
  assert.deepEqual(result[0].assessments, [])
  assert.equal(result[1].listAssessments[0].quote, sources[1].text)
})

test('omitted list evidence remains unknown, while no configured list requirements avoids a model call', async () => {
  const requirements = { keyword: 'Java', criteria: [], listCriteria: criteria.slice(0, 4) }
  const [result] = await evaluateSources(async options => {
    await options.tools[0].execute({ candidates: [{ sourceId: 'person', listAssessments: [{ field: 'education', state: 'match', evidenceId: 0, reason: 'Explicit education' }] }] })
    return done
  }, requirements, [{ sourceId: 'person', name: '王女士', text: card }], signal(), undefined, 'preview')
  assert.equal(result.listAssessments.filter(row => row.state === 'unknown').length, 3)
  assert.equal(assessListCandidate(requirements.listCriteria, result.listAssessments, card).qualified, false)
  const [empty] = await evaluateSources(async () => assert.fail('no requirements need no model judgement'), { ...requirements, listCriteria: [] }, [{ sourceId: 'person', name: '王女士', text: card }], signal(), undefined, 'preview')
  assert.deepEqual(empty.listAssessments, [])
})
