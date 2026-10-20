import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readObjectInput } from '../dist/lib/object-input.js'
import { readBusinessContext } from '../dist/lib/business-context.js'

const query = { hireStatus: 0, limit: 50, offset: 0 }
const signal = new AbortController().signal
const contextArgs = value => readObjectInput(value, 'args', 'CONTEXT_ARGUMENT_INVALID')

test('context accepts object arguments and the once-encoded job-list query from the reported failure', async () => {
  const calls = []
  const xin = { call: async (operation, args) => {
    calls.push({ operation, args })
    return { ok: true, data: { positionNames: [
      { jobId: 'job-1', jobName: '数据工程师', hireStatus: 0 },
      { jobId: 'job-2', jobName: '测试工程师', hireStatus: 1 },
    ] } }
  } }
  assert.equal(contextArgs(query), query)
  const results = []
  for (const input of [query, JSON.stringify(query)]) {
    results.push(await readBusinessContext(xin, 'recruitment_getMyJobList', contextArgs(input), signal))
  }
  assert.deepEqual(results[0], results[1])
  assert.deepEqual(results[0].items, [{ jobId: 'job-1', jobName: '数据工程师', hireStatus: 0 }])
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ({ operation: 'extensionInit', args: {} })))
})

test('context rejects invalid shapes and repeated encoding without echoing input', () => {
  for (const input of [undefined, null, [], 0, true, '{private', 'null', '[]', '42', 'true', '"private"', JSON.stringify(JSON.stringify(query))]) {
    assert.throws(() => contextArgs(input), error =>
      error.message.startsWith('CONTEXT_ARGUMENT_INVALID:') && !error.message.includes('private'))
  }
  assert.throws(() => readObjectInput(null, 'args'), /^Error: BROWSER_ARGUMENT_INVALID:/)
})

test('decoding context arguments does not bypass job-list schema validation or dispatch invalid requests', async () => {
  let calls = 0
  const xin = { call: async () => { calls++; throw new Error('unexpected dispatch') } }
  for (const input of [{ limit: 101 }, { hireStatus: 2 }, { offset: -1 }, { unknown: true }]) {
    await assert.rejects(readBusinessContext(xin, 'recruitment_getMyJobList', contextArgs(JSON.stringify(input)), signal), /查询参数不符合插件契约/)
  }
  assert.equal(calls, 0)
})
