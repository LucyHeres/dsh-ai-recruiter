'use strict'

// 薪招 Browser Agent 本地网关。
//
// 作用：让 DSH（或任何本地 agent）能够驱动薪招扩展，而不必接薪灵后端。
// 它实现的是 docs/薪灵浏览器Agent基于Manus方案独立开发说明.md 第 7 节的 WSS 协议，
// 另加一个 HTTP 接口给本地调用方，以及一个唤醒页给扩展的 content script 投递唤醒消息。
//
// 零依赖：WebSocket 服务端自带（ws-server.js）。
//
// 启动： node browser-agent-gateway/gateway.js [--port=5030]

const http = require('http')
const fs = require('fs')
const path = require('path')
const { WebSocketConnection, handleUpgrade } = require('./ws-server')
const {
  DEVICE_ID_PATTERN,
  PROTOCOL_VERSION,
  TASK_ID_PATTERN,
  WAKE_NONCE_PATTERN,
  buildToolCall,
  createDeviceId,
  createSessionId,
  createTaskId,
  createToolCallId,
  createWakeNonce
} = require('./protocol')

const DEFAULT_PORT = 5030
const HEARTBEAT_INTERVAL_MS = 20000
const IDLE_TIMEOUT_MS = 120000
const WAKE_TTL_MS = 2 * 60 * 1000
const DEFAULT_CALL_TIMEOUT_MS = 60000

// ---------------------------------------------------------------- 配置

const { configurationPath, port, requirePairing } = require('./config.cjs')
const LOCAL_CONFIG_PATH = configurationPath()
const localProfile = requirePairing()
const DEVICE_TOKEN = localProfile.deviceToken
const LOCAL_DEVICE_ID = localProfile.deviceId
const LOCAL_TASK_ID = localProfile.taskId
const argPort = process.argv.find(arg => arg.startsWith('--port='))
const PORT = Number(argPort ? argPort.slice(7) : port())

// 空闲自动退出：默认 15 分钟内没有任何 agent 调用就自己退出，避免常驻。
// 注意只统计 /api/call 与 /api/bootstrap —— /api/status、/api/log 会被唤醒页
// 每秒轮询，拿它们当活跃信号的话网关永远退不出去。传 0 可关闭（改为常驻）。
const DEFAULT_IDLE_EXIT_MS = 15 * 60 * 1000
const argIdle = process.argv.find((arg) => arg.startsWith('--idle-exit-ms='))
const IDLE_EXIT_MS = (() => {
  const raw = argIdle ? argIdle.split('=')[1] : process.env.BROWSER_AGENT_GATEWAY_IDLE_EXIT_MS
  if (raw === undefined || raw === null || raw === '') return DEFAULT_IDLE_EXIT_MS
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_IDLE_EXIT_MS
})()

// ---------------------------------------------------------------- 会话状态

const session = {
  state: 'idle', // idle | awaiting_ws | authenticating | claimed | closed
  task: null, // { taskId, deviceId, wakeNonce, expiresAt }
  socket: null,
  socketSessionId: null,
  authenticatedDeviceId: null,
  sequence: 0,
  pending: null, // { toolCallId, capability, resolve, reject, timer }
  queue: [],
  lastError: null,
  receivedCallIds: new Set(),
  // 最近一次"真正的 agent 调用"时间，用于空闲自动退出。
  lastAgentCallAt: Date.now(),
  lifecycle: false,
  workflow: null,
  requiresBegin: false,
  control: null,
  beginning: null,
  executionOwner: null,
  log: []
}

const record = (message) => {
  const line = `${new Date().toISOString()} ${message}`
  session.log.push(line)
  if (session.log.length > 200) session.log.shift()
  process.stdout.write(`[gateway] ${message}\n`)
}

