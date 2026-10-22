import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { LiepinSearchEvidence } from '../dist/lib/platforms/liepin/search-evidence.js'
import { recommendationFilterDialog } from '../dist/lib/platforms/liepin/recommendation-controls.js'
import { assertSourcingNavigation } from '../dist/lib/sourcing-policy.js'
const captured = JSON.parse(readFileSync(new URL('./fixtures/liepin-recommend-filter-controls.json', import.meta.url)))
function fixture() {
  const { page, inspections } = structuredClone(captured)
  const resolver = new LiepinSearchEvidence({ getInspection: (_page, ref) => inspections.find(row => row.ref === ref), inspectRefs: async () => {} })
  return { page, inspections, resolver }
}
test('real recommendation drawer spans resolve as filters while same-label candidate text grants no filter evidence', async () => {
  const { page, resolver } = fixture()
  await resolver.scan(page, [], { education: '本科' }, new AbortController().signal)
  const item = page.items.find(item => item.name === '本科')
  const control = resolver.control(page, item.ref)
  assert.equal(control.kind, 'filter'); assert.equal(control.field, 'education'); assert.equal(control.selected, false)
  const call = { name: 'browser_click', args: { ref: item.ref }, purpose: 'navigation', readOnly: false }
  assert.doesNotThrow(() => assertSourcingNavigation(call, page, undefined, false, !!control))
  const candidatePage = { ...page, dialogs: [], items: [{ ...item, dialogRef: undefined }] }
  assert.equal(resolver.control(candidatePage, item.ref), undefined)
  assert.doesNotThrow(() => assertSourcingNavigation(call, candidatePage), 'generic navigation is left to the model and browser hit-test')
})
test('drawer title counts and selected CSS are state changes, not a new unknown component', async () => {
  const { page, inspections, resolver } = fixture()
  page.dialogs[0].text = page.dialogs[0].text.replace('筛选条件', '筛选条件（1）')
  const item = page.items.find(item => item.name === '本科')
  inspections.find(row => row.ref === item.ref).element.attributes.class += ' ant-lpt-tag-checkable-checked'
  await resolver.scan(page, [], { education: '本科' }, new AbortController().signal)
  assert.equal(recommendationFilterDialog(page).ref, item.dialogRef)
  assert.equal(resolver.control(page, item.ref).selected, true)
  const button = page.items.find(item => item.name === '确定' && item.role === 'button')
  assert.equal(resolver.control(page, button.ref).kind, 'confirm')
})
test('a field declaration cannot borrow another group or treat a draft as committed selection', async () => {
  const { page, resolver } = fixture()
  await resolver.scan(page, [], {}, new AbortController().signal)
  const item = page.items.find(item => item.name === '本科')
  assert.throws(() => resolver.filterPage(page, [{ field: 'city', ref: item.ref }]), /所声明字段/)
  assert.throws(() => resolver.filterPage(page, [{ field: 'education', ref: item.ref }]), /未选中/)
  page.dialogs[0].text = '未知业务弹窗 本科 硕士 博士'
  assert.equal(resolver.control(page, item.ref), undefined)
})
