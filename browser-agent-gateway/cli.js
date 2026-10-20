#!/usr/bin/env node
'use strict'

// 本地网关的命令行客户端。agent 用它查看状态、下发工具调用、结束会话。
//
//   node cli.js status
//   node cli.js bootstrap
//   node cli.js call browser.snapshot '{"tabId":123}'
//   node cli.js call browser.click '{"ref":"ref_3"}' --risk=browser_mutation
//   node cli.js finish

const DEFAULT_PORT = 5030
const LOCAL_CONFIG_PATH = require('./config.cjs').configurationPath()

// 按需拉起网关并等扩展连上。默认开启；--no-ensure 可跳过（例如只想看状态）。
const ensureGateway = () => {
  if (flags['no-ensure']) return
  const { spawnSync } = require('child_process')
  const result = spawnSync(
    process.execPath,
    [require('path').join(__dirname, 'ensure.js'), `--port=${PORT}`],
    { stdio: 'inherit' }
  )
  if (result.status !== 0) fail('网关或扩展未就绪（ensure 失败）')
}

const readOriginsFromConfig = () => {
  try {
    const config = JSON.parse(require('fs').readFileSync(LOCAL_CONFIG_PATH, 'utf8'))
    return config.allowedOrigins || null
  } catch (error) {
    return null
  }
}

// 猎聘招聘端域名，作为默认白名单；测试页用 127.0.0.1。
const DEFAULT_ORIGINS = readOriginsFromConfig() || [
  'https://lpt.liepin.com',
  'https://www.liepin.com',
  'https://c.liepin.com',
  'https://passport.liepin.com',
  'http://127.0.0.1:5030'
]

const parseArgs = (argv) => {
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
  return { flags, positional }
}

const { flags, positional } = parseArgs(process.argv.slice(2))
const command = positional[0]
const PORT = Number(flags.port || require('./config.cjs').port())
const BASE = `http://127.0.0.1:${PORT}`

const fail = (message, extra) => {
  console.error(JSON.stringify({ ok: false, error: message, ...(extra ? { detail: extra } : {}) }, null, 2))
  process.exit(1)
}

const requestJson = async (pathname, options) => {
  let response
  try {
    response = await fetch(`${BASE}${pathname}`, options)
  } catch (error) {
    fail(`无法连接网关 ${BASE}，请先启动 gateway.js（${error.message}）`)
  }
  const body = await response.json().catch(() => null)
  if (!body) fail(`网关返回了非 JSON 响应（HTTP ${response.status}）`)
  return body
}

const main = async () => {
  switch (command) {
    case 'status': {
      const body = await requestJson('/api/status')
      console.log(JSON.stringify(body, null, 2))
      return
    }

    case 'bootstrap': {
      const body = await requestJson('/api/bootstrap', { method: 'POST' })
      console.log(JSON.stringify(body, null, 2))
      console.log(`\n打开唤醒页完成握手： ${BASE}/wake`)
      return
    }

    case 'log': {
      const body = await requestJson('/api/log')
      console.log((body.data || []).join('\n'))
      return
    }

    case 'begin':
    case 'finish': {
      if (command === 'begin') ensureGateway()
      const body = await requestJson(`/api/${command}`, { method: 'POST' })
      console.log(JSON.stringify(body, null, 2))
      return
    }

    case 'call': {
      const capability = positional[1]
      if (!capability) fail('用法： node cli.js call <capability> [inputJson] [--risk=...] [--origins=a,b]')
      ensureGateway()
      let input = {}
      if (positional[2]) {
        try {
          input = JSON.parse(positional[2])
        } catch (error) {
          fail(`input 不是合法 JSON：${error.message}`)
        }
      }
      const policy = {
        allowedOrigins: flags.origins ? String(flags.origins).split(',') : DEFAULT_ORIGINS
      }
      if (flags.risk) policy.riskLevel = flags.risk
      if (flags['max-writes']) policy.maxWrites = Number(flags['max-writes'])
      if (flags['min-interval-ms']) policy.minWriteIntervalMs = Number(flags['min-interval-ms'])
      if (flags.confirm) policy.requiresConfirmation = true
      if (flags['no-confirm']) policy.requiresConfirmation = false

      const body = await requestJson('/api/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capability,
          input,
          policy,
          timeoutMs: flags.timeout ? Number(flags.timeout) : undefined
        })
      })
      console.log(JSON.stringify(body, null, 2))
      if (!body.ok) process.exit(1)
      return
    }

    case 'ensure': {
      ensureGateway()
      console.log('网关与扩展已就绪')
      return
    }

    case 'shutdown': {
      const body = await requestJson('/api/shutdown', { method: 'POST' })
      console.log(JSON.stringify(body, null, 2))
      return
    }

    default:
      console.log(`薪招 Browser Agent 本地网关 CLI

  status                          查看网关/会话状态（不拉起网关）
  ensure                          按需拉起网关并等扩展连上
  shutdown                        让网关立即退出
  bootstrap                       新建一个任务（然后打开 /wake 走页面唤醒回退路径）
  call <capability> [json]        下发一次工具调用（会自动 ensure）
       --risk=read|browser_mutation|business_write
       --origins=https://a,https://b
       --max-writes=N --min-interval-ms=N
       --confirm | --no-confirm
       --timeout=ms
       --no-ensure
  log                             查看网关日志
  begin                           显式开始新任务（中断或过期后必须使用）
  finish                          结束当前任务并释放浏览器，保留本地连接

网关默认在 15 分钟没有任何 agent 调用后自行退出，所以不需要手动启停。
环境变量 BROWSER_AGENT_GATEWAY_PORT 或 --port= 可改端口（默认 ${DEFAULT_PORT}）。`)
  }
}

main().catch((error) => fail(error.message))
