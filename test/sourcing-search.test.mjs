import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveSourcingSearchFilters, hasSourcingPositionSelector, verifySourcingSearchFilters, verifySourcingSearchPosition, verifySourcingExhaustion } from '../dist/lib/sourcing-search.js'
import { readSourcingPosition } from '../dist/lib/sourcing-position.js'
import { sourcingTotalTarget } from '../dist/shared/sourcing-score.js'
const position = { id: 'job', name: 'Java开发', city: '湖北省/武汉市', description: 'Java开发，5年以上，大专及以上' }
const page = items => ({ tabId: 1, snapshotId: 's', url: 'https://lpt.liepin.com/search', items })
const selected = (ref, name) => ({ ref, name, role: 'option', states: ['selected'] })
const proof = (field, ref, quote) => ({ field, ref, quote, state: 'applied' })

test('search fields import authoritative job enums and explicit supplements override individual fields', async () => {
  const imported = await readSourcingPosition({ call: async () => ({ ok: true, data: { jobId: 'job', jobDesc: position.description, workAge: 2, eduGrade: 5, workCity: '湖北省/武汉市' } }) }, 'job', [{ id: 'job', name: 'Java开发' }])
  assert.deepEqual(imported.searchFields, { city: '湖北省/武汉市', experience: '3–5年', education: '本科' })
  assert.deepEqual(deriveSourcingSearchFilters(imported, ''), imported.searchFields)
  assert.deepEqual(deriveSourcingSearchFilters(imported, '工作地点：上海\n工作经验：5–10年\n学历要求：硕士及以上'), { city: '上海', experience: '5–10年', education: '硕士及以上' })
  assert.deepEqual(deriveSourcingSearchFilters(imported, '工作经验：不限\n学历要求：不限'), { city: '湖北省/武汉市' })
  assert.deepEqual(deriveSourcingSearchFilters(position, ''), { city: '湖北省/武汉市', experience: '5年以上', education: '大专及以上' })
})

test('filters require current applied evidence for every fixed requirement', () => {
  const expected = { city: '湖北省/武汉市', experience: '3–5年', education: '本科' }
  const current = page([selected('city', '期望城市 武汉'), selected('exp', '工作经验 3–5年'), selected('edu', '本科及以上')])
  const evidence = [proof('city', 'city', '武汉'), proof('experience', 'exp', '3–5年'), proof('education', 'edu', '本科及以上')]
  assert.equal(verifySourcingSearchFilters(current, expected, evidence).length, 3)
  assert.throws(() => verifySourcingSearchFilters(current, expected, evidence.slice(0, 2)), /education/)
  current.items[0].name = '期望城市 北京'
  assert.throws(() => verifySourcingSearchFilters(current, expected, [proof('city', 'city', '北京'), ...evidence.slice(1)]), /未覆盖/)
})

test('unselected options, editable dropdown search text and background dialogs cannot stand in for applied filters', () => {
  for (const item of [
    { ref: 'a', role: 'option', name: '本科及以上' },
    { ref: 'a', role: 'combobox', tagName: 'input', name: '学历', value: '本科及以上' },
    { ref: 'a', role: 'button', name: '学历', context: { text: '选项：本科及以上' } },
    { ref: 'a', role: 'option', name: '本科及以上', states: ['selected', 'blocked_by_dialog'] },
  ]) assert.throws(() => verifySourcingSearchFilters(page([item]), { education: '本科' }, [proof('education', 'a', '本科及以上')]), /UNVERIFIED|UNREADABLE/)
})

test('experience buckets must cover the requested interval and education includes higher degrees', () => {
  const current = page([selected('junior', '1-3年'), selected('middle', '3-5年'), selected('senior', '5-10年'), ...['本科', '硕士', '博士'].map(name => selected(name, name))])
  assert.throws(() => verifySourcingSearchFilters(page([selected('all', '经验不限')]), { experience: '3–5年' }, [proof('experience', 'all', '经验不限')]), /未覆盖/)
  assert.throws(() => verifySourcingSearchFilters(current, { experience: '3–5年' }, [proof('experience', 'junior', '1-3年')]), /未覆盖/)
  assert.equal(verifySourcingSearchFilters(current, { experience: '3–5年' }, [proof('experience', 'middle', '3-5年'), proof('experience', 'senior', '5-10年')]).length, 1)
  assert.throws(() => verifySourcingSearchFilters(current, { education: '本科' }, [proof('education', '本科', '本科')]), /未覆盖/)
  assert.equal(verifySourcingSearchFilters(current, { education: '本科' }, ['本科', '硕士', '博士'].map(name => proof('education', name, name))).length, 1)
})

test('unavailable filters require an observed platform restriction, not an invented explanation', () => {
  const current = page([{ ref: 'notice', role: 'text', name: '开通高级会员可使用学历筛选' }])
  assert.deepEqual(verifySourcingSearchFilters(current, { education: '本科' }, [{ field: 'education', ref: 'notice', quote: '开通高级会员可使用学历筛选', state: 'unsupported' }]), [{ field: 'education', state: 'unsupported' }])
  assert.throws(() => verifySourcingSearchFilters(current, { education: '本科' }, [{ field: 'education', ref: 'notice', quote: '未找到学历', state: 'unsupported' }]), /UNVERIFIED/)
})

test('job selection uses the linked platform job, accepts a closed value and rejects unselected options or typed inputs', () => {
  const job = { jobId: 'job', position, platformJobs: { liepin: [{ id: 'lp-1', name: 'Java研发工程师' }] } }
  const current = page([{ ref: 'job', role: 'combobox', tagName: 'div', name: '职位', value: 'Java研发工程师' }])
  assert.equal(hasSourcingPositionSelector(current), true)
  assert.equal(verifySourcingSearchPosition(current, job, 'liepin', { ref: 'job' }).level, 'degraded')
  for (const item of [
    { ref: 'job', role: 'option', name: 'Java研发工程师' },
    { ref: 'job', role: 'combobox', tagName: 'input', name: '职位', value: 'Java研发工程师' },
    { ref: 'job', role: 'combobox', tagName: 'input', name: 'Java研发工程师', value: 'Java研发工程师', states: ['selected'] },
    { ref: 'job', role: 'combobox', tagName: 'div', name: '职位', value: '产品经理' },
  ]) assert.throws(() => verifySourcingSearchPosition(page([item]), job, 'liepin', { ref: 'job' }), /POSITION_SELECTION_REQUIRED/)
  assert.equal(hasSourcingPositionSelector(page([{ ref: 'top', role: 'div', name: '不限职位' }])), true)
})

test('early completion needs a real end-of-results message and new per-platform targets do not rewrite historical totals', () => {
  assert.doesNotThrow(() => verifySourcingExhaustion(page([{ ref: 'end', role: 'text', name: '没有更多结果' }]), { ref: 'end', quote: '没有更多结果' }))
  assert.throws(() => verifySourcingExhaustion(page([{ ref: 'end', role: 'text', name: '共有3000+份简历' }]), { ref: 'end', quote: '共有3000+份简历' }), /EXHAUSTION_UNVERIFIED/)
  assert.equal(sourcingTotalTarget({ limit: 5, platforms: ['liepin', 'boss'], limitScope: 'per_platform' }), 10)
  assert.equal(sourcingTotalTarget({ limit: 5, platforms: ['liepin', 'boss'] }), 5)
})
