import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Store } from './store.js'
import type { WorkbenchJob, TaskResult } from '../shared/workbench.js'
import type { DataGroup, DataStorageUsage, SourcingJob } from '../shared/sourcing.js'
import { sourcingQualifiedCount } from '../shared/sourcing-score.js'
import { clearReceivedResumeCache, clearReceivedResumeRecords, receivedResumeStorage } from './received-resume-store.js'

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value, null, 2))
const safeResults = <T extends TaskResult>(rows: T[]) => rows.map(({ name: _name, detail: _detail, ...row }) => ({ ...row, name: '', detail: '' }) as T)

/** Keep just the identity/timing/outcome fields needed to prevent repeat writes. */
export function withoutTaskHistory(job: WorkbenchJob): WorkbenchJob {
  const receipt: WorkbenchJob = { id: job.id, kind: job.kind, platform: job.platform, jobId: job.jobId,
    limit: job.limit, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt,
    detail: '', results: safeResults(job.results ?? []), historyCleared: true, talentCleared: job.talentCleared }
  if (job.kind !== 'talent_sourcing') return receipt
  const source = job as SourcingJob
  return { ...receipt, platforms: source.platforms, candidates: source.candidates ?? [], channels: [],
    position: source.position, supplement: source.supplement, jobDescription: source.jobDescription,
    requirements: source.requirements, requirementVersion: source.requirementVersion, minimumScore: source.minimumScore,
    viewedCandidates: source.viewedCandidates, scanned: source.scanned,
    limitScope: source.limitScope, sourceMode: source.sourceMode, greetings: safeResults(source.greetings ?? []),
    talentCleared: source.talentCleared, clearedCandidateCount: source.clearedCandidateCount } as SourcingJob
}
export function withoutTalents(job: SourcingJob): SourcingJob {
  const position = job.historyCleared || !job.position ? undefined : {
    id: job.position.id, name: job.position.name, department: job.position.department, city: job.position.city,
    fetchedAt: job.position.fetchedAt, description: '',
  }
  const { requirements: _requirements, requirementVersion: _version, jobDescription: _description,
    platformJobs: _platformJobs, searchFilters: _filters, viewedCandidates: _viewed, ...rest } = job
  return { ...rest, candidates: [], position, supplement: '', talentCleared: true,
    clearedCandidateCount: job.talentCleared ? job.clearedCandidateCount : sourcingQualifiedCount(job) }
}
async function files(store: Store, prefix: string) {
  await store.init()
  const names = (await readdir(store.root)).filter(name => name.startsWith(prefix) && /^[A-Za-z0-9_-]+\.json$/.test(name))
  const result = []
  for (const name of names) {
    const stat = await lstat(join(store.root, name))
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('DATA_FILE_INVALID: 数据文件不可用')
    result.push({ id: name.slice(0, -5), size: stat.size })
  }
  return result
}
async function taskFiles(store: Store) {
  const result = []
  for (const prefix of ['sourcing-', 'greeting-', 'resume-task-']) for (const file of await files(store, prefix)) {
    const job = await store.get<WorkbenchJob>(file.id)
    if (!job.id || !Array.isArray(job.results)) throw new Error('DATA_FILE_INVALID: 任务数据不可用')
    result.push({ ...file, job })
  }
  return result
}
async function logBytes(store: Store) {
  let total = 0
  for (let i = 0; i < 5; i++) try {
    const stat = await lstat(join(store.root, 'developer-logs', i ? `developer.${i}.jsonl` : 'developer.jsonl'))
    if (stat.isFile() && !stat.isSymbolicLink()) total += stat.size
  } catch (error: any) { if (error.code !== 'ENOENT') throw error }
  return total
}
export async function dataStorage(store: Store): Promise<DataStorageUsage> {
  const usage = { tasks: { bytes: await logBytes(store) }, talents: { bytes: 0 } }
  for (const { size, job } of await taskFiles(store)) {
    const retained = withoutTaskHistory(job)
    if (!job.historyCleared) usage.tasks.bytes += Math.max(1, size - bytes(retained))
    if (job.kind === 'talent_sourcing' && !(job as SourcingJob).talentCleared) {
      usage.talents.bytes += Math.max(0, bytes(retained) - bytes(withoutTalents(retained as SourcingJob)))
    }
  }
  for (const file of await files(store, 'criteria-')) usage.talents.bytes += file.size
  const resumes = await store.find<unknown[]>('received-resumes')
  if (resumes?.length) usage.talents.bytes += bytes(resumes)
  usage.talents.bytes += (await receivedResumeStorage(store)).bytes
  return usage
}
/** Called only after confirmation, while the shared workbench lock is held. */
export async function clearData(store: Store, group: DataGroup, clearLogs: () => Promise<void>) {
  const entries = await taskFiles(store)
  if (entries.some(({ job }) => ['queued', 'running', 'stopping'].includes(job.status))) throw new Error('请等待当前任务结束后清理')
  const before = await dataStorage(store)
  if (group === 'tasks') {
    for (const { id, job } of entries) if (!job.historyCleared) await store.put(id, withoutTaskHistory(job))
    await clearLogs()
  } else {
    for (const { id, job } of entries) {
      if (job.kind === 'talent_sourcing' && !job.talentCleared) await store.put(id, withoutTalents(job as SourcingJob))
      else if (job.kind === 'greeting' && !job.talentCleared) await store.put(id, { ...job, talentCleared: true })
    }
    await clearReceivedResumeCache(store)
    await clearReceivedResumeRecords(store)
    for (const file of await files(store, 'criteria-')) await rm(store.path(file.id))
  }
  const usage = await dataStorage(store)
  return { usage, bytes: Math.max(0, before[group].bytes - usage[group].bytes) }
}
