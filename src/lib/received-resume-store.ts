import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Store, hash } from './store.js'
import { candidateContactKeys } from './candidate-contact.js'
import type { SourcingCandidate, SourcingJob, ReceivedResumeAttachment } from '../shared/sourcing.js'

export interface ResumeFileFingerprint { mimeType: string; size: number; sha256: string }

export interface ReceivedResumeRecord {
  id: string; platform: SourcingCandidate['platform']; identityKeys: string[]; resumeId: string; conversationId: string; messageId: string
  fileName: string; receivedAt?: string; observedAt: string
  /** Private observed download address. Never sent in list or diagnostic output. */
  downloadUrl?: string
  attachmentId?: string
  content?: ResumeFileFingerprint
  /** Legacy fingerprint. Kept for upload deduplication until old files are cleared. */
  cached?: ResumeFileFingerprint
  uploads?: Record<string, { taskId: string; stage: 'saved' | 'unknown' | 'failed'; at: string; error?: string }>
}
export const receivedResumes = async (store: Store) => await store.find<ReceivedResumeRecord[]>('received-resumes') ?? []
type AttachmentReceipt = Pick<ReceivedResumeRecord, 'id' | 'content' | 'uploads'>
/** Only hashes and write receipts survive a user clearing the talent list. */
export async function clearReceivedResumeRecords(store: Store) {
  const receipts = await store.find<AttachmentReceipt[]>('attachment-receipts') ?? []
  const merged = new Map(receipts.map(row => [row.id, row]))
  for (const row of await receivedResumes(store)) merged.set(row.id, { id: row.id, content: row.content ?? row.cached, uploads: row.uploads })
  await store.put('attachment-receipts', [...merged.values()])
  await store.put('received-resumes', [])
}

export async function saveReceivedResume(store: Store, candidate: SourcingCandidate, evidence: Omit<ReceivedResumeRecord, 'id' | 'platform' | 'identityKeys' | 'observedAt' | 'uploads' | 'cached' | 'content'>) {
  if (!evidence.resumeId || !evidence.conversationId || !evidence.messageId || !evidence.fileName) throw new Error('RECEIVED_RESUME_IDENTITY_REQUIRED')
  if (candidate.platformIdentity && candidate.platformIdentity.id !== evidence.resumeId) throw new Error('RECEIVED_RESUME_IDENTITY_MISMATCH')
  const id = hash([candidate.platform, evidence.resumeId, evidence.conversationId, evidence.messageId, evidence.attachmentId || evidence.fileName])
  const records = await receivedResumes(store), existing = records.find(row => row.id === id)
  const prior = existing ?? (await store.find<AttachmentReceipt[]>('attachment-receipts'))?.find(row => row.id === id)
  const record: ReceivedResumeRecord = { ...prior, ...evidence, id, platform: candidate.platform,
    identityKeys: [...new Set([...(existing?.identityKeys ?? []), ...candidateContactKeys(candidate)])], observedAt: new Date().toISOString() }
  await store.put('received-resumes', [...records.filter(row => row.id !== id), record])
  return { record, added: !prior }
}
export const matchesReceivedResume = (candidate: SourcingCandidate, row: ReceivedResumeRecord) => row.platform === candidate.platform
  && (!candidate.platformIdentity || candidate.platformIdentity.id === row.resumeId)
  && row.identityKeys.some(key => candidateContactKeys(candidate).includes(key))

export function candidateAttachments(candidate: SourcingCandidate, jobId: string, records: ReceivedResumeRecord[]): ReceivedResumeAttachment[] {
  return records.filter(row => (row.downloadUrl || row.attachmentId || row.cached) && matchesReceivedResume(candidate, row)).sort((a, b) => (b.receivedAt || b.observedAt).localeCompare(a.receivedAt || a.observedAt))
    .map(row => ({ id: row.id, fileName: row.fileName, receivedAt: row.receivedAt,
      uploadedAt: row.uploads?.[jobId]?.stage === 'saved' ? row.uploads[jobId].at : undefined,
      uploadStopped: row.uploads?.[jobId]?.stage === 'unknown' || undefined, uploadError: row.uploads?.[jobId]?.error }))
}
export async function updateReceivedResume(store: Store, id: string, change: (row: ReceivedResumeRecord) => void) {
  const rows = await receivedResumes(store), row = rows.find(row => row.id === id)
  if (!row) throw new Error('RECEIVED_RESUME_NOT_FOUND')
  change(row); await store.put('received-resumes', rows); return row
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
async function legacyFiles(store: Store) {
  await store.init()
  const files = []
  for (const name of await readdir(store.root)) {
    if (!/^received-file-[a-f0-9]{64}\.bin(?:\.[a-f0-9-]{36}\.tmp)?$/.test(name)) continue
    const path = join(store.root, name)
    let stat
    try { stat = await lstat(path) } catch (error: any) { if (error.code === 'ENOENT') continue; throw error }
    if (stat.isFile() && !stat.isSymbolicLink()) files.push({ path, size: stat.size })
  }
  return files
}
export async function receivedResumeStorage(store: Store) {
  const files = await legacyFiles(store)
  return { fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) }
}
/** Caller holds the task lock. Preserve fingerprints and receipts before removing bytes. */
export async function clearReceivedResumeCache(store: Store) {
  const rows = await receivedResumes(store)
  for (const row of rows) if (row.cached) { row.content ??= row.cached; delete row.cached }
  await store.put('received-resumes', rows)
  const files = await legacyFiles(store)
  let fileCount = 0, bytes = 0
  for (const file of files) {
    await rm(file.path, { force: true }); fileCount++; bytes += file.size
  }
  return { fileCount, bytes }
}