const resetSession = (reason) => {
  if (session.workflow) session.requiresBegin = true
  if (session.control) {
    clearTimeout(session.control.timer)
    session.control.reject(new Error(`SESSION_RESET: ${reason}`))
  }
  session.control = null
  session.workflow = null
  session.lifecycle = false
  session.executionOwner = null
  if (session.pending) {
    clearTimeout(session.pending.timer)
    session.pending.reject(new Error(`SESSION_RESET: ${reason}`))
    session.pending = null
  }
  for (const item of session.queue) item.reject(new Error(`SESSION_RESET: ${reason}`))
  session.queue = []
  session.socket = null
  session.socketSessionId = null
  session.authenticatedDeviceId = null
  session.sequence = 0
  session.receivedCallIds = new Set()
  session.state = 'idle'
  session.task = null
}

const statusPayload = () => ({
  state: session.state,
  connected: Boolean(session.socket && !session.socket.closed),
  authenticated: Boolean(session.authenticatedDeviceId),
  ready: session.state === 'claimed' && Boolean(session.authenticatedDeviceId),
  available: session.state === 'claimed' && !session.requiresBegin && session.executionOwner !== 'remote',
  executionOwner: session.executionOwner,
  workflowTaskId: session.workflow,
  requiresBegin: session.requiresBegin,
  taskLifecycle: session.lifecycle,
  deviceId: session.authenticatedDeviceId || session.task?.deviceId || null,
  taskId: session.task?.taskId || null,
  wakeNonce: session.task?.wakeNonce || null,
  sequence: session.sequence,
  queueLength: session.queue.length,
  busy: Boolean(session.pending),
  lastError: session.lastError,
  idleExitMs: IDLE_EXIT_MS,
  idleExitAt: IDLE_EXIT_MS > 0 ? new Date(session.lastAgentCallAt + IDLE_EXIT_MS).toISOString() : null
})

// ---------------------------------------------------------------- 工具调用

// Local task lifetime is separate from the transport claim. The extension owns
// the authoritative execution lock; a connected socket alone grants no browser access.
const controlTask = (event, taskId) => new Promise((resolve, reject) => {
  if (!session.socket || session.socket.closed || session.state !== 'claimed') return reject(new Error('BROWSER_AGENT_NOT_READY'))
  if (session.control) return reject(new Error('BROWSER_AGENT_BUSY'))
  const requestId = createToolCallId()
  const socket = session.socket
  const timer = setTimeout(() => {
    if (session.control?.requestId !== requestId) return
    session.control = null
    reject(new Error('BROWSER_AGENT_TASK_CONTROL_TIMEOUT'))
    // The lock outcome is unknown: don't send more commands on this connection.
    socket.close(1000, 'task control timeout')
  }, 10000)
  session.control = { requestId, event, taskId, resolve, reject, timer }
  socket.sendJson({ event, requestId, taskId })
})

const beginTask = (explicit = false) => {
  if (session.control?.event === 'local.task.end') return Promise.reject(new Error('BROWSER_AGENT_BUSY'))
  if (session.workflow) return Promise.resolve(session.workflow)
  if (session.beginning) return session.beginning
  if (session.state !== 'claimed') return Promise.reject(new Error('BROWSER_AGENT_NOT_READY'))
  if (session.requiresBegin && !explicit) return Promise.reject(new Error('BROWSER_AGENT_TASK_EXPIRED: 上个任务已结束或连接中断，请显式 begin 新任务；不要自动重放之前的操作'))
  if (!session.lifecycle) return Promise.resolve(session.task.taskId)
  const taskId = createTaskId()
  const operation = controlTask('local.task.begin', taskId).then(() => {
    session.workflow = taskId
    session.task.taskId = taskId
    session.sequence = 0
    session.requiresBegin = false
    return taskId
  }).finally(() => { if (session.beginning === operation) session.beginning = null })
  session.beginning = operation
  return operation
}

