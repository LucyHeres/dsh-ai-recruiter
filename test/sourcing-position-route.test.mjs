import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LiepinPositionRoute } from '../dist/lib/platforms/liepin/position-route.js'

import { StandardPositionRoute } from '../dist/lib/platforms/types.js'

const trigger = { ref: 'top', role: 'div', name: '不限职位', controls: 'top-popup' }
const choice = { ref: 'choice', role: 'span', name: 'Java开发' }
const page = { snapshotId: 's1', documentId: 'doc', items: [trigger, choice,
  { ref: 'popup', role: 'listbox', elementId: 'top-popup' },
  { ref: 'inner', role: 'combobox', tagName: 'input', name: '搜索职位名称', parentRef: 'popup' },
  { ref: 'lower', role: 'combobox', tagName: 'input', name: '搜索职位名称' }] }
const call = (name, ref, tabId = 1) => ({ name, args: { tabId, ref }, readOnly: name === 'browser_snapshot', purpose: 'navigation' })

test('only a successful menu opener permits plain target job labels, scoped to the same tab and document', async () => {
  const route = new LiepinPositionRoute(['Java开发'])
  const click = call('browser_click', 'choice')
  assert.equal(route.allowsChoice(click, page), false)
  await route.dispatch(call('browser_click', 'top'), page, async () => ({}))
  await route.dispatch(call('browser_snapshot'), page, async () => ({}))
  assert.equal(route.allowsChoice(click, page), true)
  assert.equal(route.allowsChoice(call('browser_click', 'choice', 2), page), false)
  assert.equal(route.allowsChoice(click, { ...page, documentId: 'other' }), false)
  assert.equal(route.allowsChoice(click, { ...page, items: [{ ...choice, href: '/resume/1' }] }), false)
  await route.dispatch(click, page, async () => ({}))
  assert.equal(route.allowsChoice(click, page), false)
  await assert.rejects(route.dispatch(call('browser_click', 'top'), page, async () => { throw Error('ELEMENT_HIDDEN') }))
  assert.equal(route.allowsChoice(click, page), false)
})

test('typing may search inside the opened top popup but cannot use the separate resume filter', async () => {
  const route = new LiepinPositionRoute(['Java开发'])
  assert.throws(() => route.assertInput(call('browser_type', 'inner'), page), /POSITION_ROUTE_REQUIRED/)
  await route.dispatch(call('browser_click', 'top'), page, async () => ({}))
  assert.doesNotThrow(() => route.assertInput(call('browser_type', 'inner'), page))
  assert.throws(() => route.assertInput(call('browser_type', 'lower'), page), /POSITION_ROUTE_REQUIRED/)
  await route.dispatch(call('browser_type', 'inner'), page, async () => ({}))
  assert.equal(route.allowsChoice(call('browser_click', 'choice'), page), true)
  const boss = new StandardPositionRoute()
  assert.doesNotThrow(() => boss.assertInput(call('browser_type', 'lower'), page))
  assert.equal(boss.allowsChoice(call('browser_click', 'top'), page), false)
})

test('a custom select confirms only the new observed value at its original trigger, never a menu option or another row', async () => {
  const route = new LiepinPositionRoute(['Java开发'])
  const bounds = { x: 40, y: 42, width: 100, height: 30 }
  await route.dispatch(call('browser_click', 'top'), { ...page, items: [{ ...trigger, bounds }] }, async () => ({}))
  const current = { ...page, snapshotId: 's2', items: [{ ...choice, ref: 'current', bounds }, { ...choice, ref: 'option', bounds: { ...bounds, y: 90 } }] }
  assert.equal(route.isSelectedTrigger(1, current, 'current'), false, 'an opened menu is not a confirmed closed selection')
  await route.dispatch(call('browser_click', 'choice'), page, async () => ({}))
  assert.equal(route.isSelectedTrigger(1, current, 'current'), true)
  assert.equal(route.isSelectedTrigger(1, current, 'option'), false)
  assert.equal(route.isSelectedTrigger(2, current, 'current'), false)
  assert.equal(route.isSelectedTrigger(1, { ...current, documentId: 'new-document' }, 'current'), false)
  for (const change of [{ name: '产品经理' }, { role: 'textbox', tagName: 'input', value: 'Java开发' }, { states: ['hidden'] }, { states: ['expanded'] }]) {
    assert.equal(route.isSelectedTrigger(1, { ...current, items: [{ ...current.items[0], ...change }] }, 'current'), false)
  }
})
