'use strict'
const { configurationPath, requirePairing, port } = require('./config.cjs')
const { notifyExtension } = require('./connection-notification.cjs')
const { readStatus, startGateway } = require('./gateway-process.cjs')

// Prepare the transport in the background. This never begins a browser task.
function startConnectionService({ intervalMs = 5000, canConnect = async () => true, onError = () => {} } = {}) {
  const controller = new AbortController()
  let disposed = false, timer, child, observedPort, notified = false, lastError = ''
  const report = error => {
    if (disposed) return
    const key = String(error?.code || error?.message || error)
    if (key !== lastError) { lastError = key; onError(error) }
  }
  const release = () => {
    // Disconnecting the lifetime channel restores normal idle exit. Do not kill
    // a shared gateway that may still be serving an existing browser task.
    if (child?.connected) { try { child.disconnect() } catch (_) {} }
    child = undefined
  }
  const check = async () => {
    try {
      if (!requirePairing().autoConnect) { release(); notified = false; return }
      const gatewayPort = port()
      if (observedPort !== gatewayPort) { release(); notified = false; observedPort = gatewayPort }
      const status = await readStatus(gatewayPort, controller.signal)
      if (disposed) return
      if (!status?.connected && !await canConnect()) { release(); notified = false; return }
      if (disposed) return
      if (!status) {
        notified = false
        if (!child) {
          const started = startGateway({ port: gatewayPort, appConnection: true, onError: report })
          child = started
          started.once('close', () => { if (child === started) child = undefined })
        }
      } else if (status.ready) notified = false
      else if (!status.connected && !notified) notified = notifyExtension(configurationPath())
      lastError = ''
    } catch (error) { report(error) }
    finally {
      if (!disposed) { timer = setTimeout(check, intervalMs); timer.unref() }
    }
  }
  void check()
  return () => {
    disposed = true
    clearTimeout(timer)
    controller.abort()
    release()
  }
}

module.exports = { startConnectionService }
