import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findPositionEvidence, verifyPositionEvidence } from '../dist/lib/position-evidence.js'
import { positionBusinessIds, positionChoices } from '../dist/lib/position-controls.js'

const job = { jobId: 'host-job', jobName: 'Java工程师', platformJobs: [{ id: '123', name: 'Java工程师' }] }
const current = (elementId, extra = {}) => ({ ref: 'position', role: 'tab', name: 'Java工程师', states: ['selected'], elementId, ...extra })
const page = (items = [current()], url = 'https://lpt.liepin.com/recommend') => ({ snapshotId: 's1', url, items })
const verify = (p, target = job, proof = { ref: 'position' }) => verifyPositionEvidence(p, target, proof)

test('missing, changed and misleading DOM IDs all preserve unique name plus selection without inventing a business ID', () => {
  for (const id of [undefined, '', 'rc-tabs-999-tab-456', 'arbitrary-random-widget', 'job-123']) {
    for (const target of [job, { ...job, platformJobs: [] }]) {
      const p = page([current(id)])
      const result = verify(p, target, { ref: 'position', platformJobId: '123' })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.verification.level, 'degraded')
      assert.equal(result.verification.platformJobId, undefined)
      assert.equal(findPositionEvidence(p, target).length, 1)
    }
  }
})

test('only explicit same-origin business fields corroborate identity; arbitrary URL values and DOM IDs do not', () => {
  assert.deepEqual(positionBusinessIds(page([], 'https://lpt.liepin.com/recommend?session=123&candidateId=123')), [])
  assert.deepEqual(positionBusinessIds(page(), { href: 'https://foreign.example/?jobId=123' }), [])
  for (const key of ['jobId', 'eJobId', 'positionId', 'recruitJobId', 'encryptJobId']) {
    const p = page([current('job-456')], `https://lpt.liepin.com/recommend?${key}=123`)
    assert.equal(verify(p).verification.level, 'exact')
    p.url = p.url.replace('=123', '=456')
    assert.equal(verify(p).ok, false)
  }
  assert.equal(verify(page([current(undefined, { href: '?jobId=456' })])).ok, false)
  assert.equal(verify(page(), job, { ref: 'position', platformJobId: 'wrong' }).ok, false)
})

test('a matching URL cannot turn an unselected option or a typed input into current position', () => {
  for (const item of [current(undefined, { states: [] }), current(undefined, { role: 'option', states: [] }),
    current(undefined, { role: 'combobox', tagName: 'input' }), current(undefined, { role: 'combobox', states: ['selected', 'expanded'] })]) {
    assert.equal(verify(page([item], 'https://lpt.liepin.com/recommend?jobId=123')).ok, false)
  }
})

test('name matching rejects substrings, candidate-owned controls, dialogs and invisible controls', () => {
  for (const item of [current(undefined, { name: '高级Java工程师' }), current(undefined, { name: 'Java工程师 专家' }),
    current(undefined, { name: '产品经理', context: { text: 'Java工程师' } }), current(undefined, { dialogRef: 'resume' }),
    current(undefined, { states: ['selected', 'hidden'] })]) {
    try { assert.equal(verify(page([item])).ok, false) } catch (error) { assert.match(String(error), /UNREADABLE/) }
  }
  assert.equal(verify(page([{ ref: 'card', role: 'article', name: '张先生 30岁 求职意向：Java工程师' }, current(undefined, { parentRef: 'card' })])).ok, false)
  assert.equal(verify(page([current(undefined, { name: 'Java工程师 高交付' })])).ok, true)
})

test('independent same-name choices and same-name mappings need business evidence; nested title is one control', () => {
  const second = { ...current('job-456'), ref: 'second', states: [] }
  assert.equal(verify(page([current('job-123'), second])).ok, false)
  const duplicate = { ...job, platformJobs: [...job.platformJobs, { id: '456', name: job.jobName }] }
  assert.equal(verify(page(), duplicate).ok, false)
  assert.equal(verify(page([current()], 'https://lpt.liepin.com/recommend?jobId=123'), duplicate).verification.platformJobId, '123')
  assert.equal(verify(page([current(), { ...current(), ref: 'title', role: 'text', parentRef: 'position' }])).ok, true)
  assert.equal(verify(page([current(), { ...second, states: ['selected'] }])).ok, false)
})

test('selection metadata binds to a widget structurally, not by extracting its ID suffix', () => {
  const p = page([current('widget-456', { states: [] })])
  p.selectedTabs = [{ name: job.jobName, elementId: 'widget-456' }]
  assert.equal(verify(p).ok, true)
  p.selectedTabs[0].states = ['hidden']
  assert.equal(verify(p).ok, false)
  p.selectedTabs[0].states = []
  p.selectedTabs[0].elementId = 'other-widget-123'
  assert.equal(verify(p).ok, false)
})

test('a foreground selected job control stays readable; dialog prose and background selections do not', () => {
  const p = { ...page([current(undefined, { dialogRef: 'resume' })]), dialogs: [{ ref: 'resume' }] }
  assert.equal(verify(p).ok, true)
  p.items[0].role = 'text'
  assert.equal(verify(p).ok, false)
  p.items[0].role = 'tab'; p.items[0].states.push('blocked_by_dialog')
  assert.throws(() => verify(p), /UNREADABLE/)
})

test('same-name options cannot be disambiguated by dynamic DOM IDs or the current URL', () => {
  const options = [current('job-123', { states: [] }), { ...current('job-456', { states: [] }), ref: 'second' }]
  const p = page(options, 'https://lpt.liepin.com/recommend?jobId=123')
  assert.equal(positionChoices(p, options, job.platformJobs).length, 2)
  const targets = [...job.platformJobs, { id: '456', name: job.jobName }]
  assert.deepEqual(positionChoices(p, options, targets, '456'), [])
  options[0].href = '?jobId=123'; options[1].href = '?jobId=456'
  assert.deepEqual(positionChoices(p, options, targets, '456').map(item => item.ref), ['second'])
})
