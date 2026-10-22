import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, lstat, rm } from 'node:fs/promises'
import { Store, hash } from './store.js'
import { candidateContactKeys } from './candidate-contact.js'
import type { SourcingCandidate, SourcingJob, ReceivedResumeAttachment } from '../shared/sourcing.js'
import type { CapturedFile } from './file-transfer.js'

export interface ReceivedResumeRecord {
  id: string; platform: SourcingCandidate['platform']; identityKeys: string[]; resumeId: string; conversationId: string; messageId: string
  fileName: string; receivedAt?: string; observedAt: string
  /** Private observed download address. Never sent in list or diagnostic output. */
  downloadUrl?: string
  attachmentId?: string
  cached?: { mimeType: string; size: number; sha256: string }
  uploads?: Record<string, { taskId: string; stage: 'saved' | 'unknown' | 'failed'; at: string; error?: string }>
}
export const receivedResumes = async (store: Store) => await store.find<ReceivedResumeRecord[]>('received-resumes') ?? []

export async function saveReceivedResume(store: Store, candidate: SourcingCandidate, evidence: Omit<ReceivedResumeRecord, 'id' | 'platform' | 'identityKeys' | 'observedAt' | 'uploads' | 'cached'>) {
  if (!evidence.resumeId || !evidence.conversationId || !evidence.messageId || !evidence.fileName) throw new Error('RECEIVED_RESUME_IDENTITY_REQUIRED')
  if (candidate.platformIdentity && candidate.platformIdentity.id !== evidence.resumeId) throw new Error('RECEIVED_RESUME_IDENTITY_MISMATCH')
  const id = hash([candidate.platform, evidence.resumeId, evidence.conversationId, evidence.messageId, evidence.attachmentId || evidence.fileName])
  const records = await receivedResumes(store), prior = records.find(row => row.id === id)
  const record: ReceivedResumeRecord = { ...prior, ...evidence, id, platform: candidate.platform,
    identityKeys: [...new Set([...(prior?.identityKeys ?? []), ...candidateContactKeys(candidate)])], observedAt: new Date().toISOString() }
  await store.put('received-resumes', [...records.filter(row => row.id !== id), record])
  return { record, added: !prior }
}
export const matchesReceivedResume = (candidate: SourcingCandidate, row: ReceivedResumeRecord) => row.platform === candidate.platform
  && (!candidate.platformIdentity || candidate.platformIdentity.id === row.resumeId)
  && row.identityKeys.some(key => candidateContactKeys(candidate).includes(key))

export function candidateAttachments(candidate: SourcingCandidate, jobId: string, records: ReceivedResumeRecord[]): ReceivedResumeAttachment[] {
  return records.filter(row => row.cached && matchesReceivedResume(candidate, row)).sort((a, b) => (b.receivedAt || b.observedAt).localeCompare(a.receivedAt || a.observedAt))
    .map(row => ({ id: row.id, fileName: row.fileName, receivedAt: row.receivedAt,
      uploadedAt: row.uploads?.[jobId]?.stage === 'saved' ? row.uploads[jobId].at : undefined,
      uploadStopped: row.uploads?.[jobId]?.stage === 'unknown' || undefined, uploadError: row.uploads?.[jobId]?.error }))
}
export async function updateReceivedResume(store: Store, id: string, change: (row: ReceivedResumeRecord) => void) {
  const rows = await receivedResumes(store), row = rows.find(row => row.id === id)
  if (!row) throw new Error('RECEIVED_RESUME_NOT_FOUND')
  change(row); await store.put('received-resumes', rows); return row
}
const cachePath = (store: Store, id: string) => {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('RECEIVED_RESUME_ID_INVALID')
  return store.path(`received-file-${id}`, 'bin')
}
export async function cacheReceivedFile(store: Store, row: ReceivedResumeRecord, file: CapturedFile) {
  const bytes = Buffer.from(await file.blob.arrayBuffer())
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('RECEIVED_RESUME_SIZE_INVALID')
  const extension = row.fileName.split('.').at(-1)?.toLowerCase()
  const valid = extension === 'pdf' ? bytes.subarray(0, 5).toString() === '%PDF-'
    : extension === 'doc' ? bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))
    : extension === 'docx' && bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))
  if (!valid) throw new Error('RECEIVED_RESUME_FORMAT_INVALID: 取得的内容不是有效简历附件')
  const cached = { mimeType: file.blob.type || 'application/octet-stream', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  await store.init()
  const dest = cachePath(store, row.id), temporary = dest + '.' + randomUUID() + '.tmp'
  try { await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await rename(temporary, dest) }
  finally { await rm(temporary, { force: true }) }
  await updateReceivedResume(store, row.id, record => { record.cached = cached })
  return { blob: new Blob([new Uint8Array(bytes)], { type: cached.mimeType }), fileName: row.fileName }
}

/** Resolve a UI selection through the job's stored candidates. Names and
 * client-provided download addresses never authorize access to a file. */
export async function selectReceivedResumes(store: Store, jobId: string, roundId: string, ids: string[], candidateKey?: string) {
  const jobs = (await store.list<SourcingJob>('sourcing-')).filter(j => j.kind === 'talent_sourcing' && j.jobId === jobId && (roundId === 'all' || j.id === roundId))
  if (roundId !== 'all' && !jobs.length) throw new Error('该职位下没有这轮寻聘记录')
  const candidates = jobs.flatMap(j => j.candidates).filter(c => !candidateKey || c.key === candidateKey)
  const records = await receivedResumes(store)
  return [...new Set(ids)].map(id => {
    const row = records.find(r => r.id === id)
    if (!row || !candidates.some(c => matchesReceivedResume(c, row))) throw new Error('该职位或轮次下没有这份附件简历')
    return row
  })
}
export async function cachedReceivedFile(store: Store, row: ReceivedResumeRecord): Promise<CapturedFile | undefined> {
  if (!row.cached) return
  const path = cachePath(store, row.id)
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('RECEIVED_RESUME_CACHE_INVALID')
    const bytes = await readFile(path)
    if (bytes.length !== row.cached.size || createHash('sha256').update(bytes).digest('hex') !== row.cached.sha256) throw new Error('RECEIVED_RESUME_CACHE_INVALID')
    return { blob: new Blob([new Uint8Array(bytes)], { type: row.cached.mimeType }), fileName: row.fileName }
  } catch (error: any) { if (error.code !== 'ENOENT') throw error }
}
