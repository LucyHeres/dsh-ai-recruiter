import { hash, type Store } from './store.js'
import { updateReceivedResume, type ReceivedResumeRecord } from './received-resume-store.js'
import { resumeFileFingerprint } from './received-resume-file.js'
import type { CapturedFile } from './file-transfer.js'
import type { RecruitEngine } from './recruit-engine.js'
import type { ResumeOptions, TaskResult } from '../shared/workbench.js'
import { safeError } from './task-error.js'

/** Stable across sourcing rounds, chat messages and batch tasks, but scoped to
 * this company's store, the target position, person and actual file content. */
export const receivedIngestId = (jobId: string, row: ReceivedResumeRecord) => {
  const fingerprint = row.content ?? row.cached
  if (!fingerprint) throw new Error('附件尚未取得，无法确认文件指纹')
  return `received_${hash([jobId, row.platform, row.conversationId, fingerprint.sha256]).slice(0, 40)}`
}
export async function uploadReceivedFiles(input: { store: Store; engine: RecruitEngine; jobId: string; records: ReceivedResumeRecord[];
  options: ResumeOptions; signal: AbortSignal; readFile: (row: ReceivedResumeRecord, signal: AbortSignal) => Promise<CapturedFile>;
  onResult: (result: TaskResult, index: number) => Promise<void> }) {
  const { store, engine, jobId, records, options, signal, onResult } = input
  if (!options.jobs.some(j => j.id === jobId)) throw new Error('当前职位已失效或无入库权限')
  const destination = options.destinations.find(d => d.id === '1:10')
  const channel = options.channels.find(c => c.id === options.defaults.channel && !c.requires)
  const delivery = options.deliveries.find(d => d.id === options.defaults.delivery)
  if (!destination || !channel || !delivery) throw new Error('默认入库位置或渠道不可用，请在简历入库设置中检查')
  let stopped = false
  for (const [index, row] of records.entries()) {
    signal.throwIfAborted()
    const state = row.uploads?.[jobId]
    let taskId = state?.taskId ?? (row.content || row.cached ? receivedIngestId(jobId, row) : `received_${hash([jobId, row.id, 'pending']).slice(0, 40)}`)
    const key = 'file'
    const save = async (stage: 'saved' | 'unknown' | 'failed', error?: string) => updateReceivedResume(store, row.id, record => {
      record.uploads ??= {}; record.uploads[jobId] = { taskId, stage, at: new Date().toISOString(), ...(error ? { error: safeError(error) } : {}) }
    })
    const result: TaskResult = { key: row.id, name: row.fileName, stage: 'sending', detail: '正在上传到当前职位 · 新简历 · 未处理', updatedAt: new Date().toISOString() }
    const priorOutcome = async (stage?: string) => {
      if (stage === 'saved') {
        await save('saved'); result.stage = 'skipped'; result.detail = '这份附件已上传到当前职位，已跳过'; await onResult(result, index); return true
      }
      if (stage === 'unknown') {
        await save('unknown', '上次上传已停止，请先在薪人薪事核对，未重复提交')
        result.stage = 'unknown'; result.detail = '上次上传已停止，请先在薪人薪事核对，未重复提交'; await onResult(result, index); stopped = true; return true
      }
      return false
    }
    if (await priorOutcome(state?.stage) || await priorOutcome((await engine.result({ taskId, candidateKeys: [key] })).results[0]?.stage)) {
      if (stopped) break
      continue
    }
    let file: CapturedFile
    try {
      file = await input.readFile(row, signal)
      row.content = await resumeFileFingerprint(file)
    } catch (error) {
      signal.throwIfAborted()
      if (/UNKNOWN|TASK_STORAGE_UNAVAILABLE/.test(String(error))) throw error
      result.stage = 'failed'; result.detail = safeError(error); await save('failed', result.detail); await onResult(result, index); continue
    }
    await updateReceivedResume(store, row.id, record => { record.content = row.content })
    taskId = receivedIngestId(jobId, row)
    // A different message may contain the same file. Check its durable receipt after hashing.
    if (await priorOutcome((await engine.result({ taskId, candidateKeys: [key] })).results[0]?.stage)) {
      if (stopped) break
      continue
    }
    await onResult(result, index)
    // Persist before entering the upload pipeline. A crash or lost RPC reply
    // cannot turn a dispatched upload into an automatically retryable item.
    await save('unknown', '上传处理中断时须先核对薪人薪事记录')
    try {
      const captureId = `received-${row.id}`
      const outcome = await engine.ingest({ taskId, files: new Map([[captureId, file]]), items: [{ captureId, candidateKey: key,
        jobId, channelType: channel.channelType, deliveryType: delivery.deliveryType,
        resumeLibrary: destination.resumeLibrary, resumeLibraryStatus: destination.resumeLibraryStatus }] })
      const final = outcome.results[0]
      const stage = final?.stage === 'saved' ? 'saved' : final?.stage === 'failed' ? 'failed' : 'unknown'
      const error = stage === 'saved' ? undefined : safeError(final?.error ?? '上传未返回明确结果，已停止自动处理')
      await save(stage, error)
      result.stage = stage === 'saved' ? 'succeeded' : stage; result.detail = stage === 'saved' ? '已上传到当前职位 · 新简历 · 未处理' : error!
      await onResult({ ...result, updatedAt: new Date().toISOString() }, index)
      if (stage === 'unknown') { stopped = true; break }
    } catch (error) {
      const receipt = (await engine.result({ taskId, candidateKeys: [key] })).results[0]
      const stage = receipt?.stage === 'saved' ? 'saved' : receipt?.stage === 'unknown' ? 'unknown' : 'failed'
      await save(stage, stage === 'saved' ? undefined : safeError(error))
      result.stage = stage === 'saved' ? 'succeeded' : stage; result.detail = stage === 'saved' ? '已上传到当前职位 · 新简历 · 未处理' : safeError(error)
      await onResult(result, index)
      if (stage === 'unknown') { stopped = true; break }
      signal.throwIfAborted()
    }
  }
  return { stopped }
}
