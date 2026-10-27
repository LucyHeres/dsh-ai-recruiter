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
    return body?.ok ? body.data : null
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
