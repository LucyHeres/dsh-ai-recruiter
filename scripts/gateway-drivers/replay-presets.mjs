import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { GreetingAgent } from '../../dist/lib/greeting-agent.js'
import { Store } from '../../dist/lib/store.js'

const page = JSON.parse(await readFile(process.argv[2], 'utf8'))
const original = JSON.parse(await readFile(process.argv[3], 'utf8'))
assert.equal(original.kind, 'greeting')
const directory = await mkdtemp(join(tmpdir(), 'preset-local-replay-'))
const properties = { tabId: { type: 'integer' }, snapshotId: { type: 'string' }, ref: { type: 'string' }, frameId: { type: 'integer' } }
const info = (name, fields, readOnly) => ({ name,
  inputSchema: { type: 'object', properties: fields, additionalProperties: false }, annotations: { readOnlyHint: readOnly },
  _meta: { browserAgent: { available: true, capability: name.replace('_', '.') } } })
const infos = [info('browser_list_tabs', {}, true), info('browser_snapshot', { tabId: properties.tabId }, true),
  info('browser_click', properties, false)]
const targets = page.items.filter(item => item.role === 'button' && item.name === '继续沟通').slice(0, original.limit)
assert.equal(targets.length, original.limit, 'capture must include enough completed controls to replay their pre-send state')
const sent = new Set(), paused = [], identityMatches = [], failures = []
let snapshotIndex = 0, modelInitializations = 0, simulatedTime = 0
const snapshot = () => ({ ...structuredClone(page), snapshotId: `replay-${++snapshotIndex}`,
  items: page.items.map(item => ({ ...structuredClone(item),
    ...(targets.some(target => target.ref === item.ref) ? { name: sent.has(item.ref) ? '继续沟通' : '打招呼' } : {}) })) })
try {
  const store = new Store(directory, 'test'); await store.init()
  const job = { ...original, id: randomUUID(), status: 'queued', results: [], events: [] }
  await store.put(`greeting-${job.id}`, job)
  const executor = new GreetingAgent(store, async (name, args) => {
    if (name === 'browser_list_tabs') return { tabs: [{ tabId: page.tabId, url: page.url }] }
    if (name === 'browser_snapshot') return snapshot()
    if (name === 'browser_finish') return {}
    assert.equal(name, 'browser_click')
    assert.equal(args.policy.riskLevel, 'business_write')
    assert.ok(targets.some(target => target.ref === args.ref))
    assert.ok(!sent.has(args.ref))
    const persisted = await store.get(`greeting-${job.id}`)
    assert.equal(persisted.results.at(-1).stage, 'sending'); assert.ok(persisted.results.at(-1).attemptedAt)
    identityMatches.push(original.results.some(row => row.name === persisted.results.at(-1).name))
    sent.add(args.ref)
    return { dispatched: true, snapshot: snapshot() }
  }, async () => {}, async () => infos, () => {
    modelInitializations++
    return async input => {
      failures.push(...input.initialToolResults.filter(seed => seed.isError).map(seed => ({ tool: seed.name, message: seed.value?.error?.message })))
      return { status: 'stopped', message: 'Local replay cannot invoke a model', turns: 0, modelMs: 0, toolMs: 0 }
    }
  }, { write: (_level, event, fields) => { if (event === 'recruitment.preset_paused') paused.push(fields) }, updateContext() {} }, {},
  { now: () => simulatedTime, sleep: async milliseconds => { simulatedTime += milliseconds } })
  await executor.run(job, new AbortController().signal)
  console.log(JSON.stringify({ sourceTaskId: original.id, sourcePage: new URL(page.url).origin + new URL(page.url).pathname,
    sourceFormat: page.format, sourceElements: page.items.length, status: job.status, resetLabels: targets.length,
    mockedBusinessClicks: sent.size, confirmed: job.results.filter(row => row.stage === 'succeeded').length,
    modelInitializations, identityMatches, simulatedPacingMs: simulatedTime, paused, failures,
    actualBrowserInputs: 0, actualBusinessWrites: 0,
    note: 'Captured real DOM replayed through production greeting hooks and snapshot validation. Only a local copy has completed labels reset; transport and server writes are mocked.' }, null, 2))
} finally { await rm(directory, { recursive: true, force: true }) }
