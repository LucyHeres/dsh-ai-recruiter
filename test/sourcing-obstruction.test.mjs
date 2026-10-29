import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectedSourcingClose } from '../dist/lib/sourcing-policy.js'
import { runSourcingWorkflow } from '../dist/lib/sourcing/fast-runner.js'

test('inspected close icons require close semantics and foreground ownership', () => {
  const page = { items: [{ ref: 'close', name: '', dialogRef: 'popup' }], dialogs: [{ ref: 'popup', closeRef: 'close' }] }
  const detail = { element: { ref: 'close', attributes: { class: 'modal-close' } }, ancestors: [] }
  assert.equal(inspectedSourcingClose(page, 'close', detail), true)
  assert.equal(inspectedSourcingClose(page, 'close', undefined), false)
  assert.equal(inspectedSourcingClose(page, 'close', { element: { ref: 'close', attributes: { class: 'confirm' } } }), false)
  assert.equal(inspectedSourcingClose({ ...page, items: [{ ref: 'close', name: '购买' }] }, 'close', detail), false)
  const plain = { items: [{ ref: 'close', name: '' }], dialogs: [] }
  assert.equal(inspectedSourcingClose(plain, 'close', detail), false)
  assert.equal(inspectedSourcingClose(plain, 'close', { ...detail, ancestors: [{ attributes: { class: 'dialog-wrapper' } }] }), true)
  assert.equal(inspectedSourcingClose(plain, 'close', { element: { attributes: { 'aria-label': '关闭弹窗' } } }), true)
  for (const state of ['hidden', 'disabled', 'blocked_by_dialog']) {
    assert.equal(inspectedSourcingClose({ ...page, items: [{ ...page.items[0], states: [state] }] }, 'close', detail), false)
  }
})

test('iframe obstruction recovery observes the outer page and waits for dismissal and return to the original frame', async () => {
  const signal = new AbortController().signal
  let frameId = 7, revision = 0, overlay = true, complete = false, reads = 0
  const snapshots = []
  const page = () => ({ tabId: 1, frameId, snapshotId: `s${revision}`, documentId: `doc-${frameId}`,
    url: 'https://www.zhipin.com/web/chat/recommend', format: 'dom',
    items: frameId === 0 && overlay ? [{ ref: 'close', name: '关闭' }] : [], dialogs: [] })
  const snapshot = { name: 'browser_snapshot', inputSchema: { properties: { frameId: {}, format: {} } }, execute: async args => {
    frameId = args.frameId ?? frameId; revision++; snapshots.push(frameId); return page()
  } }
  const broker = { currentPage: page, inputRevision: 0, tools: [snapshot] }
  const driver = { recognizes: async () => true, prepareSearch: async () => ({}), cards: async () => {
    reads++;assert.equal(frameId, 7, 'do not run the list driver on the outer popup page')
    if (overlay) throw Error('ELEMENT_OCCLUDED')
    return []
  }, advance: async () => ({ exhaustion: { tabId: 1, snapshotId: page().snapshotId, ref: 'end', quote: '没有更多' } }) }
  const operations = { state: () => ({ searchReady: true, needsGreeting: false }), captured: () => undefined,
    complete: () => complete, remaining: () => 1, recoveryTools: () => [],
    tools: [{ name: 'sourcing_confirm_search', execute: async () => ({}) }, { name: 'sourcing_finish', execute: async () => { complete = true } }] }
  const agent = async options => {
    const recovery = options.initialToolResults.at(-1).value.recovery
    assert.equal(recovery.obstruction.returnFrameId, 7)
    assert.equal(recovery.obstruction.activeFrameId, 0)
    assert.deepEqual(snapshots, [7, 0])
    const before = reads
    await options.beforeTurn(signal);assert.equal(reads, before, 'observing the obstruction does not restart the failed route')
    overlay = false;broker.inputRevision++
    await options.beforeTurn(signal);assert.equal(reads, before, 'closing the popup still requires returning to the list frame')
    await snapshot.execute({ frameId: recovery.obstruction.returnFrameId })
    await options.beforeTurn(signal)
    assert.equal(complete, true)
    return { status: 'completed', message: 'recovered', turns: 2, modelMs: 0, toolMs: 0 }
  }
  const result = await runSourcingWorkflow({ createSourcingDriver: () => driver },
    { broker, job: { requirements: { listCriteria: [], criteria: [] } }, signal }, operations, agent,
    { system: '', goal: {}, tools: [], signal })
  assert.equal(result.status, 'completed')
})
