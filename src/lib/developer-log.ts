import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, lstat, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { sanitizeHttpLog } from './http-log.js'
import { browserFailureReason } from './browser-errors.js'

export type DeveloperLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off'
type Fields = Record<string, unknown>
const priorities = { debug: 10, info: 20, warn: 30, error: 40, off: 100 }
const MAX_BYTES = 2 * 1024 * 1024
const FILES = 5
const LOCAL_ERRORS: Record<string, string> = {
  '浏览器未就绪或被其他任务占用': 'BROWSER_NOT_AVAILABLE',
  '请在招聘平台完成登录或验证后重新启动': 'PLATFORM_LOGIN_REQUIRED',
  '目标职位已失效或无权限，请重新选择': 'JOB_UNAVAILABLE',
  '入库位置已失效或无权限，请重新选择': 'DESTINATION_UNAVAILABLE',
  '简历打开了多个标签页，无法确认目标': 'RESUME_MULTIPLE_TABS',
  '简历详情未打开，已停止采集': 'RESUME_DETAIL_NOT_OPEN',
  '简历详情与列表候选人无法对应，已停止入库': 'RESUME_IDENTITY_MISMATCH',
  '简历附件采集不完整，已停止入库': 'RESUME_CAPTURE_INCOMPLETE',
  '未识别到 BOSS 已收简历入口，已停止；不会采集其他沟通列表': 'RECEIVED_RESUME_ENTRY_MISSING',
}
const PRIVATE_FIELD = /token|cookie|authorization|session|nonce|password|secret|credential|fileKey|fileUrl|uploadUrl|base64|headers|body|response|payload|raw|identity|fileName|candidateName|^name$|^text$|^args$/i

/** 不输出查询串和 fragment，包括可能携带凭据的 documentId。 */
export function logPageUrl(value: unknown): string | undefined {
  try { const url = new URL(String(value)); return /^https?:$/.test(url.protocol) ? url.origin + url.pathname : undefined } catch { return undefined }
}
export const logKey = (value: unknown) => createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16)

function safeValue(value: unknown, depth = 0): unknown {
  if (value === undefined || depth > 5) return undefined
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, url => logPageUrl(url) ?? '[URL]')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[凭据]')
    .replace(/(?:token|cookie|authorization|sessionId|nonce|password)\s*[=:]\s*\S+/gi, '[凭据]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱]')
    .replace(/\b1[3-9]\d{9}\b/g, '[电话]').slice(0, 600)
  if (Array.isArray(value)) return value.slice(0, 30).map(item => safeValue(item, depth + 1))
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 60)
    .filter(([key]) => !PRIVATE_FIELD.test(key)).map(([key, item]) => [key, safeValue(item, depth + 1)]))
  return undefined
}

/** 错误正文可能含远端回显或用户输入，只记录类型、错误码及调用栈位置。 */
export function logError(error: unknown): Fields {
  const value = error as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown; issues?: unknown } | null
  const known = typeof value?.message === 'string' && Object.hasOwn(LOCAL_ERRORS, value.message) ? value.message : undefined
  const code = known ? LOCAL_ERRORS[known] : typeof value?.code === 'string' || typeof value?.code === 'number' ? String(value.code)
    : /\b[A-Z][A-Z0-9_]{3,}\b/.exec(String(value?.message ?? ''))?.[0]
  return {
    errorType: typeof value?.name === 'string' ? value.name : 'UnknownError',
    errorCode: code && /^[A-Z0-9_-]{1,64}$/i.test(code) ? code : 'UNSPECIFIED',
    errorReason: browserFailureReason(error),
    ...(known ? { errorMessage: known } : {}),
    ...(Array.isArray(value?.issues) ? { validationIssues: value.issues.slice(0, 10).map(issue => ({
      code: typeof issue?.code === 'string' ? issue.code : 'invalid',
      path: Array.isArray(issue?.path) ? issue.path.slice(0, 10).map((part: unknown) => String(part).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64)).join('.') : '',
    })) } : {}),
    stack: typeof value?.stack === 'string' ? value.stack.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 10) : [],
  }
}

