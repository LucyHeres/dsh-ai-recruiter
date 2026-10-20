'use strict'
const http = require('node:http')
const { randomBytes, timingSafeEqual } = require('node:crypto')
const { setup } = require('./setup.cjs')
const { requirePairing } = require('./config.cjs')

// A short-lived grant, never the persistent device token, is exposed to the page.
async function createPairing() {
  setup()
  const ticket = randomBytes(32).toString('hex')
  const expiresAt = Date.now() + 5 * 60 * 1000
  let consumed = false
  let origin
  const server = http.createServer((req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" }
    const send = (status, value, type = 'application/json') => {
      res.writeHead(status, { ...headers, 'Content-Type': type }); res.end(value)
    }
    if (req.headers.host !== new URL(origin).host || Date.now() >= expiresAt) return send(403, '{}')
    if (req.method === 'GET' && req.url === '/xinzhao-pair') {
      return send(200, '<!doctype html><meta charset="utf-8"><title>连接薪招</title><h1>连接本机 DSH</h1><p>正在打开薪招扩展的确认页。请在扩展中确认允许连接。</p><p>若未打开，请确认已安装新版薪招扩展，然后重新打开 DSH 中的连接链接。</p>', 'text/html; charset=utf-8')
    }
    // Web pages cannot obtain credentials: require an extension origin plus the one-time grant.
    const extensionOrigin = req.headers.origin || ''
    if (/^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin)) {
      headers['Access-Control-Allow-Origin'] = extensionOrigin
      headers['Vary'] = 'Origin'
      headers['Access-Control-Allow-Methods'] = 'POST'
      headers['Access-Control-Allow-Headers'] = 'Authorization'
      if (req.method === 'OPTIONS' && req.url === '/claim') return send(204, '')
    }
    const authorization = req.headers.authorization || ''
    const supplied = authorization.replace(/^Bearer /, '')
    const valid = /^[a-f0-9]{64}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied), Buffer.from(ticket))
    if (req.method !== 'POST' || req.url !== '/claim' || consumed ||
        !/^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin) || !valid) return send(403, '{}')
    try {
      const profile = requirePairing()
      consumed = true
      send(200, JSON.stringify({ localGateway: profile }))
    } catch (_) { send(500, '{}') }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  const timer = setTimeout(() => server.close(), 5 * 60 * 1000)
  timer.unref(); server.unref()
  return { url: `${origin}/xinzhao-pair#${ticket}`, expiresAt,
    close() { clearTimeout(timer); server.close() } }
}
module.exports = { createPairing }
