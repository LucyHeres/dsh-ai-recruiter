import { z } from 'zod'
import { BrowserClient, gatewayOutcome, unwrapToolResult } from './browser-client.js'
import { RecruitEngine } from './recruit-engine.js'
import type { XinClient } from './xin-client.js'
import { Store } from './store.js'
import { readUploadChannels } from './upload-options.js'
import { runResumeAgent } from './resume-agent.js'
import { AgentBrowserTools } from './agent-browser-tools.js'
import { releaseOwnedBrowser } from './browser-release.js'
import type { BrowserAgentRunner } from './host-browser-agent.js'
import { safeError } from './task-error.js'
import { resumeDiagnosis } from './resume-diagnosis.js'
import { logError, logKey, type DeveloperLog } from './developer-log.js'
import { selectReceivedResumes, matchesReceivedResume, type ReceivedResumeRecord } from './received-resume-store.js'
import { fetchReceivedResumeFile } from './received-resume-file.js'
import { recruitmentPlatform } from './platforms/registry.js'
import { assertPlatformTaskLogin } from './platform-login.js'
import type { SourcingJob } from '../shared/sourcing.js'
import { uploadReceivedFiles } from './received-resume-upload.js'
import { platformDefinition } from './platforms/catalog.js'
import { ENSURE_TIMEOUT_SECONDS, PLATFORMS, PLATFORM_KEYS, RESUME_DEFAULTS, RESUME_LIBRARIES, RESUME_LIBRARY_STATUSES, DELIVERY_TYPE_OPTIONS, type WorkbenchJob, type ResumeOptions } from '../shared/workbench.js'
import type { WorkbenchTaskExecutor } from './task-executor.js'

/**
 * 表单入参。
 *
 * `destination` 仍是 `大库:小状态` 的字符串：人才库分类 ID 来自运行时接口，
 * 不能固化进枚举。`channel`/`delivery` 同样以字符串 id 传递，避免把 HTML
 * select 的空值语义混进数字字段。
 *
 * 身份字段统一 trim，并把空串折叠成「未提供」——表单在非内推/猎头渠道下会传
 * 空字符串，若不折叠就会被当成显式传入，触发渠道组合校验失败。
 */
const optionalId = z.string().max(64).optional()
  .transform(value => value?.trim())
  .transform(value => (value ? value : undefined))
export const resumeStartSpec = z.object({
  id: z.string().uuid(),
  platform: z.enum(PLATFORM_KEYS),
  platformJobName: z.string().trim().min(1).max(200).optional(),
  jobId: z.string().min(1).max(64),
  destination: z.string().min(1).max(80),
  channel: z.string().min(1).max(16),
  delivery: z.string().min(1).max(8),
  recommenderId: optionalId,
  headhunterSupplierId: optionalId,
  limit: z.number().int().min(1).max(50),
  confirmed: z.literal(true),
}).strict()
type ImportJob = WorkbenchJob & {
  kind: 'resume_import'
  jobId: string
  destination: string
  channel: string
  delivery: string
  recommenderId?: string
  headhunterSupplierId?: string
  roundId?: string
  attachmentIds?: string[]
}
export const receivedResumeStartSpec = z.object({ id: z.string().uuid(), jobId: z.string().min(1).max(64),
  roundId: z.union([z.literal('all'), z.string().uuid()]), attachmentIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(500),
  resumeSource: z.literal('platform_received'), confirmed: z.literal(true) }).strict()
const now = () => new Date().toISOString()

