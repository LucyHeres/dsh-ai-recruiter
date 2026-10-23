'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const notificationPath = configurationPath => `${configurationPath}.connect-request`

// A user-local wake signal, never a credential or a command from a webpage.
// Native Messaging holds the authenticated Chrome pipe and watches this file.
function notifyExtension(configurationPath) {
  const target = notificationPath(configurationPath)
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}`)
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, requestId: randomUUID(), requestedAt: Date.now() }), { mode: 0o600 })
    fs.renameSync(temporary, target)
    return true
  } catch (_) {
    try { fs.unlinkSync(temporary) } catch (_) {}
    return false
  }
}
module.exports = { notificationPath, notifyExtension }
