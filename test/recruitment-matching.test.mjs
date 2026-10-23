import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { recruitmentMatchingSkill } from '../dist/lib/browser-skill.js'
import { assessCandidate, validateCriteria, validateSupplementCoverage, sourcingVersion } from '../dist/lib/sourcing-policy.js'
import { rubricRequirementsSpec } from '../dist/lib/sourcing/contracts.js'
import { evaluateSources } from '../dist/lib/sourcing/evaluator.js'
import { requirementsGoal } from '../dist/lib/sourcing/matching-skill.js'
import { sourcingCandidateQualified, sourcingQualifiedCount } from '../dist/shared/sourcing-score.js'
import { sourcingResults } from '../dist/lib/sourcing-review.js'
import { deriveSourcingSearchFilters } from '../dist/lib/sourcing-search.js'
import { hash } from '../dist/lib/store.js'

const core = (id, weight) => ({ id, label: id, quote: id, tier: 'core', must: false, weight })
const criteria = [core('Python', 40), core('Django', 30), core('分布式', 30),
  { id: 'tenure', label: '上一段任职超过2年', quote: '优先上一段工作经历超过2年', tier: 'bonus', must: false, weight: 10 },
  { id: 'style', label: '编码习惯与规范', quote: '编码习惯与规范', tier: 'verify', must: false, weight: 0 }]
const resume = 'Python开发，Django服务，分布式系统。上一段工作2020.01—2024.06，负责接口规范和撮合引擎重构。'
const rows = () => criteria.map(c => ({ criterionId: c.id, state: 'match', quote: resume, reason: '实际项目与任职日期证据', evidenceKind: 'direct', confidence: 'high' }))
const requirements = { keyword: 'Python', rubricVersion: 2, criteria, listCriteria: [], supplementCoverage: [] }
const done = { status: 'completed', message: 'done', turns: 1, modelMs: 0, toolMs: 0 }

test('packaged matching skill is discoverable and the detail evaluator receives its full instructions and original requirements', async () => {
  const skill = recruitmentMatchingSkill()
  assert.equal(skill.name, 'recruitment-matching')
  assert.equal(skill.source, 'bundled')
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
  assert.ok(readFileSync(skill.path, 'utf8').includes(skill.content))
  await evaluateSources(async opts => {
    assert.ok(opts.system.includes(skill.content), 'isolated evaluation must actually receive the packaged rules')
    assert.deepEqual(opts.goal.criteria, criteria, 'the full quote and tier must not be reduced to a label')
    assert.deepEqual(opts.tools.map(t => t.name), ['sourcing_submit_assessments'])
    await opts.tools[0].execute({ candidates: [{ sourceId: 'candidate', assessments: rows().map(({ quote, ...row }) => ({ ...row, evidenceId: 0 })) }] })
    return done
  }, requirements, [{ sourceId: 'candidate', name: '测试候选人', text: resume }], new AbortController().signal)
})

test('soft requirements and missing bonuses never reduce the core score; unknown core evidence has a separate denominator', () => {
  const assessed = rows().map(row => ['Django', 'tenure', 'style'].includes(row.criterionId) ? { ...row, state: 'unknown', quote: '' } : row)
  const result = assessCandidate(criteria, assessed, resume)
  assert.equal(result.score, 100); assert.equal(result.coverage, 70)
  assert.deepEqual(result.scoring, { version: 2, baseScore: 100, bonusScore: 0, assessedWeight: 70, needsReview: false })
  const lower = rows().map(row => row.criterionId === 'Python' ? { ...row, state: 'partial' } : row.criterionId === 'tenure' ? { ...row, state: 'unknown', quote: '' } : row)
  assert.equal(assessCandidate(criteria, lower, resume).score, 80)
  assert.equal(assessCandidate(criteria, lower.map(row => row.criterionId === 'tenure' ? { ...row, state: 'match', quote: resume } : row), resume).score, 90)
})

