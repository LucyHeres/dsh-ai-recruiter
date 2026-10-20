import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserConnectionStatus } from '../dist/shared/connection-status.js'

test('browser labels distinguish connecting reservations from executing tasks', () => {
  const state = { jobs: [], activeJobId: null, connection: { ready: false, available: false, busy: false, activeWorkflow: false } }
  assert.equal(browserConnectionStatus(undefined, '连接中', ''), '连接中')
  assert.equal(browserConnectionStatus(state, '连接中', ''), '连接中')
  assert.equal(browserConnectionStatus({ ...state, connection: { ...state.connection, busy: true } }, '', ''), '连接中')
  assert.equal(browserConnectionStatus({ ...state, activeJobId: 'task', jobs: [{ id: 'task', status: 'queued' }] }, '', ''), '连接中')
  assert.equal(browserConnectionStatus({ ...state, activeJobId: 'task', jobs: [{ id: 'task', status: 'running' }] }, '', ''), '工作中')
  assert.equal(browserConnectionStatus({ ...state, connection: { ...state.connection, activeWorkflow: true } }, '', ''), '工作中')
  assert.equal(browserConnectionStatus({ ...state, connection: { ...state.connection, ready: true, requiresBegin: true } }, '', ''), '已连接')
  assert.equal(browserConnectionStatus(state, '', ''), '未连接')
  assert.equal(browserConnectionStatus(state, '', 'error'), '读取失败')
})
