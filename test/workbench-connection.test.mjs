import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { Workbench } from '../dist/lib/workbench.js'
import { SourcingAgent } from '../dist/lib/sourcing-agent.js'
import { ExtensionInstallationDetector } from '../dist/lib/extension-installation.js'
import { ENSURE_TIMEOUT_SECONDS } from '../dist/shared/workbench.js'

function fixture(ensure, version = '3.2.46') {
  const service = Object.create(Workbench.prototype), calls = []
  let ready = false
  Object.assign(service, { active: null, operation: false, disposed: false, connecting: false })
  service.extensionDetector = { read: async () => ({ status: 'installed' }) }
  service.call = async (tool, args, signal) => {
    calls.push({ tool, args, signal })
    if (tool === 'browser_ensure') { await ensure(signal); ready = true; return {} }
    if (tool === 'browser_status') return { connected: ready, authenticated: ready, ready, available: ready, extensionVersion: version }
    if (tool === 'browser_begin') return {}
    throw new Error(`Unexpected tool ${tool}`)
  }
  return { service, calls }
}

function waitForAbort(signal) {
  return new Promise((_resolve, reject) => {
    // Keep the test alive while AbortSignal.timeout's unreferenced timer fires.
    const timer = setTimeout(() => reject(new Error('connection deadline did not fire')), 1000)
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

test('standalone login and tab probes release execution so a manual sourcing retry is possible', async () => {
  const { service } = fixture(async () => {})
  let workflow = false, begins = 0, finishes = 0, reads = 0
  service.call = async tool => {
    if (tool === 'browser_status') return { connected: true, authenticated: true, ready: true, available: true, workflowTaskId: workflow ? 'probe' : null }
    if (tool === 'browser_ensure') return {}
    if (tool === 'browser_begin') { assert.equal(workflow, false); workflow = true; begins++; return {} }
    if (tool === 'browser_finish') { assert.equal(workflow, true); workflow = false; finishes++; return {} }
    throw new Error(tool)
  }
  for (const result of [{ loggedIn: false }, { tabs: [] }, { loggedIn: true }]) {
    const release = service.reserve()
    try {
      assert.equal(await service.browserProbe(async () => { reads++; assert.equal(workflow, true); return result }), result)
    } finally { release() }
    assert.equal(workflow, false)
    assert.equal((await service.connection()).busy, false)
    assert.equal((await service.connection()).activeWorkflow, false)
  }
  assert.equal(reads, 3); assert.equal(begins, 3); assert.equal(finishes, 3)
  await service.begin()
  assert.equal(workflow, true, 'the next explicit start can acquire execution immediately')
})

test('probe failures release only acquired execution and never replay the query', async () => {
  const { service } = fixture(async () => {})
  let begins = 0, finishes = 0, reads = 0, occupied = false
  service.call = async tool => {
    if (tool === 'browser_status') return { connected: true, authenticated: true, ready: true, available: true, workflowTaskId: occupied ? 'existing-workflow' : null }
    if (tool === 'browser_ensure') return {}
    if (tool === 'browser_begin') { begins++; return {} }
    if (tool === 'browser_finish') { finishes++; return {} }
    throw new Error(tool)
  }
  const read = async () => { reads++; throw new Error('RESULT_UNKNOWN: probe interrupted') }
  await assert.rejects(service.browserProbe(read), /RESULT_UNKNOWN/)
  assert.equal(reads, 1); assert.equal(begins, 1); assert.equal(finishes, 1)
  occupied = true
  await assert.rejects(service.browserProbe(read), /RESULT_UNKNOWN/)
  assert.equal(reads, 2); assert.equal(begins, 1); assert.equal(finishes, 1, 'an existing workflow retains its lifetime')
  occupied = false
  service.begin = async () => { throw new Error('BROWSER_AGENT_BUSY') }
  await assert.rejects(service.browserProbe(read), /BROWSER_AGENT_BUSY/)
  assert.equal(reads, 2); assert.equal(finishes, 1, 'a failed acquisition cannot finish someone else’s workflow')
})

test('task auto-connect and explicit connect share a 90-second wait and real in-flight status', async () => {
  assert.equal(ENSURE_TIMEOUT_SECONDS, 90)
  for (const action of ['begin', 'connect']) {
    let finish
    const { service, calls } = fixture(() => new Promise(resolve => { finish = resolve }))
    const pending = service[action]()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await service.connection()).connecting, true)
    assert.equal(calls.find(call => call.tool === 'browser_ensure').args.timeoutSeconds, 90)
    assert.equal(calls.some(call => call.tool === 'browser_begin'), false)
    finish(); await pending
    const status = await service.connection()
    assert.equal(status.connecting, false)
    assert.equal(status.ready, true)
    assert.equal(service.operation, false)
    assert.equal(calls.filter(call => call.tool === 'browser_begin').length, action === 'begin' ? 1 : 0)
  }
})

test('native connection timeout is actionable, releases the operation and permits a retry', async () => {
  let attempts = 0
  const { service, calls } = fixture(async () => {
    if (++attempts === 1) throw new Error('等待扩展连接超时（90s）。排查方向：')
  })
  await assert.rejects(service.connect(), /BROWSER_CONNECTION_TIMEOUT.*90 秒.*连接浏览器/)
  assert.equal((await service.connection()).connecting, false)
  assert.equal(service.operation, false)
  await service.connect()
  assert.equal(attempts, 2)
  assert.equal(calls.some(call => call.tool === 'browser_begin'), false)
})

test('a silent ensure call is bounded; timeout never begins a browser workflow', async () => {
  const { service, calls } = fixture(waitForAbort)
  const ensure = service.ensureConnection.bind(service)
  service.ensureConnection = signal => ensure(signal, 15)
  await assert.rejects(service.begin(), /BROWSER_CONNECTION_TIMEOUT/)
  assert.equal((await service.connection()).connecting, false)
  assert.equal(calls.some(call => call.tool === 'browser_begin'), false)
})

test('cancellation and non-timeout errors clear connecting and manual connection reservations', async () => {
  const controller = new AbortController()
  const { service } = fixture(waitForAbort)
  const pending = service.connect(controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('user stopped connection'))
  await assert.rejects(pending, /user stopped connection/)
  assert.equal(service.connecting, false)
  assert.equal(service.operation, false)
  const failure = fixture(async () => { throw new Error('XINZHAO_LOCAL_PAIRING_REQUIRED') })
  await assert.rejects(failure.service.connect(), /XINZHAO_LOCAL_PAIRING_REQUIRED/)
  assert.equal(failure.service.connecting, false)
  assert.equal(failure.service.operation, false)
})

test('a missing extension rejects connection immediately without ensure or browser ownership', async () => {
  for (const action of ['begin', 'connect', 'pair']) {
    const { service, calls } = fixture(() => { throw new Error('must not connect') })
    service.extensionDetector = { read: async (connected, refresh) => { assert.equal(connected, false); assert.equal(refresh, true); return { status: 'not_installed' } } }
    await assert.rejects(service[action](), /BROWSER_EXTENSION_NOT_INSTALLED.*先安装/)
    assert.equal(service.connecting, false); assert.equal(service.operation, false); assert.equal(service.active, null)
    assert.deepEqual(calls.map(call => call.tool), ['browser_status'])
  }
})

test('missing installation never saves or runs a task; installation requires a fresh manual start', async () => {
  for (const kind of ['talent_sourcing', 'greeting', 'resume_import']) {
    const { service, calls } = fixture(async () => {})
    let status = 'not_installed', prepared = 0, ran = 0
    const records = new Map(), id = randomUUID()
    const executor = { kind, storagePrefix: 'task-', create: () => ({ id, kind, platform: 'boss', status: 'queued', results: [] }),
      run: async job => { ran++; job.status = 'completed' } }
    Object.assign(service, { initialized: Promise.resolve(), executors: new Map([[kind, executor]]),
      sourcing: { prepare: async () => { prepared++ } },
      store: { find: async key => records.get(key), put: async (key, value) => records.set(key, value) },
      extensionDetector: { read: async () => ({ status }) } })
    await assert.rejects(service.start({ kind }), /BROWSER_EXTENSION_NOT_INSTALLED/)
    assert.equal(service.active, null); assert.equal(service.operation, false)
    assert.equal(records.size, 0); assert.equal(prepared, 0); assert.equal(ran, 0)
    assert.ok(calls.every(call => call.tool === 'browser_status'))
    status = 'installed'
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ran, 0, 'installing the extension never resumes the rejected task')
    await service.start({ kind })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ran, 1); assert.equal(records.size, 1); assert.equal(service.active, null)
  }
})

