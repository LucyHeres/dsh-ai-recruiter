'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const configurationPath = () => process.env.XINZHAO_GATEWAY_CONFIG || path.join(os.homedir(), '.xinzhao', 'browser-agent.local.json')
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configurationPath(), 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error('XINZHAO_LOCAL_PAIRING_INVALID: 本机配对文件无法读取，请检查配置')
  }
}
function validateProfile(value) {
  const p = value?.localGateway || value
  let url
  try { url = new URL(p?.gatewayUrl) } catch (_) { throw new Error('XINZHAO_LOCAL_PAIRING_INVALID: 无效网关地址') }
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/ws' ||
      url.username || url.password || url.search || url.hash ||
      typeof p.deviceToken !== 'string' || !p.deviceToken.trim() ||
      !/^browser_[A-Za-z0-9_-]+$/.test(p.deviceId) || !/^browser_task_[A-Za-z0-9_-]+$/.test(p.taskId) ||
      typeof p.autoConnect !== 'boolean' || (p.version !== undefined && p.version !== 1)) {
    throw new Error('XINZHAO_LOCAL_PAIRING_INVALID: 配对文件内容无效')
  }
  return { version: 1, gatewayUrl: url.href, deviceToken: p.deviceToken.trim(), deviceId: p.deviceId, taskId: p.taskId, autoConnect: p.autoConnect }
}
function requirePairing() {
  const config = readConfig()
  if (!config) throw new Error('XINZHAO_LOCAL_PAIRING_REQUIRED: 请在 DSH 中要求初始化薪招浏览器连接，调用 browser_setup 打开连接链接，并在薪招扩展确认页允许连接')
  return validateProfile(config)
}
function port() {
  if (process.env.BROWSER_AGENT_GATEWAY_PORT) return Number(process.env.BROWSER_AGENT_GATEWAY_PORT)
  const config = readConfig()
  return config ? Number(new URL(validateProfile(config).gatewayUrl).port || 80) : 5030
}
module.exports = { configurationPath, readConfig, validateProfile, requirePairing, port }
