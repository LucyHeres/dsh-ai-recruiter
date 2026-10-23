import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withFixedListCriteria } from '../dist/lib/sourcing/requirement-policy.js'
import { deriveSourcingSearchFilters } from '../dist/lib/sourcing-search.js'
import { sourcingSource, sourcingVersion } from '../dist/lib/sourcing-policy.js'
import { validateListCriteria } from '../dist/lib/sourcing/list-screening.js'
import { candidateFilterFailure } from '../dist/lib/sourcing/candidate-filters.js'
import { requirementsGoal, matchingInstructions } from '../dist/lib/sourcing/matching-skill.js'

const position = { id: 'sales', name: '高级销售经理', city: '上海市',
  description: '3年以上to B软件相关销售工作经验；本科及以上学历；工作城市北京。',
  basicRequirements: { experience: '1–3年', education: '大专', city: '上海市' },
  searchFields: { experience: '1–3年', education: '大专', city: '上海市' } }
const extracted = [{ field: 'education', requirement: '本科及以上', quote: '本科及以上学历' },
  { field: 'city', requirement: '北京', quote: '工作城市北京' }]

test('fixed fields fill the omitted experience requirement and replace conflicting JD education and city rules', () => {
  const rows = withFixedListCriteria(position, '', extracted)
  assert.deepEqual(rows.map(row => [row.field, row.requirement]), [['city', '上海市'], ['experience', '1–3年'], ['education', '大专及以上']])
  validateListCriteria(rows, sourcingSource(position, ''))
  assert.deepEqual(requirementsGoal(position, '').authoritativeBasicFilters, position.searchFields)
  assert.match(matchingInstructions(), /固定字段 > JD/)
  assert.match(matchingInstructions(), /不能再把“3年以上”设为详情 must/)
})

test('the original fixed values take precedence over a stale derived search-field copy', () => {
  const stale = { ...position, searchFields: { experience: '3年以上', education: '本科', city: '北京' } }
  assert.deepEqual(deriveSourcingSearchFilters(stale, ''), position.searchFields)
})

test('explicit unlimited fixed fields remove lower-priority JD conditions instead of reintroducing them', () => {
  const unlimited = { ...position, basicRequirements: { city: '不限', experience: '经验不限', education: '不限' } }
  assert.deepEqual(deriveSourcingSearchFilters(unlimited, ''), {})
  assert.deepEqual(withFixedListCriteria(unlimited, '', [...extracted, { field: 'experience', requirement: '3年以上', quote: '3年以上' }]), [])
})

test('a deliberate task supplement can override individual fixed fields while a preference does not', () => {
  const supplement = '工作城市：杭州；工作经验：5–10年；学历要求：硕士及以上'
  const rows = withFixedListCriteria(position, supplement, extracted)
  assert.deepEqual(rows.map(row => row.requirement), ['杭州', '5–10年', '硕士及以上'])
  validateListCriteria(rows, sourcingSource(position, supplement))
  assert.deepEqual(withFixedListCriteria(position, '优先工作经验：10年以上', extracted), withFixedListCriteria(position, '', extracted))
})

test('JD-only dimensions remain available when a fixed field is absent', () => {
  const jdOnly = { ...position, city: '', basicRequirements: {}, searchFields: {} }
  assert.deepEqual(withFixedListCriteria(jdOnly, '', extracted), extracted)
})

test('changing fixed fields invalidates cached standards even if the JD text is unchanged', () => {
  assert.notEqual(sourcingVersion(position, ''), sourcingVersion({ ...position, basicRequirements: { ...position.basicRequirements, experience: '5–10年' } }, ''))
})

test('rejection messages identify only the failed or unknown conditions and preserve their distinction', () => {
  const rows = [{ field: 'city', state: 'match', reason: '期望上海' },
    { field: 'experience', state: 'mismatch', reason: '实际6年，超出1–3年' }, { field: 'education', state: 'match', reason: '本科达到大专门槛' }]
  const failed = candidateFilterFailure(position.searchFields, rows)
  assert.match(failed, /工作经验不符合.*1–3年.*实际6年/)
  assert.doesNotMatch(failed, /学历|城市|尚无法确认/)
  rows[1] = { field: 'experience', state: 'match', reason: '工作2年' }
  rows[2] = { field: 'education', state: 'unknown', reason: '教育经历未展示' }
  assert.match(candidateFilterFailure(position.searchFields, rows), /学历尚无法确认.*大专.*教育经历未展示/)
  assert.doesNotMatch(candidateFilterFailure(position.searchFields, rows), /不符合|工作经验/)
})
