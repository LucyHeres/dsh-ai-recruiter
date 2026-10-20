import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { LiepinSearchEvidence, liepinSearchControl } from '../dist/lib/platforms/liepin/search-evidence.js'
import { verifySourcingSearchFilters } from '../dist/lib/sourcing-search.js'
const captured = JSON.parse(readFileSync(new URL('./fixtures/liepin-search-controls.json', import.meta.url)))
function fixture() {
  const data = structuredClone(captured)
  const page = { tabId: 1, snapshotId: 's', url: 'https://lpt.liepin.com/search', format: 'semantic', items: Object.values(data).map(row => ({ ...row.item, ...row.inspection.item })) }
  const details = new Map(Object.values(data).map(row => [row.item.ref, row.inspection]))
  const resolver = new LiepinSearchEvidence({ getInspection: (_page, ref) => details.get(ref) })
  return { data, page, resolver }
}
const job = { jobId: 'local', jobName: 'java开发-zidi', platformJobs: [{ id: '83698185', name: 'java开发-zidi' }] }

test('captured top current value needs no click history, synthetic AX selected state or exposed ID', () => {
  const { page, resolver } = fixture()
  for (const proof of [{ ref: 'e58' }, { ref: 'e58', platformJobId: '83698185' }]) {
    const result = resolver.position(page, job, proof)
    assert.equal(result.ok, true); assert.equal(result.verification.level, 'degraded')
    assert.equal(result.verification.platformJobId, undefined)
  }
  assert.equal(resolver.position(page, job, { ref: 'e58', platformJobId: 'wrong' }).ok, false)
  assert.equal(resolver.position(page, { ...job, platformJobs: [...job.platformJobs, { id: 'another', name: job.jobName }] }, { ref: 'e58' }).ok, false)
  assert.equal(resolver.position({ ...page, url: page.url + '?jobId=another' }, job, { ref: 'e58' }).ok, false)
  assert.equal(resolver.position({ ...page, url: page.url + '?jobId=83698185' }, job, { ref: 'e58' }).verification.level, 'exact')
})

test('captured CSS-selected city passes field proof while unselected education and wrong field cannot pass', () => {
  const { page, resolver } = fixture()
  const proof = [{ field: 'city', ref: 'e89', quote: '武汉', state: 'applied' }]
  assert.equal(page.items.find(i => i.ref === 'e89').states.includes('selected'), false)
  assert.throws(() => verifySourcingSearchFilters(page, { city: '武汉' }, proof), /UNVERIFIED/)
  assert.equal(verifySourcingSearchFilters(resolver.filterPage(page, proof), { city: '武汉' }, proof).length, 1)
  assert.throws(() => resolver.filterPage(page, [{ field: 'education', ref: 'e109' }]), /未选中/)
  assert.throws(() => resolver.filterPage(page, [{ field: 'education', ref: 'e89' }]), /所声明字段/)
})

test('candidate text, expanded job menu, hidden controls and inactive confirms never become selected top evidence', () => {
  const { data } = fixture()
  assert.equal(liepinSearchControl({ ...data.city.item, name: '武汉' }, { element: { tagName: 'span', visible: true, attributes: { class: 'candidate-city active' } }, ancestors: [] }), undefined)
  assert.equal(liepinSearchControl(data.inactiveConfirm.item, data.inactiveConfirm.inspection).active, false)
  data.position.inspection.ancestors[0].attributes.class += ' ant-lpt-dropdown-open'
  assert.equal(liepinSearchControl(data.position.item, data.position.inspection).selected, false)
  data.position.inspection.element.visible = false
  assert.equal(liepinSearchControl(data.position.item, data.position.inspection).selected, false)
})

test('DOM-only inspection details preserve top component semantics without an AX item', () => {
  const { data } = fixture()
  delete data.position.inspection.item
  assert.equal(liepinSearchControl(data.position.item, data.position.inspection).kind, 'position')
})

test('search target computed pointer-events overrides inert sticky ancestor; text duplicates are not buttons', () => {
  const detail = { element: { tagName: 'button', visible: true, css: { pointerEvents: 'auto' } }, ancestors: [
    { attributes: { class: 'searchInputBox--hash' } }, { css: { pointerEvents: 'none', position: 'sticky' } },
  ] }
  assert.equal(liepinSearchControl({ ref: 'search', role: 'button', name: '搜索', states: ['occluded'] }, detail).active, true)
  assert.equal(liepinSearchControl({ ref: 'text', role: 'StaticText', name: '搜索' }, { ...detail, element: { ...detail.element, tagName: 'span' } }), undefined)
  detail.element.css.pointerEvents = 'none'
  assert.equal(liepinSearchControl({ ref: 'search', role: 'button', name: '搜索' }, detail).active, false)
})

test('captured multiselect degrees complete evidence from all observed selected siblings and share the same minimum-level plan', () => {
  const data = JSON.parse(readFileSync(new URL('./fixtures/liepin-education-selected.json', import.meta.url)))
  const page = { tabId: 1, snapshotId: 'degrees', url: 'https://lpt.liepin.com/search', items: data.map(row => row.item) }
  const resolver = new LiepinSearchEvidence({ getInspection: (_page, ref) => data.find(row => row.item.ref === ref)?.inspection })
  const first = page.items.find(item => item.name === '本科')
  const proofs = resolver.completeFilterProofs(page, [{ field: 'education', ref: first.ref, quote: '本科', state: 'applied' }])
  assert.equal(proofs.length, 3)
  assert.equal(verifySourcingSearchFilters(resolver.filterPage(page, proofs), { education: '本科' }, proofs).length, 1)
  assert.deepEqual(resolver.summary(page, { education: '本科' }).educationPlan.missingLevels, [])
  data.find(row => row.item.name === '硕士').inspection.element.attributes.class = 'search-page-filter-item'
  assert.deepEqual(resolver.summary(page, { education: '本科' }).educationPlan.missingLevels, ['硕士'])
})

test('recommendation education summary covers higher degrees without inventing missing multiselect options', async () => {
  const page = { tabId: 1, snapshotId: 'recommend', url: 'https://lpt.liepin.com/recommend', items: [
    { ref: 'position', role: 'tab', name: 'Java开发', elementId: 'rc-tabs-2-tab-123', states: ['selected'] },
    { ref: 'education', role: 'button', name: '学历：本科及以上', states: [] },
  ] }
  let inspections = 0
  const resolver = new LiepinSearchEvidence({ getInspection: () => undefined, inspectRefs: async (_page, refs) => { inspections += refs.length } })
  await resolver.scan(page, ['Java开发'], { education: '本科' }, new AbortController().signal)
  assert.deepEqual(resolver.summary(page, { education: '本科' }).educationPlan.missingLevels, [])
  assert.equal(inspections, 0)
  assert.equal(resolver.position(page, { jobId: 'local', jobName: 'Java开发', platformJobs: [{ id: '123', name: 'Java开发' }] }, { ref: 'position' }).verification.level, 'exact')
  assert.equal(resolver.position(page, { jobId: 'local', jobName: 'Java开发', platformJobs: [{ id: '456', name: 'Java开发' }] }, { ref: 'position' }).ok, false)
})
