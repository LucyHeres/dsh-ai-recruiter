// 薪招浏览器网关的最小 MCP stdio 客户端（零依赖）。
//
// 为什么自带客户端而不引 @modelcontextprotocol/sdk：插件只需 tools/call 与
// tools/list 两个方法，且必须能在一个进程里对同一台网关连续发多次调用。
// 网关侧的 mcp-server.js 明确实现「JSON-RPC 2.0 over stdio，按行分隔」，
// 因此这里按同一契约实现即可，不引入额外运行时依赖。
//
// 关键约束（与 xinzhao-browser-control 技能一致）：
//  - 网关空闲会自动退出，连接失败要如实上报，不静默重试写操作。
//  - 一次完整任务持有浏览器执行权；BUSY 表示别人在跑，不抢占。
//  - ref/snapshotId 按身份基线策略过期，调用方必须使用同一快照的文档和引用。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { logError, logKey, logPageUrl, type DeveloperLog } from './developer-log.js'
import { browserFailureCode } from './browser-errors.js'

/** Explicit environment override, otherwise use this installed package's runtime. */
export function discoverGatewayMcp(): { path: string; source: string } | null {
  if (process.env.XINZHAO_GATEWAY_MCP) {
    const path = process.env.XINZHAO_GATEWAY_MCP
    return { path, source: '环境变量 XINZHAO_GATEWAY_MCP' }
  }
  const path = fileURLToPath(new URL('../../browser-agent-gateway/mcp-server.js', import.meta.url))
  return existsSync(path) ? { path, source: 'dsh-ai-recruiter 包内网关' } : null
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: { readOnlyHint?: boolean }
  _meta?: { browserAgent?: { capability?: string; available?: boolean } }
}

interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  cleanup: () => void
}

/** JSON-RPC 业务错误；保留网关原始错误码，便于区分 BUSY / EXPIRED / 未知结果。 */
export class McpError extends Error {
  constructor(readonly code: number | string, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'McpError'
  }
}

export interface BrowserClientOptions {
  command: string
  args: string[]
  /** 单次调用上限；网关工具自身还有更短的内部超时。 */
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  logger?: DeveloperLog
}

/**
 * 一个可复用的网关 MCP 会话。
 *
 * 生命周期由调用方通过 `dispose()` 管理；每次都新建进程会让「一次完整任务持有
 * 执行权」的语义失效，所以插件在卸载时才关闭，而不是每次工具调用都重启。
 */
export class BrowserClient {
  private child?: ChildProcessWithoutNullStreams
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private closed: Error | null = null
  private disposing = false
  private readonly timeoutMs: number