test('sparse evidence, unknown hard requirements and inferred hard matches cannot qualify or consume quota', () => {
  const sparse = rows().map(row => ['Django', '分布式'].includes(row.criterionId) ? { ...row, state: 'unknown', quote: '' } : row)
  const result = assessCandidate(criteria, sparse, resume)
  assert.equal(result.score, 100); assert.equal(result.coverage, 40); assert.equal(result.scoring.needsReview, true)
  assert.equal(sourcingCandidateQualified(result, 60), false)
  assert.equal(sourcingQualifiedCount({ candidates: [result] }), 0)
  const must = { id: 'license', label: '必需资质', quote: '必需资质', tier: 'must', must: true, weight: 0 }
  for (const row of [{ state: 'unknown', quote: '' }, { state: 'partial', quote: resume }, { state: 'match', quote: resume, evidenceKind: 'inferred' }]) {
    const out = assessCandidate([...criteria, must], [...rows(), { criterionId: must.id, reason: '需要核实', ...row }], resume)
    assert.equal(out.scoring.needsReview, true)
    assert.equal(sourcingCandidateQualified(out, 0), false)
  }
  const conflict = assessCandidate([...criteria, must], [...rows(), { criterionId: must.id, state: 'mismatch', quote: resume, reason: '明确冲突' }], resume)
  assert.equal(conflict.verdict, 'unqualified'); assert.equal(sourcingCandidateQualified(conflict, 0), false)
})

test('indirect reasoning is grounded in multiple same-person excerpts and can earn at most partial credit', async () => {
  const text = '负责RESTful API接口规范和撮合引擎优化重构。' + '工作项目细节。'.repeat(40) + '参与代码评审与自动化测试。'
  const standard = { ...requirements, criteria: [core('工程实践', 100)] }
  const [judgement] = await evaluateSources(async opts => {
    const source = opts.goal.candidates[0]
    const row = { criterionId: '工程实践', state: 'match', evidenceId: 0, evidenceIds: [source.evidence.length - 1], evidenceKind: 'inferred', confidence: 'medium', reason: '重构与评审间接支持工程实践，具体规范待核实', verificationQuestion: '请说明代码评审、命名和测试方面采用的规范。' }
    await assert.rejects(opts.tools[0].execute({ candidates: [{ sourceId: 'one', assessments: [{ ...row, evidenceIds: [999] }] }] }), /EVIDENCE_MISSING/)
    await opts.tools[0].execute({ candidates: [{ sourceId: 'one', assessments: [row] }] })
    return done
  }, standard, [{ sourceId: 'one', name: '测试候选人', text }], new AbortController().signal)
  assert.equal(judgement.assessments[0].state, 'partial')
  assert.equal(judgement.assessments[0].evidenceQuotes.length, 2)
  assert.equal(assessCandidate(standard.criteria, judgement.assessments, text).score, 50)
  assert.throws(() => assessCandidate(standard.criteria, [{ ...judgement.assessments[0], evidenceQuotes: ['另一人的简历'] }], text), /EVIDENCE_MISSING/)
})

test('supplement segments must each map to a real source-linked criterion, list condition or visible explanation', () => {
  const supplement = '优先上一段工作经历超过2年；期望工作城市北京'
  const coverage = [{ quote: '优先上一段工作经历超过2年', criterionIds: ['tenure'], listFields: [] }, { quote: '期望工作城市北京', criterionIds: [], listFields: ['city'] }]
  const standard = { ...requirements, listCriteria: [{ field: 'city', requirement: '北京', quote: '期望工作城市北京' }], supplementCoverage: coverage }
  assert.deepEqual(requirementsGoal({}, supplement).supplementParts, coverage.map(row => row.quote))
  validateSupplementCoverage(standard, supplement)
  for (const bad of [[], coverage.slice(0, 1), [{ ...coverage[0], criterionIds: ['missing'] }, coverage[1]], [{ ...coverage[0], criterionIds: ['Python'] }, coverage[1]]]) {
    assert.throws(() => validateSupplementCoverage({ ...standard, supplementCoverage: bad }, supplement), /SUPPLEMENT_UNCOVERED/)
  }
  validateSupplementCoverage({ ...standard, supplementCoverage: [{ ...coverage[0], criterionIds: [], reason: '现有材料无法核验，需补充任职日期' }, coverage[1]] }, supplement)
})