const finishTask = async () => {
  if (session.pending || session.queue.length || session.beginning || session.control) throw new Error('BROWSER_AGENT_BUSY')
  if (!session.lifecycle) {
    const socket = session.socket
    socket?.sendJson({ event: 'task.finished', taskId: session.task?.taskId })
    socket?.close(1000, 'finished')
    resetSession('任务结束')
  } else if (session.workflow) {
    await controlTask('local.task.end', session.workflow)
    session.workflow = null
  }
  session.requiresBegin = false
}

const MAX_QUEUE = 64

const enqueueToolCall = (request) =>
  new Promise((resolve, reject) => {
    if (!session.socket || session.socket.closed) {
      reject(new Error('BROWSER_AGENT_NOT_CONNECTED: 扩展尚未连接，请先打开 /wake 唤醒'))
      return
    }
    if (session.state !== 'claimed') {
      reject(new Error(`BROWSER_AGENT_NOT_READY: 会话状态为 ${session.state}`))
      return
    }
    if (session.queue.length >= MAX_QUEUE) {
      reject(new Error('BROWSER_AGENT_QUEUE_FULL'))
      return
    }
    session.queue.push({ request, resolve, reject })
    pumpQueue()
  })

const pumpQueue = () => {
  if (session.pending || !session.queue.length) return
  const item = session.queue.shift()
  const task = session.task
  if (!task || !session.socket || session.socket.closed) {
    item.reject(new Error('BROWSER_AGENT_NOT_CONNECTED'))
    return
  }

  let command
  try {
    session.sequence += 1
    command = buildToolCall({
      taskId: task.taskId,
      deviceId: task.deviceId,
      toolCallId: createToolCallId(),
      sequence: session.sequence,
      capability: item.request.capability,
      input: item.request.input || {},
      policy: item.request.policy || {}
    })
  } catch (error) {
    session.sequence -= 1
    item.reject(error)
    queueMicrotask(pumpQueue)
    return
  }

  const timeoutMs = Number(item.request.timeoutMs) > 0 ? Number(item.request.timeoutMs) : DEFAULT_CALL_TIMEOUT_MS
  const timer = setTimeout(() => {
    if (session.pending?.toolCallId !== command.toolCallId) return
    session.pending = null
    item.reject(new Error(`TOOL_CALL_OUTCOME_UNKNOWN: ${command.capability} 超过 ${timeoutMs}ms 未返回结果，不要自动重放`))
    session.requiresBegin = true
    session.socket?.close(1000, 'tool outcome unknown')
  }, timeoutMs)
  timer.unref?.()

  session.pending = {
    toolCallId: command.toolCallId,
    capability: command.capability,
    resolve: item.resolve,
    reject: item.reject,
    timer
  }

  record(`-> ${command.capability} #${command.sequence} ${command.toolCallId}`)
  session.socket.sendJson(command)
}

const settlePending = (toolCallId, error, value) => {
  const pending = session.pending
  if (!pending || pending.toolCallId !== toolCallId) return false
  clearTimeout(pending.timer)
  session.pending = null
  if (error) pending.reject(error)
  else pending.resolve(value)
  queueMicrotask(pumpQueue)
  return true
}

// ---------------------------------------------------------------- WS 报文处理

// 认证失败后这条连接没有再继续的意义（扩展侧也会主动断开），
// 主动关闭可以让调用方立刻重试，而不是占着连接等到超时。
const rejectAuth = (socket, code, detail) => {
  session.lastError = code
  if (detail) record(`!! ${detail}`)
  socket.sendJson({ event: 'agent.auth_failed', error: { code } })
  setTimeout(() => socket.close(1008, code), 50).unref?.()
}

