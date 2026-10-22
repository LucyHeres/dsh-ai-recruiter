import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentBrowserTools } from '../dist/lib/agent-browser-tools.js'
import { runBrowserAgent } from '../dist/lib/browser-agent.js'
import { modelPageObservation } from '../dist/lib/model-observation.js'

const origin = 'https://observed.test'
const signal = () => new AbortController().signal
const info = (name, properties, readOnly, required = []) => ({ name,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly }, _meta: { browserAgent: { available: true } } })
const observe = { type: 'object', properties: {
  wait: { enum: ['none', 'dom_quiet', 'snapshot_changed'] }, returnSnapshot: { enum: ['none', 'viewport', 'full'] },
  timeoutMs: { type: 'integer' }, requireChange: { type: 'boolean' },
} }
const infos = [info('browser_snapshot', { tabId: { type: 'integer' }, format: { enum: ['dom', 'semantic'] } }, true, ['tabId']),
  info('browser_click', { tabId: { type: 'integer' }, snapshotId: { type: 'string' }, ref: { type: 'string' }, observe }, false, ['tabId', 'snapshotId', 'ref'])]
const page = (revision, items = [{ ref: 'target', role: 'button', name: '打开筛选' }]) => ({ tabId: 7,
  snapshotId: 's' + revision, documentId: 'document', url: origin + '/list', format: 'semantic', items })
function fixture(options = {}) {
  let revision = 0
  const calls = []
  const broker = new AgentBrowserTools(infos, async (name, args) => {
    calls.push({ name, args: structuredClone(args) })
    if (name === 'browser_snapshot') {
      if (revision && options.failObservation) throw new Error('PAGE_UNAVAILABLE')
      return page(revision, options.items)
    }
    revision++
    assert.equal(args.observe.returnSnapshot, 'none', 'old extension must not capture an unused DOM snapshot')
    return { output: { dispatched: true, changed: true }, verification: { conditionMet: true } }
  }, { origins: [origin], confirmationId: 'task', signal: signal(), observationFormat: 'semantic' })
  const execute = (name, args) => broker.tools.find(tool => tool.name === name).execute(args, signal())
  return { broker, calls, execute }
}

test('semantic action observation captures once and returns a new actionable snapshot in the same tool result', async () => {
  const f = fixture()
  await f.execute('browser_snapshot', { tabId: 7 })
  const result = await f.execute('browser_click', { tabId: 7, snapshotId: 's0', ref: 'target' })
  assert.deepEqual(f.calls.map(call => call.name), ['browser_snapshot', 'browser_click', 'browser_snapshot'])
  assert.equal(f.calls[1].args.observe.wait, 'dom_quiet')
  assert.equal(f.calls[2].args.format, 'semantic')
  assert.equal(result.output.dispatched, true)
  assert.equal(result.snapshot.snapshotId, 's1')
  assert.equal(result.effects.snapshotId, 's1')
  assert.equal(result.effects.target.ref, 'target')
  assert.equal(f.broker.getPage(7).snapshotId, 's1')
})

test('an extension that supports observation format returns it directly and explicit format wins over the default', async () => {
  const nativeInfos = structuredClone(infos)
  nativeInfos[1].inputSchema.properties.observe.properties.format = { enum: ['dom', 'semantic'] }
  const calls = []
  let revision = 0
  const broker = new AgentBrowserTools(nativeInfos, async (name, args) => {
    calls.push({ name, args })
    if (name === 'browser_snapshot') return page(revision)
    return { output: { dispatched: true }, snapshot: { ...page(++revision), format: args.observe.format } }
  }, { origins: [origin], confirmationId: 'task', signal: signal(), observationFormat: 'semantic' })
  const execute = (name, args) => broker.tools.find(tool => tool.name === name).execute(args, signal())
  await execute('browser_snapshot', { tabId: 7 })
  await execute('browser_click', { tabId: 7, snapshotId: 's0', ref: 'target' })
  assert.equal(calls[1].args.observe.format, 'semantic')
  const result = await execute('browser_click', { tabId: 7, snapshotId: 's1', ref: 'target', observe: { format: 'dom' } })
  assert.equal(calls[2].args.observe.format, 'dom')
  assert.equal(result.snapshot.format, 'dom')
  assert.equal(calls.filter(call => call.name === 'browser_snapshot').length, 1)
})