test('unreadable installation metadata does not block a real connection attempt', async () => {
  const { service, calls } = fixture(async () => {})
  service.extensionDetector = new ExtensionInstallationDetector([])
  await service.connect()
  assert.ok(calls.some(call => call.tool === 'browser_ensure'))
})

test('outdated installation rejects connect, pairing and browser tasks before waking the extension', async () => {
  for (const action of ['begin', 'connect', 'pair']) {
    const { service, calls } = fixture(() => { throw Error('must not connect') })
    service.extensionDetector = { read: async () => ({ status: 'outdated', version: '3.2.45', detail: '请升级至 3.2.46 或更高版本' }) }
    await assert.rejects(service[action](), /BROWSER_EXTENSION_OUTDATED.*3\.2\.46/)
    assert.equal(service.connecting, false); assert.equal(service.operation, false)
    assert.deepEqual(calls.map(call => call.tool), ['browser_status'])
  }
})

test('connection validates the reported version before acquiring browser execution', async () => {
  for (const [version, code] of [['3.2.45', 'BROWSER_EXTENSION_OUTDATED'], [undefined, 'BROWSER_EXTENSION_VERSION_UNKNOWN']]) {
    const { service, calls } = fixture(async () => {}, version ?? null)
    service.extensionDetector = new ExtensionInstallationDetector([])
    await assert.rejects(service.begin(), new RegExp(code))
    assert.equal(service.connecting, false)
    assert.ok(calls.some(call => call.tool === 'browser_ensure'))
    assert.equal(calls.some(call => call.tool === 'browser_begin'), false)
  }
})