const onMessage = (raw) => {
  let message
  try {
    message = JSON.parse(raw)
  } catch (error) {
    record(`!! 收到非 JSON 报文，长度 ${raw.length}`)
    return
  }

  // 扩展发的认证报文【不带 event 字段】（文档 §7.2 写的是 agent.authenticate，实现里没有），
  // 只能靠 deviceToken 的存在识别。这里补上事件名，让下面的 switch 统一处理。
  if (!message.event && !message.type && message.deviceToken) message.event = 'agent.authenticate'
  const eventName = message.event || message.type || ''

  const socket = session.socket
  if (!socket) return

  switch (eventName) {
    case 'agent.authenticate': {
      const task = session.task
      // 有预建任务（页面唤醒流程）时严格比对 deviceId；
      // 没有任务时说明扩展走的是自动连接，任务由它在 task.claim 时自行声明，
      // 这里只校验 deviceId 的形状。真正的门禁是 deviceToken + 只监听 127.0.0.1。
      if (task) {
        if (message.deviceId !== task.deviceId) {
          return rejectAuth(socket, 'TASK_DEVICE_MISMATCH', `设备不匹配：期望 ${task.deviceId}，收到 ${message.deviceId}`)
        }
      } else if (!DEVICE_ID_PATTERN.test(String(message.deviceId || ''))) {
        return rejectAuth(socket, 'BROWSER_AGENT_DEVICE_ID_INVALID', `deviceId 形状非法：${message.deviceId}`)
      }
      if (DEVICE_TOKEN && message.deviceToken !== DEVICE_TOKEN) {
        return rejectAuth(socket, 'BROWSER_AGENT_TOKEN_INVALID', 'deviceToken 不匹配（检查 本机配对配置）')
      }
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        return rejectAuth(socket, 'BROWSER_AGENT_PROTOCOL_UNSUPPORTED', `协议版本 ${message.protocolVersion}`)
      }

      session.lifecycle = Array.isArray(message.extensionFeatures) && message.extensionFeatures.includes('local.task.lifecycle')
      session.authenticatedDeviceId = message.deviceId
      session.socketSessionId = createSessionId()
      session.state = 'authenticating'
      record(`<- agent.authenticate deviceId=${message.deviceId} extension=${message.extensionVersion || '?'}`)
      socket.sendJson({
        event: 'agent.authenticated',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: session.socketSessionId,
        deviceId: message.deviceId,
        serverTime: new Date().toISOString(),
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        idleTimeoutMs: IDLE_TIMEOUT_MS
      })
      return
    }

    case 'task.claim': {
      const claimedTaskId = String(message.taskId || message.trigger?.taskId || '')
      if (!TASK_ID_PATTERN.test(claimedTaskId)) {
        socket.sendJson({ event: 'task.claim.ack', accepted: false, error: { code: 'BROWSER_AGENT_ID_MISMATCH' } })
        return
      }
      // 扩展自动连接时没走 /api/bootstrap，任务由它在 claim 阶段自行声明。
      // 页面唤醒流程仍然先建任务，走下面的严格比对。
      if (!session.task) {
        session.task = {
          taskId: claimedTaskId,
          deviceId: session.authenticatedDeviceId || message.deviceId,
          wakeNonce: String(message.wakeNonce || ''),
          expiresAt: new Date(Date.now() + WAKE_TTL_MS).toISOString(),
          origin: 'client-declared'
        }
        record(`扩展自建任务 ${session.task.taskId} (device ${session.task.deviceId})`)
      }
      if (claimedTaskId !== session.task.taskId) {
        socket.sendJson({ event: 'task.claim.ack', accepted: false, error: { code: 'BROWSER_AGENT_ID_MISMATCH' } })
        return
      }
      // 这里只校验 wakeNonce 的形状，不强制与建任务时的 nonce 相等。
      // 原因：wakeNonce 的一次性语义由扩展在页面唤醒阶段自行校验
      // （validateBrowserAgentWake），网关再比对一次会造成死锁——
      // 页面 bootstrap 建的任务带随机 nonce，而扩展自动重连带的是固定 nonce，
      // 两者永不相等；页面又因为已有 taskId 不再唤醒，于是一直锁死。
      // 真正的门禁是 deviceToken + 只监听 127.0.0.1 + taskId 一致。
      if (message.wakeNonce && !WAKE_NONCE_PATTERN.test(String(message.wakeNonce))) {
        socket.sendJson({ event: 'task.claim.ack', accepted: false, error: { code: 'BROWSER_AGENT_WAKE_NONCE_INVALID' } })
        return
      }
      session.state = 'claimed'
      record(`<- task.claim ${session.task.taskId}`)
      socket.sendJson({
        event: 'task.claim.ack',
        accepted: true,
        taskId: session.task.taskId,
        status: 'running',
        leaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
      })
      queueMicrotask(pumpQueue)
      return
    }

    case 'local.task.begin.ack':
    case 'local.task.end.ack': {
      const control = session.control
      if (!control || message.requestId !== control.requestId || message.taskId !== control.taskId || eventName !== control.event + '.ack') return
      clearTimeout(control.timer)
      session.control = null
      if (message.accepted) control.resolve()
      else control.reject(new Error(message.error?.code || 'BROWSER_AGENT_TASK_REJECTED'))
      return
    }
    case 'local.execution.status':
      session.executionOwner = message.owner || null
      return
    case 'local.task.expired':
      if (message.taskId === session.workflow) {
        session.workflow = null
        session.requiresBegin = true
        session.executionOwner = null
      }
      return

    case 'browser.tool_received': {
      if (session.pending && session.pending.toolCallId === message.toolCallId) {
        session.receivedCallIds.add(message.toolCallId)
      }
      return
    }

    case 'browser.tool_result': {
      const pending = session.pending
      if (!pending || pending.toolCallId !== message.toolCallId) {
        // 重投的旧结果也要 ack，避免扩展卡在等 ack 上。
        socket.sendJson({ event: 'browser.tool_result.ack', taskId: session.task?.taskId, toolCallId: message.toolCallId, accepted: true })
        return
      }
      socket.sendJson({
        event: 'browser.tool_result.ack',
        taskId: session.task?.taskId,
        toolCallId: message.toolCallId,
        accepted: true
      })
      const failed = message.status !== 'succeeded'
      record(`<- ${pending.capability} ${failed ? 'FAILED' : 'ok'} ${message.toolCallId}${failed ? ` ${message.error?.code || ''}` : ''}`)
      settlePending(
        message.toolCallId,
        failed ? Object.assign(new Error(`${message.error?.code || 'TOOL_FAILED'}: ${message.error?.message || ''}`.trim()), { result: message }) : null,
        { status: message.status, output: message.output, verification: message.verification, error: message.error, startedAt: message.startedAt, completedAt: message.completedAt }
      )
      return
    }

    case 'agent.ping': {
      socket.sendJson({ event: 'agent.pong', serverTime: new Date().toISOString() })
      return
    }

    case 'agent.pong':
      return

    // 扩展在领取任务后上报自身状态，无需回复。
    case 'agent.status':
      record(`<- agent.status state=${message.state}${message.currentToolCallId ? ` tool=${message.currentToolCallId}` : ''}`)
      return

    case 'task.cancel':
    case 'task.finished':
      record(`<- ${eventName}`)
      return

    default:
      record(`<- 未知事件 ${JSON.stringify(eventName)}: ${raw.slice(0, 300)}`)
  }
}