/** 每个插件实例独立串行写入；日志异常不能改变业务结果或触发重试。 */
export class DeveloperLog {
  readonly directory: string
  readonly runId = randomUUID()
  private readonly context = new AsyncLocalStorage<Fields>()
  private queue: Promise<void> = Promise.resolve()
  private pending = 0
  private sequence = 0
  private dropped = 0
  private writeFailed = false
  constructor(root: string, readonly level: DeveloperLogLevel = 'info', readonly pluginVersion?: string) { this.directory = join(root, 'developer-logs') }
  withContext<T>(fields: Fields, action: () => T): T {
    return this.context.run({ ...this.context.getStore(), ...fields }, action)
  }
  updateContext(fields: Fields) { const current = this.context.getStore(); if (current) Object.assign(current, fields) }
  write(level: Exclude<DeveloperLogLevel, 'off'>, event: string, fields: Fields = {}) {
    this.enqueue(level, event, safeValue({ ...this.context.getStore(), ...fields }) as Fields)
  }
  /** HTTP 内容走专用脱敏，避免普通日志的字段过滤和 600 字限制吞掉接口响应。 */
  http(level: 'info' | 'warn', event: string, fields: Fields, secrets: string[]) {
    if (priorities[level] < priorities[this.level]) return
    const context = safeValue(this.context.getStore() ?? {}) as Fields
    const http = sanitizeHttpLog(fields, secrets) as Fields
    const encoded = JSON.stringify(http)
    if (Buffer.byteLength(encoded) <= 48 * 1024) {
      this.enqueue(level, event, { ...context, http })
      return
    }
    // 分片保留完整脱敏内容，每行仍小于 64 KiB；导出时可按 httpCallId 拼接。
    const parts = encoded.match(/[\s\S]{1,8000}/gu) ?? []
    parts.forEach((httpText, index) => this.enqueue(level, event, { ...context, httpCallId: http.httpCallId,
      operation: http.operation, httpPart: index + 1, httpParts: parts.length, httpText }))
  }
  private enqueue(level: Exclude<DeveloperLogLevel, 'off'>, event: string, fields: Fields) {
    if (priorities[level] < priorities[this.level]) return
    if (this.pending >= 500) { this.dropped++; return }
    // 在入队前复制，避免异步写入看到已被业务代码修改的对象。
    let line: string
    try {
      line = JSON.stringify({ ...fields,
        at: new Date().toISOString(), level, event, pluginVersion: this.pluginVersion, runId: this.runId, sequence: ++this.sequence, dropped: this.dropped }) + '\n'
      if (Buffer.byteLength(line) > 64 * 1024) { this.dropped++; return }
    } catch { this.dropped++; return }
    this.pending++
    this.queue = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      if ((await lstat(this.directory)).isSymbolicLink()) throw new Error('LOG_DIRECTORY_INVALID')
      const file = this.path(0)
      let size = 0
      try { const stat = await lstat(file); if (!stat.isFile()) throw new Error('LOG_FILE_INVALID'); size = stat.size }
      catch (error: any) { if (error.code !== 'ENOENT') throw error }
      if (size + Buffer.byteLength(line) > MAX_BYTES) {
        await rm(this.path(FILES - 1), { force: true })
        for (let i = FILES - 2; i >= 0; i--) {
          try { await rename(this.path(i), this.path(i + 1)) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
        }
      }
      const handle = await open(file, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(line) } finally { await handle.close() }
    }).catch(() => {
      this.dropped++
      if (!this.writeFailed) console.warn('[dsh-ai-recruiter] 开发日志写入失败，请检查状态目录权限；业务继续执行。')
      this.writeFailed = true
    }).finally(() => { this.pending-- })
  }
  async trace<T>(event: string, fields: Fields, action: () => Promise<T>, summary?: (value: T) => Fields,
    level: 'debug' | 'info' = 'info'): Promise<T> {
    if (this.level === 'off') return action()
    return this.withContext({ callId: randomUUID(), parentCallId: this.context.getStore()?.callId }, async () => {
      const started = Date.now()
      this.write('debug', `${event}.started`, fields)
      try {
        const value = await action()
        let result: Fields = {}
        try { result = summary?.(value) ?? {} } catch { /* 日志摘要失败不影响调用结果。 */ }
        this.write(['failed', 'unknown', 'rejected', 'not-sent'].includes(String(result.outcome)) ? 'warn' : level,
          `${event}.finished`, { ...fields, ...result, durationMs: Date.now() - started })
        return value
      } catch (error) {
        this.write('error', `${event}.failed`, { ...fields, ...logError(error), durationMs: Date.now() - started })
        throw error
      }
    })
  }
  async flush() { await this.queue }
  async clear() {
    const clear = this.queue.then(async () => { for (let index = 0; index < FILES; index++) await rm(this.path(index), { force: true }) })
    this.queue = clear.then(() => {}, () => {})
    return clear
  }
  private path(index: number) { return join(this.directory, index ? `developer.${index}.jsonl` : 'developer.jsonl') }
  async read(taskId?: string, limit = 300) {
    // 与写入共用队列，导出期间不轮转，避免跨文件读取时重复或遗漏记录。
    const result = this.queue.then(() => this.readFiles(taskId, limit))
    this.queue = result.then(() => {}, () => {})
    return result
  }
  private async readFiles(taskId: string | undefined, limit: number) {
    const lines: string[] = []
    let truncated = false
    for (let index = 0; index < FILES && !truncated; index++) {
      let handle
      try {
        handle = await open(this.path(index), constants.O_RDONLY | constants.O_NOFOLLOW)
        const stat = await handle.stat()
        if (!stat.isFile()) throw new Error('LOG_FILE_INVALID')
        const offset = Math.max(0, stat.size - MAX_BYTES)
        const bytes = Buffer.alloc(Math.min(stat.size, MAX_BYTES))
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset)
        const records = bytes.subarray(0, bytesRead).toString('utf8').split('\n')
        if (offset) records.shift()
        for (let i = records.length - 1; i >= 0; i--) {
          try {
            const row = JSON.parse(records[i])
            if (taskId && row.taskId !== taskId) continue
            if (lines.length === limit) { truncated = true; break }
            lines.push(records[i])
          } catch { /* 跳过最后一行可能未写完的记录。 */ }
        }
      } catch (error: any) { if (error.code !== 'ENOENT') throw error }
      finally { await handle?.close() }
    }
    return { directory: this.directory, level: this.level, runId: this.runId, ...(taskId ? { taskId } : {}), lines: lines.reverse(), truncated, dropped: this.dropped, writeFailed: this.writeFailed }
  }
}
