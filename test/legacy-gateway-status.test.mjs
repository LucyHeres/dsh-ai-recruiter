import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'

const { readStatus } = createRequire(import.meta.url)('../browser-agent-gateway/gateway-process.cjs')
const current = { connected: true, authenticated: true, ready: true, deviceId: 'browser_current' }
const auth = (device, version) => `2026-10-27T07:54:45.826Z <- agent.authenticate deviceId=${device} extension=${version}`

async function fixture(t, status, lines) {
  const requests = []
  const server = createServer((req, res) => {
    requests.push(req.url)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, data: req.url === '/api/status' ? status : lines }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { read: () => readStatus(server.address().port), requests }
}

test('legacy gateway reports only the latest authenticated version for the currently connected device', async t => {
  const f = await fixture(t, current, [auth('browser_current', '3.2.45'), auth('browser_current', '3.2.46')])
  assert.deepEqual(await f.read(), { ...current, extensionVersion: '3.2.46' })
  assert.deepEqual(f.requests, ['/api/status', '/api/log'])
})

test('old, unknown or unrelated authentication logs never confirm the current version', async t => {
  for (const lines of [[], [auth('browser_other', '3.2.46')],
    [auth('browser_current', '3.2.46'), auth('browser_current', '?')],
    [auth('browser_current', '3.2.46'), auth('browser_other', '3.2.47')],
    ['untrusted prefix ' + auth('browser_current', '3.2.46')]]) {
    const f = await fixture(t, current, lines)
    assert.deepEqual(await f.read(), current)
  }
})

test('modern status and disconnected sessions never fall back to legacy logs', async t => {
  for (const status of [{ ...current, extensionVersion: '3.2.45' }, { ...current, extensionVersion: null },
    { ...current, connected: false }, { ...current, authenticated: false }]) {
    const f = await fixture(t, status, [auth('browser_current', '3.2.46')])
    assert.deepEqual(await f.read(), status)
    assert.deepEqual(f.requests, ['/api/status'])
  }
})
