import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { liepinPromotionClose, dismissLiepinPromotion } from '../dist/lib/platforms/liepin/promotion-overlay.js'
import { LiepinSourcingDriver } from '../dist/lib/platforms/liepin/sourcing-driver.js'
import { recruitmentPlatform } from '../dist/lib/platforms/registry.js'
import { SourcingBrowser } from '../dist/lib/sourcing/browser.js'
import { assertSourcingNavigation } from '../dist/lib/sourcing-policy.js'
import { modelPageObservation } from '../dist/lib/model-observation.js'

const captured = JSON.parse(readFileSync(new URL('./fixtures/liepin-promotion-overlay.json', import.meta.url)))
const signal = () => new AbortController().signal
const closeRef = 'ref_466', iconRef = 'ref_467'
function fixture(options = {}) {
  const source = structuredClone(captured)
  const jobTab = { ref: 'job-tab', role: 'tab', name: 'Python工程师', states: ['enabled', 'selected'], bounds: { x: 100, y: 50, width: 160, height: 40 } }
  const end = { ref: 'end', role: 'text', name: '没有更多推荐人才', bounds: { x: 100, y: 300, width: 240, height: 40 } }
  source.page.items.push({ ...jobTab, states: [...jobTab.states, 'occluded'] })
  const cleared = { ...source.page, items: [jobTab, end], selectedTabs: [{ name: jobTab.name }], truncated: !!options.truncated }
  let page = source.page, revision = 0, clicked = false
  const clicks = [], reads = [], progress = []
  const broker = { currentPage: () => page,
    getInspection: (_page, ref) => source.inspections.find(row => row.ref === ref),
    inspectRefs: async (observed, refs) => { assert.equal(observed, page); reads.push(...refs) },
    tools: [{ name: 'browser_inspect_element' },
      { name: 'browser_snapshot', execute: async args => {
        assert.equal(args.format, 'dom'); assert.equal(args.viewportOnly, true)
        if (options.appearOnSnapshot && !clicked) page = source.page
        else if (clicked && !options.stillVisible) page = cleared
        page = { ...page, snapshotId: `s${++revision}` }
        return page
      } },
      { name: 'browser_click', execute: async args => {
        assert.equal(args.snapshotId, page.snapshotId); clicks.push(args.ref)
        assertSourcingNavigation({ name: 'browser_click', purpose: 'navigation', readOnly: false, args }, page,
          undefined, false, false, recruitmentPlatform('liepin').allowsNavigation(page, args.ref, broker))
        assert.equal(args.ref, closeRef, 'do not click the background job or a notification close')
        if (options.unknown) throw Error('TOOL_CALL_OUTCOME_UNKNOWN')
        clicked = true
        if (!options.stillVisible) page = cleared
        return { dispatched: true }
      } }],
  }
  if (options.appearOnSnapshot) page = cleared
  const browser = new SourcingBrowser(broker, signal())
  const context = { broker, signal: browser.signal, job: { jobId: 'host-job', jobName: jobTab.name, sourceMode: 'recommend', searchFilters: {} },
    progress: async message => progress.push(message) }
  return { source, broker, browser, context, clicks, reads, progress, page: () => page }
}

test('the observed ad-slot blank close and nested icon have close ownership; advertising and other crosses do not', () => {
  const f = fixture(), page = f.page()
  assert.deepEqual(page.dialogs, [], 'the actual promotion is not an accessible dialog')
  assert.equal(liepinPromotionClose(page, closeRef, f.broker), closeRef)
  assert.equal(liepinPromotionClose(page, iconRef, f.broker), closeRef)
  assert.equal(liepinPromotionClose(page, 'ref_33', f.broker), undefined)
  assert.equal(liepinPromotionClose(page, 'ref_21', f.broker), undefined)
  assert.equal(liepinPromotionClose({ ...page, url: 'https://example.com' }, closeRef, f.broker), undefined)
  const unknown = { ...f.broker, getInspection: () => ({ element: { attributes: { class: 'close' } }, ancestors: [] }) }
  assert.equal(liepinPromotionClose(page, closeRef, unknown), undefined)
  const call = { name: 'browser_click', args: { ref: closeRef }, readOnly: false, purpose: 'navigation' }
  assert.throws(() => assertSourcingNavigation(call, page), /NAVIGATION_UNVERIFIED/)
  assert.doesNotThrow(() => assertSourcingNavigation(call, page, undefined, false, false, true))
  assert.throws(() => assertSourcingNavigation({ ...call, purpose: 'business_write' }, page, undefined, false, false, true), /READ_ONLY/)
})