const onConnection = (connection) => {
  if (session.socket && !session.socket.closed) {
    record('!! 已有连接，拒绝新的连接')
    connection.close(1008, 'another session active')
    return
  }
  session.socket = connection
  session.state = 'authenticating'
  record('WS 已连接，等待 agent.authenticate')

  connection.on('message', raw => { if (session.socket === connection) onMessage(raw) })
  connection.on('error', (error) => record(`WS 错误：${error.message}`))
  connection.on('close', () => {
    // 旧连接的关闭事件可能晚于新会话建立（例如重新唤醒时），
    // 这里必须确认关闭的就是当前会话的连接，否则会把新任务一起清掉。
    if (session.socket !== connection) {
      record('旧连接关闭，忽略')
      return
    }
    record('WS 已断开')
    if (session.pending) settlePending(session.pending.toolCallId, new Error('BROWSER_AGENT_DISCONNECTED: 连接已断开'))
    resetSession('连接断开')
  })
}

// ---------------------------------------------------------------- 唤醒页

const WAKE_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>薪招 Browser Agent · 本地网关</title>
<style>
  body { font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; background: #f6f7f9; color: #1f2329; }
  .card { max-width: 760px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 2px 12px rgba(0,0,0,.06); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8a9099; font-size: 13px; margin-bottom: 20px; }
  .state { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; background: #eef0f3; }
  .state.ok { background: #e6f4ea; color: #1a7f37; }
  .state.warn { background: #fff4e5; color: #b25e00; }
  .state.err { background: #fdecea; color: #b3261e; }
  button { font-size: 14px; padding: 8px 16px; border-radius: 8px; border: 1px solid #d0d5dd; background: #fff; cursor: pointer; }
  button.primary { background: #1664ff; border-color: #1664ff; color: #fff; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  dl { display: grid; grid-template-columns: 120px 1fr; gap: 6px 12px; margin: 18px 0; }
  dt { color: #8a9099; }
  dd { margin: 0; font-family: ui-monospace, Menlo, monospace; font-size: 12px; word-break: break-all; }
  pre { background: #0f1115; color: #d6deeb; padding: 14px; border-radius: 8px; max-height: 260px; overflow: auto; font-size: 12px; }
  .tip { font-size: 13px; color: #5c6470; background: #f6f7f9; border-radius: 8px; padding: 12px 14px; margin-top: 16px; }
</style>
</head>
<body>
<div class="card">
  <h1>薪招 Browser Agent · 本地网关</h1>
  <div class="sub">这个页面用于唤醒薪招扩展并建立本地调试会话。保持它打开即可，扩展会附加到这个标签页。</div>

  <div>状态：<span id="state" class="state">读取中</span></div>

  <dl>
    <dt>taskId</dt><dd id="taskId">-</dd>
    <dt>deviceId</dt><dd id="deviceId">-</dd>
    <dt>已认证设备</dt><dd id="authDevice">-</dd>
    <dt>队列 / 序号</dt><dd id="seq">-</dd>
  </dl>

  <button id="wake" class="primary">唤醒扩展 / 建立会话</button>
  <span id="wakeMsg" class="sub" style="margin-left:10px"></span>

  <div class="tip">若长时间连不上：确认已在 <code>chrome://extensions</code> 加载了新构建的 dist，且 <code>本机配对配置</code> 里的 deviceToken 与网关一致。</div>

  <pre id="log">等待中…</pre>
</div>

<script>
var wakeButton = document.getElementById('wake')
var wakeMsg = document.getElementById('wakeMsg')

function setText(id, value) {
  document.getElementById(id).textContent = value === null || value === undefined ? '-' : String(value)
}

async function bootstrap() {
  var response = await fetch('/api/bootstrap', { method: 'POST' })
  var body = await response.json()
  if (!body.ok) throw new Error(body.error && body.error.message || 'bootstrap failed')
  return body.data
}

function sendWake(data) {
  window.postMessage({
    source: 'cinlyn-page',
    type: 'CINLYN_BROWSER_AGENT_WAKE',
    task_id: data.taskId,
    device_id: data.deviceId,
    wake_nonce: data.wakeNonce,
    expires_at: data.expiresAt
  }, window.location.origin)
}

var waking = false
var lastAutoWakeAt = 0

async function wake() {
  if (waking) return
  waking = true
  wakeButton.disabled = true
  wakeMsg.textContent = '正在唤醒…'
  try {
    var data = await bootstrap()
    setText('taskId', data.taskId)
    setText('deviceId', data.deviceId)
    // 页面必须先发出唤醒消息，扩展收到后才会去连网关。
    sendWake(data)
  } catch (error) {
    wakeMsg.textContent = '唤醒失败：' + error.message
  } finally {
    waking = false
    wakeButton.disabled = false
  }
}

window.addEventListener('message', function (event) {
  if (event.source !== window) return
  var payload = event.data
  if (!payload || payload.type !== 'CINLYN_BROWSER_AGENT_WAKE_RESULT') return
  wakeMsg.textContent = payload.success
    ? '扩展已接受唤醒，正在建立连接…'
    : '扩展拒绝唤醒：' + (payload.error || 'unknown')
})

async function poll() {
  try {
    var body = await fetch('/api/status').then(function (r) { return r.json() })
    var data = body.data
    var el = document.getElementById('state')
    el.textContent = data.state + (data.connected ? ' · 已连接' : ' · 未连接')
    el.className = 'state ' + (data.state === 'claimed' ? 'ok' : (data.connected ? 'warn' : ''))
    setText('authDevice', data.deviceId)
    setText('seq', data.queueLength + ' / ' + data.sequence)
    if (data.lastError) el.className = 'state err'

    // 网关重启或连接掉线后自动重新唤醒，避免每次手动点按钮。
    if (!data.connected && !data.taskId && !waking && Date.now() - lastAutoWakeAt > 2000) {
      lastAutoWakeAt = Date.now()
      wake()
    }
  } catch (error) {
    /* 网关重启中，忽略 */
  }
  try {
    var logBody = await fetch('/api/log').then(function (r) { return r.json() })
    document.getElementById('log').textContent = (logBody.data || []).slice(-60).join('\\n')
  } catch (error) {}
}

wakeButton.addEventListener('click', wake)
poll()
setInterval(poll, 1000)
window.addEventListener('load', wake)
</script>
</body>
</html>`

// ---------------------------------------------------------------- HTTP

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('BODY_TOO_LARGE'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error('BODY_NOT_JSON'))
      }
    })
    request.on('error', reject)
  })

const sendJson = (response, status, payload) => {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  response.end(body)
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`)

  if (url.pathname === '/' || url.pathname === '/wake') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(WAKE_PAGE)
    return
  }

  if (url.pathname === '/api/status') {
    sendJson(response, 200, { ok: true, data: statusPayload() })
    return
  }

  if (url.pathname === '/api/log') {
    sendJson(response, 200, { ok: true, data: session.log.slice(-200) })
    return
  }

  if (url.pathname === '/api/bootstrap') {
    session.lastAgentCallAt = Date.now()
    // 页面唤醒流程：新建一个任务。用配置里的固定身份（如果配了），
    // 这样和扩展的自动连接路径共用同一个 deviceId / taskId，两条路不会打架。
    if (session.socket && !session.socket.closed && session.lifecycle) {
      // Opening the fallback page must not tear down an active workflow.
      sendJson(response, 200, { ok: true, data: { ...session.task, expiresAt: new Date(Date.now() + WAKE_TTL_MS).toISOString() } })
      return
    }
    if (session.socket && !session.socket.closed) session.socket.close(1000, 'rebootstrap')
    resetSession('重新唤醒')
    session.task = {
      taskId: LOCAL_TASK_ID || createTaskId(),
      deviceId: LOCAL_DEVICE_ID || createDeviceId(),
      wakeNonce: createWakeNonce(),
      expiresAt: new Date(Date.now() + WAKE_TTL_MS).toISOString(),
      origin: 'bootstrap'
    }
    session.state = 'awaiting_ws'
    session.lastError = null
    record(`新建任务 ${session.task.taskId} (device ${session.task.deviceId})`)
    sendJson(response, 200, {
      ok: true,
      data: {
        ...session.task,
        gatewayUrl: `ws://127.0.0.1:${PORT}/ws`
      }
    })
    return
  }

  if (url.pathname === '/api/call' && request.method === 'POST') {
    session.lastAgentCallAt = Date.now()
    let body
    try {
      body = await readBody(request)
    } catch (error) {
      sendJson(response, 400, { ok: false, error: { code: error.message } })
      return
    }
    try {
      // Validate before acquiring the browser for a malformed request.
      buildToolCall({ taskId: session.task?.taskId || LOCAL_TASK_ID, deviceId: LOCAL_DEVICE_ID,
        toolCallId: createToolCallId(), sequence: 1, capability: body.capability, input: body.input || {}, policy: body.policy || {} })
      await beginTask()
      const result = await enqueueToolCall({
        capability: body.capability,
        input: body.input,
        policy: body.policy,
        timeoutMs: body.timeoutMs
      })
      sendJson(response, 200, { ok: true, data: result })
    } catch (error) {
      sendJson(response, 200, { ok: false, error: { code: String(error.message).split(':')[0].trim(), message: error.message } })
    }
    return
  }

  if (['/api/begin', '/api/finish'].includes(url.pathname) && request.method === 'POST') {
    session.lastAgentCallAt = Date.now()
    try {
      if (url.pathname === '/api/begin') await beginTask(true)
      else await finishTask()
      sendJson(response, 200, { ok: true, data: statusPayload() })
    } catch (error) {
      sendJson(response, 200, { ok: false, error: { code: error.message.split(':')[0], message: error.message } })
    }
    return
  }

  if (url.pathname === '/api/shutdown' && request.method === 'POST') {
    record('收到 shutdown，网关退出')
    sendJson(response, 200, { ok: true, data: { shuttingDown: true } })
    setTimeout(() => process.exit(0), 50).unref?.()
    return
  }

  sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND' } })
})

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`)
  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }
  handleUpgrade(request, socket, head, onConnection, (s) => s.destroy())
})

// WS 层心跳，顺便回收僵死连接；同时负责空闲自动退出。
const sweepTimer = setInterval(() => {
  if (IDLE_EXIT_MS > 0 && Date.now() - session.lastAgentCallAt > IDLE_EXIT_MS) {
    const idleLabel = IDLE_EXIT_MS >= 60000
      ? `${Math.round(IDLE_EXIT_MS / 60000)} 分钟`
      : `${Math.round(IDLE_EXIT_MS / 1000)} 秒`
    record(`空闲超过 ${idleLabel} 没有任何 agent 调用，网关自动退出`)
    // 先礼貌断开扩展，避免它把一个死连接当成活的。
    try { session.socket?.close(1000, 'gateway idle exit') } catch (error) { /* 忽略 */ }
    setTimeout(() => process.exit(0), 100).unref?.()
    return
  }
  const socket = session.socket
  if (!socket || socket.closed) return
  if (Date.now() - socket.lastActivityAt > IDLE_TIMEOUT_MS) {
    record('空闲超时，断开连接')
    socket.close(1000, 'idle timeout')
    return
  }
  socket.ping()
}, HEARTBEAT_INTERVAL_MS)
sweepTimer.unref?.()

server.listen(PORT, '127.0.0.1', () => {
  require('./connection-notification.cjs').notifyExtension(LOCAL_CONFIG_PATH)
  console.log(`[gateway] 网关已启动`)
  console.log(`[gateway]   唤醒页   http://127.0.0.1:${PORT}/wake`)
  console.log(`[gateway]   WS 端点  ws://127.0.0.1:${PORT}/ws`)
  console.log(`[gateway]   HTTP API http://127.0.0.1:${PORT}/api/status`)
  console.log(`[gateway]   deviceToken ${DEVICE_TOKEN ? '已配置' : '未配置(不校验)'}`)
  console.log(`[gateway]   本地配置 ${fs.existsSync(LOCAL_CONFIG_PATH) ? LOCAL_CONFIG_PATH : '未找到（请先完成本机配对）'}`)
  console.log(`[gateway]   空闲退出 ${IDLE_EXIT_MS > 0 ? `${Math.round(IDLE_EXIT_MS / 60000)} 分钟无 agent 调用后自动退出` : '已关闭（常驻）'}`)
})

module.exports = { server, session }
