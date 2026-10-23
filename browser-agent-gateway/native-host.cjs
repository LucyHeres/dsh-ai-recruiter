'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validateProfile } = require('./config.cjs')
const { notificationPath } = require('./connection-notification.cjs')
const HOST_NAME = 'com.xinrenxinshi.xinzhao.dsh'
const EXTENSION_ID = 'elbamdfkepfcainfggecfjhahpjjdmdg'

function serve(configurationPath) {
  // Chrome passes the caller origin, and also enforces allowed_origins in its registration.
  if (process.argv[2] !== `chrome-extension://${EXTENSION_ID}/`) return
  let buffer = Buffer.alloc(0), finished = false, watching = false, watcher, pending
  const timer = setTimeout(() => process.exit(0), 10000)
  const close = () => {
    finished = true; clearTimeout(timer); clearTimeout(pending); watcher?.close()
  }
  const reply = (value, end = true) => {
    if (finished) return
    clearTimeout(timer)
    const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4)
    if (os.endianness() === 'LE') header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length)
    if (end) close()
    process.stdout.write(Buffer.concat([header, body]), () => { if (end) process.exit(0) })
  }
  const connection = reason => {
    try {
      if (fs.statSync(configurationPath).size > 65536) throw new Error('invalid')
      const profile = validateProfile(JSON.parse(fs.readFileSync(configurationPath, 'utf8')))
      // Only the authenticated Chrome native pipe receives credentials.
      reply({ ok: true, protocolVersion: watching ? 2 : 1, reason, localGateway: profile }, !watching)
    } catch (_) { reply({ ok: false, protocolVersion: watching ? 2 : 1, code: 'LOCAL_CONNECTION_UNAVAILABLE' }, !watching) }
  }
  process.stdin.on('data', chunk => {
    if (finished) return
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > 8192) return reply({ ok: false, code: 'INVALID_REQUEST' })
    if (buffer.length < 4) return
    const size = os.endianness() === 'LE' ? buffer.readUInt32LE() : buffer.readUInt32BE()
    if (!size || size > 4096) return reply({ ok: false, code: 'INVALID_REQUEST' })
    if (buffer.length < size + 4) return
    try {
      const message = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'))
      if (watching || !['get_local_connection', 'watch_local_connection'].includes(message?.action)) return reply({ ok: false, code: 'UNSUPPORTED_ACTION' })
      buffer = Buffer.alloc(0)
      if (message.action === 'watch_local_connection') {
        watching = true
        const configName = path.basename(configurationPath), wakeName = path.basename(notificationPath(configurationPath))
        let reason
        watcher = fs.watch(path.dirname(configurationPath), (_event, filename) => {
          const name = filename?.toString()
          if (name !== configName && name !== wakeName) return
          // Preserve an explicit request if a simultaneous config rename arrives.
          reason = name === wakeName || reason === 'connection_requested' ? 'connection_requested' : 'configuration_changed'
          clearTimeout(pending)
          pending = setTimeout(() => { const value = reason; reason = undefined; connection(value) }, 25)
        })
        watcher.on('error', () => reply({ ok: false, code: 'LOCAL_CONNECTION_WATCH_FAILED' }))
      }
      connection('initial')
    } catch (_) { reply({ ok: false, code: 'LOCAL_CONNECTION_UNAVAILABLE' }) }
  })
  process.stdin.on('end', () => { if (watching) { close(); process.exit(0) } else if (!finished) reply({ ok: false, code: 'INCOMPLETE_REQUEST' }) })
  process.stdout.on('error', () => { close(); process.exit(0) })
}
module.exports = { serve, HOST_NAME, EXTENSION_ID }
