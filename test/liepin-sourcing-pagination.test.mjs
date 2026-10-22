import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LiepinSourcingDriver } from '../dist/lib/platforms/liepin/sourcing-driver.js'

function fixture(options = {}) {
  let revision = 0, screen = options.screen ?? 0, scrolls = 0, current
  const snapshots = [], inputs = []
  const candidateItems = (index, y = 100) => {
    const name = ['张先生', '李先生', '陈先生', '王先生'][index]
    const text = `${name} 30岁 6年经验 本科 武汉 Java开发 工作经历：第${index}家公司负责订单服务及数据库开发。 在线提示${revision}`
    const bounds = { x: 100, y, width: 150, height: 30 }
    return [{ ref: `root-${index}`, role: 'article', name: text, bounds },
      { ref: `name-${index}`, role: 'text', name, parentRef: `root-${index}`, context: { text }, bounds },
      { ref: `greet-${index}`, role: 'button', name: '立即沟通', parentRef: `root-${index}`, context: { text }, bounds }]
  }
  const snapshot = args => {
    revision++; snapshots.push(args)
    const end = options.exhausted && screen === 3
    // A full-page snapshot is capped at the old prefix even as DOM size grows.
    // The viewport snapshot carries the actual current candidate instead.
    let items = end ? [{ ref: 'end', role: 'text', name: '没有更多推荐人才', bounds: { x: 100, y: 300, width: 200, height: 30 } }]
      : candidateItems(args.viewportOnly ? screen : 0, args.viewportOnly || screen === 0 ? 100 : options.partiallyVisibleOld ? -10 : -900)
    if (options.clippedName && args.viewportOnly) items = items.filter(item => item.role === 'button')
    if (options.clippedName && !args.viewportOnly) items.push(...candidateItems(screen))
    current = { tabId: 1, snapshotId: `s${revision}`, documentId: 'doc', format: 'dom', url: 'https://lpt.liepin.com/recommend',
      viewport: { width: 1440, height: 700, scrollY: scrolls * 350 }, items, dialogs: [],
      truncated: !args.viewportOnly, coverage: { totalItems: 20000 + revision, returnedItems: items.length } }
    return current
  }
  const broker = { currentPage: () => current, inspectRefs: async () => {},
    getInspection: (_page, ref) => ({ element: { attributes: { class: `xpath-resume-item-wrap xpath-resume-item-wrap-resume000${ref.split('-')[1]}` } } }),
    tools: [{ name: 'browser_snapshot', execute: snapshot }, { name: 'browser_scroll', execute: async args => {
      assert.equal(args.ref, `greet-${screen}`)
      assert.equal(args.snapshotId, current.snapshotId)
      inputs.push(args); scrolls++
      if (!options.stuck) screen = Math.min(3, screen + 1)
      return {}
    } }],
  }
  snapshot({ viewportOnly: true })
  const driver = new LiepinSourcingDriver({ broker, job: { sourceMode: 'recommend' }, signal: new AbortController().signal })
  return { driver, snapshots, inputs, counts: () => ({ screen, scrolls }) }
}

test('an appended and capped full DOM prefix cannot hide the new visible candidates after scrolling', async () => {
  const f = fixture(), ids = []
  for (let i = 0; i < 4; i++) {
    const cards = await f.driver.cards()
    assert.equal(cards.length, 1)
    assert.equal(cards[0].openRef, `name-${i}`)
    ids.push(cards[0].sourceId)
    if (i < 3) await f.driver.advance()
  }
  assert.equal(new Set(ids).size, 4)
  assert.equal(f.counts().scrolls, 3)
  assert.ok(f.snapshots.every(args => args.viewportOnly === true))
})

test('a fresh DOM view is resolved once and advancing reuses it instead of taking duplicate snapshots', async () => {
  const f = fixture()
  const before = f.snapshots.length
  const cards = await f.driver.cards({ refresh: false })
  assert.equal(cards.length, 1)
  assert.equal(f.snapshots.length, before)
  assert.equal(await f.driver.cards({ refresh: false }), cards)
  await f.driver.advance()
  assert.equal(f.snapshots.length, before)
  await f.driver.cards()
  assert.equal(f.snapshots.length, before + 1, 'assessment boundaries can explicitly renew refs')
})

test('full-tree ownership fallback still excludes old offscreen cards', async () => {
  const f = fixture({ screen: 2, clippedName: true })
  const cards = await f.driver.cards()
  assert.deepEqual(cards.map(card => card.openRef), ['name-2'])
  assert.ok(f.snapshots.some(args => args.viewportOnly === false))
})

test('a name clipped above the viewport is left for a later view rather than triggering a reverse scroll', async () => {
  const f = fixture({ screen: 2, clippedName: true, partiallyVisibleOld: true })
  assert.deepEqual((await f.driver.cards()).map(card => card.openRef), ['name-2'])
})

test('changing activity hints, DOM counts and background scroll cannot reset a stalled candidate list', async () => {
  const f = fixture({ stuck: true })
  await f.driver.cards()
  await f.driver.advance()
  await f.driver.advance()
  await assert.rejects(f.driver.advance(), /list_no_progress/)
  assert.equal(f.counts().scrolls, 2)
})

test('only an actual visible end message can finish a list below quota', async () => {
  const f = fixture({ screen: 3, exhausted: true })
  const result = await f.driver.advance()
  assert.equal(result.exhaustion.ref, 'end')
  assert.equal(f.counts().scrolls, 0)
})
