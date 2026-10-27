import { positionOverview } from './position-overview.js'
import { sourcingQualifiedCount } from '../shared/sourcing-score.js'
import { greetingHistory } from './greeting-history.js'
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { BrowserClient, gatewayOutcome, unwrapToolResult } from './browser-client.js'
import { Store } from './store.js'
import { listCalls } from './call-journal.js'
import { createGreetingJob, greetingPolicy, dailyUsage, type GreetingPolicy } from './greeting-policy.js'
import { GreetingAgent } from './greeting-agent.js'
import { hostBrowserAgent, type BrowserAgentModelConfig } from './host-browser-agent.js'
import { hostLoginClassifier } from './login-planner.js'
import { safeError } from './task-error.js'
import { logError, type DeveloperLog } from './developer-log.js'
import { detectPlatformLogin, assertPlatformTaskLogin, isPlatformLoginRequired } from './platform-login.js'
import { ExtensionInstallationDetector } from './extension-installation.js'
import { EXTENSION_REQUIRED_CODE } from '../shared/connection-status.js'
import type { ResumeImport } from './resume-import.js'
import type { WorkbenchTaskExecutor } from './task-executor.js'
import { candidateCommunication, communicationIndex, sourcingResults, taskHistoryPage } from './sourcing-review.js'
import { SourcingAgent } from './sourcing-agent.js'
import { readSourcingSettings, saveSourcingSettings, sourcingSettingsPatchSpec } from './sourcing-settings.js'
import { AgentBrowserTools } from './agent-browser-tools.js'
import { candidateContactKeys, candidateResumeReceipt, readCandidateContacts } from './candidate-contact.js'
import { assertCommunicationRead, syncPlatformCommunication } from './communication-sync.js'
import { recruitmentPlatform } from './platforms/registry.js'
import { candidateAttachments, receivedResumes, selectReceivedResumes, receivedResumeStorage, clearReceivedResumeCache } from './received-resume-store.js'
import { ReceivedResumeDownloads } from './received-resume-download.js'
import { dataStorage, clearData } from './data-management.js'
import type { BrowserAgentRunner } from './host-browser-agent.js'
import type { CommunicationSyncResult, SourcingCandidate, SourcingJob, SourcingPosition } from '../shared/sourcing.js'
import { ENSURE_TIMEOUT_SECONDS, PLATFORMS, PLATFORM_KEYS, TASK_FEATURES, type Platform, type TaskKind, type ConnectionState, type GreetingJob, type JobOption, type WorkbenchJob, type WorkbenchState } from '../shared/workbench.js'

const platformSpec = z.enum(PLATFORM_KEYS)
const idSpec = z.string().uuid()
const date = () => new Date().toISOString()
declare module '@deepseek-ai/cordis' { interface Context { aiRecruitWorkbench: Workbench } }

