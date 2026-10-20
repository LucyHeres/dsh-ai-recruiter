import { greetingHistory, greetingRows } from './greeting-history.js'
import { createHash, randomInt } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { safeError } from './task-error.js'
import { logError, type DeveloperLog } from './developer-log.js'
import { pageFailureDetail } from './browser-errors.js'
import { Store } from './store.js'
import { greetingActionSpec, assertPositionEvidence, type GreetingPlanner } from './greeting-planner.js'
import { allowedTab, frameUrl, allowedFrame, normalized, recoverablePageError, safePageUrl, type PageNavigation } from './page-actions.js'
import { pageInspector } from './page-inspection.js'
import { PageOperation, PageRecovery } from './page-operation.js'
import { candidateProfile } from './candidate-profile.js'
import { sameGreetingIdentity, greetingIdentityAliases } from './candidate-identity.js'
import { assertCandidateQuote, candidateQuoteCheck, greetingEvidenceFeedback } from './candidate-evidence.js'
import { PageProgress, rememberPageAction, type PageActionRecord } from './page-progress.js'
import { PLATFORMS, type Platform, type GreetingJob, type WorkbenchJob, type TaskResult } from '../shared/workbench.js'

import { greetingPolicy, dailyUsage, type GreetingPolicy } from './greeting-policy.js'
export { DAILY_LIMIT, DEFAULT_GREETING_POLICY, createGreetingJob, greetingPolicy, dailyUsage, type GreetingPolicy } from './greeting-policy.js'
const date = () => new Date().toISOString()

