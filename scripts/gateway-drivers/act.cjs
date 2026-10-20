#!/usr/bin/env node
'use strict'

// 浏览器 Agent 原子驱动脚本。
//
// 为什么需要它：快照 ref 只有 30 秒有效期（SNAPSHOT_TTL），且必须带上同一次快照的
// snapshotId / documentId。所以「先快照、再点击」不能拆成两次命令，否则很容易过期。
// 这里把快照和操作放在同一个进程里完成。
//
//   node scripts/gateway-drivers/act.cjs text  <tabId> [chars]
//   node scripts/gateway-drivers/act.cjs find  <tabId> <query...>
//   node scripts/gateway-drivers/act.cjs click <tabId> <query...>
//   node scripts/gateway-drivers/act.cjs type  <tabId> <query...> --text=要输入的内容
//   node scripts/gateway-drivers/act.cjs press <tabId> <key>
//   node scripts/gateway-drivers/act.cjs scroll <tabId> <deltaY>
//   node scripts/gateway-drivers/act.cjs call  <capability> [json]     # 直接透传，不做快照
//
// 可选： --origins=a,b   --risk=read|browser_mutation|business_write

const PORT = require('../../browser-agent-gateway/config.cjs').port()
const BASE = `http://127.0.0.1:${PORT}`

// 按需拉起网关并等扩展连上（网关空闲会自动退出，所以每次动作前都先 ensure）。
// ensure.js 位于当前插件的 browser-agent-gateway 目录；找不到就跳过，让后面的调用自己报错。
const path = require('path')
const fs = require('fs')
const ENSURE_PATH = process.env.BROWSER_AGENT_ENSURE || path.resolve(__dirname, '../../browser-agent-gateway/ensure.js')