test('a known non-dialog promotion closes once and fresh observation precedes continuation', async () => {
  const f = fixture()
  assert.equal(await dismissLiepinPromotion(f.browser, f.context.progress), true)
  assert.deepEqual(f.clicks, [closeRef]); assert.match(f.page().snapshotId, /^s/)
  assert.ok(f.reads.includes(iconRef)); assert.ok(f.reads.includes(closeRef))
  assert.ok(f.progress.some(message => /推广弹窗已关闭/.test(message)))
  assert.equal(await dismissLiepinPromotion(f.browser), false)
  assert.deepEqual(f.clicks, [closeRef])
})

test('the real Liepin driver dismisses the promotion before confirming a job or reading the list', async () => {
  const f = fixture(), driver = new LiepinSourcingDriver(f.context)
  const proof = await driver.prepareSearch()
  assert.equal(proof.ref, 'job-tab'); assert.equal(proof.mode, 'position')
  assert.deepEqual(await driver.cards({ refresh: false }), [])
  assert.deepEqual(f.clicks, [closeRef])
  assert.match((await driver.advance()).exhaustion.quote, /没有更多/)
})

test('a promotion that appears in the next list snapshot is closed before processing candidate cards', async () => {
  const f = fixture({ appearOnSnapshot: true }), driver = new LiepinSourcingDriver(f.context)
  assert.deepEqual(await driver.cards(), [])
  assert.deepEqual(f.clicks, [closeRef])
})

test('a still-visible promotion or an incomplete confirmation never replays its close click', async () => {
  for (const options of [{ stillVisible: true }, { truncated: true }]) {
    const f = fixture(options)
    await assert.rejects(dismissLiepinPromotion(f.browser), /PROMOTION_CLOSE_UNCONFIRMED/)
    assert.deepEqual(f.clicks, [closeRef])
  }
  const f = fixture({ unknown: true })
  await assert.rejects(dismissLiepinPromotion(f.browser), /OUTCOME_UNKNOWN/)
  assert.deepEqual(f.clicks, [closeRef])
})

test('occluded notification closes and unrelated close icons cannot trigger automatic dismissal', async () => {
  const f = fixture()
  for (const item of f.page().items) if (item.ref === iconRef) item.states.push('occluded')
  assert.equal(await dismissLiepinPromotion(f.browser), false); assert.deepEqual(f.clicks, [])
  const other = fixture()
  other.source.inspections.forEach(row => row.ancestors = [])
  assert.equal(await dismissLiepinPromotion(other.browser), false); assert.deepEqual(other.clicks, [])
})

test('visible close-circle remains in the AI observation even when a long non-dialog tree is bounded', () => {
  const f = fixture()
  const noise = Array.from({ length: 500 }, (_, index) => ({ ref: `noise-${index}`, role: 'div', name: '普通页面内容'.repeat(40) }))
  const page = { ...f.page(), items: [...noise, ...f.page().items] }
  for (const compact of [true, false]) {
    const observation = modelPageObservation(page, { compact })
    assert.equal(observation.truncated, true)
    assert.match(observation.tree, /close-circle/)
    assert.ok(observation.tree.indexOf('close-circle') < observation.tree.indexOf('noise-0'))
  }
})
