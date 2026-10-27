'use strict'
const path = require('node:path')
const { spawn } = require('node:child_process')

async function readStatus(port, signal) {
  try {
    const timeout = AbortSignal.timeout(2000)
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      credentials: 'omit', redirect: 'error', cache: 'no-store'
    })
    const body = await response.json()
    if (!body?.ok) return null
    const status = body.data
    // Same-version local reinstalls may keep an older shared gateway running.
    // Its authentication log already records the extension-reported version.
    // Use only the newest authentication for this device, never profile metadata
    // or an earlier authentication when the current version is missing.
    if (status?.connected && status.authenticated && !Object.hasOwn(status, 'extensionVersion')) {
      try {
        const logResponse = await fetch(`http://127.0.0.1:${port}/api/log`, {
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000),
          credentials: 'omit', redirect: 'error', cache: 'no-store'
        })
        const logBody = await logResponse.json()
        const lines = logBody?.ok && Array.isArray(logBody.data) ? logBody.data.slice(-200) : []
        const latest = lines.findLast(line => typeof line === 'string' && /^\d{4}-\d\d-\d\dT\S+ <- agent\.authenticate /.test(line))
        const auth = latest?.match(/ <- agent\.authenticate deviceId=(browser_[A-Za-z0-9_-]+) extension=(\d+(?:\.\d+){0,3})$/)
        if (auth && auth[1] === status.deviceId) return { ...status, extensionVersion: auth[2] }
      } catch (_) { /* Keep the version unknown when the legacy evidence is unavailable. */ }
    }
    return status
  } catch (_) { return null }
}

function startGateway({ port, idleExitMs, appConnection = false, onError = () => {} }) {
  const args = [path.join(__dirname, 'gateway.js'), `--port=${port}`]
  if (idleExitMs !== undefined) args.push(`--idle-exit-ms=${idleExitMs}`)
  if (appConnection) args.push('--app-connection')
  const child = spawn(process.execPath, args, {
    detached: true, windowsHide: true, cwd: __dirname,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: appConnection ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore'
  })
  child.on('error', onError)
  child.unref()
  child.channel?.unref()
  return child
}

module.exports = { readStatus, startGateway }
