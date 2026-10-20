import assert from 'node:assert/strict'
import { test } from 'node:test'
import { releaseOwnedBrowser } from '../dist/lib/browser-release.js'

test('cancel cleanup waits for the same in-flight task, then finishes once without input replay', async () => {
  const calls = []; let clock = 0, polls = 0
  await releaseOwnedBrowser(async name => {
    calls.push(name)
    return { workflowTaskId: 'owned', executionOwner: 'local', busy: name === 'browser_status' && ++polls < 3 }
  }, { workflowTaskId: 'owned' }, { now: () => clock, sleep: async ms => { clock += ms } })
  assert.deepEqual(calls, ['browser_status', 'browser_status', 'browser_status', 'browser_finish'])
})

test('cleanup never finishes a new local task or remote owner', async () => {
  for (const state of [{ workflowTaskId: 'other', executionOwner: 'local' }, { workflowTaskId: 'owned', executionOwner: 'remote' }]) {
    const calls = []
    await assert.rejects(releaseOwnedBrowser(async name => { calls.push(name); return state }, { workflowTaskId: 'owned' }), /OWNERSHIP_CHANGED/)
    assert.deepEqual(calls, ['browser_status'])
  }
})

test('cleanup is bounded even with a noncooperative status transport', async () => {
  const calls = []
  await assert.rejects(releaseOwnedBrowser(async name => { calls.push(name); return new Promise(() => {}) }, { workflowTaskId: 'owned' }, { timeoutMs: 15 }), /RELEASE_PENDING/)
  assert.deepEqual(calls, ['browser_status'])
})

test('busy timeout does not force finish and legacy begin gets only its original single finish', async () => {
  const calls = []; let clock = 0
  await assert.rejects(releaseOwnedBrowser(async name => { calls.push(name); return { workflowTaskId: 'owned', busy: true } }, { workflowTaskId: 'owned' },
    { now: () => clock, sleep: async ms => { clock += ms }, timeoutMs: 200 }), /RELEASE_PENDING/)
  assert.ok(!calls.includes('browser_finish'))
  calls.length = 0
  await releaseOwnedBrowser(async name => { calls.push(name) }, undefined)
  assert.deepEqual(calls, ['browser_finish'])
})