test('new rubric validation separates core and bonus budgets and invalidates old cached standards', () => {
  const source = criteria.map(c => c.quote).join('；')
  validateCriteria(criteria, source)
  const wireCriteria = criteria.map((row, index) => ({ ...row, id: 'criterion' + index }))
  assert.equal(rubricRequirementsSpec.safeParse({ keyword: 'Python', criteria: wireCriteria, listCriteria: [] }).success, true)
  assert.equal(rubricRequirementsSpec.safeParse({ keyword: 'Python', criteria: criteria.map(({ tier, ...row }) => row), listCriteria: [] }).success, false)
  assert.throws(() => validateCriteria(criteria.map(c => c.id === 'tenure' ? { ...c, weight: 20 } : c), source), /RUBRIC_INVALID/)
  assert.throws(() => validateCriteria(criteria.map(c => c.id === 'style' ? { ...c, weight: 10 } : c), source), /RUBRIC_INVALID/)
  const many = Array.from({ length: 10 }, (_, i) => core('能力' + i, 10))
  validateCriteria(many, many.map(c => c.quote).join(' '))
  const position = { id: 'python', name: 'Python', description: source, city: '北京' }
  assert.notEqual(sourcingVersion(position, ''), hash({ listScreeningVersion: 1, ...position, supplement: '' }))
  assert.notEqual(sourcingVersion(position, ''), sourcingVersion(position, '优先上一段工作经历超过2年'))
})

test('preferences and previous-role tenure do not become total-experience, education or city hard filters', () => {
  const position = { description: '工作经验：3年以上；学历要求：本科', city: '北京' }
  const baseline = deriveSourcingSearchFilters(position, '')
  for (const supplement of ['优先工作经验：10年以上', '加分项：学历：硕士', '优先工作城市：上海', '上一段任职超过2年以上']) {
    assert.deepEqual(deriveSourcingSearchFilters(position, supplement), baseline)
  }
})

test('historical review candidates do not reenter the qualified list and their stored records remain intact', () => {
  const candidate = { key: 'review', name: '测试候选人', platform: 'liepin', score: 0, coverage: 0, verdict: 'review', fields: [],
    scoring: { version: 2, baseScore: 0, bonusScore: 0, assessedWeight: 0, needsReview: true } }
  const job = { id: 'round', jobId: 'python', kind: 'talent_sourcing', candidates: [candidate], createdAt: '2026-10-21', channels: [], minimumScore: 60, limit: 1 }
  const result = sourcingResults([job], 'python', 'all', new Map())
  assert.equal(result.candidates.length, 0); assert.equal(job.candidates.length, 1)
  assert.equal(result.current.candidateCount, 0); assert.equal(result.rounds[0].candidateCount, 0)
})

test('concrete implementation evidence supports foundation skills without repeating the JD keywords', async () => {
  const text = '独立实现树形权限继承、数据去重索引和任务优先级调度，优化检索排序，将接口响应从800ms降至120ms。'
  const standard = { ...requirements, criteria: [core('基本数据结构和算法', 100)] }
  const [judgement] = await evaluateSources(async opts => {
    assert.match(opts.system, /具体职责本身就是能力证据/)
    assert.match(opts.system, /先跨工作和项目寻找本人承担/)
    await opts.tools[0].execute({ candidates: [{ sourceId: 'one', assessments: [{ criterionId: '基本数据结构和算法', state: 'match', evidenceId: 0,
      evidenceKind: 'direct', confidence: 'high', reason: '本人实现树形权限、去重索引及调度，直接体现基础数据组织和算法应用。' }] }] })
    return done
  }, standard, [{ sourceId: 'one', name: '测试候选人', text }], new AbortController().signal)
  const result = assessCandidate(standard.criteria, judgement.assessments, text)
  assert.equal(result.score, 100)
  assert.equal(sourcingCandidateQualified(result, 60), true)
})