export class Workbench extends TypertRemoteService {
  private readonly executors = new Map<TaskKind, WorkbenchTaskExecutor>()
  private active: { id: string; controller: AbortController; task?: Promise<void> } | null = null
  private operation = false
  private disposed = false
  private initialized?: Promise<void>
  private statusRead?: Promise<ConnectionState>
  private connecting = false
  private resumeDownloads?: ReceivedResumeDownloads
  private readonly fileLifetime = new AbortController()
  private readonly extensionDetector = new ExtensionInstallationDetector()
  private readonly greetingConfig: GreetingPolicy
  private readonly classifyLogin: ReturnType<typeof hostLoginClassifier>
  private sourcing?: SourcingAgent
  constructor(ctx: Context, private readonly browser: BrowserClient, private readonly store: Store,
    private readonly native: () => { registered: boolean; error: string }, private readonly resume: ResumeImport,
    private readonly loadJobOptions: (signal?: AbortSignal) => Promise<JobOption[]>,
    private readonly loadPlatformJobs: (jobId: string, platform: Platform, signal?: AbortSignal) => Promise<{ id: string; name: string }[]>,
    private readonly logger?: DeveloperLog, greetingConfig: Partial<GreetingPolicy> = {}, browserAgentConfig: BrowserAgentModelConfig = {}) {
    super(ctx, 'aiRecruitWorkbench', { namespace: 'aiRecruitWorkbench' })
    this.greetingConfig = greetingPolicy(greetingConfig)
    this.classifyLogin = hostLoginClassifier(ctx, logger)
    const greeting = new GreetingAgent(store, (tool, args, signal) => this.call(tool, args, signal), signal => this.begin(signal), signal => browser.listTools(signal), hostBrowserAgent(ctx, logger, browserAgentConfig), logger, this.greetingConfig)
    this.registerTask({ kind: 'greeting', storagePrefix: 'greeting-', create: request => createGreetingJob(request, this.greetingConfig),
      run: (job, signal) => greeting.run(job as GreetingJob, signal) })
    this.registerTask(resume)
    ctx.effect(() => async () => {
      this.disposed = true
      this.fileLifetime.abort()
      this.resumeDownloads?.dispose()
      this.active?.controller.abort()
      await this.active?.task
    })
  }
  /** Host-only registration; an unregistered feature cannot be started from the UI. */
  registerTask(executor: WorkbenchTaskExecutor) {
    if (this.active || this.initialized) throw new Error('任务类型必须在工作台初始化前注册')
    if (this.executors.has(executor.kind)) throw new Error('任务类型已注册')
    if (!executor.storagePrefix || [...this.executors.values()].some(existing => existing.storagePrefix.startsWith(executor.storagePrefix) || executor.storagePrefix.startsWith(existing.storagePrefix))) throw new Error('任务记录前缀必须独立')
    this.executors.set(executor.kind, executor)
  }
  private async listJobs(includeCleared = false): Promise<WorkbenchJob[]> {
    const groups = await Promise.all([...this.executors.values()].map(async executor =>
      (await this.store.list<WorkbenchJob>(executor.storagePrefix))
        .filter(job => !!job.id && Array.isArray(job.results) && (includeCleared || !job.historyCleared))
        .map(job => ({ ...job, kind: executor.kind }))))
    return groups.flat()
  }
  registerSourcing(loadPosition: (jobId: string, signal?: AbortSignal) => Promise<SourcingPosition>, agentOf: () => BrowserAgentRunner) {
    this.sourcing = new SourcingAgent(this.store, (tool, args, signal) => this.call(tool, args, signal), signal => this.begin(signal), signal => this.browser.listTools(signal), agentOf, loadPosition, this.logger, { loadPlatformJobs: this.loadPlatformJobs, greetingPolicy: this.greetingConfig })
    this.registerTask(this.sourcing)
  }
  private recordKey(job: WorkbenchJob) {
    const executor = this.executors.get(job.kind)
    if (!executor) throw new Error('任务类型尚未接入')
    return `${executor.storagePrefix}${job.id}`
  }
  /** Shared with chat tools so a workstation task cannot interleave with another caller. */
  reserve() {
    if (this.disposed) throw new Error('插件已卸载')
    if (this.active || this.operation) throw new Error('BROWSER_AGENT_BUSY: 工作台正在操作浏览器，请等待或停止任务')
    this.operation = true
    return () => { this.operation = false }
  }
  private async call(tool: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
    const outcome = gatewayOutcome(unwrapToolResult(await this.browser.call(tool, args, undefined, signal)))
    if (outcome.status !== 'succeeded') throw new Error(`${outcome.status === 'unknown' ? 'BROWSER_OUTCOME_UNKNOWN: ' : ''}${outcome.error ?? 'GATEWAY_FAILED'}`)
    return outcome.output
  }
  private async initialize() {
    this.initialized ??= (async () => {
      for (const job of await this.listJobs()) {
        if (!['queued', 'running', 'stopping'].includes(job.status)) continue
        for (const result of job.results) if (result.stage === 'sending') {
          result.stage = 'unknown'; result.detail = '前次执行中断，请在平台核对，禁止自动重发'
        }
        if (job.kind === 'talent_sourcing') for (const row of (job as SourcingJob).greetings ?? []) if (row.stage === 'sending') { row.stage = row.attemptedAt ? 'unknown' : 'skipped'; row.detail = row.attemptedAt ? '前次招呼中断，禁止自动重发，请在平台核对' : '前次中断，未派发招呼' }
        job.status = (job as SourcingJob).greetings?.some(row => row.stage === 'unknown') || job.results.some(r => r.stage === 'unknown') ? 'unknown' : 'stopped'
        job.detail = '前次进程中断，任务不会自动恢复'; job.updatedAt = date()
        if (job.kind === 'talent_sourcing') for (const channel of (job as SourcingJob).channels) {
          if (channel.status === 'running' || channel.status === 'queued') { channel.status = 'stopped'; channel.detail = job.detail }
        }
        await this.save(job)
      }
    })()
    await this.initialized
  }
  private save(job: WorkbenchJob) { job.updatedAt = date(); return this.store.put(this.recordKey(job), job) }
  private async connection(): Promise<ConnectionState> {
    if (this.statusRead) return this.statusRead
    const task = (async () => {
      const base: ConnectionState = { gateway: false, connected: false, authenticated: false, ready: false, available: false, busy: !!this.active || this.operation, connecting: this.connecting === true, requiresBegin: false, executionOwner: null, activeWorkflow: false, detail: '网关未运行，请点击启动连接' }
      try {
        const raw = await this.call('browser_status')
        return { ...base, gateway: true, connected: raw.connected === true, authenticated: raw.authenticated === true,
          ready: raw.connected === true && raw.authenticated === true && raw.ready === true,
          available: raw.available === true, busy: base.busy || raw.busy === true,
          requiresBegin: raw.requiresBegin === true, executionOwner: typeof raw.executionOwner === 'string' ? raw.executionOwner : null,
          activeWorkflow: !!raw.workflowTaskId,
          detail: raw.ready === true ? '扩展已就绪' : '网关已启动，等待扩展连接或授权' }
      } catch { return base }
    })()
    this.statusRead = task
    try { return await task } finally { this.statusRead = undefined }
  }
  @Remote
  async greetingJobOptions(request: unknown, signal?: AbortSignal) { return this.loadJobOptions(signal) }
  @Remote
  async sourcingPosition(request: unknown, signal?: AbortSignal) {
    const { jobId } = z.object({ jobId: z.string().min(1).max(64) }).strict().parse(request)
    if (!this.sourcing) throw new Error('人才寻聘尚未接入')
    const [position, settings] = await Promise.all([this.sourcing.loadPosition(jobId, signal), readSourcingSettings(this.store, jobId)])
    return { ...position, settings }
  }
  @Remote
  async saveSourcingSettings(request: unknown) {
    const { jobId, settings } = z.object({ jobId: z.string().min(1).max(64), settings: sourcingSettingsPatchSpec }).strict().parse(request)
    return saveSourcingSettings(this.store, jobId, settings)
  }
  @Remote
  async positionOverview() {
    await this.initialize()
    const [options, tasks] = await Promise.all([this.loadJobOptions(), this.listJobs(true)])
    return positionOverview(options, tasks, this.active?.id)
  }
  @Remote
  async sourcingHistory(request: unknown) {
    const { jobId } = z.object({ jobId: z.string().min(1).max(64) }).strict().parse(request)
    await this.initialize()
    return (await this.store.list<SourcingJob>('sourcing-')).filter(job => job.kind === 'talent_sourcing' && job.jobId === jobId && !job.talentCleared)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50).map(({ candidates, ...job }) => ({ ...job, candidateCount: sourcingQualifiedCount({ ...job, candidates }) }))
  }
  @Remote
  async sourcingBatch(request: unknown) {
    const { id, jobId } = z.object({ id: idSpec, jobId: z.string().min(1).max(64) }).strict().parse(request)
    const job = await this.store.find<SourcingJob>(`sourcing-${id}`)
    if (!job || job.kind !== 'talent_sourcing' || job.jobId !== jobId) throw new Error('该职位下没有这轮寻聘记录')
    const [greetings, contacts, attachments] = await Promise.all([greetingHistory(this.store), readCandidateContacts(this.store), receivedResumes(this.store)])
    const communications = communicationIndex(greetings, contacts)
    return { ...job, candidates: job.candidates.map(candidate => ({ ...candidate, communication: candidateCommunication(candidate, communications), ...candidateResumeReceipt(candidate, contacts), resumeAttachments: candidateAttachments(candidate, jobId, attachments) })) }
  }
  @Remote
  async sourcingResults(request: unknown) {
    const { jobId, roundId } = z.object({ jobId: z.string().min(1).max(64), roundId: z.union([z.literal('all'), idSpec]).default('all') }).strict().parse(request)
    await this.initialize()
    const [jobs, greetings, contacts, attachments] = await Promise.all([this.store.list<SourcingJob>('sourcing-'), this.store.list<WorkbenchJob>('greeting-'), readCandidateContacts(this.store), receivedResumes(this.store)])
    return sourcingResults(jobs, jobId, roundId, communicationIndex([...greetings, ...jobs], contacts), contacts, attachments)
  }
  @Remote
  async sourcingCandidate(request: unknown) {
    const { jobId, id, key } = z.object({ jobId: z.string().min(1).max(64), id: idSpec, key: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request)
    const job = await this.store.find<SourcingJob>(`sourcing-${id}`)
    if (!job || job.kind !== 'talent_sourcing' || job.jobId !== jobId) throw new Error('该职位下没有这轮寻聘记录')
    const candidate = job.candidates.find(row => row.key === key)
    if (!candidate) throw new Error('该轮次没有这位候选人的评估记录')
    const [greetings, contacts, attachments] = await Promise.all([greetingHistory(this.store), readCandidateContacts(this.store), receivedResumes(this.store)])
    const communications = communicationIndex(greetings, contacts)
    return { jobId, roundId: id, candidate: { ...candidate, communication: candidateCommunication(candidate, communications), ...candidateResumeReceipt(candidate, contacts), resumeAttachments: candidateAttachments(candidate, jobId, attachments) }, position: job.position, requirements: job.requirements, supplement: job.supplement }
  }
  @Remote
  async downloadReceivedResume(request: unknown, requestedSignal?: AbortSignal): Promise<import('../shared/sourcing.js').ResumeDownloadChunk> {
    const { jobId, roundId, key, attachmentId, offset, downloadId } = z.object({ jobId: z.string().min(1).max(64), roundId: idSpec,
      key: z.string().regex(/^[a-f0-9]{64}$/), attachmentId: z.string().regex(/^[a-f0-9]{64}$/),
      offset: z.number().int().min(0).max(20 * 1024 * 1024).default(0), downloadId: idSpec.optional() }).strict().parse(request)
    const [row] = await selectReceivedResumes(this.store, jobId, roundId, [attachmentId], key)
    const signal = AbortSignal.any([AbortSignal.timeout(180000), ...(requestedSignal ? [requestedSignal] : []), ...(this.fileLifetime ? [this.fileLifetime.signal] : [])])
    signal.throwIfAborted()
    this.resumeDownloads ??= new ReceivedResumeDownloads()
    return this.resumeDownloads.read(JSON.stringify([jobId, roundId, key, attachmentId]), offset, downloadId, async () => {
      const release = this.reserve()
      try { return await this.store.locked('workbench-browser', () => this.resume.receivedFile(row, signal)) }
      finally { release() }
    })
  }
  @Remote
  async resumeStorage() { return receivedResumeStorage(this.store) }
  @Remote
  async dataStorage() { return dataStorage(this.store) }
  @Remote
  async clearData(request: unknown) {
    const { group } = z.object({ group: z.enum(['tasks', 'talents']), confirmed: z.literal(true) }).strict().parse(request)
    await this.initialize()
    const release = this.reserve()
    try {
      return await this.store.locked('workbench-browser', () => clearData(this.store, group, async () => {
        if (!this.logger) throw new Error('开发日志服务未初始化，无法清理任务日志')
        await this.logger.clear()
      }))
    } finally { release() }
  }
  @Remote
  async clearResumeCache(request: unknown) {
    z.object({ confirmed: z.literal(true) }).strict().parse(request)
    const release = this.reserve()
    try { return await this.store.locked('workbench-browser', () => clearReceivedResumeCache(this.store)) }
    finally { release() }
  }
  @Remote
  async uploadReceivedResumes(request: unknown) {
    const input = z.object({ id: idSpec, jobId: z.string().min(1).max(64), roundId: z.union([z.literal('all'), idSpec]),
      attachmentIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(500) }).strict().parse(request)
    // Validate ownership before creating a task or looking up any file bytes.
    await selectReceivedResumes(this.store, input.jobId, input.roundId, input.attachmentIds)
    return this.startTask({ ...input, kind: 'resume_import', resumeSource: 'platform_received', confirmed: true })
  }
  @Remote
  async syncCommunication(request: unknown, requestedSignal?: AbortSignal): Promise<CommunicationSyncResult> {
    const { jobId, roundId } = z.object({ jobId: z.string().min(1).max(64), roundId: z.union([z.literal('all'), idSpec]).default('all') }).strict().parse(request)
    await this.initialize()
    const release = this.reserve(); let owned = false
    const signal = requestedSignal ? AbortSignal.any([requestedSignal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000)
    try {
      const [jobs, greetings, contacts] = await Promise.all([this.store.list<SourcingJob>('sourcing-'), greetingHistory(this.store), readCandidateContacts(this.store)])
      const index = communicationIndex(greetings, contacts), candidates = new Map<string, SourcingCandidate>()
      const visible = new Set(sourcingResults(jobs, jobId, roundId, index, contacts).candidates.map(row => `${row.roundId}:${row.key}`))
      for (const job of jobs.filter(job => job.jobId === jobId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))) for (const candidate of job.candidates) {
        if (!visible.has(`${job.id}:${candidate.key}`)) continue
        const key = candidateContactKeys(candidate)[0]!
        if (!candidates.has(key)) candidates.set(key, { ...candidate, communication: candidateCommunication(candidate, index), ...candidateResumeReceipt(candidate, contacts) })
      }
      const result: CommunicationSyncResult = { checked: candidates.size, matched: 0, updated: 0, platforms: [] }
      if (!candidates.size) return result
      await this.begin(signal); owned = true
      const tools = await this.browser.listTools(signal)
      for (const platform of [...new Set([...candidates.values()].map(candidate => candidate.platform))]) {
        // 平台差异只来自注册表：缺省走通用 DOM 读取，声明了专有同步则直接用。
        const sync = recruitmentPlatform(platform).communicationSync
        const broker = new AgentBrowserTools(tools, (name, args, toolSignal) => this.call(name, args, toolSignal), {
          origins: sync?.origins ?? PLATFORMS[platform].origins, signal, confirmationId: `communication-read-${jobId}-${Date.now()}`,
          hostTools: sync?.hostTools,
          observationFormat: 'dom', observationViewportOnly: true, observationWait: 'none', logger: this.logger })
        broker.setBeforeCall(async call => { assertCommunicationRead(call, broker.currentPage()) })
        try {
          await assertPlatformTaskLogin((tool, args, checkSignal) => this.call(tool, args, checkSignal), platform, '同步平台简历', signal)
          const synced = sync?.sync ? await sync.sync(broker, [...candidates.values()], this.store, signal)
            : await syncPlatformCommunication(broker, platform, [...candidates.values()], this.store, signal)
          result.matched += synced.matched; result.updated += synced.updated
          result.platforms.push({ platform, matched: synced.matched, detail: synced.detail, status: synced.status, scanned: synced.scanned, unidentified: synced.unidentified })
        } catch (error) {
          signal.throwIfAborted()
          if (/OUTCOME_UNKNOWN|RESULT_UNKNOWN/.test(String(error))) throw error
          result.platforms.push({ platform, matched: 0, detail: safeError(error), status: 'failed' })
          if (isPlatformLoginRequired(error)) break
        }
      }
      this.logger?.write('info', 'communication.synced', { checked: result.checked, matched: result.matched, updated: result.updated,
        platforms: result.platforms.map(({ platform, status, scanned, unidentified }) => ({ platform, status, scanned, unidentified })) })
      return result
    } finally { try { if (owned) await this.call('browser_finish') } finally { release() } }
  }
  @Remote
  async taskHistory(request: unknown) {
    const { page, kind } = z.object({ page: z.number().int().min(1).max(100000).default(1), kind: z.enum(['greeting', 'resume_import', 'talent_sourcing']).optional() }).strict().parse(request)
    await this.initialize()
    return taskHistoryPage(await this.listJobs(), page, kind)
  }
  @Remote
  async taskDetail(request: unknown) {
    const { id } = z.object({ id: idSpec }).strict().parse(request)
    await this.initialize()
    const job = (await this.listJobs()).find(row => row.id === id)
    if (!job) throw new Error('任务不存在或已移除')
    return job.kind === 'talent_sourcing' ? { ...job, candidates: [] } : job
  }
  @Remote
  async resumeOptions(request: unknown, signal?: AbortSignal) { return this.resume.options(signal) }
  @Remote
  async developerLogs(request: unknown) {
    const { id, limit } = z.object({ id: idSpec.optional(), limit: z.number().int().min(1).max(1000).default(300) }).strict().parse(request)
    if (!this.logger) throw new Error('开发日志服务未初始化')
    if (id && !(await this.listJobs()).some(job => job.id === id)) throw new Error('任务不存在')
    return this.logger.read(id, limit)
  }
  @Remote
  async resumeDiagnosis(request: unknown, signal?: AbortSignal) {
    const { id } = z.object({ id: idSpec }).strict().parse(request)
    const job = await this.store.find<WorkbenchJob>(`${this.resume.storagePrefix}${id}`)
    if (!job || job.kind !== 'resume_import') throw new Error('简历入库任务不存在')
    const release = this.reserve(); let owned = false
    const inspect = async () => {
      try {
        await this.begin(signal); owned = true
        return await this.store.locked('workbench-browser', () => this.resume.inspectPage(job, signal))
      } finally { try { if (owned) await this.call('browser_finish') } finally { release() } }
    }
    return this.logger ? this.logger.withContext({ taskId: id, kind: job.kind, platform: job.platform },
      () => this.logger!.trace('resume.page_check', {}, inspect, diagnosis => ({ candidateCount: diagnosis.candidateCount, elementCount: diagnosis.elementCount, reasons: diagnosis.reasons }))) : inspect()
  }
  @Remote
  async state(): Promise<WorkbenchState> {
    await this.initialize()
    const allJobs = await this.listJobs(true)
    const jobs = allJobs.filter(job => !job.historyCleared).map(job => job.kind === 'talent_sourcing' ? { ...job, candidates: [] } : job)
    const connection = await this.connection()
    return { features: TASK_FEATURES.map(feature => ({ ...feature, available: this.executors.has(feature.kind) })), connection, extensionInstallation: await this.extensionDetector.read(connection.connected && connection.authenticated), jobs: jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30), activeJobId: this.active?.id ?? null, nativeConnection: this.native(), dailyUsage: dailyUsage(allJobs), dailyLimit: this.greetingConfig.dailyLimit }
  }
  @Remote
  async checkExtension(request: unknown) {
    z.object({}).strict().parse(request)
    const connection = await this.connection()
    return this.extensionDetector.read(connection.connected && connection.authenticated, true)
  }
  @Remote
  async connect(signal?: AbortSignal) {
    const release = this.reserve()
    try { await this.ensureConnection(signal); return await this.connection() }
    finally { release() }
  }
  private async ensureConnection(signal?: AbortSignal, timeoutMs = (ENSURE_TIMEOUT_SECONDS + 5) * 1000) {
    await this.assertExtensionInstalled(signal)
    const deadline = AbortSignal.timeout(timeoutMs)
    const connectionSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
    this.connecting = true
    try { await this.call('browser_ensure', { timeoutSeconds: ENSURE_TIMEOUT_SECONDS }, connectionSignal) }
    catch (error) {
      if (!signal?.aborted && (deadline.aborted || /等待扩展连接超时/.test(String(error)))) throw new Error(`BROWSER_CONNECTION_TIMEOUT: 浏览器扩展在 ${ENSURE_TIMEOUT_SECONDS} 秒内未连接成功，请确认浏览器已打开且薪招扩展已启用，再点击“连接浏览器”重试`)
      throw error
    } finally { this.connecting = false }
  }
  private async assertExtensionInstalled(signal?: AbortSignal) {
    signal?.throwIfAborted()
    const connection = await this.connection()
    const installation = await this.extensionDetector.read(connection.connected && connection.authenticated, true)
    signal?.throwIfAborted()
    if (this.disposed) throw new Error('插件已卸载')
    if (installation.status === 'not_installed') throw new Error(`${EXTENSION_REQUIRED_CODE}: 尚未安装薪招浏览器扩展，请先安装后再开始任务。`)
  }
  @Remote
  async pair(signal?: AbortSignal) {
    const release = this.reserve()
    try {
      await this.assertExtensionInstalled(signal)
      const raw = await this.call('browser_setup', {}, signal)
      const link = new URL(raw.pairingUrl)
      if (link.protocol !== 'http:' || link.hostname !== '127.0.0.1' || link.pathname !== '/xinzhao-pair') throw new Error('备用配对链接无效，请检查网关配置')
      // One-time links are only returned to this explicit UI action, never saved in job/state.
      return { pairingUrl: link.href, expiresAt: raw.expiresAt }
    } finally { release() }
  }
  private async begin(signal?: AbortSignal) {
    await this.ensureConnection(signal)
    const state = await this.connection()
    if (!state.ready || (!state.available && !state.requiresBegin) || state.activeWorkflow || state.executionOwner === 'remote') throw new Error('BROWSER_AGENT_BUSY: 浏览器未就绪或已有任务持有执行权')
    await this.call('browser_begin', {}, signal)
  }
  /** Standalone discovery must not leave an implicit workflow locking the drawer.
   * An existing workflow still owns its lifetime, including any probes. */
  async browserProbe<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const state = await this.connection()
    if (state.activeWorkflow) return read()
    await this.begin(signal)
    try { return await read() }
    finally { await this.call('browser_finish') }
  }
  @Remote
  async tabs(request: unknown, signal?: AbortSignal) {
    const platform = z.object({ platform: platformSpec }).strict().parse(request).platform
    const release = this.reserve(); let owned = false
    try {
      await this.begin(signal); owned = true
      const output = await this.call('browser_list_tabs', { policy: { allowedOrigins: [...PLATFORMS[platform].origins] } }, signal)
      return { tabs: (Array.isArray(output?.tabs) ? output.tabs : []).filter((tab: any) => { try { return new URL(tab.url).origin === new URL(PLATFORMS[platform].url).origin } catch { return false } }).map((tab: any) => ({ tabId: tab.tabId, title: String(tab.title ?? ''), url: String(tab.url ?? '') })) }
    } finally { try { if (owned) await this.call('browser_finish') } finally { release() } }
  }
  @Remote
  async open(request: unknown, signal?: AbortSignal) {
    const platform = z.object({ platform: platformSpec }).strict().parse(request).platform
    const release = this.reserve(); let owned = false
    try {
      await this.begin(signal); owned = true
      return await this.call('browser_open_tab', { url: PLATFORMS[platform].url, policy: { allowedOrigins: [...PLATFORMS[platform].origins] } }, signal)
    } finally { try { if (owned) await this.call('browser_finish') } finally { release() } }
  }
  @Remote
  async platformLogin(request: unknown, signal?: AbortSignal) {
    const { platform, open } = z.object({ platform: platformSpec, open: z.boolean().default(false) }).strict().parse(request)
    const release = this.reserve(); let owned = false
    try {
      await this.begin(signal); owned = true
      return await detectPlatformLogin((tool, args, checkSignal) => this.call(tool, args, checkSignal), platform, open, signal, this.classifyLogin)
    } finally { try { if (owned) await this.call('browser_finish') } finally { release() } }
  }
  @Remote
  async start(request: unknown) {
    const execute = () => this.startTask(request)
    return this.logger ? this.logger.trace('workbench.start', {}, execute,
      job => ({ taskId: job.id, kind: job.kind, platform: job.platform, status: job.status })) : execute()
  }
  async startSession(request: unknown, sessionId: string, callId: string) {
    z.string().min(1).max(200).parse(sessionId)
    const input = z.object({ kind: z.enum(['greeting', 'resume_import', 'talent_sourcing']) }).passthrough().parse(request)
    const digest = createHash('sha256').update(`${sessionId}:${callId}:${input.kind}`).digest('hex')
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
    return this.startTask({ ...input, id }, sessionId)
  }
  @Remote
  async startSessionTask(request: unknown) {
    const input = z.object({ sessionId: z.string().min(1).max(200), task: z.object({ id: idSpec, kind: z.literal('talent_sourcing') }).passthrough() }).strict().parse(request)
    return this.startTask(input.task, input.sessionId)
  }
  @Remote
  async sessionTasks(request: unknown) {
    const { sessionId } = z.object({ sessionId: z.string().min(1).max(200) }).strict().parse(request)
    await this.initialize()
    const jobs = (await this.listJobs()).filter(job => job.source === 'chat' && job.sessionId === sessionId)
      .sort((first, second) => second.createdAt.localeCompare(first.createdAt)).slice(0, 20)
    const calls = listCalls(sessionId)
    const latestPositionId = [...jobs.filter(job => job.jobId).map(job => ({ at: job.createdAt, jobId: job.jobId })),
      ...calls.filter(call => call.ok && call.jobId).map(call => ({ at: call.at, jobId: call.jobId }))]
      .sort((a, b) => b.at.localeCompare(a.at))[0]?.jobId
    return { jobs: jobs.map(job => job.kind === 'talent_sourcing' ? { ...job, candidates: [] } : job), activeJobId: jobs.some(job => job.id === this.active?.id) ? this.active!.id : null, calls, latestPositionId }
  }
  async stopSession(sessionId: string, id: string) {
    const state = await this.sessionTasks({ sessionId })
    if (!state.jobs.some(job => job.id === id)) throw new Error('当前会话不存在该招聘任务')
    return this.stop({ id })
  }
  private async startTask(request: unknown, sessionId?: string) {
    const { kind, ...input } = z.object({ kind: z.enum(['greeting', 'resume_import', 'talent_sourcing']).default('greeting') }).passthrough().parse(request)
    const executor = this.executors.get(kind)
    if (!executor) throw new Error('该功能尚未接入工作台')
    const job = executor.create(input)
    job.source = sessionId ? 'chat' : 'workbench'
    if (sessionId) job.sessionId = sessionId
    if (job.kind !== kind) throw new Error('任务类型不匹配')
    await this.initialize()
    // A lost response can be reconciled with the same id; it never creates a second send task.
    const prior = await this.store.find<WorkbenchJob>(this.recordKey(job))
    if (prior) { if (sessionId && prior.sessionId !== sessionId) throw new Error('当前会话不存在该招聘任务'); this.logger?.write('info', 'task.reused', { taskId: job.id, kind }); return { ...prior, kind } }
    const release = this.reserve()
    const controller = new AbortController()
    const active = { id: job.id, controller, task: undefined as Promise<void> | undefined }
    try {
      // Reject missing prerequisites before accepting, preparing or saving a new task.
      if (!(job.kind === 'resume_import' && job.resumeSource === 'platform_received')) await this.assertExtensionInstalled(controller.signal)
      this.active = active
      this.logger?.write('info', 'task.accepted', { taskId: job.id, kind, platform: job.platform, limit: job.limit })
      if (job.kind === 'talent_sourcing') await this.sourcing!.prepare(job as SourcingJob, controller.signal)
      if (job.kind === 'greeting' && (job as GreetingJob).jobId) {
        const greeting = job as GreetingJob
        const selected = (await this.loadJobOptions(controller.signal)).find(option => option.id === greeting.jobId)
        if (!selected) throw new Error('所选职位已失效或无权限，请刷新后重新选择')
        greeting.jobName = selected.name
        greeting.platformJobs = await this.loadPlatformJobs(greeting.jobId!, greeting.platform, controller.signal)
      }
      await this.save(job)
      const execute = () => executor.run(job, controller.signal).catch(async error => {
        this.logger?.write('error', 'task.failed', { phase: job.phase, ...logError(error) })
        if (job.kind === 'talent_sourcing') for (const row of (job as SourcingJob).greetings ?? []) if (row.stage === 'sending') { row.stage = row.attemptedAt ? 'unknown' : 'skipped'; row.detail = row.attemptedAt ? '前次招呼中断，禁止自动重发，请在平台核对' : '前次中断，未派发招呼' }
        job.status = (job as SourcingJob).greetings?.some(row => row.stage === 'unknown') || job.results.some(r => r.stage === 'sending' || r.stage === 'unknown') ? 'unknown' : 'failed'
        job.detail = safeError(error)
        for (const result of job.results) if (result.stage === 'sending') result.stage = 'unknown'
        await this.save(job)
      }).finally(() => {
        this.logger?.write(['failed', 'unknown'].includes(job.status) ? 'warn' : 'info', 'task.finished', {
          taskId: job.id, kind, platform: job.platform, status: job.status, phase: job.phase,
          durationMs: Date.now() - Date.parse(job.createdAt),
          processed: job.results.length, succeeded: job.results.filter(r => r.stage === 'succeeded').length,
          failed: job.results.filter(r => r.stage === 'failed').length, unknown: job.results.filter(r => r.stage === 'unknown').length,
        })
        if (this.active === active) this.active = null
      })
      active.task = this.logger ? this.logger.withContext({ taskId: job.id, kind, platform: job.platform }, execute) : execute()
      return JSON.parse(JSON.stringify(job)) as WorkbenchJob
    } catch (error) { this.logger?.write('error', 'task.start_failed', { taskId: job.id, kind, ...logError(error) }); this.active = null; throw error }
    finally { release() }
  }
  @Remote
  async stop(request: unknown) {
    const id = z.object({ id: idSpec }).strict().parse(request).id
    this.logger?.write('info', 'task.stop_requested', { taskId: id, active: this.active?.id === id })
    if (this.active?.id === id) this.active.controller.abort()
    return { stopping: this.active?.id === id }
  }
}
