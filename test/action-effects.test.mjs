import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionEffects } from '../dist/lib/action-effects.js'

const page = (revision, items, extra = {}) => ({ tabId: 1, snapshotId: 's' + revision,
  documentId: 'document', url: 'https://example.test/list', items, ...extra })

test('effects expose new refs and controls, while a dispatched receipt does not claim business success', () => {
  const before = page(1, [{ ref: 'old', role: 'button', name: '立即沟通' }])
  const after = page(2, [{ ref: 'new', role: 'button', name: '立即沟通' },
    { ref: 'choice', role: 'button', name: '超级聊聊' }])
  const effects = actionEffects(before, after, 'old', { output: { dispatched: true, changed: true } })
  assert.equal(effects.target.ref, 'new')
  assert.deepEqual(effects.addedControls.map(item => item.ref), ['choice'])
  assert.equal(effects.changed, true)
  assert.equal(effects.urlChanged, false)
  assert.equal('succeeded' in effects, false)
})

test('ref renewal alone adds no controls and ambiguous targets are never rebound by name', () => {
  const before = page(1, [{ ref: 'old', role: 'button', name: '查看简历' }])
  const renewed = page(2, [{ ref: 'fresh', role: 'button', name: '查看简历' }])
  assert.deepEqual(actionEffects(before, renewed, 'old', {}).addedControls, [])
  const ambiguous = page(3, [...renewed.items, { ref: 'other', role: 'button', name: '查看简历' }])
  assert.equal(actionEffects(before, ambiguous, 'old', {}).target, undefined)
  assert.equal(actionEffects(before, before, 'old', {}), undefined)
})

test('newly visible controls are reported, hidden ones are omitted, and a new document never inherits the old target', () => {
  const before = page(1, [{ ref: 'old', role: 'button', name: '筛选', states: ['hidden'] }])
  const after = page(2, [{ ref: 'new', role: 'button', name: '筛选' },
    { ref: 'hidden', role: 'button', name: '隐藏按钮', states: ['hidden'] }])
  assert.deepEqual(actionEffects(before, after, 'old', {}).addedControls.map(item => item.ref), ['new'])
  const nextDocument = page(3, [after.items[0]], { documentId: 'another' })
  const effects = actionEffects(page(2, [after.items[0]]), nextDocument, 'new', {})
  assert.equal(effects.target, undefined)
  assert.equal(effects.addedControls.length, 1)
})
