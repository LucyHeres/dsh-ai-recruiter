import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { Workbench } from '../dist/lib/workbench.js'
import { SourcingAgent } from '../dist/lib/sourcing-agent.js'
import { ENSURE_TIMEOUT_SECONDS } from '../dist/shared/workbench.js'

function fixture(ensure) {
  const service = Object.create(Workbench.prototype), calls = []
  let ready = false
  Object.assign(service, { active: null, operation: false, disposed: false, connecting: false })
  service.call = async (tool, args, signal) => {
    calls.push({ tool, args, signal })
    if (tool === 'browser_ensure') { await ensure(signal); ready = true; return {} }
    if (tool === 'browser_status') return { connected: ready, authenticated: ready, ready, available: ready }
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

test('task auto-connect and explicit connect share a 90-second wait and real in-flight status', async () => {
  assert.equal(ENSURE_TIMEOUT_SECONDS, 90)
  for (const action of ['begin', 'connect']) {
    let finish
    const { service, calls } = fixture(() => new Promise(resolve => { finish = resolve }))
    const pending = service[action]()
    assert.equal((await service.connection()).connecting, true)
    assert.equal(calls[0].args.timeoutSeconds, 90)
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
  controller.abort(new Error('user stopped connection'))
  await assert.rejects(pending, /user stopped connection/)
  assert.equal(service.connecting, false)
  assert.equal(service.operation, false)
  const failure = fixture(async () => { throw new Error('XINZHAO_LOCAL_PAIRING_REQUIRED') })
  await assert.rejects(failure.service.connect(), /XINZHAO_LOCAL_PAIRING_REQUIRED/)
  assert.equal(failure.service.connecting, false)
  assert.equal(failure.service.operation, false)
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
  assert.match(job.events[0].message, /未连接时将自动连接.*90 秒/)
  assert.equal(job.status, 'failed')
  assert.equal(job.phase, 'finished')
  assert.match(job.detail, /BROWSER_CONNECTION_TIMEOUT/)
  assert.equal(service.connecting, false)
  assert.equal(locked, false)
  assert.equal(calls.some(call => call.tool === 'browser_begin'), false)
})
