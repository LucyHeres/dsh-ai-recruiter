import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PageOperation } from '../dist/lib/page-operation.js'
import { modelPageObservation } from '../dist/lib/model-observation.js'
const before = { snapshotId: 'before', items: [{ ref: 'button', name: '可执行操作' }] }
test('all displayed observation sources may be cited independently of actionable DOM refs', () => {
  for (const page of [
    { snapshotId: 'after', items: [], dialogs: [{ text: '操作成功', closeRef: 'close' }] },
    { snapshotId: 'after', items: [], text: '操作成功' },
    { snapshotId: 'after', items: [{ ref: 'status', name: '操作成功', states: ['disabled', 'occluded'] }] },
  ]) {
    const shown = modelPageObservation(page)
    const evidence = shown.dialogs?.[0].evidenceRef ?? shown.textEvidenceRef ?? 'status'
    assert.doesNotThrow(() => new PageOperation('before', before).assertResult(page, 'completed', [evidence]))
  }
})
test('dialog metadata refs remain readable when absent from the actionable node list', () => {
  assert.doesNotThrow(() => new PageOperation('before', before).assertResult({ snapshotId: 'after', items: [],
    dialogs: [{ ref: 'noninteractive-status', text: '操作成功' }] }, 'completed', ['noninteractive-status']))
})
test('wrong refs produce actionable source feedback; hidden data and unchanged source cannot fake a result', () => {
  const operation = new PageOperation('before', before)
  assert.throws(() => operation.assertResult({ snapshotId: 'after', items: [], dialogs: [{ text: '操作成功' }] }, 'completed', ['old-ref']), /evidence:dialog:0/)
  assert.throws(() => operation.assertResult({ snapshotId: 'after', items: [{ ref: 'status', name: '成功', states: ['hidden'] }] }, 'completed', ['status']), /PAGE_OPERATION_RESULT_REQUIRED/)
  const original = { snapshotId: 'before', items: [], dialogs: [{ text: '操作成功' }] }
  assert.throws(() => new PageOperation('before', original).assertResult({ ...original, snapshotId: 'after' }, 'completed', ['evidence:dialog:0']), /所引证据未变化/)
})
