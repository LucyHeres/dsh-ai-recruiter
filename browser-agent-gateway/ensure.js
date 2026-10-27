#!/usr/bin/env node
'use strict'

// 按需拉起网关，并等到扩展连上为止。
//
//   node ensure.js [--port=5030] [--timeout=90] [--idle-exit-ms=900000]
//
// 为什么要它：网关是扩展唯一能连的服务端（扩展是 WebSocket 客户端，只能主动连出去），
// 所以进程本身跑不掉；但"需要时自动起、不用时自动退"可以做到 ——
// 起由本脚本负责，退由 gateway.js 的空闲自动退出负责。
//
// 退出码：0 = 已就绪（扩展已连上）；1 = 超时或失败。

const { notifyExtension } = require('./connection-notification.cjs')
const { configurationPath } = require('./config.cjs')
const { readStatus: gatewayStatus, startGateway } = require('./gateway-process.cjs')

const DEFAULT_PORT = 5030
const DEFAULT_TIMEOUT_MS = 90 * 1000

const flags = {}
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('--')) continue
  const [key, ...rest] = arg.slice(2).split('=')
  flags[key] = rest.length ? rest.join('=') : true
}

const PORT = Number(flags.port || require('./config.cjs').port())
const TIMEOUT_MS = Number(flags.timeout || 90) * 1000
const QUIET = Boolean(flags.quiet)
const say = (message) => { if (!QUIET) console.log(message) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const readStatus = () => gatewayStatus(PORT)

const main = async () => {
  let status = await readStatus()

  if (status?.ready) {
    say(`网关已在运行且扩展已连接（taskId=${status.taskId}）`)
    return 0
  }

  if (!status) {
    require('./config.cjs').requirePairing()
    const { pid } = startGateway({ port: PORT, idleExitMs: flags['idle-exit-ms'] })
    say(`网关未运行，已自动拉起（pid=${pid}，端口 ${PORT}）`)
  } else {
    say('网关已在运行，等待扩展连接…')
  }

  const started = Date.now()
  let notified = status ? notifyExtension(configurationPath()) : false
  let lastNote = 0
  for (;;) {
    await sleep(Date.now() - started < 2000 ? 100 : 250)
    const current = await readStatus()
    if (current?.ready) {
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      say(`扩展已连接（${seconds}s，deviceId=${current.deviceId}，taskId=${current.taskId}）`)
      return 0
    }
    if (current && !notified) notified = notifyExtension(configurationPath())
    const elapsed = Date.now() - started
    if (elapsed > TIMEOUT_MS) {
      console.error(`等待扩展连接超时（${TIMEOUT_MS / 1000}s）。排查方向：`)
      console.error('  1) Chrome 是否开着，且 chrome://extensions 里「薪招」已启用')
      console.error('  2) 是否已在薪招扩展设置中导入本机配对文件并重新加载扩展')
      console.error(`  3) 直接看 http://127.0.0.1:${PORT}/api/status 与 /api/log`)
      return 1
    }
    if (elapsed - lastNote > 10000) {
      lastNote = elapsed
      say(`  仍在等待扩展连接…（已 ${Math.round(elapsed / 1000)}s）`)
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`ensure 失败：${error.message}`)
    process.exit(1)
  })
