import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await sleep(25) }
  assert.fail('connection service did not reach expected state')
}
async function fixture(t, { autoConnect = true, installed = true, server, idleExitMs = 900000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'connection-service-')), config = join(root, 'pair.json')
  const reservation = server || createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  if (!server) await new Promise(resolve => reservation.close(resolve))
  const profile = { version: 1, gatewayUrl: `ws://127.0.0.1:${port}/ws`, deviceToken: 'isolated-test-only',
    deviceId: 'browser_startup_test', taskId: 'browser_task_startup_test', autoConnect }
  await writeFile(config, JSON.stringify(profile))
  const entry = join(root, 'app.cjs')
  // Observe actual spawned children for cleanup without replacing their behavior.
  await writeFile(entry, `
const cp = require('node:child_process'), spawn = cp.spawn
cp.spawn = (...args) => { const child = spawn(...args); process.send({ event: 'gateway', pid: child.pid }); return child }
let installed = ${JSON.stringify(installed)}
const stop = require(${JSON.stringify(resolve('browser-agent-gateway/connection-service.cjs'))}).startConnectionService({
  intervalMs: 50, canConnect: async () => installed, onError: error => process.send({ event: 'error', code: error.code || error.message })
})
process.on('message', message => { if (message === 'installed') installed = true; if (message === 'stop') { stop(); process.send({ event: 'stopped' }) } })
process.on('disconnect', () => { stop(); process.exit(0) })
process.send({ event: 'started' })
`)
  const app = spawn(process.execPath, [entry], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, XINZHAO_GATEWAY_CONFIG: config, BROWSER_AGENT_GATEWAY_PORT: String(port), BROWSER_AGENT_GATEWAY_IDLE_EXIT_MS: String(idleExitMs) } })
  const messages = [], sockets = [], pids = []
  let stderr = ''
  app.stderr.on('data', chunk => { stderr += chunk })
  app.on('message', message => { messages.push(message); if (message.event === 'gateway') pids.push(message.pid) })
  t.after(async () => {
    for (const socket of sockets) socket.close()
    if (app.exitCode === null && app.signalCode === null) app.kill()
    for (const pid of pids) { try { process.kill(pid) } catch (_) {} }
    if (server) await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
    assert.equal(stderr, '')
    assert.equal(messages.filter(message => message.event === 'error').length, 0)
  })
  const status = async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(500) })).json()).data }
    catch (_) { return null }
  }
  await until(() => messages.find(message => message.event === 'started'))
  return { app, config, profile, status, pids, messages, sockets }
}
async function extension(f, version = '3.2.46') {
  const socket = new WebSocket(f.profile.gatewayUrl), events = []
  f.sockets.push(socket)
  socket.addEventListener('error', () => {})
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data); events.push(message.event)
    if (message.event === 'agent.authenticated') socket.send(JSON.stringify({ event: 'task.claim', taskId: f.profile.taskId }))
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.send(JSON.stringify({ deviceId: f.profile.deviceId, deviceToken: f.profile.deviceToken,
    protocolVersion: '1.0', extensionVersion: version, extensionFeatures: ['local.task.lifecycle'] }))
  await until(async () => (await f.status())?.ready)
  assert.deepEqual(events, ['agent.authenticated', 'task.claim.ack'])
  return socket
}

test('gateway status exposes the authenticated version and clears it on disconnect', async t => {
  const f = await fixture(t)
  await until(f.status)
  for (const version of ['3.2.45', '3.2.46', null]) {
    const socket = await extension(f, version)
    assert.equal((await f.status()).extensionVersion, version)
    socket.close()
    await until(async () => !(await f.status())?.connected)
    assert.equal((await f.status()).extensionVersion, null)
  }
})

test('startup skips gateway and wake-up while the extension is missing, then connects after installation', async t => {
  const f = await fixture(t, { installed: false })
  await sleep(200)
  assert.equal(f.pids.length, 0); assert.equal(await f.status(), null)
  await assert.rejects(readFile(`${f.config}.connect-request`), { code: 'ENOENT' })
  f.app.send('installed')
  await until(f.status)
  assert.equal(f.pids.length, 1)
  await extension(f)
  assert.equal((await f.status()).ready, true)
  assert.equal((await f.status()).executionOwner, null, 'installing prepares the transport without starting a task')
})