  constructor(private readonly options: BrowserClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.closed) throw this.closed
    if (this.child) return this.child
    const child = spawn(this.options.command, this.options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.options.env },
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consume(chunk))
    child.stderr.setEncoding('utf8')
    // 网关的日志一律走 stderr；这里只用来补齐进程异常退出时的错误信息。
    let stderr = ''
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000) })
    child.on('error', (error) => this.failAll(new Error(`无法启动薪招网关 MCP：${error.message}`)))
    child.on('exit', (code) => {
      this.failAll(new Error(`薪招网关 MCP 已退出（code=${code ?? 'null'}）${stderr ? `：${stderr.trim().slice(0, 300)}` : ''}`))
    })
    this.child = child
    return child
  }

  private failAll(error: Error) {
    if (!this.disposing) this.options.logger?.write('error', 'browser.transport_failed', { ...logError(error), pendingCalls: this.pending.size })
    this.closed = error
    this.child = undefined
    for (const [, entry] of this.pending) {
      entry.cleanup()
      entry.reject(error)
    }
    this.pending.clear()
  }

  private consume(chunk: string) {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) return
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message: any
      try { message = JSON.parse(line) } catch { continue }
      if (typeof message?.id !== 'number') continue
      const entry = this.pending.get(message.id)
      if (!entry) continue
      this.pending.delete(message.id)
      entry.cleanup()
      if (message.error) entry.reject(new McpError(message.error.code ?? -32_000, String(message.error.message ?? 'MCP 调用失败'), message.error.data))
      else entry.resolve(message.result)
    }
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted()
    const child = this.ensure()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        cleanup()
        reject(new McpError('TIMEOUT', `网关调用超过 ${this.timeoutMs}ms 未返回；结果未知，禁止直接重放写操作`))
      }, this.timeoutMs)
      const onAbort = () => {
        this.pending.delete(id)
        cleanup()
        reject(new McpError('RESULT_UNKNOWN', '浏览器调用发出后被取消，结果需观察核对；不能自动重放写操作'))
      }
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { resolve, reject, timer, cleanup })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  async initialize(signal?: AbortSignal): Promise<{ serverInfo?: unknown; instructions?: string }> {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-ai-recruiter', version: '0.1.15' },
    }, signal)
    await this.notify('notifications/initialized', {})
    return result ?? {}
  }

  private notify(method: string, params: unknown): Promise<void> {
    const child = this.ensure()
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    return Promise.resolve()
  }

  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const result = await this.request('tools/list', {}, signal)
    return Array.isArray(result?.tools) ? result.tools : []
  }

  /**
   * 调用一个网关工具。
   *
   * MCP 的 `isError` 与业务结果都要看：`ok:true` 不代表内部 `data.status` 成功，
   * 因此这里把原始结果整体返回，由上层按 `data.status`/`data.error` 判定。
   * 取消只停止等待，不撤回已发到网关的操作；调用方必须核对未知结果。
   * @param name tools/list 提供的工具名。
   * @param args 对应工具 schema 中的参数。
   * @param deadlineMs 本次任务剩余时间；省略时使用客户端超时。
   * @param signal 宿主工具调用的取消信号。
   * @returns 原始 MCP 工具响应。
   */
  async call(name: string, args: Record<string, unknown>, deadlineMs?: number, signal?: AbortSignal): Promise<any> {
    const invoke = async () => {
      const request = this.request('tools/call', { name, arguments: args }, signal)
      if (!deadlineMs || deadlineMs <= 0) return request
      let timer: ReturnType<typeof setTimeout> | undefined
      try { return await Promise.race([request, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new McpError('DEADLINE', `调用 ${name} 超过本次任务的剩余时间`)), deadlineMs)
      })]) } finally { clearTimeout(timer) }
    }
    if (!this.options.logger) return invoke()
    const refId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined
    return this.options.logger.trace('browser.call', {
      tool: name, tabId: args.tabId, snapshotId: refId(args.snapshotId), ref: refId(args.ref),
      documentKey: args.documentId ? logKey(args.documentId) : undefined,
      viewportOnly: args.viewportOnly === true,
    }, invoke, raw => {
      try {
        const outcome = gatewayOutcome(unwrapToolResult(raw)), page = outcome.output
        return {
          outcome: outcome.status, ...(outcome.error ? logError(new Error(outcome.error)) : {}),
          snapshotId: refId(page?.snapshotId), documentKey: page?.documentId ? logKey(page.documentId) : undefined,
          pageUrl: logPageUrl(page?.url), elementCount: Array.isArray(page?.items) ? page.items.length : undefined,
          textLength: typeof page?.text === 'string' ? page.text.length : undefined,
          dialogCount: Array.isArray(page?.dialogs) ? page.dialogs.length : undefined,
          truncated: typeof page?.truncated === 'boolean' ? page.truncated : undefined,
          format: page?.format, requestedFormat: page?.requestedFormat, formatReason: page?.formatReason, coverage: page?.coverage,
          ...(name === 'browser_inspect_element' ? {
            inspectedRole: page?.item?.role, inspectedTagName: page?.item?.tagName,
            inspectedLabelKey: page?.item?.name ? logKey(page.item.name) : undefined,
            inspectedStates: Array.isArray(page?.item?.states) ? page.item.states.filter((state: unknown) =>
              ['hidden', 'invisible', 'occluded', 'blocked_by_dialog', 'disabled', 'selected', 'expanded', 'checked'].includes(String(state))) : undefined,
            pointerEvents: ['auto', 'none'].includes(page?.element?.css?.pointerEvents) ? page.element.css.pointerEvents : undefined,
            ancestorControls: Array.isArray(page?.ancestors) ? page.ancestors.slice(0, 5).map((element: any) => ({
              tagName: typeof element?.tagName === 'string' && /^[a-z][a-z0-9-]{0,29}$/.test(element.tagName) ? element.tagName : undefined,
              role: typeof element?.attributes?.role === 'string' && /^[a-z][a-z-]{0,29}$/.test(element.attributes.role) ? element.attributes.role : undefined,
            })) : undefined,
          } : {}),
          ...(name === 'browser_click' ? {
            requestedRef: refId(page?.requestedRef), requestedRole: page?.requestedTarget?.role,
            requestedLabelKey: page?.requestedTarget?.name ? logKey(page.requestedTarget.name) : undefined,
            targetRole: page?.target?.role, targetTagName: page?.target?.tagName,
            targetLabelKey: page?.target?.name ? logKey(page.target.name) : undefined,
            promotedFromRef: refId(page?.target?.promotedFromRef), hitRole: page?.hitTarget?.role,
            hitLabelKey: page?.hitTarget?.name ? logKey(page.hitTarget.name) : undefined,
            point: page?.point && Number.isFinite(page.point.x) && Number.isFinite(page.point.y) ? { x: page.point.x, y: page.point.y } : undefined,
          } : {}),
          ...(name === 'browser_status' ? {
            connected: page?.connected === true, authenticated: page?.authenticated === true, ready: page?.ready === true,
            available: page?.available === true, busy: page?.busy === true, requiresBegin: page?.requiresBegin === true,
            executionOwner: ['local', 'remote'].includes(page?.executionOwner) ? page.executionOwner : null, activeWorkflow: !!page?.workflowTaskId,
          } : {}),
          ...(name === 'browser_acquire_file' ? { captureComplete: page?.complete === true, bytes: page?.size, captureKey: logKey(page?.captureId) } : {}),
          ...(name === 'artifact_read' ? { bytes: page?.size, offset: page?.offset, totalBytes: page?.totalSize, eof: page?.eof === true } : {}),
        }
      } catch (error) { return { outcome: 'failed', ...logError(error) } }
    }, ['browser_status', 'artifact_read'].includes(name) ? 'debug' : 'info')
  }

  dispose() {
    this.disposing = true
    const child = this.child
    this.child = undefined
    this.closed = new Error('浏览器会话已关闭')
    for (const [, entry] of this.pending) { entry.cleanup(); entry.reject(this.closed) }
    this.pending.clear()
    if (child && !child.killed) child.kill()
  }
}

