import { randomUUID } from 'node:crypto'
import type { DeveloperLog } from './developer-log.js'

const PRIVATE_KEY = /token|cookie|authorization|session|csrf|nonce|password|secret|credential|signature|fileKey|fileUrl|uploadUrl|base64|resumeBody|resumeContent|resumeText|fileName|candidateName|fullName|realName|mobile|phone|email|姓名|手机号|邮箱|^name$|^key$|^text$|^content$|^html$/i
const BODY_LIMIT = 128 * 1024
const REDACTED = '[REDACTED]'

/** HTTP 日志保留字段结构，凭据与附件内容只留脱敏标记。 */
export function sanitizeHttpLog(value: unknown, secrets: string[] = [], depth = 0): unknown {
  if (depth > 24) return '[DEPTH_LIMIT]'
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.map(item => sanitizeHttpLog(item, secrets, depth + 1))
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key !== 'resumeFileKeys' && PRIVATE_KEY.test(key) ? REDACTED : sanitizeHttpLog(item, secrets, depth + 1)]))
  let text = String(value)
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join(REDACTED)
  return text
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, value => {
      try {
        const url = new URL(value)
        if (url.username) url.username = REDACTED
        if (url.password) url.password = REDACTED
        for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, REDACTED)
        url.hash = ''
        return url.href
      } catch { return '[URL]' }
    })
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, REDACTED)
    .replace(/((?:["']?)(?:[\w-]*(?:token|cookie|authorization|sessionId|csrf|password|secret|fileKey|fileName|candidateName|resumeBody|signature)[\w-]*)(?:["']?)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}<]+)/gi, `$1"${REDACTED}"`)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱]')
    .replace(/\b1[3-9]\d{9}\b/g, '[电话]')
}

function payload(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}

function requestBody(init: RequestInit): unknown {
  if (init.body instanceof FormData) return Object.fromEntries([...init.body.entries()].map(([key, value]) => [key,
    typeof value === 'string' ? value : { bytes: value.size, mimeType: value.type, fileName: REDACTED }]))
  if (typeof init.body !== 'string') return init.body == null ? null : '[BINARY]'
  const contentType = new Headers(init.headers).get('content-type') || ''
  return contentType.includes('application/x-www-form-urlencoded')
    ? Object.fromEntries([...new URLSearchParams(init.body)].map(([key, value]) => [key, /^[\[{]/.test(value.trim()) ? payload(value) : value]))
    : payload(init.body)
}

/** 不增加或重放网络请求；仅记录调用方实际发送和消费的内容。 */
export class HttpLog {
  private readonly started = Date.now()
  private readonly httpCallId = randomUUID()
  private readonly common: Record<string, unknown>
  constructor(private readonly logger: DeveloperLog | undefined, url: string, init: RequestInit,
    metadata: Record<string, unknown>, private readonly secrets: string[] = []) {
    this.common = { ...metadata, httpCallId: this.httpCallId, method: init.method || 'GET', url }
    this.write('info', 'xrxs.http.request', { headers: Object.fromEntries(new Headers(init.headers)),
      query: Object.fromEntries(new URL(url).searchParams), body: requestBody(init), redirect: init.redirect })
  }
  private write(level: 'info' | 'warn', event: string, fields: Record<string, unknown>) {
    // 诊断失败不得改变业务结果。
    try { this.logger?.http(level, event, { ...this.common, ...fields }, this.secrets) } catch { /* 日志不影响调用 */ }
  }
  response(response: Response, text: string, complete = true) {
    if (!this.logger || this.logger.level === 'off') return
    const bytes = Buffer.byteLength(text)
    const body = sanitizeHttpLog(payload(text), this.secrets)
    const encoded = JSON.stringify(body) ?? 'null'
    const bounded = Buffer.from(encoded).subarray(0, BODY_LIMIT).toString('utf8')
    this.write(response.ok ? 'info' : 'warn', 'xrxs.http.response', {
      httpStatus: response.status, statusText: response.statusText, responseUrl: response.url || undefined,
      redirected: response.redirected, headers: Object.fromEntries(response.headers), durationMs: Date.now() - this.started,
      body: Buffer.byteLength(encoded) <= BODY_LIMIT ? body : bounded,
      bodyBytes: bytes, bodyComplete: complete, bodyTruncated: Buffer.byteLength(encoded) > BODY_LIMIT,
    })
  }
  failed(error: unknown, phase: 'request' | 'response-body') {
    const value = error as { name?: unknown; message?: unknown; cause?: { code?: unknown } }
    this.write('warn', 'xrxs.http.failed', { phase, durationMs: Date.now() - this.started,
      errorType: value?.name, errorMessage: value?.message, causeCode: value?.cause?.code })
  }
}
