import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostBrowserAgent } from '../dist/lib/host-browser-agent.js'

function fixture(config = {}, efforts = ['low', 'high']) {
  const selected = { provider: 'existing-host', model: 'existing-model', reasoningEffort: 'high' }
  const requests = [], lookups = []
  const llm = {
    async resolveModelInfo(provider, model, signal) { lookups.push({ provider, model, signal }); return { provider, id: model, reasoning: { efforts: efforts.map(id => ({ id, name: id })) } } },
    async *stream(request) { requests.push(request); yield { type: 'finish', reason: { kind: 'stop' } } },
  }
  const ctx = { get: name => name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => selected } : undefined }
  const create = () => hostBrowserAgent(ctx, undefined, config)()
  const run = (options = {}) => create()({ system: 'test', goal: {}, tools: [], signal: new AbortController().signal, maxTurns: 1, ...options })
  return { selected, requests, lookups, llm, create, run }
}

test('browser auto-low uses only advertised low and does not mutate global route', async () => {
  const f = fixture(); await f.run()
  assert.equal(f.requests[0].reasoningEffort, 'low'); assert.equal(f.selected.reasoningEffort, 'high')
  assert.equal(f.requests[0].provider, 'existing-host'); assert.equal(f.lookups.length, 1)
})

test('unsupported auto-low or missing model metadata preserves the selected effort', async () => {
  for (const absent of [false, true]) {
    const f = fixture({}, ['high'])
    if (absent) delete f.llm.resolveModelInfo
    await f.run(); assert.equal(f.requests[0].reasoningEffort, 'high')
  }
})

test('inherit skips lookup and keeps the exact host route', async () => {
  const f = fixture({ browserAgentReasoningEffort: 'inherit' }); await f.run()
  assert.equal(f.lookups.length, 0); assert.equal(f.requests[0].reasoningEffort, 'high')
})

test('dedicated browser route uses existing host transport without leaking another model effort', async () => {
  const f = fixture({ browserAgentProvider: 'another-registered-provider', browserAgentModel: 'chosen-fast-model', browserAgentReasoningEffort: 'inherit' })
  await f.run()
  assert.equal(f.requests[0].provider, 'another-registered-provider'); assert.equal(f.requests[0].model, 'chosen-fast-model')
  assert.equal(f.requests[0].reasoningEffort, undefined); assert.equal(f.selected.model, 'existing-model')
})

test('half-configured route and unsupported explicit effort fail before inference', async () => {
  const f = fixture({ browserAgentModel: 'orphan' })
  assert.throws(f.create, /MODEL_CONFIG_INVALID/); assert.equal(f.requests.length, 0)
  const g = fixture({ browserAgentReasoningEffort: 'invented' })
  await assert.rejects(g.run(), /REASONING_UNSUPPORTED/); assert.equal(g.requests.length, 0)
})

test('cancellation interrupts a noncooperative model-metadata lookup before inference', async () => {
  const f = fixture(), abort = new AbortController()
  f.llm.resolveModelInfo = async () => { abort.abort(); return new Promise(() => {}) }
  await assert.rejects(f.run({ signal: abort.signal }))
  assert.equal(f.requests.length, 0)
})