test('startup prepares transport before the browser opens, reconnects and restarts a failed gateway without beginning a task', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const initial = await until(f.status)
  assert.equal(initial.ready, false)
  assert.equal(initial.idleExitAt, null)
  assert.equal(initial.executionOwner, null)
  assert.equal(initial.workflowTaskId, null)
  const notification = JSON.parse(await readFile(`${f.config}.connect-request`, 'utf8'))
  assert.equal(notification.version, 1)
  assert.equal('deviceToken' in notification, false)
  await sleep(150) // browser can open after plugin startup has already returned
  const first = await extension(f)
  first.close(); await until(async () => !(await f.status())?.connected)
  await extension(f)
  process.kill(f.pids[0])
  await until(() => f.pids.length === 2)
  const restarted = await until(f.status)
  assert.equal(restarted.ready, false)
  assert.equal(restarted.workflowTaskId, null)
  await extension(f)
  assert.equal((await f.status()).executionOwner, null)
})

test('startup reuses an existing busy transport and disposal leaves it running', { timeout: 10000 }, async t => {
  const requests = [], existing = { ready: true, executionOwner: 'remote', workflowTaskId: 'existing-task' }
  const server = createServer((req, res) => {
    requests.push({ path: req.url, method: req.method })
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data: existing }))
  })
  const f = await fixture(t, { server })
  await until(() => requests.length >= 3)
  f.app.send('stop'); await until(() => f.messages.find(message => message.event === 'stopped'))
  assert.equal(f.pids.length, 0)
  assert.deepEqual(await f.status(), existing)
  assert.ok(requests.every(request => request.path === '/api/status' && request.method === 'GET'))
  await assert.rejects(readFile(`${f.config}.connect-request`), { code: 'ENOENT' })
})

test('authentication in progress is left alone and a disconnected transport receives only one wake request', { timeout: 10000 }, async t => {
  const existing = { connected: true, ready: false }, requests = []
  const server = createServer((req, res) => {
    requests.push(req.url)
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data: existing }))
  })
  const f = await fixture(t, { server })
  await until(() => requests.length >= 3)
  await assert.rejects(readFile(`${f.config}.connect-request`), { code: 'ENOENT' })
  existing.connected = false
  const request = await until(async () => {
    try { return JSON.parse(await readFile(`${f.config}.connect-request`, 'utf8')) } catch (_) { return null }
  })
  await sleep(200)
  assert.equal(JSON.parse(await readFile(`${f.config}.connect-request`, 'utf8')).requestId, request.requestId)
  assert.equal(f.pids.length, 0)
  assert.ok(requests.every(path => path === '/api/status'))
})

test('disabled automatic connection stays off; enabling it starts service and disposal preserves a connected transport', { timeout: 10000 }, async t => {
  const f = await fixture(t, { autoConnect: false })
  await sleep(200)
  assert.equal(f.pids.length, 0)
  assert.equal(await f.status(), null)
  await assert.rejects(readFile(`${f.config}.connect-request`), { code: 'ENOENT' })
  await writeFile(f.config, JSON.stringify({ ...f.profile, autoConnect: true }))
  await until(f.status)
  const socket = await extension(f)
  f.app.send('stop'); await until(() => f.messages.find(message => message.event === 'stopped'))
  const status = await until(async () => { const status = await f.status(); return status?.idleExitAt && status })
  assert.equal(status.ready, true)
  assert.equal(socket.readyState, WebSocket.OPEN)
})

test('app lifetime prevents idle exit and an app crash restores normal idle cleanup', { timeout: 50000 }, async t => {
  const f = await fixture(t, { idleExitMs: 100 })
  await until(f.status)
  await sleep(21000) // pass the gateway's real 20-second idle sweep
  assert.equal(f.pids.length, 1)
  assert.equal((await f.status()).idleExitAt, null)
  f.app.kill('SIGKILL')
  await until(async () => (await f.status())?.idleExitAt)
  await until(async () => (await f.status()) === null, 25000)
})
