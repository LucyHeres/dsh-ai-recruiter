import { HttpLog } from './http-log.js'
import type { DeveloperLog } from './developer-log.js'

export interface CapturedFile { blob: Blob; fileName: string }
const MAX_BYTES = 20 * 1024 * 1024
const CHUNK_BYTES = 96 * 1024

/** File bytes remain in process memory and never become model output or persistent records. */
export async function readCapturedFile(
  captureId: string, read: (args: Record<string, unknown>) => Promise<any>, signal?: AbortSignal,
): Promise<CapturedFile> {
  const parts: Uint8Array<ArrayBuffer>[] = []
  let offset = 0, total = 0, fileName = '', mimeType = ''
  do {
    signal?.throwIfAborted()
    const chunk = await read({ captureId, offset, length: CHUNK_BYTES })
    if (chunk?.captureId !== captureId || chunk.offset !== offset || !Number.isInteger(chunk.totalSize) ||
        chunk.totalSize < 1 || chunk.totalSize > MAX_BYTES || typeof chunk.base64 !== 'string' ||
        chunk.base64.length > CHUNK_BYTES * 4 / 3 || !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.base64)) throw new Error('ARTIFACT_TRANSFER_INVALID')
    if (!offset) {
      total = chunk.totalSize
      fileName = typeof chunk.fileName === 'string' ? chunk.fileName : 'resume.bin'
      mimeType = typeof chunk.mimeType === 'string' ? chunk.mimeType : 'application/octet-stream'
    }
    const bytes = Buffer.from(chunk.base64, 'base64')
    if (!bytes.length || bytes.length !== chunk.size || bytes.toString('base64') !== chunk.base64 ||
        bytes.length > CHUNK_BYTES || total !== chunk.totalSize || offset + bytes.length > total ||
        chunk.eof !== (offset + bytes.length === total)) throw new Error('ARTIFACT_TRANSFER_INVALID')
    parts.push(new Uint8Array(bytes)); offset += bytes.length
  } while (offset < total)
  return { blob: new Blob(parts, { type: mimeType }), fileName }
}

/** Only upload destinations explicitly trusted by the application are accepted. */
export async function uploadCapturedFile(urlValue: string, file: CapturedFile,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>, signal?: AbortSignal, extraOrigins: string[] = [], logger?: DeveloperLog) {
  let url: URL
  try { url = new URL(urlValue) } catch { throw new Error('UPLOAD_URL_INVALID') }
  const allowed = url.hostname === 'files.xinrenxinshi.com' || url.hostname.endsWith('.devtest.vip') ||
    extraOrigins.some(origin => origin === url.origin)
  if (!allowed || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
      url.pathname !== '/site/upload' || !url.searchParams.get('token')) throw new Error('UPLOAD_URL_INVALID')
  signal?.throwIfAborted()
  if (!file.blob.size || file.blob.size > MAX_BYTES) throw new Error('ARTIFACT_SIZE_INVALID')
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000)
  const body = new FormData()
  body.append('file', file.blob, file.fileName.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 160) || 'resume.bin')
  const init: RequestInit = { method: 'POST', body, credentials: 'omit', redirect: 'error', signal: combined }
  const secrets = [url.searchParams.get('token')!, file.fileName]
  const http = new HttpLog(logger, url.href, init, { operation: 'uploadFile', authMode: 'signed-url' }, secrets)
  let response: Response | undefined
  let logged = false
  try {
    response = await fetchImpl(url.href, init)
    if (!response.body) {
      http.response(response, ''); logged = true
      throw new Error([401, 403].includes(response.status) ? 'UPLOAD_URL_EXPIRED' : 'UPLOAD_HTTP_FAILED')
    }
    const reader = response.body.getReader(), parts: Uint8Array<ArrayBuffer>[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 65536) {
        const text = await new Blob(parts).text()
        http.response(response, text, false); logged = true
        await reader.cancel(); throw new Error('UPLOAD_RESPONSE_INVALID')
      }
      parts.push(new Uint8Array(value))
    }
    const text = await new Blob(parts).text()
    http.response(response, text); logged = true
    if ([401, 403].includes(response.status)) throw new Error('UPLOAD_URL_EXPIRED')
    if (!response.ok) throw new Error('UPLOAD_HTTP_FAILED')
    const payload = JSON.parse(text)
    if (payload?.status !== true) throw new Error(Number(payload?.code) === 126011014 ? 'UPLOAD_URL_EXPIRED' : 'UPLOAD_RESPONSE_INVALID')
    const fileKey = payload.data?.key || payload.data?.fileKey
    if (typeof fileKey !== 'string' || !fileKey || fileKey.length > 2048) throw new Error('UPLOAD_RESPONSE_INVALID')
    return { fileKey }
  } catch (error) {
    if (!logged) {
      if (response) http.response(response, '', false)
      http.failed(error, response ? 'response-body' : 'request')
    }
    // Remote text, signed URLs and request credentials never enter tool output.
    const message = error instanceof Error ? error.message : ''
    if (response && [401, 403].includes(response.status)) throw new Error('UPLOAD_URL_EXPIRED')
    if (response && !response.ok) throw new Error('UPLOAD_HTTP_FAILED')
    throw new Error(/^UPLOAD_[A-Z_]+$/.test(message) ? message : 'UPLOAD_RESULT_UNKNOWN')
  }
}
