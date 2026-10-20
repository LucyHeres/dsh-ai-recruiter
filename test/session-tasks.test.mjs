import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Workbench } from '../dist/lib/workbench.js'
import { recordCall } from '../dist/lib/call-journal.js'
import { randomUUID } from 'node:crypto'

test('chat task identities are stable for a retried call and isolated across sessions', async () => {
  const workbench = Object.create(Workbench.prototype)
  workbench.startTask = async (request, sessionId) => ({ ...request, sessionId })
  const request = { kind: 'greeting', platform: 'liepin', limit: 2, confirmed: true }
  const first = await workbench.startSession(request, 'session-one', 'call-one')
  const repeated = await workbench.startSession(request, 'session-one', 'call-one')
  const other = await workbench.startSession(request, 'session-two', 'call-one')
  assert.equal(first.id, repeated.id)
  assert.notEqual(first.id, other.id)
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(first.sessionId, 'session-one')
  const otherKind = await workbench.startSession({ ...request, kind: 'resume_import' }, 'session-one', 'call-one')
  assert.notEqual(first.id, otherKind.id)
  await assert.rejects(workbench.startSession({ platform: 'liepin' }, 'session-one', 'missing-kind'))
})

test('session drawer defaults to the most recently referenced job, including a later query without a task', async () => {
  const workbench = Object.create(Workbench.prototype)
  workbench.initialize = async () => {}; workbench.active = null
  workbench.listJobs = async () => [{ id: 'older', jobId: 'older-job', kind: 'greeting', source: 'chat', sessionId: 'last-position', createdAt: '2020-01-01T00:00:00Z' }]
  recordCall('last-position', 'ai_recruit_context', { tool: 'recruitment_getJobDetail', args: { jobId: 'recent-query-job' } }, { ok: true, durationMs: 1 })
  assert.equal((await workbench.sessionTasks({ sessionId: 'last-position' })).latestPositionId, 'recent-query-job')
  assert.equal((await workbench.sessionTasks({ sessionId: 'different-session' })).latestPositionId, undefined)
})

test('drawer starts retain the originating session and client id for lost-response reconciliation', async () => {
  const workbench = Object.create(Workbench.prototype)
  const calls = []; workbench.startTask = async (task, sessionId) => { calls.push({ task, sessionId }); return task }
  const task = { id: randomUUID(), kind: 'talent_sourcing', jobId: 'java', platforms: ['liepin'], limit: 5, confirmed: true }
  await workbench.startSessionTask({ sessionId: 'origin', task })
  await workbench.startSessionTask({ sessionId: 'origin', task })
  assert.equal(calls[0].sessionId, 'origin'); assert.equal(calls[0].task.id, calls[1].task.id)
  await assert.rejects(workbench.startSessionTask({ sessionId: 'origin', task: { ...task, kind: 'greeting' } }))
})

test('session progress and stop do not expose or affect other sessions or workbench tasks', async () => {
  const workbench = Object.create(Workbench.prototype)
  workbench.initialize = async () => {}
  workbench.active = { id: 'another-task' }
  workbench.listJobs = async () => [
    { id: 'own-task', source: 'chat', sessionId: 'session-one', createdAt: '2026-10-16T10:00:00Z' },
    { id: 'another-task', source: 'chat', sessionId: 'session-two', createdAt: '2026-10-16T11:00:00Z' },
    { id: 'workbench-task', source: 'workbench', createdAt: '2026-10-16T12:00:00Z' },
  ]
  const stopped = []
  workbench.stop = async request => { stopped.push(request.id); return { stopping: true } }
  const state = await workbench.sessionTasks({ sessionId: 'session-one' })
  assert.deepEqual(state.jobs.map(job => job.id), ['own-task'])
  assert.equal(state.activeJobId, null)
  await assert.rejects(workbench.stopSession('session-one', 'another-task'), /当前会话不存在/)
  assert.deepEqual(stopped, [])
  await workbench.stopSession('session-one', 'own-task')
  assert.deepEqual(stopped, ['own-task'])
})
