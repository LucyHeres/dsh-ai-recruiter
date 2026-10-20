import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserClient, unwrapToolResult } from '../dist/lib/browser-client.js'
import { GreetingExecutor, createGreetingJob } from '../dist/lib/greeting-executor.js'
import { Store } from '../dist/lib/store.js'
import { DeveloperLog } from '../dist/lib/developer-log.js'

test('real MCP transport reproduces equal-deadline race; startup can receive plugin timeout and reach model without replay', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'recruit-wait-gateway-'))
  const requests = [], origin = 'https://lpt.liepin.com'
  const server = createServer(async (req, res) => {
    const respond = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.url === '/api/status') { respond({ ok: true, data: { ready: true } }); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const internalMs = body.input.condition.timeoutMs ?? body.input.timeoutMs
    // Model the two actual budgets, including a small result serialization/transport delay.
    const outer = setTimeout(() => respond({ ok: false, error: { code: 'TOOL_CALL_OUTCOME_UNKNOWN', message: 'browser.wait result not received' } }), body.timeoutMs)
    const inner = setTimeout(() => respond({ ok: true, data: { status: 'succeeded', output: {
      conditionMet: false, timeout: true, timeoutSource: 'plugin', waitedMs: internalMs,
    } } }), internalMs + 40)
    res.on('close', () => { clearTimeout(outer); clearTimeout(inner) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = new BrowserClient({ command: process.execPath,
    args: [fileURLToPath(new URL('../browser-agent-gateway/mcp-server.js', import.meta.url))],
    env: { BROWSER_AGENT_GATEWAY_PORT: String(server.address().port), XINZHAO_GATEWAY_CONFIG: join(root, 'absent-pairing.json') } })
  try {
    await assert.rejects(async () => unwrapToolResult(await browser.call('browser_wait', {
      tabId: 1, condition: { type: 'dom_quiet' }, timeoutMs: 2000,
    })), error => error.code === 'TOOL_CALL_OUTCOME_UNKNOWN')
    let navigated = false, decisions = 0, writes = 0
    const store = new Store(root, 'isolated-test'); await store.init()
    const logger = new DeveloperLog(store.root)
    const job = createGreetingJob({ id: randomUUID(), platform: 'liepin', limit: 1, confirmed: true })
    const executor = new GreetingExecutor(store, async (tool, args) => {
      if (tool === 'browser_list_tabs') return { tabs: [{ tabId: 1, url: `${origin}/${navigated ? 'recommend' : 'other'}` }] }
      if (tool === 'browser_navigate') { navigated = true; return {} }
      if (tool === 'browser_wait') return unwrapToolResult(await browser.call(tool, args))
      if (tool === 'browser_list_frames') return { frames: [] }
      if (tool === 'browser_snapshot') return { snapshotId: 's', documentId: 'doc', url: `${origin}/recommend`, items: [] }
      if (tool === 'browser_click') writes++
      return {}
    }, async () => {}, () => ({ decide: async () => { decisions++; return { action: 'stop', reason: '仅测试等待，不操作候选人' } } }), logger)
    await executor.run(job, new AbortController().signal)
    assert.equal(job.status, 'stopped', job.detail)
    assert.equal(decisions, 1); assert.equal(writes, 0)
    assert.equal(requests.length, 2, 'one reproduction and one startup read; no automatic replay')
    assert.equal(requests[1].input.condition.timeoutMs, 2000)
    assert.equal(requests[1].timeoutMs, 5000)
    await logger.flush()
    const rows = (await logger.read(undefined, 1000)).lines.map(line => JSON.parse(line))
    assert.equal(rows.find(row => row.event === 'greeting.page_readiness')?.timeout, true)
  } finally {
    browser.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