test('grouped inputs can explicitly retain refs and only the final input returns a fresh observation', async () => {
  const f = fixture()
  await f.execute('browser_snapshot', { tabId: 7 })
  await f.execute('browser_click', { tabId: 7, snapshotId: 's0', ref: 'target', observe: { returnSnapshot: 'none' } })
  assert.equal(f.calls.length, 2)
  assert.equal(f.broker.getPage(7).snapshotId, 's0')
  const result = await f.execute('browser_click', { tabId: 7, snapshotId: 's0', ref: 'target' })
  assert.equal(result.snapshot.snapshotId, 's2')
  assert.equal(f.calls.filter(call => call.name === 'browser_snapshot').length, 2)
})

test('failed post-action observation preserves the dispatched receipt and does not replay the click', async () => {
  const f = fixture({ failObservation: true })
  await f.execute('browser_snapshot', { tabId: 7 })
  const result = await f.execute('browser_click', { tabId: 7, snapshotId: 's0', ref: 'target' })
  assert.equal(result.output.dispatched, true)
  assert.equal(result.observationError, 'PAGE_UNAVAILABLE')
  assert.equal(f.calls.filter(call => call.name === 'browser_click').length, 1)
})

test('compact model views keep full evidence in the host and continuation restores omitted metadata without a browser call', async () => {
  const items = Array.from({ length: 180 }, (_, i) => ({ ref: 'r' + i, role: 'article', name: '候选经历' + i,
    elementId: 'source-' + i, bounds: { x: 1, y: i * 200, width: 900, height: 180 },
    description: '已观察的详细描述'.repeat(35), context: { text: '真实经历' + i + '：' + 'Java 订单系统开发与维护。'.repeat(70) } }))
  const f = fixture({ items })
  const result = await f.execute('browser_snapshot', { tabId: 7 })
  assert.ok(JSON.stringify(result).length < 27000)
  assert.equal(f.broker.getPage(7).items.length, items.length)
  assert.equal(f.broker.getPage(7).items[179].context.text, items[179].context.text)
  const count = f.calls.length
  const restored = await f.execute('browser_read_observation', { tabId: 7, snapshotId: 's0', query: '候选经历179' })
  assert.match(restored.tree, /id="source-179"/)
  assert.match(JSON.stringify(restored.contexts), /真实经历179/)
  assert.equal(f.calls.length, count)
  const short = modelPageObservation(page(0, Array.from({ length: 400 }, (_, i) => ({ ref: 'ref' + i, role: 'button', name: '操作 ref' + i }))), { compact: true })
  assert.equal(short.coverage.nextOffset, null, 'short rows must not be arbitrarily limited to the first 120 refs')
  assert.match(short.tree, /ref=ref399/)
})

test('startup observations remain complete and are compacted when superseded, without fabricated assistant messages', async () => {
  const requests = []
  let complete = false
  const f = fixture({ items: Array.from({ length: 300 }, (_, i) => ({ ref: 'r' + i, role: 'button', name: '初始可观察内容' + i })) })
  const initial = await f.execute('browser_snapshot', { tabId: 7 })
  assert.ok(JSON.stringify(initial).length > 6000)
  const llm = { async *stream(request) {
    requests.push(request)
    const name = requests.length === 1 ? 'browser_snapshot' : 'complete'
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-' + requests.length, name,
      arguments: JSON.stringify(name === 'browser_snapshot' ? { tabId: 7 } : {}) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  } }
  // Make the next snapshot a distinct version while retaining the original full
  // source in its task-local broker until the new observation replaces it.
  const snapshotTool = f.broker.tools.find(tool => tool.name === 'browser_snapshot')
  const original = snapshotTool.execute
  snapshotTool.execute = async (...args) => { const value = await original(...args); return { ...value, snapshotId: 's-new' } }
  const result = await runBrowserAgent(llm, { provider: 'test', model: 'test' }, {
    system: 'test', goal: {}, signal: signal(), tools: [...f.broker.tools,
      { name: 'complete', description: 'complete', readOnly: false, inputSchema: { type: 'object' }, execute: async () => { complete = true; return {} } }],
    initialToolResults: [{ name: 'browser_snapshot', args: { tabId: 7 }, value: initial }], isComplete: () => complete,
  })
  assert.equal(result.status, 'completed')
  assert.match(JSON.stringify(requests[0].messages), /初始可观察内容299/)
  assert.match(JSON.stringify(requests[0].messages), /coverage/)
  const seed = requests[1].messages.find(message => message.role === 'user' && JSON.stringify(message).includes('宿主已执行'))
  assert.match(JSON.stringify(seed), /historical-snapshot-summary/)
  assert.doesNotMatch(JSON.stringify(seed), /初始可观察内容299/)
  assert.equal(requests[0].messages.some(message => message.role === 'assistant'), false)
})
