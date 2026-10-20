'use strict'
const fs = require('node:fs')
const os = require('node:os')
const { validateProfile } = require('./config.cjs')
const HOST_NAME = 'com.xinrenxinshi.xinzhao.dsh'
const EXTENSION_ID = 'elbamdfkepfcainfggecfjhahpjjdmdg'

function serve(configurationPath) {
  // Chrome passes the caller origin, and also enforces allowed_origins in its registration.
  if (process.argv[2] !== `chrome-extension://${EXTENSION_ID}/`) return
  let buffer = Buffer.alloc(0), finished = false
  const timer = setTimeout(() => process.exit(0), 10000)
  const reply = value => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4)
    if (os.endianness() === 'LE') header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length)
    process.stdout.write(Buffer.concat([header, body]), () => process.exit(0))
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
      if (message?.action !== 'get_local_connection') return reply({ ok: false, code: 'UNSUPPORTED_ACTION' })
      if (fs.statSync(configurationPath).size > 65536) throw new Error('invalid')
      const profile = validateProfile(JSON.parse(fs.readFileSync(configurationPath, 'utf8')))
      // Only the Chrome native pipe receives the credential. No HTTP endpoint or chat output.
      reply({ ok: true, protocolVersion: 1, localGateway: profile })
    } catch (_) { reply({ ok: false, code: 'LOCAL_CONNECTION_UNAVAILABLE' }) }
  })
  process.stdin.on('end', () => { if (!finished) reply({ ok: false, code: 'INCOMPLETE_REQUEST' }) })
  process.stdout.on('error', () => process.exit(0))
}
module.exports = { serve, HOST_NAME, EXTENSION_ID }
