import type { GreetingPolicy } from './greeting-policy.js'
import type { BrowserAgentRunner } from './host-browser-agent.js'
import type { McpToolInfo } from './browser-client.js'
import type { DeveloperLog } from './developer-log.js'
import { Store } from './store.js'
import { safeError } from './task-error.js'
import { sourcingSource, sourcingStartSpec, sourcingVersion, validateCriteria } from './sourcing-policy.js'
import { PLATFORMS, type Platform, type WorkbenchJob } from '../shared/workbench.js'
import type { SourcingJob, SourcingPosition, SourcingRequirements } from '../shared/sourcing.js'
import { sourcingTotalTarget } from '../shared/sourcing-score.js'
import { deriveSourcingSearchFilters } from './sourcing-search.js'
import { sourcingChannelReason } from '../shared/sourcing-status.js'
import { sourcingPlatformsForChannels } from '../shared/published-channels.js'
import { createSourcingSession } from './sourcing/session.js'
import { sourcingEntry, sourcingMode } from './sourcing/source.js'
import { recruitmentPlatform } from './platforms/registry.js'

const now = () => new Date().toISOString()

export class SourcingAgent {
  readonly kind = 'talent_sourcing' as const
  readonly storagePrefix = 'sourcing-'
  constructor(private readonly store: Store,
    private readonly call: (tool: string, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>,
    private readonly begin: (signal?: AbortSignal) => Promise<void>, private readonly listTools: (signal?: AbortSignal) => Promise<McpToolInfo[]>,
    private readonly agentOf: () => BrowserAgentRunner,
    readonly loadPosition: (jobId: string, signal?: AbortSignal) => Promise<SourcingPosition>, private readonly logger?: DeveloperLog, private readonly options: { loadPlatformJobs?: (jobId: string, platform: Platform, signal?: AbortSignal) => Promise<{ id: string; name: string }[]>; greetingPolicy?: Partial<GreetingPolicy> } = {}) {}
  create(request: unknown): SourcingJob {
    const input = sourcingStartSpec.parse(request)
    return { kind: this.kind, id: input.id, jobId: input.jobId, platform: input.platforms[0], platforms: input.platforms,
      supplement: input.supplement, sourceMode: input.sourceMode, limit: input.limit, limitScope: 'per_platform', minimumScore: input.minimumScore, autoGreet: input.autoGreet, greetings: [], scanned: 0, skippedLowScore: 0, candidates: [], channels: input.platforms.map(platform => ({ platform, status: 'queued', detail: '尚未开始', candidateCount: 0, limit: input.limit })),
      status: 'queued', detail: '正在读取职位要求', results: [], events: [], createdAt: now(), updatedAt: now() }
  }
  async prepare(job: SourcingJob, signal: AbortSignal) {
    job.position = await this.loadPosition(job.jobId, signal); job.jobName = job.position.name
    const available = job.position.publishedChannels ? sourcingPlatformsForChannels(job.position.publishedChannels) : job.position.platforms ?? []
    const unavailable = job.platforms.filter(platform => !available.includes(platform))
    if (unavailable.length) throw new Error(`SOURCING_PLATFORM_NOT_CONNECTED: 当前职位尚未对接同步${unavailable.map(platform => PLATFORMS[platform].label).join('、')}，请先在薪人薪事同步职位后刷新再试`)
    for (const platform of job.platforms) sourcingEntry(recruitmentPlatform(platform), job)
    if (!job.position.description && !job.supplement) throw new Error('该职位尚无职位说明，请补充本轮招聘要求再开始寻聘')
    job.searchFilters = deriveSourcingSearchFilters(job.position, job.supplement)
    job.platformJobs = {}
    for (const platform of job.platforms) job.platformJobs[platform] = await this.options.loadPlatformJobs?.(job.jobId, platform, signal) ?? []
    job.requirementVersion = sourcingVersion(job.position, job.supplement)
    const prior = await this.store.find<SourcingRequirements>(`criteria-${job.requirementVersion}`)
    if (prior) { validateCriteria(prior.criteria, sourcingSource(job.position, job.supplement)); job.requirements = prior }
  }
  private async save(job: SourcingJob) {
    job.updatedAt = now()
    try { await this.store.put(`${this.storagePrefix}${job.id}`, job) }
    catch { throw new Error('TASK_STORAGE_UNAVAILABLE: 寻聘记录无法保存，已停止') }
  }
  private async progress(job: SourcingJob, phase: string, message: string, source: 'model' | 'host' = 'host') {
    job.phase = phase; job.detail = safeError(message)
    job.events = [...(job.events ?? []), { at: now(), message: job.detail, source }].slice(-100)
    await this.save(job)
  }
  async run(raw: WorkbenchJob, signal: AbortSignal) {
    const job = raw as SourcingJob
    const totalTarget = sourcingTotalTarget(job)
    await this.store.locked('workbench-browser', async () => {
      let owned = false
      let interruption = ''
      try {
        const agent = this.agentOf()
        const history = (await this.store.list<SourcingJob>(this.storagePrefix)).filter(row => row.kind === this.kind && row.jobId === job.jobId && row.requirementVersion === job.requirementVersion && row.id !== job.id)
        const previous = new Set(history.flatMap(row => row.candidates ?? []).map(row => row.key))
        await this.begin(signal); owned = true; job.status = 'running'
        for (const channel of job.channels) {
          signal.throwIfAborted()
          if (job.candidates.length >= totalTarget) break
          channel.status = 'running'
          this.logger?.updateContext({ platform: channel.platform })
          await this.progress(job, 'searching', `正在${PLATFORMS[channel.platform].label}${sourcingMode(job) === 'recommend' ? '人才推荐中按职位要求寻聘' : '按职位要求搜索人才'}`)
          const quota = job.limitScope === 'per_platform' ? job.limit : Math.ceil((job.limit - job.candidates.length) / job.channels.filter(row => row.status === 'queued' || row === channel).length)
          channel.limit = quota
          const before = job.candidates.length
          const session = await createSourcingSession({ job, channel, quota, before, previous, signal, agent,
            store: this.store, call: this.call, listTools: this.listTools, logger: this.logger, greetingPolicy: this.options.greetingPolicy,
            save: job => this.save(job), progress: (job, phase, message) => this.progress(job, phase, message) })
          try {
            const result = await session.run()
            // The browser runner may return a stopped result for a fatal error instead of throwing.
            if (/OUTCOME_UNKNOWN|RESULT_UNKNOWN|TASK_STORAGE_UNAVAILABLE/.test(result.message)) throw new Error(result.message)
            if (channel.status === 'running') {
              const reached = session.complete()
              channel.status = reached ? 'completed' : 'stopped'
              channel.detail = reached ? `本渠道已评估 ${job.candidates.length - before} 人` : `${safeError(result.message)}；${session.failureDetail()}`
            }
          } catch (error) {
            if (/OUTCOME_UNKNOWN|RESULT_UNKNOWN/.test(String(error))) {
              channel.status = 'stopped'; channel.detail = safeError(error)
              interruption = /已有待核实招呼记录/.test(String(error))
                ? `${PLATFORMS[channel.platform].label}当前候选人有历史招呼结果待核实，本轮尚未向此人发送，已保留 ${job.candidates.length} 位候选人。请核对该人选的历史沟通记录后继续。`
                : `${PLATFORMS[channel.platform].label}页面操作${/TIMEOUT/.test(String(error)) ? '超时' : '结果未确认'}，本轮已停止，已保留 ${job.candidates.length} 位候选人。请先检查平台页面和连接状态，确认后再开始寻聘。`
            }
            if (signal.aborted || /OUTCOME_UNKNOWN|RESULT_UNKNOWN|TASK_STORAGE_UNAVAILABLE/.test(String(error))) throw error
            channel.status = 'failed'; channel.detail = safeError(error)
          } finally {
            session.finish()
          }
          await this.save(job)
          if (channel.status !== 'completed') break
        }
        job.status = job.channels.every(row => row.status === 'completed') ? 'completed' : job.channels.some(row => row.status === 'failed') && !job.candidates.length ? 'failed' : 'stopped'
        const blocked = job.channels.filter(row => ['stopped', 'failed'].includes(row.status))
        const shortages = job.channels.filter(row => row.status === 'completed' && (row.candidateCount ?? 0) < (row.limit ?? job.limit))
        job.detail = `本轮已评估 ${job.candidates.length} 人${[...blocked, ...shortages].length ? `；${[...blocked, ...shortages].map(row => `${PLATFORMS[row.platform].label}：${sourcingChannelReason(row.detail)}`).join('；')}` : ''}`
      } catch (error) { job.status = /OUTCOME_UNKNOWN|RESULT_UNKNOWN/.test(String(error)) ? 'unknown' : signal.aborted ? 'stopped' : 'failed'; job.detail = interruption || safeError(error) }
      finally {
        for (const row of job.greetings ?? []) if (row.stage === 'sending') { row.stage = row.attemptedAt ? 'unknown' : 'skipped'; row.detail = row.attemptedAt ? '招呼结果未知，禁止重发' : '任务结束前未执行招呼'; row.updatedAt = now() }
        if (job.greetings?.some(row => row.stage === 'unknown')) job.status = 'unknown'
        for (const channel of job.channels) if (channel.status === 'running') { channel.status = signal.aborted ? 'stopped' : 'failed'; channel.detail = job.detail }
        for (const channel of job.channels) if (channel.status === 'queued') { channel.status = 'stopped'; channel.detail = '前序渠道未完成，本轮已停止，该渠道尚未开始' }
        if (owned) try { await this.call('browser_finish') } catch { job.detail += '；浏览器执行权尚未确认释放' }
        await this.progress(job, 'finished', job.detail)
      }
    })
  }
}
