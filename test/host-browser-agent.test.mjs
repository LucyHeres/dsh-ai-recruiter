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

test('unregistered default provider stops before metadata lookup or inference with recovery guidance', () => {
  const f = fixture()
  f.selected.provider = 'xinling-workbuddy'
  f.llm.listProviders = () => [{ id: 'deepseek-official' }]
  assert.throws(f.create, error => /HOST_MODEL_PROVIDER_UNAVAILABLE/.test(error.message)
    && /xinling-workbuddy/.test(error.message) && /薪灵默认模型/.test(error.message) && /模型设置/.test(error.message))
  assert.equal(f.requests.length, 0)
  assert.equal(f.lookups.length, 0)
  assert.equal(f.selected.provider, 'xinling-workbuddy')
})

test('unregistered dedicated provider requires fixing its configuration without falling back', () => {
  const f = fixture({ browserAgentProvider: 'removed-provider', browserAgentModel: 'old-model' })
  f.llm.listProviders = () => [{ id: 'existing-host' }]
  assert.throws(f.create, error => /HOST_MODEL_PROVIDER_UNAVAILABLE/.test(error.message)
    && /browserAgentProvider\/browserAgentModel/.test(error.message))
  assert.equal(f.requests.length, 0)
  assert.equal(f.lookups.length, 0)
})

test('registered dedicated route remains usable when the host default provider was removed', async () => {
  const f = fixture({ browserAgentProvider: 'deepseek-official', browserAgentModel: 'deepseek-flash' })
  f.selected.provider = 'xinling-workbuddy'
  f.llm.listProviders = () => [{ id: 'deepseek-official' }]
  await f.run()
  assert.equal(f.requests[0].provider, 'deepseek-official')
  assert.equal(f.selected.provider, 'xinling-workbuddy')
})

test('cancellation interrupts a noncooperative model-metadata lookup before inference', async () => {
  const f = fixture(), abort = new AbortController()
  f.llm.resolveModelInfo = async () => { abort.abort(); return new Promise(() => {}) }
  await assert.rejects(f.run({ signal: abort.signal }))
  assert.equal(f.requests.length, 0)
})

test('one task reuses successful model metadata across navigation and isolated assessment calls', async () => {
  const f = fixture(), run = f.create()
  const opts = () => ({ system: 'test', goal: {}, tools: [], signal: new AbortController().signal, maxTurns: 1 })
  await run({ ...opts(), modelPurpose: 'navigation' })
  await run({ ...opts(), modelPurpose: 'assessment' })
  await run(opts())
  assert.equal(f.requests.length, 3)
  assert.equal(f.lookups.length, 1)
  assert.ok(f.requests.every(request => request.reasoningEffort === 'low'))
  assert.equal(f.selected.reasoningEffort, 'high')
})