/**
 * 把 MCP `tools/call` 的返回解包成网关的业务结果。
 *
 * 官方 `mcp-server.js` 的契约是**已经解包**的：
 *  - 成功：`{ content:[{type:'text', text: JSON.stringify(data.output)}] }`
 *  - 失败：`{ isError:true, content:[{type:'text', text:'工具执行失败：CODE ...'}] }`
 *    其中 `data.status !== 'succeeded'` 已被服务端折叠成 `isError`。
 *
 * 因此这里的职责只有两件：失败时带着服务端原始错误码抛错（BUSY / EXPIRED /
 * 未知结果都必须原样上抛，不能降级成通用错误），成功时解析出 output。
 * 同时也兼容仍然透传 `{ok,data:{status,output}}` 信封的自建网关。
 */
export function unwrapToolResult(result: any): any {
  if (result?.isError) {
    const message = toolResultText(result) ?? '网关工具返回错误'
    let structured: unknown
    try { structured = JSON.parse(message) } catch { /* normal MCP text error */ }
    throw new McpError(browserFailureCode(structured) ?? browserFailureCode(message) ?? 'TOOL_ERROR', message)
  }
  if (result?.structuredContent !== undefined) return result.structuredContent
  const text = toolResultText(result)
  if (text === undefined) return undefined
  try { return JSON.parse(text) } catch { return text }
}

function toolResultText(result: any): string | undefined {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const texts = blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text)
  if (!texts.length) return undefined
  return texts.join('\n')
}

/**
 * 归一化网关结果。
 *
 * 官方 server 只回传 output，此时「拿到了值」就等于成功；自建网关透传信封时按
 * `ok` 与 `data.status` 判定。两种形态都不会把未知结构默认当成成功。
 */
export function gatewayOutcome(value: any): { status: string; error?: string; output?: any } {
  const wrapped = value && typeof value === 'object' && typeof (value as any).ok === 'boolean'
  if (wrapped) {
    const data = (value as any).data
    const status = typeof data?.status === 'string' ? data.status : ((value as any).ok === true ? 'succeeded' : 'failed')
    const error = data?.error?.code ?? data?.error ?? (value as any).error
    return { status, error: error === undefined ? undefined : String(error), output: data?.output }
  }
  if (value === undefined || value === null) return { status: 'failed', error: 'EMPTY_RESULT' }
  return { status: 'succeeded', output: value }
}