test('an already connected old extension cannot bypass the version requirement', async () => {
  const { service, calls } = fixture(() => { throw Error('must not ensure') })
  service.extensionDetector = new ExtensionInstallationDetector([])
  service.connection = async () => ({ connected: true, authenticated: true, ready: true, extensionVersion: '3.2.45' })
  await assert.rejects(service.connect(), /BROWSER_EXTENSION_OUTDATED/)
  assert.equal(calls.length, 0)
  assert.equal(service.operation, false)
})

test('resume sync also rejects missing installation and releases its reservation without connecting', async () => {
  const { service, calls } = fixture(() => { throw Error('must not connect') })
  Object.assign(service, { initialized: Promise.resolve(), extensionDetector: { read: async () => ({ status: 'not_installed' }) },
    store: { find: async () => undefined, list: async prefix => prefix === 'sourcing-' ? [{ id: 'round', kind: 'talent_sourcing', jobId: 'java', createdAt: '', candidates: [{ key: 'person', name: '甲', platform: 'boss', score: 90 }] }] : [] } })
  await assert.rejects(service.syncCommunication({ jobId: 'java' }), /BROWSER_EXTENSION_NOT_INSTALLED/)
  assert.equal(service.operation, false); assert.equal(service.active, null)
  assert.ok(calls.every(call => call.tool === 'browser_status'))
})

test('sourcing shows auto-connection progress and settles failed before any platform action on timeout', async () => {
  const { service, calls } = fixture(waitForAbort)
  const ensure = service.ensureConnection.bind(service)
  service.ensureConnection = signal => ensure(signal, 15)
  let locked = false
  const store = {
    locked: async (_key, run) => { locked = true; try { return await run() } finally { locked = false } },
    list: async () => [], put: async () => {},
  }
  const agent = new SourcingAgent(store, async () => { throw new Error('unexpected platform call') },
    signal => service.begin(signal), async () => [], () => async () => {}, async () => ({}))
  const job = agent.create({ id: randomUUID(), jobId: 'sales', platforms: ['boss'], limit: 1, confirmed: true })
  await agent.run(job, new AbortController().signal)
  assert.equal(job.events[0].message, '正在连接浏览器…')
  assert.equal(job.status, 'failed')
  assert.equal(job.phase, 'finished')
  assert.match(job.detail, /BROWSER_CONNECTION_TIMEOUT/)
  assert.equal(service.connecting, false)
  assert.equal(locked, false)
  assert.equal(calls.some(call => call.tool === 'browser_begin'), false)
})