type Timing = { now?: () => number; sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void> }
export class GreetingExecutor {
  private readonly policy: GreetingPolicy
  private readonly clock: () => number
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  constructor(private readonly store: Store,
    private readonly call: (tool: string, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>,
    private readonly begin: (signal?: AbortSignal) => Promise<void>, private readonly plannerOf: () => GreetingPlanner,
    private readonly logger?: DeveloperLog, configured: Partial<GreetingPolicy> = {}, timing: Timing = {}) {
    this.policy = greetingPolicy(configured)
    this.clock = timing.now ?? Date.now
    this.sleep = timing.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }))
  }
  private save(job: GreetingJob) { job.updatedAt = date(); return this.store.put(`greeting-${job.id}`, job) }
  private async progress(job: GreetingJob, phase: string, message: string) {
    job.phase = phase; job.detail = message
    this.logger?.updateContext({ phase })
    this.logger?.write('info', 'task.progress', { taskId: job.id, kind: job.kind, platform: job.platform, phase, processed: job.results.length })
    const events = job.events ??= []
    if (events.at(-1)?.message !== message) events.push({ at: date(), message })
    job.events = events.slice(-150); await this.save(job)
  }
  async run(job: GreetingJob, signal: AbortSignal) {
    await this.store.locked('workbench-browser', async () => {
      let owned = false, frameId: number | undefined, invalidActions = 0, sent = 0, batch = 0
      let batchSize = randomInt(this.policy.batchMin, this.policy.batchMax + 1), nextSendAt = 0, waitingSince: number | undefined
      let pending: { result: TaskResult; operation: PageOperation } | undefined
      const policy = { allowedOrigins: [...PLATFORMS[job.platform].origins], maxWrites: 1000 }
      const origins: readonly string[] = policy.allowedOrigins
      const call = (tool: string, args: Record<string, unknown> = {}) => {
        const invoke = (input: Record<string, unknown>) => this.call(tool, { ...input, policy: { ...policy, ...(input.policy as object ?? {}) } }, signal)
        return invoke({ ...(tool === 'browser_snapshot' ? { format: 'semantic' } : {}), ...args })
      }
      const history: PageActionRecord[] = []
      const navigation = new PageProgress(history, 'greeting', this.logger)
      const recovery = new PageRecovery()
      const remember = (action: string, outcome: string, ref?: string) => rememberPageAction(history, { action, ref, outcome })
      const protectedResults = (rows: TaskResult[]) => rows.filter(row => ['succeeded', 'sending', 'unknown'].includes(row.stage))
      try {
        const planner = this.plannerOf() // No fallback to the former page rules when the model is unavailable.
        if (dailyUsage(await greetingHistory(this.store))[job.platform] >= this.policy.dailyLimit) throw new Error(`该平台今天已达到 ${this.policy.dailyLimit} 次沟通上限`)
        await this.progress(job, 'connecting', '正在连接浏览器')
        await this.begin(signal); owned = true; job.status = 'running'
        if (!job.tabId) {
          const target = new URL(PLATFORMS[job.platform].url)
          const existing = ((await call('browser_list_tabs')).tabs ?? []).filter((tab: any) => {
            try { return Number.isInteger(tab.tabId) && new URL(tab.url).origin === target.origin } catch { return false }
          })
          const ready = existing.find((tab: any) => new URL(tab.url).pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, ''))
          job.tabId = (ready ?? existing[0])?.tabId
          let navigated = false
          if (job.tabId && !ready) { await call('browser_navigate', { tabId: job.tabId, url: target.href }); navigated = true }
          else if (!job.tabId) { job.tabId = (await call('browser_open_tab', { url: target.href }))?.tabId; navigated = true }
          if (navigated && Number.isInteger(job.tabId)) {
            // A bounded generic DOM check, never a candidate count or platform text rule.
            // The plugin's wait budget must expire before the gateway's reply
            // deadline, allowing a normal conditionMet:false timeout receipt.
            const readiness = await call('browser_wait', { tabId: job.tabId,
              condition: { type: 'dom_quiet', quietMs: 500, timeoutMs: 2000 }, timeoutMs: 5000 })
            this.logger?.write('info', 'greeting.page_readiness', { conditionMet: readiness?.conditionMet === true,
              timeout: readiness?.timeout === true, waitedMs: readiness?.waitedMs, timeoutSource: readiness?.timeoutSource,
              waitBudgetMs: 2000, replyBudgetMs: 5000 })
          }
        }
        if (!Number.isInteger(job.tabId) || !job.tabId) throw new Error('平台页面未成功打开')
        const prior = protectedResults(greetingRows((await greetingHistory(this.store)).filter(row => row.id !== job.id), job.platform))
        const attempted = new Set<string>()
        for (let step = 0; step < 40 + job.limit * 20; step++) {
          signal.throwIfAborted()
          const tabs = ((await call('browser_list_tabs')).tabs ?? []).filter((tab: any) => allowedTab(tab, origins))
          if (!tabs.some((tab: any) => tab.tabId === job.tabId)) throw new Error('当前标签页不属于所选招聘平台')
          const frames = ((await call('browser_list_frames', { tabId: job.tabId }).catch(() => ({ frames: [] }))).frames ?? []).filter((frame: any) => allowedFrame(frame, origins))
          const page = await call('browser_snapshot', { tabId: job.tabId, viewportOnly: true, ...(frameId === undefined ? {} : { frameId }) })
          if (!allowedTab({ tabId: job.tabId, url: page.url }, origins)) throw new Error('当前页面不属于所选招聘平台')
          navigation.observe({ tabId: job.tabId!, frameId, page, tabs })
          if (!pending && sent >= job.limit && !page.dialogs?.length) {
            job.status = 'completed'; job.detail = `已核对 ${sent}/${job.limit} 人的打招呼结果`; break
          }
          await this.progress(job, 'reading', 'AI 正在阅读页面并选择下一步操作')
          const action = greetingActionSpec.parse(await planner.decide({ platform: job.platform, limit: job.limit, remaining: job.limit - sent,
            targetJob: { jobId: job.jobId, name: job.jobName, platformJobs: job.platformJobs ?? [] }, currentTabId: job.tabId, currentFrameId: frameId,
            page, tabs: tabs.map((tab: any) => ({ tabId: tab.tabId, title: tab.title, url: safePageUrl(tab.url) })),
            frames: frames.map((frame: any) => ({ frameId: frame.frameId, url: frameUrl(frame) })),
            pendingGreeting: pending ? { name: pending.result.name,
              instruction: '当前操作尚未完成；根据页面自主继续或恢复，核对结果后再开启下一条记录' } : null,
            processed: job.results.map(row => ({ key: row.key, name: row.name, stage: row.stage, detail: row.detail, retryable: row.retryable })),
            previousGreetings: prior.map(row => ({ key: row.key, name: row.name, stage: row.stage })).slice(-300), recentActions: history }, signal, pageInspector({ tabId: job.tabId!, frameId, page, tabs, frames, origins, call }, message => this.progress(job, 'reading', message))))
          signal.throwIfAborted()
          this.logger?.write('info', 'greeting.action_selected', { step, action: action.action, ref: 'ref' in action ? action.ref : undefined })
          await this.progress(job, 'reading', `AI：${safeError(action.reason)}`)
          try {
            if (pending && (action.action === 'greet' || action.action === 'skip_candidate')) {
              throw new Error('PAGE_OPERATION_RESULT_REQUIRED: 当前操作尚未核对，先继续或恢复当前目标，再开启其他记录')
            }
            if (action.action === 'record_result') {
              if (!pending) throw new Error('PAGE_OPERATION_RESULT_REQUIRED: 没有待核对操作')
              pending.operation.assertResult(page, action.outcome, action.evidenceRefs)
              if (action.outcome === 'unknown') throw new Error('GREETING_OUTCOME_UNKNOWN: 无法核实发送结果，停止且不会自动重发')
              const result = pending.result
              result.stage = action.outcome === 'completed' ? 'succeeded' : 'skipped'
              result.detail = safeError(action.reason); result.updatedAt = date()
              if (action.outcome === 'completed') result.confirmedAt = date()
              else { result.retryable = true; attempted.delete(result.key) }
              pending = undefined
              navigation.checkpoint()
              if (action.outcome === 'completed') {
                sent++; batch++
                if (batch >= batchSize) { nextSendAt = this.clock() + this.policy.batchPauseSeconds * 1000; batch = 0; batchSize = randomInt(this.policy.batchMin, this.policy.batchMax + 1) }
                else nextSendAt = this.clock() + randomInt(job.intervalMinSeconds ?? this.policy.intervalMinSeconds, (job.intervalMaxSeconds ?? this.policy.intervalMaxSeconds) + 1) * 1000
              }
              planner.recordResult?.({ status: 'recorded', action: action.action, outcome: action.outcome })
              remember(action.action, `${action.outcome}: ${safeError(action.reason)}`)
              await this.progress(job, 'reading', action.outcome === 'completed' ? `已核对向 ${result.name} 打招呼（${sent}/${job.limit}）` : `未向 ${result.name} 发送：${result.detail}`)
              this.logger?.write('info', 'greeting.result_checked', { outcome: action.outcome, sent, limit: job.limit })
              if (sent >= job.limit && !page.dialogs?.length) {
                job.status = 'completed'; job.detail = `已核对 ${sent}/${job.limit} 人的打招呼结果`; break
              }
            } else if (action.action === 'submit') {
              if (!pending) throw new Error('PAGE_OPERATION_RESULT_REQUIRED: 提交动作需要已有操作记录')
              const receipt = await pending.operation.submit(action.ref, { tabId: job.tabId!, frameId, page, tabs, frames, origins, call },
                () => call('browser_click', { tabId: job.tabId, snapshotId: page.snapshotId, documentId: page.documentId, ref: action.ref,
                  observe: { wait: 'dom_quiet', timeoutMs: 1500 }, policy: { ...policy, riskLevel: 'business_write', requiresConfirmation: true, confirmationId: `greeting-${job.id}` } }), recoverablePageError)
              planner.recordResult?.({ status: 'dispatched', action: action.action, receipt, note: '同一记录的后续动作已派发，仍需核对实际结果' })
              remember(action.action, '后续动作已派发，核对新页面结果', action.ref)
            } else if (action.action === 'greet' || action.action === 'skip_candidate') {
              if (action.candidateRef && !action.evidenceRefs.includes(action.candidateRef)) action.evidenceRefs.push(action.candidateRef)
              if (page.format === 'semantic') {
                const refs = [...new Set([action.ref, ...action.evidenceRefs, ...(action.profileRef ? [action.profileRef] : []),
                  ...(action.action === 'greet' && action.position ? [action.position.ref] : [])])]
                // Read only selected node details; no model round or all-page DOM scan.
                for (const ref of refs) {
                  const item = (page.items ?? []).find((item: any) => item.ref === ref)
                  if (!item) throw new Error('ELEMENT_NOT_FOUND')
                  const detail = await call('browser_inspect_element', { tabId: job.tabId, snapshotId: page.snapshotId, documentId: page.documentId, ref })
                  if (!detail?.item) throw new Error('SEMANTIC_DETAILS_UNAVAILABLE: 需更新薪招到 3.2.40+')
                  Object.assign(item, detail.item)
                  const context = (detail.item.contextCandidates ?? []).find((value: any) => normalized(value.text).replace(/\s/g, '').includes(normalized(action.name).replace(/\s/g, '')))
                  if (context) item.context = context
                }
              }
              const identityQuote = assertCandidateQuote(page, action)
              const resolvedProfile = candidateProfile(page, action, origins)
              const profile = resolvedProfile.url
              if (action.profileRef) this.logger?.write('info', 'greeting.profile_evidence', {
                ref: action.ref, profileRef: action.profileRef, mode: resolvedProfile.mode, reason: resolvedProfile.reason,
              })
              const key = createHash('sha256').update(JSON.stringify([job.platform, profile || normalized(identityQuote)])).digest('hex')
              const identityAliases = greetingIdentityAliases(job.platform, profile, identityQuote)
              if (action.action === 'skip_candidate') {
                if (!job.results.some(row => row.key === key)) {
                  job.results.push({ key, name: action.name, stage: 'skipped', detail: safeError(action.reason), updatedAt: date() })
                  navigation.checkpoint()
                }
                await this.progress(job, 'reading', `AI 已跳过候选人：${safeError(action.reason)}`)
                planner.recordResult?.({ status: 'recorded', action: action.action })
                remember(action.action, '已记录跳过', action.ref); invalidActions = 0; continue
              }
              const previous = [...prior, ...protectedResults(job.results)]
              if (attempted.has(key) || previous.some(row => sameGreetingIdentity({ key, identityAliases } as TaskResult, row))) {
                planner.recordResult?.({ status: 'not-dispatched', reason: '已有成功或待核对记录，重复发送被阻止' })
                remember('greet', '已有沟通或待核对记录，不能重复发送；请跳过并选择其他候选人')
                if (++invalidActions >= 3) throw new Error('重复候选人已阻止，AI 连续选择未完成')
                continue
              }
              if (sent >= job.limit) throw new Error('本次沟通人数已达到设置上限')
              assertPositionEvidence(page, job, action.position)
              if (dailyUsage(await greetingHistory(this.store))[job.platform] >= this.policy.dailyLimit) throw new Error('该平台今天已达到本机沟通上限')
              if (this.clock() < nextSendAt) {
                const ms = nextSendAt - this.clock()
                job.nextActionAt = new Date(Date.now() + ms).toISOString()
                await this.progress(job, 'cooldown', `按沟通节奏等待 ${Math.ceil(ms / 1000)} 秒后重新核对页面`)
                try { await this.sleep(ms, signal) } finally { delete job.nextActionAt }
                planner.recordResult?.({ status: 'not-dispatched', reason: '间隔等待结束，需要根据新快照重新选择' })
                remember('cooldown', '等待结束，旧引用不能使用，请根据新快照重新选择'); continue
              }
              const result: TaskResult = { key, identityAliases, name: action.name, identityKind: profile ? 'url' : 'text', stage: 'sending', detail: '正在触发沟通按钮', attemptedAt: date(), updatedAt: date() }
              attempted.add(key); job.results.push(result)
              await this.progress(job, 'sending', `正在向 ${action.name} 打招呼（${sent + 1}/${job.limit}）`)
              const operation = new PageOperation(page.snapshotId, page)
              const receipt = await operation.submit(action.ref, { tabId: job.tabId!, frameId, page, tabs, frames, origins, call },
                () => call('browser_click', { tabId: job.tabId, snapshotId: page.snapshotId, documentId: page.documentId, ref: action.ref,
                observe: { wait: 'dom_quiet', timeoutMs: 1500 }, policy: { ...policy, riskLevel: 'business_write', requiresConfirmation: true, confirmationId: `greeting-${job.id}` } }), recoverablePageError)
              pending = { result, operation }
              result.detail = '已点击沟通入口，正在核对发送结果'; result.updatedAt = date()
              planner.recordResult?.({ status: 'dispatched', action: 'greet', receipt, note: '动作已派发，尚未计为完成；自主继续或恢复后报告 record_result' })
              await this.progress(job, 'reading', `正在核对 ${action.name} 的发送结果`)
              remember('greet', `${action.name} 的发送结果待核对，必须先处理后续弹窗，不能发送下一人`)
            } else if (action.action === 'finish' || action.action === 'stop') {
              if (pending) throw new Error('GREETING_OUTCOME_UNKNOWN: 当前候选人的发送结果未核实，停止且不会自动重发')
              job.status = action.action === 'finish' ? 'completed' : 'stopped'
              job.detail = safeError(action.reason); break
            } else if (action.action === 'wait_for_user') {
              waitingSince ??= this.clock()
              if (this.clock() - waitingSince >= 180000) throw new Error('等待用户处理登录或验证超时')
              await this.progress(job, 'waiting_login', `请在浏览器处理：${safeError(action.reason)}`)
              await this.sleep(2000, signal)
              planner.recordResult?.({ status: 'waiting_for_user', reason: safeError(action.reason) })
              continue
            } else {
              waitingSince = undefined
              const view: PageNavigation = { tabId: job.tabId!, frameId, page, tabs, frames, origins, call }
              await navigation.execute(action, view)
              job.tabId = view.tabId; frameId = view.frameId
              planner.recordResult?.({ status: 'executed', receipt: navigation.lastReceipt, note: '需核对新快照，不能把调用完成当作目标成功' })
            }
            invalidActions = 0; recovery.reset()
          } catch (error) {
            const isCandidate = action.action === 'greet' || action.action === 'skip_candidate'
            const sending = job.results.find(row => row.stage === 'sending')
            if (!recoverablePageError(error)) throw error
            // Only pre-dispatch failures can become failed/retryable. Once an
            // entry click succeeded, later read/navigation errors cannot erase it.
            if (sending && !pending) { sending.stage = 'failed'; sending.detail = pageFailureDetail(error); sending.updatedAt = date(); attempted.delete(sending.key) }
            remember(action.action, safeError(error), 'ref' in action ? action.ref : undefined)
            this.logger?.write('warn', 'greeting.action_observation', { action: action.action, ref: 'ref' in action ? action.ref : undefined,
              profileRef: 'profileRef' in action ? action.profileRef : undefined, ...logError(error),
              ...(isCandidate && /CANDIDATE_IDENTITY_QUOTE_INVALID/.test(String(error)) ? candidateQuoteCheck(page, action) : {}) })
            await this.save(job)
            const recoveryState = recovery.failed(error, action, page)
            planner.recordResult?.({ status: 'error', dispatched: false, error: safeError(error), recovery: recoveryState,
              ...(isCandidate ? { feedback: greetingEvidenceFeedback(page, action) } : {}),
              note: '这是当前动作的失败回执；已派发的历史操作仍保留。读取缺失信息并选择有依据的恢复路径，不能重放未知提交。' })
            if (recoveryState.exhausted) throw new Error(`AI 恢复操作未能推进，已停止：${safeError(error)}`)
          }
        }
        if (job.status === 'running') throw new Error('AI 页面操作已达到本次任务预算，已停止')
      } catch (error) {
        const uncertain = job.results.filter(row => row.stage === 'sending')
        for (const row of uncertain) { row.stage = 'unknown'; row.detail = '发送结果未知，已停止且不会自动重发'; row.updatedAt = date() }
        job.status = uncertain.length ? 'unknown' : signal.aborted ? 'stopped' : 'failed'
        job.detail = signal.aborted ? '任务已停止' : safeError(error)
        this.logger?.write(signal.aborted ? 'warn' : 'error', 'greeting.interrupted', { ...logError(error), phase: job.phase })
      } finally {
        delete job.nextActionAt
        if (owned) try { await this.call('browser_finish') } catch { job.detail += '；浏览器执行权尚未确认释放' }
        await this.progress(job, 'finished', job.detail)
      }
    })
  }
}
