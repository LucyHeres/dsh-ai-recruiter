import { createHash } from 'node:crypto'
import type { CapturedFile } from './file-transfer.js'
import { recruitmentPlatform } from './platforms/registry.js'
import { updateReceivedResume, type ReceivedResumeRecord, type ResumeFileFingerprint } from './received-resume-store.js'
import type { Store } from './store.js'
import { logError, logKey, type DeveloperLog } from './developer-log.js'

const MAX_BYTES = 20 * 1024 * 1024
const mimeTypes: Record<string, string> = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }

export async function resumeFileFingerprint(file: CapturedFile): Promise<ResumeFileFingerprint> {
  if (!file.blob.size || file.blob.size > MAX_BYTES) throw new Error('RECEIVED_RESUME_SIZE_INVALID')
  const bytes = Buffer.from(await file.blob.arrayBuffer()), extension = file.fileName.split('.').at(-1)?.toLowerCase() ?? ''
  const valid = extension === 'pdf' ? bytes.subarray(0, 5).toString() === '%PDF-'
    : extension === 'doc' ? bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))
    : extension === 'docx' && bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))
  if (!valid) throw new Error('RECEIVED_RESUME_FORMAT_INVALID: 取得的内容不是有效简历附件')
  return { mimeType: mimeTypes[extension]!, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** Fetch only an observed, platform-approved file address. No cookies, redirects or disk cache. */
export async function fetchReceivedResumeFile(input: {
  store: Store; row: ReceivedResumeRecord; signal: AbortSignal
  refresh: (row: ReceivedResumeRecord, signal: AbortSignal) => Promise<ReceivedResumeRecord | { record: ReceivedResumeRecord; file: CapturedFile }>
  fetch?: typeof globalThis.fetch
  logger?: DeveloperLog
}): Promise<CapturedFile> {
  const reportFailure = (error: unknown, stage: string) => input.logger?.write('warn', 'received_resume.read_failed', {
    platform: input.row.platform, attachmentKey: logKey(input.row.id), stage, ...logError(error),
    httpStatus: typeof (error as any)?.httpStatus === 'number' ? (error as any).httpStatus : undefined,
  })
  const fetchFile = async (row: ReceivedResumeRecord) => {
    input.signal.throwIfAborted()
    const source = recruitmentPlatform(row.platform).receivedAttachment
    let address: URL
    try { address = new URL(row.downloadUrl ?? '') } catch { throw new Error('RECEIVED_RESUME_LINK_UNAVAILABLE') }
    if (!source?.acceptsUrl(address)) throw new Error('RECEIVED_RESUME_LINK_UNAVAILABLE')
    const response = await (input.fetch ?? globalThis.fetch)(address.href, {
      credentials: 'omit', redirect: 'error', signal: AbortSignal.any([input.signal, AbortSignal.timeout(90000)]),
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw Object.assign(new Error('RECEIVED_RESUME_LINK_UNAVAILABLE'), { httpStatus: response.status })
    }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body.cancel(); throw new Error('RECEIVED_RESUME_SIZE_INVALID') }
    const reader = response.body.getReader(), parts: Uint8Array<ArrayBuffer>[] = []
    let size = 0
    try {
      while (true) {
        input.signal.throwIfAborted()
        const { value, done } = await reader.read()
        if (done) break
        size += value.length
        if (size > MAX_BYTES) throw new Error('RECEIVED_RESUME_SIZE_INVALID')
        parts.push(new Uint8Array(value))
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    const file = { fileName: row.fileName, blob: new Blob(parts) }
    const fingerprint = await resumeFileFingerprint(file)
    return { file: { ...file, blob: new Blob(parts, { type: fingerprint.mimeType }) }, fingerprint }
  }
  let row = input.row, result: Awaited<ReturnType<typeof fetchFile>>
  let acquiredVia = 'link'
  try { result = await fetchFile(row) }
  catch (error) {
    input.signal.throwIfAborted()
    reportFailure(error, 'stored_link')
    if (error instanceof Error && error.message === 'RECEIVED_RESUME_SIZE_INVALID') throw error
    let refreshed: Awaited<ReturnType<typeof input.refresh>>
    try { refreshed = await input.refresh(row, input.signal) }
    catch (error) { reportFailure(error, 'browser_attachment'); throw error }
    row = 'record' in refreshed ? refreshed.record : refreshed
    if (row.id !== input.row.id || row.platform !== input.row.platform || row.resumeId !== input.row.resumeId
      || row.conversationId !== input.row.conversationId || row.messageId !== input.row.messageId || row.attachmentId !== input.row.attachmentId) {
      throw new Error('RECEIVED_RESUME_IDENTITY_MISMATCH')
    }
    if ('record' in refreshed) {
      try {
        const fingerprint = await resumeFileFingerprint(refreshed.file)
        result = { file: { ...refreshed.file, blob: refreshed.file.blob.slice(0, refreshed.file.blob.size, fingerprint.mimeType) }, fingerprint }
        acquiredVia = 'browser'
      } catch (error) { reportFailure(error, 'browser_file_validation'); throw error }
    } else {
      try { result = await fetchFile(row) }
      catch (error) { reportFailure(error, 'refreshed_link'); input.signal.throwIfAborted(); throw new Error('附件链接不可用，请确认平台登录和原附件仍可访问后重试') }
    }
  }
  await updateReceivedResume(input.store, row.id, saved => { saved.content = result.fingerprint })
  input.logger?.write('info', 'received_resume.file_ready', { platform: row.platform, attachmentKey: logKey(row.id),
    acquiredVia, bytes: result.fingerprint.size })
  return result.file
}
