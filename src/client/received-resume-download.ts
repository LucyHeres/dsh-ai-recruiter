import type { ResumeDownloadChunk } from '../shared/sourcing.js'

export async function readResumeDownload(read: (offset: number) => Promise<ResumeDownloadChunk>, signal: AbortSignal) {
  const parts: Uint8Array<ArrayBuffer>[] = []
  let offset = 0, total = 0, fileName = '', mimeType = ''
  do {
    signal.throwIfAborted()
    const chunk = await read(offset)
    if (chunk.offset !== offset || !Number.isInteger(chunk.totalSize) || chunk.totalSize < 1 || chunk.totalSize > 20 * 1024 * 1024
      || typeof chunk.base64 !== 'string' || chunk.base64.length > 131072 || !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.base64)) throw new Error('简历附件读取不完整，请重试')
    if (!offset) { total = chunk.totalSize; fileName = chunk.fileName; mimeType = chunk.mimeType }
    if (total !== chunk.totalSize || fileName !== chunk.fileName || mimeType !== chunk.mimeType) throw new Error('简历附件已变化，请重新下载')
    const bytes = Uint8Array.from(atob(chunk.base64), c => c.charCodeAt(0))
    if (!bytes.length || bytes.length > 98304 || offset + bytes.length > total || chunk.eof !== (offset + bytes.length === total)) throw new Error('简历附件读取不完整，请重试')
    parts.push(bytes); offset += bytes.length
  } while (offset < total)
  signal.throwIfAborted()
  return { blob: new Blob(parts, { type: mimeType }), fileName }
}
