import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir, endianness } from 'node:os'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { notifyExtension } = require('../browser-agent-gateway/connection-notification.cjs')
const origin = 'chrome-extension://elbamdfkepfcainfggecfjhahpjjdmdg/'
const frame = value => { const body = Buffer.from(JSON.stringify(value)), head = Buffer.alloc(4); head[endianness() === 'LE' ? 'writeUInt32LE' : 'writeUInt32BE'](body.length); return Buffer.concat([head, body]) }
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'native-connection-test-')), config = join(dir, 'pair.json'), entry = join(dir, 'entry.cjs')
  const profile = { version: 1, gatewayUrl: 'ws://127.0.0.1:5030/ws', deviceToken: 'test-only', deviceId: 'browser_test', taskId: 'browser_task_test', autoConnect: true }
  await writeFile(config, JSON.stringify(profile)); await writeFile(entry, `require(${JSON.stringify(resolve('browser-agent-gateway/native-host.cjs'))}).serve(${JSON.stringify(config)})`)
  const children = []
  t.after(async () => { for (const child of children) if (child.exitCode === null) child.kill(); await rm(dir, { recursive: true, force: true }) })
  const start = (caller = origin) => {
    const child = spawn(process.execPath, [entry, caller], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child)
    let buffer = Buffer.alloc(0); const messages = [], waiting = []
    child.stdout.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); while (buffer.length >= 4) { const n = buffer[endianness() === 'LE' ? 'readUInt32LE' : 'readUInt32BE'](); if (buffer.length < n + 4) break; const value = JSON.parse(buffer.subarray(4, n + 4)); buffer = buffer.subarray(n + 4); if (waiting.length) waiting.shift()(value); else messages.push(value) } })
    const next = () => new Promise((resolve, reject) => { if (messages.length) return resolve(messages.shift()); const timeout = setTimeout(() => reject(Error('native reply timeout')), 3000); waiting.push(value => { clearTimeout(timeout); resolve(value) }) })
    return { child, next, exited: new Promise(resolve => child.on('exit', resolve)) }
  }
  return { config, profile, start, children }
}
test('native watch accepts fragmented framing, pushes config/wake changes and exits with Chrome', async t => {
  const f = await fixture(t), s = f.start(), input = frame({ action: 'watch_local_connection' })
  s.child.stdin.write(input.subarray(0, 2)); s.child.stdin.write(input.subarray(2))
  assert.equal((await s.next()).reason, 'initial')
  const started = Date.now(); assert.equal(notifyExtension(f.config), true)
  assert.equal((await s.next()).reason, 'connection_requested'); assert.ok(Date.now() - started < 2000)
  await writeFile(f.config, JSON.stringify({ ...f.profile, deviceToken: 'rotated-test-only' }))
  const changed = await s.next(); assert.equal(changed.reason, 'configuration_changed'); assert.equal(changed.localGateway.deviceToken, 'rotated-test-only')
  s.child.stdin.end(); assert.equal(await s.exited, 0)
})
test('native host rejects other callers and unsupported requests', async t => {
  const f = await fixture(t), denied = f.start('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/')
  assert.equal(await denied.exited, 0)
  const s = f.start(); s.child.stdin.write(frame({ action: 'run', path: '/tmp/never-execute' }))
  assert.equal((await s.next()).code, 'UNSUPPORTED_ACTION'); assert.equal(await s.exited, 0)
})
test('ensure actively notifies an existing disconnected gateway and observes readiness promptly', async t => {
  const f = await fixture(t); let ready = false
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data: { state: ready ? 'claimed' : 'idle', connected: ready, ready } })) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close())
  const port = server.address().port
  await writeFile(f.config, JSON.stringify({ ...f.profile, gatewayUrl: `ws://127.0.0.1:${port}/ws` }))
  const native = f.start(); native.child.stdin.write(frame({ action: 'watch_local_connection' })); await native.next()
  const started = Date.now(), ensure = spawn(process.execPath, ['browser-agent-gateway/ensure.js', `--port=${port}`, '--timeout=3', '--quiet'], { env: { ...process.env, XINZHAO_GATEWAY_CONFIG: f.config }, stdio: 'ignore' }); f.children.push(ensure)
  const exited = new Promise(resolve => ensure.on('exit', resolve))
  assert.equal((await native.next()).reason, 'connection_requested'); ready = true
  assert.equal(await exited, 0); assert.ok(Date.now() - started < 2000)
})
