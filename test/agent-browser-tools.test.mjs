import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

// Transpile just this dependency graph into memory. No dist build or browser is
// required, and createRequire retains the project's normal package resolution.
const modules = new Map()
async function moduleUrl(url) {
  const key = String(url)
  if (modules.has(key)) return modules.get(key)
  const pending = (async () => {
    const source = await readFile(url, 'utf8')
    let output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    for (const match of [...output.matchAll(/from (['"])([^'"]+)\1/g)]) {
      const specifier = match[2]
      const resolved = specifier.startsWith('.')
        ? await moduleUrl(new URL(specifier.replace(/\.js$/, '.ts'), url))
        : import.meta.resolve(specifier)
      output = output.replaceAll(match[0], `from ${JSON.stringify(resolved)}`)
    }
    output = output.replaceAll('createRequire(import.meta.url)', `createRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)})`)
    return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
  })()
  modules.set(key, pending)
  return pending
}
const { AgentBrowserTools } = await import(await moduleUrl(new URL('../src/lib/agent-browser-tools.ts', import.meta.url)))
const { runBrowserAgent } = await import(await moduleUrl(new URL('../src/lib/browser-agent.ts', import.meta.url)))
const origin = 'https://allowed.test'
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const info = (name, inputSchema, readOnly = false, available = true) => ({ name, description: `Native ${name}`, inputSchema,
  annotations: { readOnlyHint: readOnly }, _meta: { browserAgent: { available } } })
const snapshotInfo = info('browser_snapshot', schema({ tabId: { type: 'integer' }, frameId: { type: 'integer' }, format: { type: 'string' }, offset: { type: 'integer' }, maxItems: { type: 'integer' },
  policy: { type: 'object' }, documentId: { type: 'string' } }, ['tabId', 'policy', 'documentId']), true)
const clickInfo = info('browser_click', schema({ tabId: { type: 'integer' }, snapshotId: { type: 'string' }, ref: { type: 'string' },
  documentId: { type: 'string' }, policy: { type: 'object' } }), false)
const inspectInfo = info('browser_inspect_element', schema({ tabId: { type: 'integer' }, snapshotId: { type: 'string' }, ref: { type: 'string' },
  documentId: { type: 'string' }, policy: { type: 'object' } }), true)
const page = (id = 's1', tabId = 7, url = `${origin}/list`, refs = ['a', 'b']) => ({ tabId, url, documentId: `document-${id}`, snapshotId: id,
  format: 'semantic', items: refs.map(ref => ({ ref, role: 'button', name: `操作 ${ref}`, states: [] })) })
const tool = (broker, name) => { const found = broker.tools.find(value => value.name === name); assert.ok(found, name); return found }
function fixture(extra = [], handler, overrides = {}) {
  const calls = [], controller = new AbortController()
  const broker = new AgentBrowserTools([snapshotInfo, clickInfo, inspectInfo, ...extra], async (name, args, signal) => {
    calls.push({ name, args: structuredClone(args), signal })
    return handler ? handler(name, args, signal) : name === 'browser_snapshot' ? page() : { dispatched: true }
  }, { origins: [origin], signal: controller.signal, confirmationId: 'confirmed-task', ...overrides })
  return { broker, calls, controller, execute: (name, args) => tool(broker, name).execute(args, controller.signal) }
}

test('new MCP schemas are preserved without a core action enum, and host-owned fields cannot be model-controlled', async () => {
  const inputSchema = schema({ tabId: { type: 'integer' }, nextShape: { type: 'object', properties: { values: { type: 'array', items: { type: 'integer' }, minItems: 2 } }, required: ['values'], additionalProperties: false },
    policy: { type: 'object' }, documentId: { type: 'string' } })
  const original = structuredClone(inputSchema)
  const f = fixture([info('browser_future_control', inputSchema)])
  const native = tool(f.broker, 'browser_future_control')
  assert.deepEqual(native.inputSchema.properties.nextShape, inputSchema.properties.nextShape)
  assert.equal(native.inputSchema.properties.policy, undefined); assert.equal(native.inputSchema.properties.documentId, undefined)
  assert.ok(!native.inputSchema.required.includes('policy') && !native.inputSchema.required.includes('documentId'))
  assert.deepEqual(inputSchema, original, 'the MCP discovery schema is not mutated')
  await f.execute('browser_future_control', { tabId: 7, nextShape: { values: [3, 5] }, purpose: 'business_write' })
  const actual = f.calls[0]
  assert.deepEqual(actual.args.nextShape, { values: [3, 5] }); assert.equal(actual.args.purpose, undefined)
  assert.deepEqual(actual.args.policy.allowedOrigins, [origin])
  assert.equal(actual.args.policy.riskLevel, 'business_write')
  assert.equal(actual.args.policy.confirmationId, 'confirmed-task')
  await assert.rejects(f.execute('browser_future_control', { tabId: 7, nextShape: { values: ['wrong'] } }), /BROWSER_ARGUMENT_INVALID/)
  await assert.rejects(f.execute('browser_future_control', { tabId: 7, nextShape: { values: [1, 2] }, policy: { allowedOrigins: ['https://foreign.test'] } }), /BROWSER_ARGUMENT_INVALID/)
  assert.equal(f.calls.length, 1)
})

test('discovery metadata and adapter allow filters scope the actual tool set; snapshot cache updates are ordered', () => {
  const f = fixture([info('browser_disabled', schema({}), true, false), info('browser_denied', schema({}), true),
    { name: 'browser_legacy', inputSchema: schema({}), annotations: { readOnlyHint: true } }], undefined, { allow: entry => entry.name !== 'browser_denied' })
  assert.ok(!f.broker.tools.some(value => ['browser_disabled', 'browser_denied', 'browser_legacy'].includes(value.name)))
  assert.equal(tool(f.broker, 'browser_snapshot').readOnly, false)
  assert.equal(tool(f.broker, 'browser_inspect_element').readOnly, false)
  assert.equal(tool(f.broker, 'browser_read_observation').readOnly, true)
  assert.throws(() => new AgentBrowserTools([], async () => ({}), { origins: [origin], signal: new AbortController().signal, confirmationId: 'c' }), /REGISTRY_UNAVAILABLE/)
})

test('read budgets follow discovered schema maxima without coercing identities, unsupported fields or write arguments', async () => {
  const limited = schema({ maxItems: { type: 'integer', maximum: 600 }, tabId: { type: 'integer', maximum: 8 } })
  const f = fixture([info('limited_read', limited, true), info('limited_write', limited)], async () => ({ read: true }))
  const input = { maxItems: 1000, tabId: 7 }
  const result = await f.execute('limited_read', input)
  assert.equal(f.calls[0].args.maxItems, 600); assert.equal(input.maxItems, 1000)
  assert.deepEqual(result.argumentAdjustments, [{ field: 'maxItems', requested: 1000, applied: 600 }])
  for (const args of [{ maxItems: '600', tabId: 7 }, { maxItems: 600, tabId: 9 }, { maxItems: 600, tabId: 7, unsupported: true }]) {
    await assert.rejects(f.execute('limited_read', args), /BROWSER_ARGUMENT_INVALID/)
  }
  await assert.rejects(f.execute('limited_write', input), /BROWSER_ARGUMENT_INVALID/)
  assert.equal(f.calls.length, 1)
})

test('snapshot refs are bound to their exact tab and latest snapshot, and document identity comes from the cache', async () => {
  let generation = 1
  const f = fixture([], async (name, args) => name === 'browser_snapshot' ? page(`s${generation}`, args.tabId) : { dispatched: true })
  const first = await f.execute('browser_snapshot', { tabId: 7 })
  assert.equal(first.snapshotId, 's1'); assert.equal(first.items, undefined); assert.match(first.tree, /\[ref=a\]/)
  assert.equal(f.calls[0].args.format, 'semantic')
  assert.equal(f.calls[0].args.policy.riskLevel, 'read')
  await f.execute('browser_click', { tabId: 7, snapshotId: 's1', ref: 'a', purpose: 'navigation' })
  assert.equal(f.calls[1].args.documentId, 'document-s1')
  assert.equal(f.calls[1].args.policy.riskLevel, 'browser_mutation')
  const before = f.calls.length
  await assert.rejects(f.execute('browser_click', { tabId: 8, snapshotId: 's1', ref: 'a' }), /SNAPSHOT_EXPIRED/)
  await assert.rejects(f.execute('browser_click', { tabId: 7, snapshotId: 's1', ref: 'missing' }), /ELEMENT_NOT_FOUND/)
  assert.equal(f.calls.length, before)
  generation = 2
  await f.execute('browser_snapshot', { tabId: 7, offset: 600, maxItems: 100 })
  assert.equal(f.calls.at(-1).args.offset, 600); assert.equal(f.calls.at(-1).args.maxItems, 100)
  await assert.rejects(f.execute('browser_click', { tabId: 7, snapshotId: 's1', ref: 'a' }), /SNAPSHOT_EXPIRED/)
  assert.equal(f.broker.getPage(7).snapshotId, 's2')
  const other = fixture()
  await assert.rejects(other.execute('browser_click', { tabId: 7, snapshotId: 's2', ref: 'a' }), /SNAPSHOT_EXPIRED/)
})

test('foreign-origin snapshots are rejected without replacing a previously valid task observation', async () => {
  let foreign = false
  const f = fixture([], async () => page(foreign ? 'foreign' : 'valid', 7, foreign ? 'https://foreign.test/list' : `${origin}/list`))
  await f.execute('browser_snapshot', { tabId: 7 })
  foreign = true
  await assert.rejects(f.execute('browser_snapshot', { tabId: 7 }), /ORIGIN_NOT_ALLOWED/)
  assert.equal(f.broker.getPage(7).snapshotId, 'valid')
})

test('ordinary unfamiliar errors retain their identity, while ambiguous mutating transport outcomes are fatal unknowns', async () => {
  let currentError
  const f = fixture([info('browser_independent_read', schema({}), true)], async name => {
    if (name === 'browser_snapshot') return page()
    throw currentError
  })
  await f.execute('browser_snapshot', { tabId: 7 })
  const ordinary = currentError = Object.assign(new Error('BRAND_NEW_INTERACTION_ERROR'), { code: 'BRAND_NEW_INTERACTION_ERROR' })
  await assert.rejects(f.execute('browser_click', { tabId: 7, snapshotId: 's1', ref: 'a' }), error => error === ordinary)
  for (const message of ['RESULT_UNKNOWN', 'TRANSPORT_ERROR socket closed', 'TIMEOUT', 'CDP_TARGET_DETACHED']) {
    currentError = new Error(`${message} token=private`)
    await assert.rejects(f.execute('browser_click', { tabId: 7, snapshotId: 's1', ref: 'a', purpose: 'navigation' }), error =>
      /BROWSER_WRITE_OUTCOME_UNKNOWN/.test(error.message) && !error.message.includes('private'))
  }
  currentError = new Error('TIMEOUT')
  await assert.rejects(f.execute('browser_independent_read', {}), error => error === currentError)
})

test('local observation reads can recover omitted refs without browser calls and cannot use another snapshot', async () => {
  const many = page('long', 7, `${origin}/list`, Array.from({ length: 700 }, (_, index) => `r${index}`))
  many.items.at(-1).context = { text: '末端完整关联内容' }
  const f = fixture([], async () => many)
  await f.execute('browser_snapshot', { tabId: 7 })
  const count = f.calls.length
  const read = await f.execute('browser_read_observation', { tabId: 7, snapshotId: 'long', query: '末端完整关联内容' })
  assert.match(read.tree, /ref=r699/); assert.match(JSON.stringify(read.contexts), /末端完整关联内容/)
  assert.equal(read.snapshotId, 'long'); assert.equal(f.calls.length, count)
  await assert.rejects(f.execute('browser_read_observation', { tabId: 7, snapshotId: 'other' }), /SNAPSHOT_EXPIRED/)
})

test('an observation timeout can return to the model while a successfully dispatched write with broken local observation is fatal', async () => {
  const f = fixture([], async name => {
    if (name === 'browser_snapshot') return page()
    return page('s2', 7, 'https://foreign.test/')
  })
  await f.execute('browser_snapshot', { tabId: 7 })
  await assert.rejects(f.execute('browser_click', { tabId: 7, snapshotId: 's1', ref: 'a' }), /BROWSER_WRITE_OUTCOME_UNKNOWN/)
  const readFailure = fixture([], async () => { throw new Error('TOOL_CALL_OUTCOME_UNKNOWN') })
  await assert.rejects(readFailure.execute('browser_snapshot', { tabId: 7 }), error => /BROWSER_OBSERVATION_UNAVAILABLE/.test(error.message) && !/OUTCOME_UNKNOWN/.test(error.message))
})

test('semantic inspection enrichment is serialized per tab so backend signature records cannot race', async () => {
  let active = 0, peak = 0
  const order = [], f = fixture([], async (name, args) => {
    if (name === 'browser_snapshot') return page()
    peak = Math.max(peak, ++active); order.push(args.ref)
    await new Promise(resolve => setTimeout(resolve, 2)); active--
    return { item: { ref: args.ref, contextCandidates: [{ text: `候选人 ${args.ref} 的上下文` }], nodeSignature: `signature-${args.ref}` } }
  })
  await f.execute('browser_snapshot', { tabId: 7 })
  const current = f.broker.getPage(7)
  await Promise.all([f.broker.inspectRefs(current, ['a', 'b', 'a']), f.broker.inspectRefs(current, ['b'])])
  assert.equal(peak, 1); assert.deepEqual(order, ['a', 'b', 'b'])
  assert.equal(current.items[0].nodeSignature, 'signature-a')
  assert.equal(f.calls.at(-1).args.policy.riskLevel, 'read')
  assert.equal(f.calls.at(-1).args.documentId, 'document-s1')
})

const nativeCall = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
function model(turns) {
  const requests = []
  return { requests, async *stream(request) {
    requests.push(structuredClone({ ...request, signal: undefined }))
    const blocks = turns.shift(); assert.ok(blocks)
    for (let index = 0; index < blocks.length; index++) {
      yield { type: 'block-start', index, blockType: blocks[index].type }
      yield { type: 'block-end', index, block: blocks[index] }
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  } }
}

test('core and broker return a new ordinary browser error to the model before it chooses another native tool', async () => {
  let complete = false
  const f = fixture([info('browser_future_path', schema({ arbitrary: { type: 'string' } }))], async name => {
    if (name === 'browser_snapshot') return page()
    if (name === 'browser_click') throw new Error('AN_UNSEEN_ORDINARY_ERROR')
    if (name === 'browser_future_path') { complete = true; return { verified: true } }
    return {}
  })
  await f.execute('browser_snapshot', { tabId: 7 })
  const llm = model([[nativeCall('first', 'browser_click', { tabId: 7, snapshotId: 's1', ref: 'a' })], [nativeCall('next', 'browser_future_path', { arbitrary: 'new shape' })]])
  const result = await runBrowserAgent(llm, { provider: 'host', model: 'default' }, {
    system: 'Test', goal: {}, tools: f.broker.tools, signal: f.controller.signal, isComplete: () => complete,
    isFatal: error => /BROWSER_WRITE_OUTCOME_UNKNOWN/.test(String(error)), maxTurns: 3, maxDurationMs: 1000,
  })
  assert.equal(result.status, 'completed')
  const errors = llm.requests[1].messages.flatMap(message => message.content.filter(block => block.type === 'tool-result' && block.isError))
  assert.match(errors[0].content[0].text, /AN_UNSEEN_ORDINARY_ERROR/)
  assert.equal(f.calls.at(-1).name, 'browser_future_path')
})

test('core and broker stop later native writes when the prior write has an unknown outcome', async () => {
  const f = fixture([], async name => { if (name === 'browser_snapshot') return page(); throw new Error('RESULT_UNKNOWN') })
  await f.execute('browser_snapshot', { tabId: 7 })
  const args = { tabId: 7, snapshotId: 's1', ref: 'a' }
  const llm = model([[nativeCall('first', 'browser_click', args), nativeCall('tail', 'browser_click', args)]])
  const result = await runBrowserAgent(llm, { provider: 'host', model: 'default' }, {
    system: 'Test', goal: {}, tools: f.broker.tools, signal: f.controller.signal,
    isFatal: error => /BROWSER_WRITE_OUTCOME_UNKNOWN/.test(String(error)), maxTurns: 3, maxDurationMs: 1000,
  })
  assert.equal(result.status, 'stopped'); assert.match(result.message, /BROWSER_WRITE_OUTCOME_UNKNOWN/)
  assert.equal(f.calls.filter(row => row.name === 'browser_click').length, 1)
  assert.equal(llm.requests.length, 1)
})

test('before and around hooks enforce host preflight and record dispatch/result in exact order', async () => {
  const events = []
  const f = fixture([], async (name) => { events.push(`remote:${name}`); return name === 'browser_snapshot' ? page() : { dispatched: true, target: { role: 'button', name: '实际目标' } } })
  await f.execute('browser_snapshot', { tabId: 7 })
  events.length = 0
  f.broker.setBeforeCall(async invocation => {
    assert.equal(invocation.purpose, 'business_write')
    assert.equal(invocation.readOnly, false)
    assert.equal(invocation.args.ref, 'a')
    events.push('preflight')
  })
  f.broker.setAroundCall(async (invocation, dispatch) => {
    assert.equal(invocation.name, 'browser_click')
    events.push('host-start')
    const output = await dispatch()
    events.push('host-receipt')
    assert.equal(output.dispatched, true)
    assert.equal(output.target.name, '实际目标')
    return { ...output, hostRecorded: true }
  })
  const output = await f.execute('browser_click', { tabId: 7, snapshotId: 's1', ref: 'a', purpose: 'business_write' })
  assert.deepEqual(events, ['preflight', 'host-start', 'remote:browser_click', 'host-receipt'])
  assert.equal(output.hostRecorded, true)
  assert.equal(f.calls.filter(row => row.name === 'browser_click').length, 1)
})

test('host preflight or around refusal prevents dispatch without poisoning the valid snapshot', async () => {
  const f = fixture()
  await f.execute('browser_snapshot', { tabId: 7 })
  f.broker.setBeforeCall(async () => { throw new Error('HOST_TARGET_NOT_AUTHORIZED') })
  const args = { tabId: 7, snapshotId: 's1', ref: 'a', purpose: 'business_write' }
  await assert.rejects(f.execute('browser_click', args), /HOST_TARGET_NOT_AUTHORIZED/)
  f.broker.setBeforeCall(async () => {})
  f.broker.setAroundCall(async () => { throw new Error('HOST_OPERATION_PENDING') })
  await assert.rejects(f.execute('browser_click', args), /HOST_OPERATION_PENDING/)
  assert.equal(f.calls.length, 1)
  assert.equal(f.broker.getPage(7).snapshotId, 's1')
})

const observedClickInfo = structuredClone(clickInfo)
observedClickInfo.inputSchema.properties.observe = { type: 'object', properties: {
  wait: { type: 'string', enum: ['none', 'dom_quiet', 'snapshot_changed'] },
  returnSnapshot: { type: 'string', enum: ['none', 'viewport', 'full'] }, timeoutMs: { type: 'integer' }, requireChange: { type: 'boolean' },
} }
function observedFixture(handler) {
  return fixture([observedClickInfo], handler, { allow: entry => entry !== clickInfo })
}

test('supported writes include bounded post-action snapshots by default; explicit opt-out wins', async () => {
  const f = observedFixture(async name => name === 'browser_snapshot' ? page('s1') :
    { output: { clicked: true, snapshot: page('s2'), verification: { conditionMet: true } } })
  await f.execute('browser_snapshot', { tabId: 7 })
  const result = await f.execute('browser_click', { tabId: 7, snapshotId: 's1', ref: 'a' })
  assert.deepEqual(f.calls[1].args.observe, { wait: 'dom_quiet', returnSnapshot: 'viewport', requireChange: false, timeoutMs: 2500 })
  assert.equal(result.output.clicked, true); assert.match(result.output.snapshot.tree, /ref=a/)
  assert.equal(f.broker.getPage(7).snapshotId, 's2')
  const explicit = { wait: 'none', returnSnapshot: 'none' }
  await f.execute('browser_click', { tabId: 7, snapshotId: 's2', ref: 'a', observe: explicit })
  assert.deepEqual(f.calls.at(-1).args.observe, explicit)
})

test('configured observation normalization replaces native DOM refs with a fresh semantic snapshot without replaying input', async () => {
  let snapshots = 0
  const f = fixture([observedClickInfo], async name => name === 'browser_snapshot' ? page(`s${++snapshots}`) :
    { output: { dispatched: true, clicked: true, snapshot: { ...page('native-dom'), format: 'dom' } } },
  { allow: entry => entry !== clickInfo, observationFormat: 'semantic' })
  await f.execute('browser_snapshot', { tabId: 7 })
  const result = await f.execute('browser_click', { tabId: 7, snapshotId: 's1', ref: 'a' })
  assert.equal(result.output.clicked, true)
  assert.equal(result.output.snapshot.snapshotId, 's2')
  assert.equal(f.broker.getPage(7).snapshotId, 's2')
  assert.equal(f.calls.filter(c => c.name === 'browser_click').length, 1)
})

test('full DOM inspection details are snapshot scoped even when the native inspector has no AX item', async () => {
  let generation = 0, inspected = 0
  const f = fixture([], async name => name === 'browser_snapshot' ? { ...page(`s${++generation}`), format: 'dom' } :
    { element: { tagName: 'label', attributes: { class: ++inspected === 1 ? 'active--captured' : 'plain' }, visible: true }, ancestors: [] })
  await f.execute('browser_snapshot', { tabId: 7 })
  const current = f.broker.getPage(7)
  await f.broker.inspectRefs(current, ['a'], f.controller.signal, false, true)
  assert.equal(f.broker.getInspection(current, 'a').element.attributes.class, 'active--captured')
  await f.broker.inspectRefs(current, ['a'], f.controller.signal, false, true)
  assert.equal(f.broker.getInspection(current, 'a').element.attributes.class, 'plain')
  assert.equal(JSON.stringify(current).includes('attributes'), false, 'raw DOM detail is not added to ordinary observations')
  await f.execute('browser_snapshot', { tabId: 7 })
  assert.throws(() => f.broker.getInspection(current, 'a'), /SNAPSHOT_EXPIRED/)
  assert.equal(f.broker.getInspection(f.broker.getPage(7), 'a'), undefined)
})

test('partial observation settings retain the snapshot default and missing post-input observations need no model round', async () => {
  for (const observe of [{}, { wait: 'none' }, { returnSnapshot: 'viewport' }]) {
    let snapshots = 0
    const f = observedFixture(async name => name === 'browser_snapshot' ? page(`s${++snapshots}`) : { output: { clicked: true, dispatched: true } })
    await f.execute('browser_snapshot', { tabId: 7 })
    const result = await f.execute('browser_click', { tabId: 7, snapshotId: 's1', ref: 'a', observe })
    assert.equal(f.calls[1].args.observe.returnSnapshot, 'viewport')
    assert.equal(f.calls[1].args.observe.wait, observe.wait ?? 'dom_quiet')
    assert.equal(result.output.clicked, true); assert.equal(result.snapshot.snapshotId, 's2')
    assert.deepEqual(f.calls.map(call => call.name), ['browser_snapshot', 'browser_click', 'browser_snapshot'])
    assert.equal(f.broker.getPage(7).snapshotId, 's2')
  }
  const f = observedFixture(async name => name === 'browser_snapshot' ? page() : { output: { clicked: true } })
  await f.execute('browser_snapshot', { tabId: 7 })
  await f.execute('browser_click', { tabId: 7, snapshotId: 's1', ref: 'a', observe: { returnSnapshot: 'none' } })
  assert.equal(f.calls.length, 2)
})

test('failed fallback observation preserves the successful input receipt and never replays it', async () => {
  let snapshots = 0
  const f = observedFixture(async name => {
    if (name === 'browser_snapshot') { if (++snapshots > 1) throw new Error('PAGE_UNAVAILABLE'); return page() }
    return { output: { clicked: true, dispatched: true, verification: { timeout: true } } }
  })
  await f.execute('browser_snapshot', { tabId: 7 })
  const result = await f.execute('browser_click', { tabId: 7, snapshotId: 's1', ref: 'a' })
  assert.equal(result.output.dispatched, true); assert.equal(result.observationError, 'PAGE_UNAVAILABLE')
  assert.equal(f.calls.filter(call => call.name === 'browser_click').length, 1)
})

test('post-action stale snapshots are withheld but the original dispatch receipt is preserved', async () => {
  const f = observedFixture(async name => name === 'browser_snapshot' ? page('before') : {
    output: { clicked: true, snapshot: page('stale'), verification: { snapshotStale: true, conditionMet: false } },
    verification: { snapshotStale: true, conditionMet: false },
  })
  await f.execute('browser_snapshot', { tabId: 7 })
  const result = await f.execute('browser_click', { tabId: 7, snapshotId: 'before', ref: 'a' })
  assert.equal(result.output.clicked, true); assert.equal(result.output.snapshot, undefined)
  assert.equal(result.verification.snapshotStale, true); assert.match(result.observationUnavailable, /Do not replay/)
  assert.equal(f.broker.getPage(7).snapshotId, 'before')
  assert.equal(f.calls.filter(row => row.name === 'browser_click').length, 1)
})

test('post-action verification timeout never turns a successful input into a retryable failure', async () => {
  const f = observedFixture(async name => name === 'browser_snapshot' ? page() : {
    output: { clicked: true, verification: { timeout: true, conditionMet: false } },
  })
  await f.execute('browser_snapshot', { tabId: 7 })
  const result = await f.execute('browser_click', { tabId: 7, snapshotId: 's1', ref: 'a' })
  assert.equal(result.output.clicked, true); assert.equal(result.output.verification.timeout, true)
  assert.equal(f.calls.filter(row => row.name === 'browser_click').length, 1)
})

test('an ordinary array tool result retains its shape', async () => {
  const f = fixture([info('browser_tabs', schema({}), true)], async () => [{ tabId: 7, url: `${origin}/list` }])
  assert.deepEqual(await f.execute('browser_tabs', {}), [{ tabId: 7, url: `${origin}/list` }])
})

test('stale reference failure returns a fresh read in the same model turn without replaying the click', async () => {
  let snapshots = 0, complete = false
  const f = fixture([], async name => {
    if (name === 'browser_snapshot') return page(`s${++snapshots}`)
    throw new Error('SNAPSHOT_EXPIRED')
  })
  await f.execute('browser_snapshot', { tabId: 7 })
  const llm = model([[nativeCall('failed', 'browser_click', { tabId: 7, snapshotId: 's1', ref: 'a' })], [nativeCall('finish', 'finish', {})]])
  const result = await runBrowserAgent(llm, { provider: 'host', model: 'default' }, {
    system: 'Test', goal: {}, tools: [...f.broker.tools, { name: 'finish', description: 'finish', inputSchema: schema({}), readOnly: false,
      execute: async () => { complete = true; return {} } }], signal: f.controller.signal, isComplete: () => complete,
  })
  assert.equal(result.status, 'completed'); assert.equal(result.turns, 2)
  const reply = llm.requests[1].messages.flatMap(message => message.content).find(block => block.type === 'tool-result')
  const body = JSON.parse(reply.content[0].text)
  assert.equal(body.recovery.snapshot.snapshotId, 's2'); assert.match(body.recovery.snapshot.tree, /ref=a/)
  assert.equal(f.calls.filter(row => row.name === 'browser_click').length, 1)
  assert.equal(snapshots, 2); assert.equal(f.broker.getPage(7).snapshotId, 's2')
})

test('failed recovery preserves the original error and rejects foreign-origin page content', async () => {
  let snapshots = 0
  const f = fixture([], async name => {
    if (name === 'browser_snapshot') return ++snapshots === 1 ? page() : page('foreign', 7, 'https://foreign.test/')
    throw new Error('PAGE_CHANGED')
  })
  await f.execute('browser_snapshot', { tabId: 7 })
  const args = { tabId: 7, snapshotId: 's1', ref: 'a' }
  await assert.rejects(tool(f.broker, 'browser_click').recover(new Error('PAGE_CHANGED'), args, f.controller.signal), /ORIGIN_NOT_ALLOWED/)
  assert.equal(f.broker.getPage(7).snapshotId, 's1')
  const before = f.calls.length
  assert.equal(await tool(f.broker, 'browser_click').recover(new Error('RESULT_UNKNOWN'), args, f.controller.signal), undefined)
  assert.equal(f.calls.length, before)
})

for (const code of ['ELEMENT_OCCLUDED', 'ELEMENT_HIDDEN']) test(`${code} returns a read-only target inspection and fresh DOM refs without replaying input`, async () => {
  let generation = 0, inputs = 0
  const f = fixture([], async (name, args) => {
    if (name === 'browser_snapshot') return { ...page(`s${++generation}`, 7, `${origin}/list`, args.format === 'dom' ? ['dom-control'] : ['a']), format: args.format }
    if (name === 'browser_click') { inputs++; throw new Error(code) }
    if (name === 'browser_inspect_element') return { item: { ref: 'a', role: 'generic', name: 'selected text', states: ['occluded'] },
      element: { css: { pointerEvents: 'none' } }, ancestors: [{ tagName: 'div', attributes: { role: 'combobox' } }] }
    throw new Error('Unexpected browser command')
  })
  await f.execute('browser_snapshot', { tabId: 7 })
  const args = { tabId: 7, snapshotId: 's1', ref: 'a' }
  await assert.rejects(f.execute('browser_click', args), new RegExp(code))
  const recovery = await tool(f.broker, 'browser_click').recover(new Error(code), args, f.controller.signal)
  assert.equal(recovery.inspection.element.css.pointerEvents, 'none')
  assert.equal(recovery.inspection.ancestors[0].attributes.role, 'combobox')
  assert.equal(recovery.observationMode, 'dom'); assert.equal(recovery.snapshot.snapshotId, 's2')
  assert.equal(f.broker.getPage(7).format, 'dom'); assert.equal(inputs, 1)
  assert.deepEqual(f.calls.map(call => call.name), ['browser_snapshot', 'browser_click', 'browser_inspect_element', 'browser_snapshot'])
  assert.equal(f.calls[2].args.policy.riskLevel, 'read')
  assert.match(recovery.note, /not replayed/i)
  if (code === 'ELEMENT_HIDDEN') assert.match(recovery.note, /hidden target, not proof of a covering overlay/)
  await assert.rejects(f.execute('browser_click', args), /SNAPSHOT_EXPIRED/)
})

test('failed obstruction inspection still returns a fresh observation and cannot trigger input replay', async () => {
  let generation = 0
  const f = fixture([], async (name, args) => {
    if (name === 'browser_snapshot') return { ...page(`s${++generation}`), format: args.format }
    if (name === 'browser_inspect_element') throw new Error('ELEMENT_NOT_FOUND private remote details')
    throw new Error('Unexpected browser input')
  })
  await f.execute('browser_snapshot', { tabId: 7 })
  const args = { tabId: 7, snapshotId: 's1', ref: 'a' }
  const recovery = await tool(f.broker, 'browser_click').recover(new Error('ELEMENT_OCCLUDED'), args, f.controller.signal)
  assert.equal(recovery.inspectionError, 'ELEMENT_NOT_FOUND'); assert.equal(recovery.snapshot.snapshotId, 's2')
  assert.ok(!JSON.stringify(recovery).includes('private'))
  assert.equal(f.calls.filter(call => call.name === 'browser_click').length, 0)
})

test('unknown writes never enter obstruction inspection or DOM recovery', async () => {
  const f = fixture()
  await f.execute('browser_snapshot', { tabId: 7 })
  const before = f.calls.length
  assert.equal(await tool(f.broker, 'browser_click').recover(new Error('RESULT_UNKNOWN'), { tabId: 7, snapshotId: 's1', ref: 'a' }, f.controller.signal), undefined)
  assert.equal(f.calls.length, before)
})

test('failed semantic read recovers through fresh DOM refs without relaxing or replaying browser input', async () => {
  let generation = 0, reads = 0
  const f = fixture([], async (name, args) => {
    if (name === 'browser_snapshot') return { ...page(`s${++generation}`, 7, `${origin}/list`, args.format === 'dom' ? ['dom-target'] : ['a']), format: args.format }
    if (name === 'browser_inspect_element') {
      reads++
      if (args.ref === 'a') throw new Error('SNAPSHOT_EXPIRED')
      return { item: { ref: 'dom-target', role: 'button', name: 'current DOM target' } }
    }
    throw new Error('Unexpected browser input')
  })
  await f.execute('browser_snapshot', { tabId: 7 })
  const args = { tabId: 7, snapshotId: 's1', ref: 'a' }
  await assert.rejects(f.execute('browser_inspect_element', args), /SNAPSHOT_EXPIRED/)
  const recovery = await tool(f.broker, 'browser_inspect_element').recover(new Error('SNAPSHOT_EXPIRED'), args, f.controller.signal)
  assert.equal(recovery.observationMode, 'dom'); assert.equal(recovery.snapshot.format, 'dom')
  assert.equal(f.calls.at(-1).args.format, 'dom')
  const result = await f.execute('browser_inspect_element', { tabId: 7, snapshotId: 's2', ref: 'dom-target' })
  assert.equal(result.item.ref, 'dom-target'); assert.equal(reads, 2)
  assert.equal(f.calls.filter(call => call.name === 'browser_click').length, 0)
})

test('recovery observations are compacted with normal observations while error identity and input receipts survive', async () => {
  let generation = 0
  const f = fixture([], async name => {
    if (name !== 'browser_snapshot') throw new Error('PAGE_CHANGED')
    const current = page(`s${++generation}`)
    current.items[0].name = `snapshot-body-${generation} ` + 'page detail '.repeat(1800)
    return current
  })
  const llm = model([
    [nativeCall('read', 'browser_snapshot', { tabId: 7 })],
    [nativeCall('failed', 'browser_click', { tabId: 7, snapshotId: 's1', ref: 'a' })],
    [nativeCall('fresh', 'browser_snapshot', { tabId: 7 })],
    [nativeCall('last', 'browser_read_observation', { tabId: 7, snapshotId: 's3' })],
  ])
  await runBrowserAgent(llm, { provider: 'host', model: 'default' }, {
    system: 'Test', goal: {}, tools: f.broker.tools, signal: f.controller.signal, maxTurns: 4,
  })
  const results = llm.requests.at(-1).messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
  const failed = results.find(block => block.toolCallId === 'failed')
  const body = JSON.parse(failed.content[0].text)
  assert.equal(failed.isError, true); assert.equal(body.error.code, 'PAGE_CHANGED')
  assert.equal(body.recovery.snapshot.representation, 'historical-snapshot-summary')
  assert.equal(body.recovery.snapshot.snapshotId, 's2')
  const serialized = JSON.stringify(llm.requests.at(-1).messages)
  assert.ok(!serialized.includes('snapshot-body-1')); assert.ok(!serialized.includes('snapshot-body-2'))
  assert.ok(serialized.includes('snapshot-body-3'))
  assert.equal(f.calls.filter(call => call.name === 'browser_click').length, 1)
})

test('an obstruction returns a fresh foreground observation for replanning without replaying the failed input', async () => {
  let generation = 0
  const f = fixture([], async name => {
    if (name === 'browser_snapshot') return page(`s${++generation}`)
    throw new Error('ELEMENT_OCCLUDED')
  })
  await f.execute('browser_snapshot', { tabId: 7 })
  const recovery = await tool(f.broker, 'browser_click').recover(new Error('ELEMENT_OCCLUDED'), { tabId: 7, snapshotId: 's1', ref: 'a' }, f.controller.signal)
  assert.equal(recovery.snapshot.snapshotId, 's2'); assert.equal(recovery.evidence[0].ref, 'a')
  assert.equal(recovery.inspectionError, 'ELEMENT_OCCLUDED')
  assert.deepEqual(f.calls.map(call => call.name), ['browser_snapshot', 'browser_inspect_element', 'browser_snapshot'])
})

test('superseded snapshots are compacted per tab while action receipts, latest pages and call IDs survive', async () => {
  let generation = 0
  const logs = []
  const f = observedFixture(async (name, args) => {
    const next = page(`s${++generation}`, args.tabId)
    next.items[0].name = `generation-${generation} ` + '页面内容'.repeat(250)
    return name === 'browser_snapshot' ? next : { output: { clicked: true, receipt: 'keep-business-receipt', snapshot: next } }
  })
  const llm = model([
    [nativeCall('read1', 'browser_snapshot', { tabId: 7 })],
    [nativeCall('click2', 'browser_click', { tabId: 7, snapshotId: 's1', ref: 'a' })],
    [nativeCall('other', 'browser_snapshot', { tabId: 8 })],
    [nativeCall('read4', 'browser_snapshot', { tabId: 7 })],
    [nativeCall('read5', 'browser_snapshot', { tabId: 7 })],
    [nativeCall('read6', 'browser_snapshot', { tabId: 7 })],
  ])
  await runBrowserAgent(llm, { provider: 'host', model: 'default' }, {
    system: 'Test', goal: {}, tools: f.broker.tools, signal: f.controller.signal, maxTurns: 6,
    logger: { write: (level, event, fields) => logs.push({ event, fields }) },
  })
  const last = llm.requests.at(-1), replies = last.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
  assert.deepEqual(replies.map(reply => reply.toolCallId), ['read1', 'click2', 'other', 'read4', 'read5'])
  const body = replies.map(reply => JSON.parse(reply.content[0].text))
  assert.equal(body[0].representation, 'historical-snapshot-summary')
  assert.equal(body[1].output.snapshot.representation, 'historical-snapshot-summary')
  assert.equal(body[1].output.receipt, 'keep-business-receipt'); assert.equal(body[1].output.clicked, true)
  assert.match(body[2].tree, /generation-3/); assert.equal(body[3].representation, 'historical-snapshot-summary'); assert.match(body[4].tree, /generation-5/)
  assert.ok(logs.filter(row => row.event === 'browser_agent.model_turn').at(-1).fields.contextSavedCharacters > 1500)
})

test('post-action observation allows the model to finish in two turns without a standalone snapshot round', async () => {
  let complete = false
  const f = observedFixture(async name => name === 'browser_snapshot' ? page('before') : { output: { clicked: true, snapshot: page('after') } })
  await f.execute('browser_snapshot', { tabId: 7 })
  const llm = model([[nativeCall('click', 'browser_click', { tabId: 7, snapshotId: 'before', ref: 'a' })], [nativeCall('record', 'record', { snapshotId: 'after' })]])
  const result = await runBrowserAgent(llm, { provider: 'host', model: 'default' }, {
    system: 'Test', goal: {}, signal: f.controller.signal, isComplete: () => complete,
    tools: [...f.broker.tools, { name: 'record', description: 'confirm evidence', inputSchema: schema({ snapshotId: { type: 'string' } }), readOnly: false,
      execute: async args => { assert.equal(f.broker.getPage(7, args.snapshotId).snapshotId, 'after'); complete = true; return { confirmed: true } } }],
  })
  assert.equal(result.status, 'completed'); assert.equal(result.turns, 2)
  assert.deepEqual(f.calls.map(row => row.name), ['browser_snapshot', 'browser_click'])
  assert.match(JSON.stringify(llm.requests[1].messages), /after/)
})

test('bootstrap only observes the preferred or uniquely allowed tab and never opens or navigates', async () => {
  const tabsInfo = info('browser_list_tabs', schema({}), true)
  for (const [preferred, tabs, expected] of [
    [undefined, [{ tabId: 7, url: `${origin}/list` }], 7],
    [undefined, [{ tabId: 7, url: `${origin}/a` }, { tabId: 8, url: `${origin}/b` }], undefined],
    [8, [{ tabId: 7, url: `${origin}/a` }, { tabId: 8, url: `${origin}/b` }], 8],
    [9, [{ tabId: 9, url: 'https://foreign.test/' }], undefined],
  ]) {
    const f = fixture([tabsInfo], async (name, args) => name === 'browser_list_tabs' ? { tabs } : page('startup', args.tabId))
    const seeds = await f.broker.bootstrap(preferred)
    assert.deepEqual(f.calls.map(row => row.name), expected ? ['browser_list_tabs', 'browser_snapshot'] : ['browser_list_tabs'])
    assert.equal(seeds.length, expected ? 2 : 1)
    if (expected) assert.equal(seeds[1].args.tabId, expected)
  }
})

test('navigation read failure retains its receipt without replaying or poisoning cached page', async () => {
  let snapshots = 0
  const f = fixture([info('browser_navigate', schema({ tabId: { type: 'integer' }, url: { type: 'string' } }))], async name => {
    if (name === 'browser_snapshot') { if (++snapshots > 1) throw new Error('PAGE_UNAVAILABLE'); return page() }
    return { navigated: true }
  })
  await f.execute('browser_snapshot', { tabId: 7 })
  const value = await f.execute('browser_navigate', { tabId: 7, url: `${origin}/next` })
  assert.equal(value.navigated, true); assert.equal(value.observationError, 'PAGE_UNAVAILABLE')
  assert.equal(f.calls.filter(row => row.name === 'browser_navigate').length, 1)
})

test('read-only inspection reuse is snapshot-scoped and never applies to fresh action validation', async () => {
  let generation = 1
  const f = fixture([], async (name, args) => name === 'browser_snapshot' ? page(`s${generation}`) : { item: { ref: args.ref, nodeSignature: 'observed' } })
  await f.execute('browser_snapshot', { tabId: 7 })
  const current = f.broker.getPage(7)
  await f.broker.inspectRefs(current, ['a'], f.controller.signal, true)
  await f.broker.inspectRefs(current, ['a'], f.controller.signal, true)
  assert.equal(f.calls.filter(row => row.name === 'browser_inspect_element').length, 1)
  await f.broker.inspectRefs(current, ['a'], f.controller.signal)
  assert.equal(f.calls.filter(row => row.name === 'browser_inspect_element').length, 2)
  generation++
  await f.execute('browser_snapshot', { tabId: 7 })
  await f.broker.inspectRefs(f.broker.getPage(7), ['a'], f.controller.signal, true)
  assert.equal(f.calls.filter(row => row.name === 'browser_inspect_element').length, 3)
})

test('initial observation keeps later candidate refs when within budget; local continuation never fetches again', async () => {
  const f = fixture([], async () => page('long', 7, `${origin}/list`, Array.from({ length: 400 }, (_, i) => `ref${i}`)))
  const result = await f.execute('browser_snapshot', { tabId: 7 })
  assert.equal(result.coverage.returnedElements, 400); assert.equal(result.coverage.nextOffset, null)
  assert.match(result.tree, /ref=ref399/)
  const rest = await f.execute('browser_read_observation', { tabId: 7, snapshotId: 'long', offset: 120, limit: 100 })
  assert.match(rest.tree, /ref=ref120/); assert.equal(f.calls.length, 1)
})

test('failure identity survives ref regeneration, viewport movement and state toggles', async () => {
  const f = fixture([], async () => page())
  await f.execute('browser_snapshot', { tabId: 7 })
  const click = tool(f.broker, 'browser_click')
  const first = click.failureKey({ tabId: 7, snapshotId: 's1', ref: 'a' })
  const observed = f.broker.getPage(7)
  // 同一元素换 ref、换快照、滚动换位置、被聚焦/展开：仍是同一个失败目标。
  observed.items = [{ ...observed.items[0], ref: 'regenerated', bounds: { x: 10, y: 900, width: 80, height: 30 }, states: ['focused'] }]
  assert.equal(click.failureKey({ tabId: 7, snapshotId: 's2', ref: 'regenerated' }), first)
  assert.equal(click.failureLabel({ tabId: 7, ref: 'regenerated' }), 'button')
  // 真正不同的元素仍然独立计数。
  observed.items.push({ ref: 'other', role: 'button', name: '操作 b', elementId: 'greet-2', states: [] })
  assert.notEqual(click.failureKey({ tabId: 7, snapshotId: 's2', ref: 'other' }), first)
  assert.equal(click.failureLabel({ tabId: 7, ref: 'other' }), 'button#greet-2')
})

test('a host-supplied purpose on a read-only tool is stripped instead of failing the whole task', async () => {
  // 真实事故：预设对 browser_wait（网关标为只读）传了 purpose，additionalProperties:false
  // 的 schema 直接拒绝，预设随即 tool_failed 交棒，新开标签页首屏永远进不了预设。
  const f = fixture([info('browser_wait', schema({ tabId: { type: 'integer' }, condition: { type: 'object' } }), true)])
  const wait = tool(f.broker, 'browser_wait')
  const result = await wait.execute({ tabId: 7, condition: { type: 'time', delayMs: 100 }, purpose: 'navigation' }, f.controller.signal)
  assert.equal(result.dispatched, true)
  const sent = f.calls.find(call => call.name === 'browser_wait')
  assert.equal(sent.args.purpose, undefined, 'read-only 工具不应收到 purpose')
  assert.equal(sent.args.policy.riskLevel, 'read')
})

test('a write tool still rejects an unknown field and still requires its declared purpose', async () => {
  const f = fixture([])
  const click = tool(f.broker, 'browser_click')
  await assert.rejects(click.execute({ tabId: 7, snapshotId: 's1', ref: 'a', invented: 1 }, f.controller.signal), /BROWSER_ARGUMENT_INVALID/)
})

test('a snapshot frameId is dropped for tools that do not declare it and kept for those that do', async () => {
  const f = fixture([info('browser_range', schema({ tabId: { type: 'integer' }, frameId: { type: 'integer' },
    snapshotId: { type: 'string' }, ref: { type: 'string' } }), false)])
  // 快照类工具声明了 frameId：必须原样送达（iframe 观察依赖它）。
  await f.execute('browser_snapshot', { tabId: 7, frameId: 3 })
  assert.equal(f.calls.at(-1).args.frameId, 3)
  // 未声明的工具：剥离而不是拒绝。交互类能力从快照记录取帧，剥离不改变行为。
  await f.execute('browser_click', { tabId: 7, snapshotId: 's1', ref: 'a', frameId: 0, purpose: 'business_write' })
  assert.equal(f.calls.at(-1).args.frameId, undefined)
  await f.execute('browser_range', { tabId: 7, snapshotId: 's1', ref: 'a', frameId: 2 })
  assert.equal(f.calls.at(-1).args.frameId, 2)
})


test('bootstrap uses a unique configured entry among allowed tabs and preserves route ambiguity', async () => {
  const tabsInfo = info('browser_list_tabs', schema({}), true)
  for (const [urls, entry, expected] of [
    [['/recommend', '/search#preview'], '/search', 8],
    [['/search?a=1', '/search?a=2'], '/search?a=2', 8],
    [['/search#one', '/search#two'], '/search', undefined],
    [['/recommend', '/other'], '/search', undefined],
    [['/recommend', 'https://foreign.test/search'], '/search', 7],
  ]) {
    const tabs = urls.map((url, i) => ({ tabId: i + 7, url: new URL(url, origin).href }))
    const f = fixture([tabsInfo], async (name, args) => name === 'browser_list_tabs' ? { tabs } : page('startup', args.tabId))
    const seeds = await f.broker.bootstrap(undefined, undefined, origin + entry)
    assert.deepEqual(f.calls.map(row => row.name), expected ? ['browser_list_tabs', 'browser_snapshot'] : ['browser_list_tabs'])
    if (expected) assert.equal(seeds[1].args.tabId, expected)
  }
})
