#!/usr/bin/env node
'use strict'
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { configurationPath, readConfig, validateProfile, port } = require('./config.cjs')

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'setup') {
    const { configurationPath: file } = require('./setup.cjs').setup(args)
    console.log(`本机配对：${file}`)
    console.log('在 Chrome 薪招扩展设置的「本地浏览器连接」中导入此文件，然后重新加载扩展。')
    return
  }
  if (command === 'doctor') {
    const config = readConfig()
    if (config) validateProfile(config)
    let status
    try {
      const response = await fetch(`http://127.0.0.1:${port()}/api/status`, { signal: AbortSignal.timeout(2000), redirect: 'error' })
      status = (await response.json())?.data
    } catch (_) {}
    // Whitelist output: never return task wake nonces or pairing tokens.
    console.log(JSON.stringify({ configurationPath: configurationPath(), paired: Boolean(config), gatewayRunning: Boolean(status),
      extensionReady: status?.ready === true, connected: status?.connected === true }, null, 2))
    return
  }
  const script = command === 'ensure' ? 'ensure.js' : ['status', 'begin', 'finish', 'call'].includes(command) ? 'cli.js' : null
  if (!script) throw new Error('用法：dsh-ai-recruiter-browser setup|doctor|ensure|status|begin|finish|call')
  const forwarded = script === 'cli.js' ? [command, ...args] : args
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...forwarded], { stdio: 'inherit' })
  if (result.error) throw new Error('无法启动网关命令')
  process.exitCode = result.status ?? 1
}
main().catch(error => {
  // Parse errors may quote input: show only a known validation error, never raw file contents.
  const safe = /^(XINZHAO_|用法：|端口须|无法启动)/.test(error.message) ? error.message : '本机配对配置操作失败，请检查文件和权限'
  console.error(safe)
  process.exitCode = 1
})
