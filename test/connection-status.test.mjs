import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserConnectionStatus } from '../dist/shared/connection-status.js'

test('browser status has only connected and disconnected labels', () => {
  const state = { jobs: [], activeJobId: null, connection: { ready: false, available: false, busy: false, activeWorkflow: false } }
  assert.equal(browserConnectionStatus(undefined, ''), '未连接')
  assert.equal(browserConnectionStatus(state, ''), '未连接')
  assert.equal(browserConnectionStatus({ ...state, connection: { ...state.connection, busy: true } }, ''), '未连接')
  assert.equal(browserConnectionStatus({ ...state, connection: { ...state.connection, connecting: true } }, ''), '未连接')
  assert.equal(browserConnectionStatus({ ...state, connection: { ...state.connection, ready: true, requiresBegin: true } }, ''), '已连接')
  assert.equal(browserConnectionStatus({ ...state, connection: { ...state.connection, ready: true } }, 'error'), '未连接')
  for (const ready of [false, true]) {
    for (const status of ['queued', 'running', 'stopping', 'failed']) {
      const occupied = { ...state, activeJobId: 'task', jobs: [{ id: 'task', status }],
        connection: { ...state.connection, ready, busy: true, activeWorkflow: true, executionOwner: 'remote' } }
      assert.equal(browserConnectionStatus(occupied, ''), ready ? '已连接' : '未连接')
    }
  }
})