export class ResumeImport implements WorkbenchTaskExecutor {
  readonly kind = 'resume_import' as const
  readonly storagePrefix = 'resume-task-'
  constructor(private browser: BrowserClient, private store: Store, private xinOf: () => XinClient | null,
    private engineOf: (signal?: AbortSignal) => RecruitEngine, private readonly agentOf: () => BrowserAgentRunner, private readonly logger?: DeveloperLog) {}
  create(request: unknown): ImportJob {
    if ((request as any)?.resumeSource === 'platform_received') {
      const input = receivedResumeStartSpec.parse(request)
      return { ...input, platform: 'liepin', destination: '1:10', channel: '', delivery: '1', kind: this.kind, status: 'queued',
        limit: new Set(input.attachmentIds).size, results: [], events: [], detail: '正在准备上传人才列表的附件简历', createdAt: now(), updatedAt: now() }
    }
    const input = resumeStartSpec.parse(request)
    return { ...input, kind: this.kind, status: 'queued', results: [], events: [], detail: '正在准备简历入库', createdAt: now(), updatedAt: now() }
  }
  async options(signal?: AbortSignal): Promise<ResumeOptions> {
    const xin = this.xinOf()
    if (!xin) throw new Error('请先在薪灵完成薪人薪事授权')
    const init = await xin.call('extensionInit', {}, signal)
    if (!init.ok) throw new Error(`薪人薪事授权或职位读取失败：${init.failure.message}`)
    const rows = init.data?.positionNames
    if (!Array.isArray(rows) || rows.some((row: any) => typeof row.jobId !== 'string' || typeof row.jobName !== 'string')) throw new Error('职位列表格式不可识别')
    const jobs = rows.filter((row: any) => row.hireStatus === 0).map((row: any) => ({ id: row.jobId, label: [row.jobName, row.department, row.workCity, row.jobNo].filter(v => typeof v === 'string' && v).join(' · ') }))
    const destinations: ResumeOptions['destinations'] = [
      { id: '1:10', label: '新简历 · 未处理', resumeLibrary: RESUME_LIBRARIES.newResume, resumeLibraryStatus: RESUME_LIBRARY_STATUSES.pending },
      { id: '1:11', label: '新简历 · 待定', resumeLibrary: RESUME_LIBRARIES.newResume, resumeLibraryStatus: RESUME_LIBRARY_STATUSES.undetermined },
    ]
    const labels = await xin.call('destinationLabels', {}, signal)
    if (!labels.ok) throw new Error(`入库位置读取失败：${labels.failure.message}`)
    const walk = (nodes: any, path: string[] = []) => {
      if (!Array.isArray(nodes)) return
      for (const node of nodes) {
        const next = [...path, String(node.labelName ?? '')].filter(Boolean)
        if (node.hasAuth === 1) continue
        if (Array.isArray(node.children) && node.children.length) walk(node.children, next)
        else if (node.hasAuth === 0 && node.resumeType === RESUME_LIBRARIES.talentBank && Number.isInteger(node.typeStatus)) destinations.push({ id: `4:${node.typeStatus}`, label: next.join(' / '), resumeLibrary: RESUME_LIBRARIES.talentBank, resumeLibraryStatus: node.typeStatus })
      }
    }
    walk(labels.data)
    const channels = await readUploadChannels(xin, signal)
    return {
      jobs, destinations,
      channels,
      deliveries: DELIVERY_TYPE_OPTIONS.map(delivery => ({ ...delivery })),
      defaults: { ...RESUME_DEFAULTS, channel: channels.some(row => row.id === RESUME_DEFAULTS.channel) ? RESUME_DEFAULTS.channel : channels[0]?.id ?? '' },
    }
  }
  private async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const out = gatewayOutcome(unwrapToolResult(await this.browser.call(tool, args, undefined, signal)))
    if (out.status !== 'succeeded') throw new Error(`${out.status === 'unknown' ? 'BROWSER_OUTCOME_UNKNOWN: ' : ''}${out.error ?? '浏览器操作失败'}`)
    return out.output
  }
  /** 只读原任务标签页，不导航、不点击、不采集附件。 */
  async inspectPage(job: WorkbenchJob, signal?: AbortSignal) {
    if (job.kind !== this.kind || !job.tabId) throw new Error('该任务未记录招聘页面，请重新启动任务后检查')
    const page = await this.call('browser_snapshot', { tabId: job.tabId, viewportOnly: true,
      policy: { allowedOrigins: [...PLATFORMS[job.platform].origins] } }, signal)
    return resumeDiagnosis(page, 'page_check')
  }
  private async progress(job: ImportJob, phase: string, message: string, source?: 'model' | 'host') {
    job.phase = phase; job.detail = message; job.updatedAt = now()
    this.logger?.updateContext({ phase })
    this.logger?.write('info', 'task.progress', { taskId: job.id, kind: job.kind, platform: job.platform, phase, source: source ?? 'host', processed: job.results.length })
    job.events = [...(job.events ?? []), { at: now(), message, source: source ?? 'host' }].slice(-150)
    try { await this.store.put(`${this.storagePrefix}${job.id}`, job) }
    catch { throw new Error('TASK_STORAGE_UNAVAILABLE: 操作记录无法持久化，已停止') }
  }
  async run(base: WorkbenchJob, signal: AbortSignal) {
    const job = base as ImportJob
    if (job.resumeSource === 'platform_received') return this.runReceived(job, signal)
    await this.store.locked('workbench-browser', async () => {
      let owned = false
      let ownedSession: { workflowTaskId?: string; taskId?: string } | undefined
      const policy = { allowedOrigins: [...PLATFORMS[job.platform].origins], maxWrites: 1000 }
      try {
        await this.progress(job, 'preparing', '正在读取薪人薪事职位和入库权限')
        const options = await this.options(signal)
        const targetJob = options.jobs.find(row => row.id === job.jobId)
        if (!targetJob) throw new Error('目标职位已失效或无权限，请重新选择')
        job.jobName = targetJob.label
        const destination = options.destinations.find(row => row.id === job.destination)
        if (!destination) throw new Error('入库位置已失效或无权限，请重新选择')
        job.destinationLabel = destination.label
        // 渠道、投递类型与身份字段在启动时重新解析一次：表单传的是字符串 id，
        // 真实数值以服务端选项为准，避免把失效或伪造的渠道值提交上去。
        const channel = options.channels.find(row => row.id === job.channel)
        if (!channel) throw new Error('来源渠道已失效，请重新选择')
        if (channel.requires === 'recommenderId' && !job.recommenderId) throw new Error('内推渠道需要填写内推人员工ID')
        if (channel.requires === 'headhunterSupplierId' && !job.headhunterSupplierId) throw new Error('猎头渠道需要填写猎头供应商ID')
        const delivery = options.deliveries.find(row => row.id === job.delivery)
        if (!delivery) throw new Error('投递类型已失效，请重新选择')
        const submission = {
          channelType: channel.channelType,
          deliveryType: delivery.deliveryType,
          ...(channel.requires === 'recommenderId' ? { recommenderId: job.recommenderId } : {}),
          ...(channel.requires === 'headhunterSupplierId' ? { headhunterSupplierId: job.headhunterSupplierId } : {}),
        }
        await this.call('browser_ensure', { timeoutSeconds: ENSURE_TIMEOUT_SECONDS }, signal)
        const state = await this.call('browser_status', {}, signal)
        if (!state.ready || state.workflowTaskId || state.executionOwner === 'remote' || (!state.available && !state.requiresBegin)) throw new Error('浏览器未就绪或被其他任务占用')
        ownedSession = await this.call('browser_begin', {}, signal); owned = true
        job.status = 'running'
        const broker = new AgentBrowserTools(await this.browser.listTools(signal),
          (tool, args, callSignal) => this.call(tool, args, callSignal), { origins: policy.allowedOrigins, signal, confirmationId: `resume-${job.id}`,
            allow: info => !['browser.acquire_file', 'browser.capture_content', 'browser.close_tab'].includes(info._meta?.browserAgent?.capability ?? '') })
        const priorJobs = (await this.store.list<WorkbenchJob>(this.storagePrefix))
          .filter(prior => prior.id !== job.id && prior.platform === job.platform && Array.isArray(prior.results))
        await runResumeAgent({
          job, agent: options => this.agentOf()(options), broker, signal, priorJobs, logger: this.logger,
          goal: { entryUrl: platformDefinition(job.platform).receivedEntry, targetJob: options.jobs.find(row => row.id === job.jobId),
            start: '优先读取并复用已有平台标签页。根据实际页面进入收到的简历，不要重复打开已有平台页面。' },
          progress: (phase, message, source) => this.progress(job, phase, message, source),
          ingest: async (ref, page, result, executionSignal) => {
            const engine = this.engineOf(executionSignal ?? signal)
            const capture = await engine.capture({ tabId: job.tabId!, snapshotId: page.snapshotId, ref,
              documentId: page.documentId, mode: 'download', policy }).catch(error => {
                if (/BROWSER_AGENT_INPUT_INVALID/.test(String(error))) throw new Error('当前薪招扩展不支持监听后点击下载，请配套更新薪招扩展至 3.2.38 或更新版本')
                throw error
              })
            this.logger?.write(capture.complete ? 'info' : 'warn', 'resume.attachment_captured', {
              complete: capture.complete, bytes: capture.size, captureKey: logKey(capture.captureId), captureStrategy: capture.captureStrategy,
            })
            if (!capture.complete || !capture.captureId) throw new Error('简历附件采集不完整，已停止入库')
            await this.progress(job, 'importing', `正在上传简历 ${result.name}`)
            const outcome = await engine.ingest({ taskId: job.id, onProgress: async state => {
              const phase = state.stage === 'saved' ? '已保存' : state.error?.startsWith('文件上传已开始') ? '正在上传附件'
                : state.error?.startsWith('简历预上传已开始') ? '正在解析简历'
                : state.error?.startsWith('简历提交已开始') ? '正在提交入库'
                : state.stage === 'preuploaded' ? '简历解析完成' : state.stage === 'uploaded' ? '附件已上传' : '正在处理'
              result.detail = phase; result.updatedAt = now()
              await this.progress(job, 'importing', `${result.name}：${phase}`)
            }, items: [{ captureId: capture.captureId, candidateKey: result.key, jobId: job.jobId,
              resumeLibrary: destination.resumeLibrary, resumeLibraryStatus: destination.resumeLibraryStatus, ...submission }] })
            const saved = outcome.results[0]
            result.stage = saved?.stage === 'saved' ? 'succeeded' : saved?.stage === 'unknown' ? 'unknown' : 'failed'
            result.detail = saved?.stage === 'saved' ? `已上传到薪人薪事${saved.resumeId ? `，简历编号 ${saved.resumeId}` : ''}` : safeError(saved?.error ?? '未返回入库结果')
            result.updatedAt = now()
            await this.progress(job, result.stage === 'unknown' ? 'finished' : 'reading', `${result.name}：${result.detail}`)
          },
        })
      } catch (error) {
        this.logger?.write(signal.aborted ? 'warn' : 'error', 'resume.interrupted', { taskId: job.id, phase: job.phase, aborted: signal.aborted, ...logError(error) })
        for (const result of job.results) if (result.stage === 'sending') { result.stage = job.phase === 'importing' ? 'unknown' : 'failed'; result.detail = job.phase === 'importing' ? '入库处理被中断，未自动重试' : '采集未完成，未提交入库'; result.updatedAt = now() }
        job.status = job.results.some(r => r.stage === 'unknown') ? 'unknown' : signal.aborted ? 'stopped' : 'failed'
        job.detail = signal.aborted ? '任务已停止' : safeError(error)
        if (job.tabId && !signal.aborted) {
          try {
            const page = await this.call('browser_snapshot', { tabId: job.tabId, viewportOnly: true, policy }, signal)
            job.diagnosis = resumeDiagnosis(page, 'execution_error')
          } catch (diagnosisError) { this.logger?.write('warn', 'resume.diagnosis_unavailable', logError(diagnosisError)) }
        }
        await this.progress(job, 'finished', job.detail)
      } finally {
        if (owned) try { await releaseOwnedBrowser((tool, args, releaseSignal) => this.call(tool, args, releaseSignal), ownedSession) }
        catch (error) {
          this.logger?.write('warn', 'browser.release_failed', logError(error))
          await this.progress(job, 'finished', `${job.detail}；浏览器执行权释放未确认`)
        }
      }
    })
  }
  private async runReceived(job: ImportJob, signal: AbortSignal) {
    await this.store.locked('workbench-browser', async () => {
      try {
        await this.progress(job, 'preparing', '正在核对当前职位的附件和入库权限')
        const records = await selectReceivedResumes(this.store, job.jobId, job.roundId!, job.attachmentIds!)
        const options = await this.options(signal)
        job.jobName = options.jobs.find(row => row.id === job.jobId)?.label
        job.destinationLabel = '新简历 · 未处理'; job.status = 'running'
        const outcome = await uploadReceivedFiles({ store: this.store, engine: this.engineOf(signal), jobId: job.jobId, records, options, signal,
          readFile: (row, readSignal) => this.receivedFile(row, readSignal),
          onResult: async (result, index) => {
            job.results[index] = result
            await this.progress(job, 'importing', `${index + 1}/${records.length}：${result.name} · ${result.detail}`)
          } })
        const saved = job.results.filter(r => r.stage === 'succeeded').length, skipped = job.results.filter(r => r.stage === 'skipped').length, failed = job.results.filter(r => r.stage === 'failed').length
        job.status = outcome.stopped ? 'unknown' : failed ? 'failed' : 'completed'
        await this.progress(job, 'finished', `附件上传结束：成功 ${saved} 份，已上传跳过 ${skipped} 份，失败 ${failed} 份${outcome.stopped ? '；已停止，请先核对薪人薪事记录' : ''}`)
      } catch (error) {
        for (const result of job.results) if (result.stage === 'sending') { result.stage = 'unknown'; result.detail = '上传已中断，请先核对薪人薪事记录' }
        job.status = job.results.some(r => r.stage === 'unknown') ? 'unknown' : signal.aborted ? 'stopped' : 'failed'
        await this.progress(job, 'finished', signal.aborted ? '附件上传已停止' : safeError(error))
      }
    })
  }

  /** Called only with an authorized stored selection and the workbench task lock held. */
  async receivedFile(row: ReceivedResumeRecord, signal: AbortSignal) {
    return fetchReceivedResumeFile({ store: this.store, row, signal, logger: this.logger, refresh: async (record, refreshSignal) => {
      const platform = recruitmentPlatform(record.platform), source = platform.receivedAttachment
      if (!source) throw new Error('当前平台暂不支持重新获取附件链接，请先同步平台简历')
      const jobs = await this.store.list<SourcingJob>('sourcing-')
      const candidate = jobs.flatMap(job => job.candidates ?? []).find(person => person.platformIdentity?.id === record.resumeId && matchesReceivedResume(person, record))
      if (!candidate) throw new Error('附件所属候选人记录不可用，请先同步平台简历')
      let owned: { workflowTaskId?: string; taskId?: string } | undefined, acquired = false
      try {
        await this.call('browser_ensure', { timeoutSeconds: ENSURE_TIMEOUT_SECONDS }, refreshSignal)
        const state = await this.call('browser_status', {}, refreshSignal)
        if (!state.ready || state.workflowTaskId || state.executionOwner === 'remote' || (!state.available && !state.requiresBegin)) throw new Error('浏览器未就绪或被其他任务占用')
        owned = await this.call('browser_begin', {}, refreshSignal); acquired = true
        await assertPlatformTaskLogin((tool, args, requestSignal) => this.call(tool, args ?? {}, requestSignal), record.platform, '重新获取附件链接', refreshSignal)
        const sync = platform.communicationSync
        const broker = new AgentBrowserTools(await this.browser.listTools(refreshSignal),
          (tool, args, requestSignal) => this.call(tool, args, requestSignal), { origins: sync?.origins ?? PLATFORMS[record.platform].origins,
            signal: refreshSignal, confirmationId: `resume-link-${record.id}`, hostTools: sync?.hostTools,
            observationFormat: 'dom', observationViewportOnly: true, observationWait: 'none', logger: this.logger })
        return await source.refresh(broker, candidate, record, this.store, refreshSignal, true)
      } finally {
        if (acquired) try { await releaseOwnedBrowser((tool, args, requestSignal) => this.call(tool, args, requestSignal), owned) }
        catch (error) { this.logger?.write('warn', 'browser.release_failed', logError(error)) }
      }
    } })
  }
}
