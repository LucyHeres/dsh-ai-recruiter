import { z } from 'zod'
import { sourcingMinimumScore } from '../shared/sourcing-score.js'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentBrowserTools, AgentBrowserCall } from './agent-browser-tools.js'
import { assertCandidateQuote } from './candidate-evidence.js'
import { candidateProfile } from './candidate-profile.js'
import { platformIdentityKey, sameGreetingIdentity, greetingOutcome, greetingIdentityAliases } from './candidate-identity.js'
import { bindResumeDetail, matchesResumeDetail } from './resume-detail-identity.js'
import { normalized, readableIdentityRef, recoverablePageError } from './page-actions.js'
import { verifyPositionEvidence } from './position-evidence.js'
import { recruitmentPlatform } from './platforms/registry.js'
import { greetingLabels, completedGreetingLabels } from './recruitment-controls.js'
import { dailyUsage, greetingPolicy, GREETING_CLICK_INTERVAL_MS, type GreetingPolicy } from './greeting-policy.js'
import { greetingHistory, greetingRows } from './greeting-history.js'
import { PageOperation } from './page-operation.js'
import { Store, hash } from './store.js'
import { PLATFORMS, type GreetingJob, type Platform } from '../shared/workbench.js'
import type { SourcingJob, SourcingCandidate } from '../shared/sourcing.js'
export const sourcingGreetingSpec = z.object({ tabId: z.number().int().positive(), snapshotId: z.string().min(1),
  candidateKey: z.string().regex(/^[a-f0-9]{64}$/), ref: z.string().min(1), identityRef: z.string().min(1),
  evidenceRefs: z.array(z.string()).max(6).default([]), profileRef: z.string().optional(),
  position: z.object({ ref: z.string().min(1), quote: z.string().optional(), platformJobId: z.string().optional() }).strict(),
}).strict()
/** The only source-task write grant is a synchronous, exact, host-validated click. */
export class SourcingGreeting {
  awaiting?: string
  private authorized?: { tabId: number; snapshotId: string; ref: string }
  private detailIdentity?: ReturnType<typeof bindResumeDetail>
  constructor(private store: Store, private job: SourcingJob, private broker: AgentBrowserTools, private platform: Platform,
    private save: () => Promise<void>, private progress: (phase: string, message: string) => Promise<void>, private policy: Partial<GreetingPolicy> = {}) {}
  allows(call: AgentBrowserCall) { return call.name === 'browser_click' && call.purpose === 'business_write' && !!this.authorized
    && call.args.tabId === this.authorized.tabId && call.args.snapshotId === this.authorized.snapshotId && call.args.ref === this.authorized.ref }
  queue(candidate: SourcingCandidate, identity: string, page?: any, foregroundSource?: string) {
    if (!this.job.autoGreet) return
    const legacyKey = hash([candidate.platform, candidate.profileUrl || normalized(identity)])
    const row = { key: candidate.platformIdentity ? platformIdentityKey(candidate.platform, candidate.platformIdentity) : legacyKey,
      platformIdentity: candidate.platformIdentity, identityAliases: greetingIdentityAliases(candidate.platform, candidate.profileUrl, identity), candidateKey: candidate.key, platform: candidate.platform,
      name: candidate.name, identityKind: candidate.platformIdentity ? 'platform_id' as const : candidate.profileUrl ? 'url' as const : 'text' as const, stage: 'sending' as const, detail: '等待核对页面后打招呼，尚未派发', updatedAt: new Date().toISOString() }
    ;(this.job.greetings ??= []).push(row); this.awaiting = candidate.key
    this.detailIdentity = page ? bindResumeDetail(page, candidate, foregroundSource) : undefined
  }
  async execute(input: z.infer<typeof sourcingGreetingSpec>, signal: AbortSignal) {
    const candidate = this.job.candidates.find(row => row.key === input.candidateKey && row.platform === this.platform)
    if (!this.job.autoGreet || !candidate || candidate.score < sourcingMinimumScore(this.job) || this.awaiting !== candidate.key) throw new Error(`SOURCING_GREETING_NOT_AUTHORIZED: 仅允许当前已保存且达到本轮${sourcingMinimumScore(this.job)}分门槛的人选`)
    const row = this.job.greetings!.find(row => row.candidateKey === candidate.key && row.platform === this.platform)!
    if (row.attemptedAt || row.clickedAt || row.stage === 'unknown') throw new Error('GREETING_OUTCOME_UNKNOWN: 已派发的招呼不得重试')
    const page = this.broker.getPage(input.tabId, input.snapshotId)
    const refs = [input.ref, input.identityRef, ...input.evidenceRefs, input.position.ref, ...(input.profileRef ? [input.profileRef] : [])]
    const adapter = recruitmentPlatform(this.platform)
    await this.broker.inspectRefs(page, refs, signal, true, !!adapter.candidateIdentity)
    this.broker.candidateContext(page, [input.ref, input.identityRef, ...input.evidenceRefs], candidate.name)
    const currentIdentity = adapter.candidateIdentity?.(page, [input.ref, input.identityRef, ...input.evidenceRefs], this.broker)
    const detailMatches = !currentIdentity && matchesResumeDetail(this.detailIdentity, page, candidate.key, [input.ref, input.identityRef, ...input.evidenceRefs])
    // A bound foreground checks the exact read source plus every node's owner.
    // It needs neither the list quote nor a name duplicated on a parent-owned
    // button. Other paths still validate both identity and action quotes.
    let identityMatches = detailMatches
    if (!detailMatches) {
      const identity = { name: candidate.name, ref: input.identityRef, evidenceRefs: input.evidenceRefs, profileRef: input.profileRef }
      const quote = assertCandidateQuote(page, identity)
      assertCandidateQuote(page, { name: candidate.name, ref: input.ref, evidenceRefs: [input.identityRef, ...input.evidenceRefs] })
      const profile = candidateProfile(page, identity, PLATFORMS[this.platform].origins).url
      const legacyKey = hash([this.platform, candidate.profileUrl ? profile : normalized(quote)])
      identityMatches = candidate.platformIdentity && currentIdentity
        ? platformIdentityKey(this.platform, currentIdentity) === row.key
        : [row.key, ...(row.identityAliases ?? [])].includes(legacyKey)
    }
    if (!identityMatches) throw new Error(`CANDIDATE_EVIDENCE_INVALID: ${currentIdentity ? 'GREETING_RESUME_ID_MISMATCH 当前简历ID与已评分人选不一致' : 'GREETING_DETAIL_UNVERIFIED 当前页面未能关联已保存的简历；请引用同一前景简历的身份和按钮，或返回已验证的列表卡片'}`)
    const searchEvidence = recruitmentPlatform(this.platform).createSearchEvidence(this.broker)
    await searchEvidence.inspect(page, [input.position.ref], signal)
    const positionJob = { ...this.job, kind: 'greeting', platform: this.platform, platformJobs: this.job.platformJobs?.[this.platform] } as unknown as GreetingJob
    const detailPosition = detailMatches ? searchEvidence.position(page, positionJob, { ref: page.dialogs[0].ref }) : undefined
    const position = detailPosition ?? searchEvidence.position(page, positionJob, input.position) ?? verifyPositionEvidence(page, positionJob, input.position)
    if (!position.ok) throw new Error(`POSITION_EVIDENCE_INVALID: ${position.error}`)
    const target = readableIdentityRef(page, input.ref)
    const history = await greetingHistory(this.store)
    const prior = [...greetingRows(history.filter(task => task.id !== this.job.id), this.platform), ...(this.job.greetings ?? []).filter(other => other !== row && other.platform === this.platform)]
      .filter(other => sameGreetingIdentity(row, other))
    if (prior.some(other => greetingOutcome(other) === 'uncertain')) throw new Error('GREETING_OUTCOME_UNKNOWN: 已有待核实招呼记录，停止且禁止重发')
    if (completedGreetingLabels.has(normalized(target.name)) || prior.some(other => greetingOutcome(other) === 'recorded')) {
      row.stage = 'skipped'; row.knownContacted = true; row.detail = '已有沟通记录，本轮不重复发送'; row.updatedAt = new Date().toISOString(); this.awaiting = undefined; await this.save(); return { skipped: true, knownContacted: true }
    }
    if (!greetingLabels(this.platform).has(normalized(target.name))) throw new Error('TASK_GREETING_CONTROL_REQUIRED: 仅允许平台默认单人招呼按钮，不发送自定义消息或付费')
    if (dailyUsage(history)[this.platform] >= greetingPolicy(this.policy).dailyLimit) throw new Error('TASK_DAILY_LIMIT_REACHED: 今日沟通上限已达到')
    const latest = Math.max(0, ...greetingRows(history).map(other => Date.parse(other.clickedAt || other.attemptedAt || '') || 0))
    const wait = latest + GREETING_CLICK_INTERVAL_MS - Date.now()
    if (wait > 0) { await this.progress('greeting', '正在等待下一次招呼间隔'); await delay(wait, undefined, { signal }) }
    signal.throwIfAborted()
    const click = this.broker.tools.find(tool => tool.name === 'browser_click')
    if (!click) throw new Error('TASK_GREETING_CONTROL_REQUIRED: 浏览器未提供点击能力')
    const operation = new PageOperation(page.snapshotId, page)
    try {
      await operation.submit(input.ref, { tabId: page.tabId, page, tabs: [], frames: [], origins: PLATFORMS[this.platform].origins, call: async () => { throw new Error('UNSUPPORTED') } }, async () => {
        row.attemptedAt = new Date().toISOString(); await this.progress('greeting', `正在向 ${candidate.name} 打招呼`)
        this.authorized = { tabId: input.tabId, snapshotId: input.snapshotId, ref: input.ref }
        try { await click.execute({ tabId: input.tabId, snapshotId: input.snapshotId, ref: input.ref, purpose: 'business_write' }, signal) }
        finally { this.authorized = undefined }
      }, recoverablePageError)
      row.stage = 'succeeded'; row.clickedAt = row.updatedAt = new Date().toISOString(); row.detail = '已点击平台默认招呼按钮，未确认消息送达'; this.awaiting = undefined
      await this.progress('reading', `已向 ${candidate.name} 点击打招呼`)
      return { clicked: true, delivered: 'unconfirmed' }
    } catch (error) {
      if (row.clickedAt) throw error
      if (recoverablePageError(error)) { delete row.attemptedAt; row.detail = '招呼尚未派发，请重新观察后核对'; await this.save(); throw error }
      if (!row.attemptedAt) throw error
      row.stage = 'unknown'; row.detail = '招呼执行结果未知，禁止自动重发'; await this.save()
      throw new Error('GREETING_OUTCOME_UNKNOWN: 招呼执行结果未知，请在平台核对')
    }
  }
}
