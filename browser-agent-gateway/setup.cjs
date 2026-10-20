'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { configurationPath, readConfig, validateProfile } = require('./config.cjs')
function setup(args = []) {
  const file = configurationPath()
  // Existing pairing is reused; never rotate tokens merely by running setup again.
  const existing = readConfig()
  if (existing) {
    validateProfile(existing)
  } else {
    let profile
    if (args[0] === '--import' && args.length === 2) {
      const imported = JSON.parse(fs.readFileSync(args[1], 'utf8'))
      const local = imported.localGateway || imported
      profile = validateProfile({ ...local, deviceId: local.deviceId || 'browser_local_dev', taskId: local.taskId || 'browser_task_local', autoConnect: local.autoConnect ?? true })
    } else if (args.length === 0 || (args[0] === '--port' && args.length === 2)) {
      const selectedPort = args.length ? Number(args[1]) : Number(process.env.BROWSER_AGENT_GATEWAY_PORT || 5030)
      if (!Number.isInteger(selectedPort) || selectedPort < 1024 || selectedPort > 65535) throw new Error('端口须在 1024–65535 之间')
      const id = randomBytes(8).toString('hex')
      profile = { version: 1, gatewayUrl: `ws://127.0.0.1:${selectedPort}/ws`, deviceToken: randomBytes(32).toString('hex'),
        deviceId: `browser_${id}`, taskId: `browser_task_${id}`, autoConnect: true }
    } else throw new Error('用法：setup [--port 5030 | --import /path/to/browser-agent.local.json]')
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    try {
      fs.writeFileSync(file, JSON.stringify({ localGateway: profile }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      validateProfile(readConfig())
    }
  }
  return { configurationPath: file }
}
module.exports = { setup }
