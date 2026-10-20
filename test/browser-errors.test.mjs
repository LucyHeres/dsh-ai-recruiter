import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BrowserClient, McpError, unwrapToolResult } from '../dist/lib/browser-client.js'
import { logError } from '../dist/lib/developer-log.js'
import { browserFailureCode, pageFailureDetail } from '../dist/lib/browser-errors.js'
import { recoverablePageError } from '../dist/lib/page-actions.js'

test('MCP errors retain exact gateway codes in diagnostics without remote bodies', () => {
  for (const code of ['PAGE_CHANGED', 'ELEMENT_OCCLUDED', 'ELEMENT_HIDDEN', 'ELEMENT_DISABLED', 'PAGE_DIALOG_BLOCKED', 'RESULT_UNKNOWN', 'PAGE_BRIDGE_UNAVAILABLE']) {
    let error
    try { unwrapToolResult({ isError: true, content: [{ type: 'text', text: `工具执行失败：${code} remote-private token=private` }] }) }
    catch (value) { error = value }
    assert.ok(error instanceof McpError); assert.equal(error.code, code)
    assert.equal(logError(error).errorCode, code)
    assert.ok(!JSON.stringify(logError(error)).includes('private'))
  }
  assert.equal(browserFailureCode('PAGE_CHANGED: changed'), 'PAGE_CHANGED')
  assert.equal(browserFailureCode('arbitrary user echo PAGE_CHANGED'), undefined)
})

test('specific pre-dispatch errors explain failed attempts and uncertain writes stay nonrecoverable', () => {
  for (const code of ['PAGE_CHANGED', 'ELEMENT_OCCLUDED', 'ELEMENT_HIDDEN', 'ELEMENT_DISABLED', 'PAGE_DIALOG_BLOCKED', 'ELEMENT_NOT_IN_VIEWPORT']) {
    const error = new McpError(code, `工具执行失败：${code}`)
    assert.equal(recoverablePageError(error), true)
    assert.ok(pageFailureDetail(error).includes(code))
  }
  assert.ok(!pageFailureDetail(new Error('PAGE_CHANGED')).includes('遮挡'))
  assert.equal(recoverablePageError(new McpError('RESULT_UNKNOWN', 'RESULT_UNKNOWN ELEMENT_OCCLUDED')), false)
  assert.throws(() => unwrapToolResult({ isError: true, content: [{ type: 'text', text: 'unknown failure' }] }), error => error.code === 'TOOL_ERROR')
})

test('finish/begin structured gateway errors retain their real code rather than TOOL_ERROR', () => {
  for (const body of [{ code: 'BROWSER_AGENT_BUSY', message: 'private text' }, 'RESULT_UNKNOWN']) {
    const expected = typeof body === 'string' ? body : body.code
    assert.throws(() => unwrapToolResult({ isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] }), error => error.code === expected)
  }
})

test('snapshot diagnostics distinguish known expiry reasons without exposing remote content', () => {
  for (const reason of ['RECORD_MISSING', 'TASK_SCOPE_MISMATCH', 'TAB_MISMATCH', 'TTL_EXCEEDED', 'AX_BASELINE_MISSING', 'AX_NODE_UNAVAILABLE']) {
    const logged = logError(new McpError('SNAPSHOT_EXPIRED', `工具执行失败：SNAPSHOT_EXPIRED: ${reason} token=private`))
    assert.equal(logged.errorCode, 'SNAPSHOT_EXPIRED'); assert.equal(logged.errorReason, reason)
    assert.ok(!JSON.stringify(logged).includes('private'))
  }
  assert.equal(logError(new Error('SNAPSHOT_EXPIRED: arbitrary-private')).errorReason, undefined)
})
test('result rejection reasons are distinguishable without logging page content', () => {
  for (const reason of ['SAME_SNAPSHOT', 'EVIDENCE_REF_MISSING', 'EVIDENCE_UNCHANGED']) {
    const logged = logError(new Error(`PAGE_OPERATION_RESULT_REQUIRED: ${reason} private candidate receipt`))
    assert.equal(logged.errorCode, 'PAGE_OPERATION_RESULT_REQUIRED'); assert.equal(logged.errorReason, reason)
    assert.ok(!JSON.stringify(logged).includes('private'))
  }
  assert.equal(logError(new Error('PAGE_OPERATION_RESULT_REQUIRED: arbitrary-private')).errorReason, undefined)
})

test('inspection diagnostics retain control structure without candidate names or raw DOM', async () => {
  let logged
  const client = new BrowserClient({ command: 'unused', args: [], logger: {
    trace: async (_event, _fields, execute, summarize) => {
      const value = await execute(); logged = summarize(value); return value
    },
  } })
  client.request = async () => ({ content: [{ type: 'text', text: JSON.stringify({ item: {
    role: 'generic', tagName: 'span', name: 'private candidate name', states: ['occluded', 'private-state'],
  }, element: { css: { pointerEvents: 'none' }, text: 'private DOM text' }, ancestors: [
    { tagName: 'div', attributes: { role: 'combobox', class: 'private class', id: 'private-id' }, text: 'private ancestor' },
  ] }) }] })
  await client.call('browser_inspect_element', { tabId: 7, snapshotId: 's1', ref: 'a' })
  assert.equal(logged.inspectedRole, 'generic'); assert.equal(logged.pointerEvents, 'none')
  assert.deepEqual(logged.inspectedStates, ['occluded'])
  assert.deepEqual(logged.ancestorControls, [{ tagName: 'div', role: 'combobox' }])
  assert.equal(typeof logged.inspectedLabelKey, 'string'); assert.ok(!JSON.stringify(logged).includes('private'))
})
