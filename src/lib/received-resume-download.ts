import { randomUUID } from 'node:crypto'
import type { CapturedFile } from './file-transfer.js'
import type { ResumeDownloadChunk } from '../shared/sourcing.js'

/** Short-lived transfer buffers, bound to an authorized selection and sequential offsets. */
export class ReceivedResumeDownloads {
  private readonly sessions = new Map<string, { owner: string; file: CapturedFile; offset: number; timer: ReturnType<typeof setTimeout> }>()
  private pending = 0
  private disposed = false
  async read(owner: string, offset: number, downloadId: string | undefined, load: () => Promise<CapturedFile>): Promise<ResumeDownloadChunk> {
    if (this.disposed) throw new Error('附件下载已结束或失效，请重新下载')
    if (!downloadId) {
      if (offset !== 0) throw new Error('附件下载已结束或失效，请重新下载')
      if (this.sessions.size + this.pending >= 2) throw new Error('附件正在下载，请稍后重试')
      this.pending++
      let file: CapturedFile
      try { file = await load() } finally { this.pending-- }
      if (this.disposed) throw new Error('附件下载已结束或失效，请重新下载')
      if (!file.blob.size || file.blob.size > 20 * 1024 * 1024) throw new Error('RECEIVED_RESUME_SIZE_INVALID')
      downloadId = randomUUID()
      const id = downloadId, timer = setTimeout(() => this.remove(id), 120000)
      timer.unref()
      this.sessions.set(id, { owner, file, offset: 0, timer })
    }
    const session = this.sessions.get(downloadId)
    if (!session || session.owner !== owner || session.offset !== offset || offset >= session.file.blob.size) throw new Error('附件下载已结束或失效，请重新下载')
    const end = Math.min(offset + 96 * 1024, session.file.blob.size)
    session.offset = end
    const bytes = Buffer.from(await session.file.blob.slice(offset, end).arrayBuffer())
    const eof = end === session.file.blob.size
    const chunk = { downloadId, fileName: session.file.fileName, mimeType: session.file.blob.type,
      totalSize: session.file.blob.size, offset, base64: bytes.toString('base64'), eof }
    if (eof) this.remove(downloadId)
    return chunk
  }
  private remove(id: string) { const session = this.sessions.get(id); if (session) clearTimeout(session.timer); this.sessions.delete(id) }
  dispose() { this.disposed = true; for (const id of this.sessions.keys()) this.remove(id) }
}