const ensureReady = () => {
  if (process.env.BROWSER_AGENT_NO_ENSURE) return
  if (!fs.existsSync(ENSURE_PATH)) return
  const { spawnSync } = require('child_process')
  const result = spawnSync(process.execPath, [ENSURE_PATH, `--port=${PORT}`, '--quiet'], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('网关或扩展未就绪')
}

const DEFAULT_ORIGINS = [
  'https://lpt.liepin.com',
  'https://www.liepin.com',
  'https://c.liepin.com',
  'https://passport.liepin.com',
  'https://safe.liepin.com',
  'http://127.0.0.1:5030'
]

const argv = process.argv.slice(2)
const flags = {}
const positional = []
for (const arg of argv) {
  if (arg.startsWith('--')) {
    const [key, ...rest] = arg.slice(2).split('=')
    flags[key] = rest.length ? rest.join('=') : true
  } else {
    positional.push(arg)
  }
}

const ORIGINS = flags.origins ? String(flags.origins).split(',') : DEFAULT_ORIGINS

const die = (message, detail) => {
  console.error(JSON.stringify({ ok: false, error: message, detail }, null, 2))
  process.exit(1)
}

const call = async (capability, input, extra = {}) => {
  let response
  try {
    response = await fetch(`${BASE}/api/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capability,
        input,
        policy: { allowedOrigins: ORIGINS, ...(extra.risk ? { riskLevel: extra.risk } : {}) },
        timeoutMs: extra.timeoutMs || 60000
      })
    })
  } catch (error) {
    die(`无法连接网关 ${BASE}（${error.message}）`)
  }
  const body = await response.json()
  if (!body.ok) die(body.error?.code || 'CALL_FAILED', body.error?.message)
  const output = body.data.output
  if (body.data.status !== 'succeeded') die('TOOL_FAILED', body.data.error)
  return output
}

const ACTION_ROLES = new Set(['button', 'link', 'tab', 'combobox', 'radio', 'checkbox', 'menuitem', 'option', 'switch'])
const INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox'])

const score = (item, query, roles) => {
  const name = String(item.name || '').trim()
  if (!name) return -1
  let base = 0
  if (name === query) base = 100
  else if (name.startsWith(query)) base = 60
  else if (name.includes(query)) base = 30
  else return -1
  if (roles && roles.has(item.role)) base += 15
  return base
}

const pick = (items, query, roles, near) => {
  const candidates = items
    .map((item) => ({ item, value: score(item, query, roles) }))
    .filter((entry) => entry.value > 0)
  if (!candidates.length) return null
  if (!near) {
    candidates.sort((a, b) => b.value - a.value)
    return candidates[0].item
  }
  // --near=x,y：同名元素有多个时（例如两行都叫「其他」），取离该坐标最近的。
  const [nx, ny] = near
  let best = null
  let bestDistance = Infinity
  for (const { item } of candidates) {
    const bounds = item.bounds || {}
    const cx = (bounds.x || 0) + (bounds.width || 0) / 2
    const cy = (bounds.y || 0) + (bounds.height || 0) / 2
    const distance = Math.hypot(cx - nx, cy - ny)
    if (distance < bestDistance) {
      bestDistance = distance
      best = item
    }
  }
  return best
}

const parseNear = () => {
  if (!flags.near) return null
  const [x, y] = String(flags.near).split(',').map(Number)
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
}

const snapshot = (tabId) =>
  call('browser.snapshot', { tabId: Number(tabId), includeText: true }, { timeoutMs: 30000 })

const describe = (item) =>
  `${item.ref}\t${item.role}\t${(item.name || '').slice(0, 60)}\t@${item.bounds?.x},${item.bounds?.y}`

const main = async () => {
  const [command, tabArg, ...rest] = positional
  const tabId = Number(tabArg)
  if (command) ensureReady()

  switch (command) {
    case 'text': {
      const out = await snapshot(tabId)
      console.log(`URL: ${out.url}\nTITLE: ${out.title}\nitems: ${out.items.length}\n`)
      console.log((out.text || '').slice(0, Number(rest[0] || 3000)))
      return
    }

    case 'find': {
      const query = rest.join(' ')
      const out = await snapshot(tabId)
      const matches = out.items
        .map((item) => ({ item, value: score(item, query, null) }))
        .filter((entry) => entry.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, Number(flags.limit || 25))
      console.log(`命中 ${matches.length} 个：`)
      matches.forEach((entry) => console.log(describe(entry.item)))
      return
    }

    case 'click': {
      const query = rest.join(' ')
      const out = await snapshot(tabId)
      const target = pick(out.items, query, ACTION_ROLES, parseNear())
      if (!target) die(`ELEMENT_NOT_FOUND: 快照里没有匹配「${query}」的可点击元素`)
      const result = await call('browser.click', {
        tabId,
        snapshotId: out.snapshotId,
        documentId: out.documentId,
        ref: target.ref
      }, { risk: flags.risk || 'browser_mutation' })
      console.log(JSON.stringify({ clicked: target.name, ref: target.ref, result }, null, 2))
      return
    }

    case 'type': {
      const query = rest.join(' ')
      const text = flags.text
      if (!text) die('缺少 --text=要输入的内容')
      const out = await snapshot(tabId)
      const target = pick(out.items, query, INPUT_ROLES, parseNear())
      if (!target) die(`ELEMENT_NOT_FOUND: 快照里没有匹配「${query}」的输入框`)
      const result = await call('browser.type', {
        tabId,
        snapshotId: out.snapshotId,
        documentId: out.documentId,
        ref: target.ref,
        text,
        clear: true
      }, { risk: flags.risk || 'browser_mutation' })
      console.log(JSON.stringify({ typed: text, into: target.name, ref: target.ref, result }, null, 2))
      return
    }

    case 'press': {
      const key = rest.join(' ')
      const out = await call('browser.press_key', { tabId, key }, { risk: flags.risk || 'browser_mutation' })
      console.log(JSON.stringify(out, null, 2))
      return
    }

    case 'scroll': {
      const out = await call('browser.scroll', { tabId, deltaY: Number(rest[0] || 800) }, { risk: flags.risk || 'browser_mutation' })
      console.log(JSON.stringify(out, null, 2))
      return
    }

    case 'call': {
      const capability = tabArg
      let input = {}
      if (rest[0]) {
        try {
          input = JSON.parse(rest[0])
        } catch (error) {
          die(`input 不是合法 JSON：${error.message}`)
        }
      }
      const out = await call(capability, input, { risk: flags.risk })
      console.log(JSON.stringify(out, null, 2))
      return
    }

    default:
      console.log(`用法：
  node scripts/gateway-drivers/act.cjs text  <tabId> [chars]
  node scripts/gateway-drivers/act.cjs find  <tabId> <query>
  node scripts/gateway-drivers/act.cjs click <tabId> <query>
  node scripts/gateway-drivers/act.cjs type  <tabId> <query> --text=内容
  node scripts/gateway-drivers/act.cjs press <tabId> <key>
  node scripts/gateway-drivers/act.cjs scroll <tabId> <deltaY>
  node scripts/gateway-drivers/act.cjs call  <capability> [json]`)
  }
}

main().catch((error) => die(error.message))
