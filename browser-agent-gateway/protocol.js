'use strict'

// 与薪招 src/function/browser-agent/protocol.js 对齐的报文构造与本地校验。
// 服务端先自己校验一遍，避免把必然被扩展拒绝的命令发出去。

const PROTOCOL_VERSION = '1.0'
const MAX_COMMAND_TTL_MS = 5 * 60 * 1000

const CAPABILITIES = Object.freeze([
  'browser.execute_actions',
  'browser.list_tabs',
  'browser.open_tab',
  'browser.activate_tab',
  'browser.close_tab',
  'browser.navigate',
  'browser.history',
  'browser.snapshot',
  'browser.inspect_element',
  'browser.accessibility',
  'browser.network_requests',
  'browser.network_response',
  'browser.wait',
  'browser.click',
  'browser.hover',
  'browser.type',
  'browser.select_option',
  'browser.press_key',
  'browser.scroll',
  'browser.list_frames',
  'browser.capture_content',
  'browser.acquire_file',
  // 无页签读取平台登录态（扩展后台带 cookie 请求平台接口），不打开任何页面。
  'browser.channel_login',
  'artifact.read'
])

const RISK_LEVELS = Object.freeze(['read', 'browser_mutation', 'business_write'])

const MUTATION_CAPABILITIES = new Set([
  'browser.execute_actions',
  'browser.click',
  'browser.hover',
  'browser.type',
  'browser.select_option',
  'browser.press_key',
  'browser.open_tab',
  'browser.activate_tab',
  'browser.close_tab',
  'browser.navigate',
  'browser.history',
  'browser.scroll',
  'browser.acquire_file'
])

// 这三个工具在扩展里由服务端托管确认流程，显式 requiresConfirmation:false 才放行。
const SERVER_MANAGED_FILE_CONFIRMATION = new Set([
  'browser.acquire_file',
  'browser.capture_content',
  'artifact.upload'
])

const randomId = (prefix) =>
  `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`

const createTaskId = () => randomId('browser_task')
const createWakeNonce = () => randomId('wake')
const createToolCallId = () => randomId('browser_call')
const createSessionId = () => randomId('socket_session')
const createDeviceId = () => randomId('browser')

const TASK_ID_PATTERN = /^browser_task_[A-Za-z0-9_-]+$/
const DEVICE_ID_PATTERN = /^browser_[A-Za-z0-9_-]+$/
const WAKE_NONCE_PATTERN = /^wake_[A-Za-z0-9_-]+$/

const isBareOrigin = (origin) => {
  try {
    const parsed = new URL(origin)
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin
  } catch (error) {
    return false
  }
}

const normalizeOrigins = (origins) => {
  const list = Array.isArray(origins) ? origins : String(origins || '').split(',')
  return list.map((item) => String(item || '').trim()).filter(Boolean)
}

// 校验一条即将发出的 browser.tool_call，返回规范化后的对象。
const buildToolCall = ({ taskId, deviceId, toolCallId, sequence, capability, input, policy = {} }) => {
  if (!CAPABILITIES.includes(capability)) throw new Error(`CAPABILITY_NOT_SUPPORTED: ${capability}`)
  if (!input || typeof input !== 'object') throw new Error('BROWSER_AGENT_INPUT_INVALID: input 必须是对象')

  const allowedOrigins = normalizeOrigins(policy.allowedOrigins)
  if (!allowedOrigins.length) throw new Error('BROWSER_AGENT_POLICY_INVALID: 缺少 allowedOrigins')
  const badOrigin = allowedOrigins.find((origin) => !isBareOrigin(origin))
  if (badOrigin) {
    throw new Error(`BROWSER_AGENT_POLICY_INVALID: "${badOrigin}" 必须是裸 origin，例如 https://lpt.liepin.com`)
  }

  const riskLevel = policy.riskLevel || (MUTATION_CAPABILITIES.has(capability) ? 'browser_mutation' : 'read')
  if (!RISK_LEVELS.includes(riskLevel)) throw new Error(`BROWSER_AGENT_POLICY_INVALID: riskLevel=${riskLevel}`)
  if (MUTATION_CAPABILITIES.has(capability) && riskLevel === 'read') {
    throw new Error(`BROWSER_AGENT_POLICY_INVALID: ${capability} 不能声明为 read`)
  }

  const requiresConfirmation = policy.requiresConfirmation === true
  const confirmationId = requiresConfirmation ? policy.confirmationId || randomId('confirm') : null
  const fileConfirmationDisabled =
    SERVER_MANAGED_FILE_CONFIRMATION.has(capability) && policy.requiresConfirmation === false
  if (riskLevel === 'business_write' && !requiresConfirmation && !fileConfirmationDisabled) {
    throw new Error('CONFIRMATION_REQUIRED: business_write 需要 requiresConfirmation:true，或用文件工具显式关闭')
  }

  const normalizedPolicy = {
    allowedOrigins,
    riskLevel,
    requiresConfirmation,
    confirmationId,
    maxWrites: Number.isInteger(policy.maxWrites) ? policy.maxWrites : null,
    minWriteIntervalMs: Number.isFinite(policy.minWriteIntervalMs) ? policy.minWriteIntervalMs : 0
  }

  // execute_actions 会走批量校验，maxWrites 必填且范围固定。
  if (capability === 'browser.execute_actions') {
    if (!Number.isInteger(normalizedPolicy.maxWrites) || normalizedPolicy.maxWrites < 1 || normalizedPolicy.maxWrites > 1000) {
      throw new Error('BROWSER_AGENT_POLICY_INVALID: execute_actions 需要 maxWrites(1-1000)')
    }
    if (normalizedPolicy.minWriteIntervalMs < 0 || normalizedPolicy.minWriteIntervalMs > 600000) {
      throw new Error('BROWSER_AGENT_POLICY_INVALID: minWriteIntervalMs 需在 0-600000')
    }
  }

  const issuedAt = new Date()
  const expiresAt = new Date(Math.min(issuedAt.getTime() + 60 * 1000, issuedAt.getTime() + MAX_COMMAND_TTL_MS))

  return {
    event: 'browser.tool_call',
    protocolVersion: PROTOCOL_VERSION,
    taskId,
    toolCallId,
    sequence,
    deviceId,
    capability,
    input,
    policy: normalizedPolicy,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString()
  }
}

module.exports = {
  CAPABILITIES,
  DEVICE_ID_PATTERN,
  MAX_COMMAND_TTL_MS,
  MUTATION_CAPABILITIES,
  PROTOCOL_VERSION,
  RISK_LEVELS,
  TASK_ID_PATTERN,
  WAKE_NONCE_PATTERN,
  buildToolCall,
  createDeviceId,
  createSessionId,
  createTaskId,
  createToolCallId,
  createWakeNonce,
  isBareOrigin,
  normalizeOrigins
}
