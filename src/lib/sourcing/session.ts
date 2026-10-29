import { SourcingGreeting, sourcingGreetingSpec } from '../sourcing-greeting.js'
import type { GreetingPolicy } from '../greeting-policy.js'
import { z } from 'zod'
import { candidateListProfile } from '../candidate-list-profile.js'
import { pageSpec, rubricRequirementsSpec, selectionSpec, readResumeSpec, recordSpec } from './contracts.js'
import { sourcingSystem } from './prompts.js'
import { AgentBrowserTools } from '../agent-browser-tools.js'
import type { BrowserAgentTool } from '../browser-agent.js'
import type { BrowserAgentRunner } from '../host-browser-agent.js'
import type { McpToolInfo } from '../browser-client.js'
import type { DeveloperLog } from '../developer-log.js'
import { Store, hash } from '../store.js'
import { assertCandidateQuote } from '../candidate-evidence.js'
import { candidateProfile } from '../candidate-profile.js'
import { platformIdentityKey } from '../candidate-identity.js'
import type { PlatformCandidateIdentity } from '../../shared/workbench.js'
import { itemText, normalized, readableIdentityRef, safePageUrl, statesOf } from '../page-actions.js'
import { safeError } from '../task-error.js'
import { assessCandidate, assertSourcingNavigation, inspectedSourcingClose, assertSourcingResumeDetail, mergeSourcingResumeParts, sourcingResumeDialog, sourcingResumeParts, SourcingSearchTracker, sourcingSource, validateCriteria, validateSupplementCoverage } from '../sourcing-policy.js'
import { PLATFORMS } from '../../shared/workbench.js'
import type { SourcingJob, SourcingListAssessment } from '../../shared/sourcing.js'
import { sourcingMinimumScore, sourcingTotalTarget, sourcingQualifiedCount } from '../../shared/sourcing-score.js'
import { supplementParts } from './matching-skill.js'
import { deriveSourcingSearchFilters, hasSourcingPositionSelector, isSourcingFilterControl, sourcingSearchConfirmationSpec, verifySourcingExhaustion, verifySourcingSearchFilters, verifySourcingSearchPosition } from '../sourcing-search.js'
import { browserFailureCode, browserFailureReason } from '../browser-errors.js'
import { sourcingAssessmentDiagnostic, sourcingTargetDiagnostic } from '../sourcing-diagnostics.js'
import { recruitmentPlatform } from '../platforms/registry.js'
import { runSourcingWorkflow } from './fast-runner.js'
import { evaluateSources, judgementAnalysis } from './evaluator.js'
import { sourcingMode, sourcingEntry, isSourcingDocument, assertRecommendationPage, assertRecommendationNavigation, bootstrapSourcing } from './source.js'
import { assessCandidateFilters, candidateFilterFailure } from './candidate-filters.js'
import { withFixedListCriteria } from './requirement-policy.js'
import { assessListCandidate, listAssessmentFailure, validateListCriteria } from './list-screening.js'
import { visualResumeReader } from './visual-resume.js'
import { assertPlatformPageLogin, isPlatformLoginRequired } from '../platform-login.js'


const now = () => new Date().toISOString()
type SessionOptions = {
  job: SourcingJob; channel: SourcingJob['channels'][number]; quota: number; before: number; previous: Set<string>
  store: Store; signal: AbortSignal; agent: BrowserAgentRunner; logger?: DeveloperLog
  call: (tool: string, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>
  listTools: (signal?: AbortSignal) => Promise<McpToolInfo[]>
  greetingPolicy?: Partial<GreetingPolicy>
  save(job: SourcingJob): Promise<void>
  progress(job: SourcingJob, phase: string, message: string): Promise<void>
}
/** One channel owns policy and business hooks. The agent and its optional
 * collection tool share this state and the same durable write protections. */
export async function createSourcingSession(ctx: SessionOptions) {
  const { job, channel, quota, before, previous, signal, agent } = ctx
  const minimumScore = sourcingMinimumScore(job), totalTarget = sourcingTotalTarget(job)
  const qualifiedCount = () => sourcingQualifiedCount(job)
  let done = false, searchReady = false, positionSelectorSeen = false
  let preparedSearch: { tabId: number; documentId?: string } | undefined
  let phase: 'preparing' | 'searching' | 'reading' | 'evaluating' | 'greeting' = job.requirements ? 'searching' : 'preparing'
  let lastIssue = ''
  let previewEvidence: { tabId: number; snapshotId: string; name: string; refs: string[]; text: string } | undefined
  const searchTracker = new SourcingSearchTracker(() => job.requirements?.keyword ?? '')
  const platformPositions = job.platformJobs?.[channel.platform]
  const platform = recruitmentPlatform(channel.platform)
  const sourceMode = sourcingMode(job), entryUrl = sourcingEntry(platform, job)
  const entryAliases = platform.sourcingEntryAliases ?? []
  const recommendation = sourceMode === 'recommend'
  const candidateFilters = recommendation ? job.searchFilters ?? {} : {}
  const positionRoute = platform.createPositionRoute((platformPositions?.length ? platformPositions.map(row => row.name) : [job.position?.name || job.jobName || '']).map(normalized), sourceMode)
  let pending: { name: string; key: string; identityAliases: string[]; profileUrl: string; platformIdentity?: PlatformCandidateIdentity; selectionSnapshot: string; selectionPage: { tabId: number; url: string; documentId?: string }; listText: string; listAssessments: SourcingListAssessment[]; parts: string[]; detailSeen: boolean; identity: string; refs: string[] } | undefined
  const diagnose = (level: 'info' | 'warn', event: string, fields: Record<string, unknown>) => {
    try { ctx.logger?.write(level, `sourcing.${event}`, { taskId: job.id, platform: channel.platform, phase, ...fields }) } catch { /* Diagnostics never change execution. */ }
  }
  const origins = PLATFORMS[channel.platform].origins
  const broker = new AgentBrowserTools(await ctx.listTools(signal), ctx.call, { origins, signal, confirmationId: `sourcing-${job.id}`,
    observationFormat: platform.observationFormat ?? 'semantic', observationViewportOnly: true, logger: ctx.logger,
    allow: info => !/acquire_file|capture_content|close_tab|network/i.test(info._meta?.browserAgent?.capability ?? info.name) })
  const searchEvidence = platform.createSearchEvidence(broker)
  const greeter = new SourcingGreeting(ctx.store, job, broker, channel.platform, () => ctx.save(job), (phase, message) => ctx.progress(job, phase, message), ctx.greetingPolicy)
  const readVisual = visualResumeReader(broker, ctx.call, agent, message => ctx.progress(job, 'reading', pending ? `候选人[${pending.name}]：${message}` : message))
  const selectedCandidate = () => {
    if (pending) return { candidateKey: pending.key, name: pending.name, platformIdentity: pending.platformIdentity,
      verifiedListText: pending.listText.slice(0, 2400), listEvidenceHash: hash(pending.listText), resumeCharacters: pending.parts.join('\n').length,
      stage: pending.parts.length ? 'reading' as const : 'selected' as const }
    const saved = job.candidates.find(row => row.key === greeter.awaiting)
    if (saved) return { candidateKey: saved.key, name: saved.name, platformIdentity: saved.platformIdentity,
      resumeCharacters: saved.resumeText.length, stage: 'greeting' as const }
  }
  const rejected = new Set<string>()
  const duplicateAttempts = new Map<string, number>()
  broker.setBeforeCall(async call => {
    const page = call.args.tabId ? (() => { try { return broker.getPage(call.args.tabId, call.args.snapshotId) } catch { return undefined } })() : undefined
    let validationStage = 'navigation_policy'
    try {
      assertPlatformPageLogin(page ?? broker.currentPage(), channel.platform)
      if (recommendation) assertRecommendationNavigation(call, page, entryUrl, entryAliases)
      if (greeter.allows(call)) return
      const searchControl = page && call.args.ref ? searchEvidence.control(page, String(call.args.ref)) : undefined
      positionSelectorSeen ||= hasSourcingPositionSelector(page)
      positionSelectorSeen ||= searchControl?.kind === 'position'
      if (call.name === 'browser_type' && positionSelectorSeen) {
        const target = readableIdentityRef(page, String(call.args.ref || ''))
        if (['textbox', 'searchbox'].includes(target.role) && /关键词|关键字|搜索人才|搜人才|人才搜索/i.test(normalized(target.name))) throw new Error('SOURCING_POSITION_SELECTION_REQUIRED: 页面有职位选择器，请选择对应职位，不在关键词框输入职位名')
      }
      const positionControl = positionRoute.allowsChoice(call, page) || !!searchControl
      validationStage = 'navigation_policy'
      assertSourcingNavigation(call, page, pending?.name, searchTracker.hasFocusedSearch(call, page),
        positionControl, !!(call.args.ref && (platform.allowsNavigation?.(page, call.args.ref, broker)
          || inspectedSourcingClose(page, String(call.args.ref), broker.getInspection(page, String(call.args.ref))))))
      const selectedCandidate = pending ?? job.candidates.find(person => person.key === greeter.awaiting)
      if (!call.readOnly && ['browser_click', 'browser_hover'].includes(call.name)) {
        const target = readableIdentityRef(page, String(call.args.ref || ''))
        // A known profile URL remains candidate-bound. Custom close icons,
        // labels and dropdown surfaces are left to the browser's real hit-test.
        const candidateEntry = target.href && /\/(?:resume|geek|candidate|talent|profile)(?:\/|\?|$)/i.test(target.href)
          || /^(?:查看|打开)(?:在线)?(?:简历|候选人|人选)(?:详情)?$/.test(normalized(target.name))
        if (candidateEntry && !selectedCandidate) throw new Error('SOURCING_PREFLIGHT_REQUIRED: 先完成当前候选人的列表初筛，再打开简历详情')
        if (candidateEntry && selectedCandidate) {
          validationStage = 'candidate_ownership'
          await broker.inspectRefs(page, [target.ref], call.signal, true)
          broker.candidateContext(page, [target.ref], selectedCandidate.name)
          assertCandidateQuote(page, { ref: target.ref, name: selectedCandidate.name, evidenceRefs: pending && pending.selectionSnapshot === page.snapshotId ? pending.refs : [] })
        }
      }
      if (call.name === 'browser_open_tab' || call.name === 'browser_navigate') {
        validationStage = 'navigation_url'
        const url = String(call.args.url ?? '')
        const isEntry = isSourcingDocument(url, entryUrl, entryAliases)
        if (!isEntry && !pending && !greeter.awaiting) throw new Error('SOURCING_PREFLIGHT_REQUIRED: 评分达标前不能导航至个人详情')
        if (!isEntry && !page?.items?.some((item: any) => item.href === url)) throw new Error('SOURCING_URL_UNOBSERVED: 只能进入平台入口或当前已观察的链接')
        if (!isEntry && selectedCandidate) {
          const link = page.items.find((item: any) => item.href === url)
          broker.candidateContext(page, [link.ref], selectedCandidate.name)
          assertCandidateQuote(page, { ref: link.ref, name: selectedCandidate.name, evidenceRefs: pending && pending.selectionSnapshot === page.snapshotId ? pending.refs : [] })
        }
      }
      if (call.name === 'browser_type' || call.name === 'browser_select_option') searchReady = false
      if (call.name === 'browser_click' && (positionControl || isSourcingFilterControl(readableIdentityRef(page, String(call.args.ref || '')))
        || ['tab', 'option', 'checkbox', 'radio', 'combobox'].includes(readableIdentityRef(page, String(call.args.ref || '')).role))) searchReady = false
      if (call.name === 'browser_open_tab' || call.name === 'browser_navigate') searchReady = false
    } catch (error) {
      try { diagnose('warn', 'navigation_rejected', { tool: call.name, errorCode: browserFailureCode(error), validationStage,
        inputDispatched: false, tabId: call.args.tabId, purpose: call.purpose, searchReady,
        candidateKey: pending?.key ?? greeter.awaiting, candidatePending: !!pending,
        capturedCharacters: pending?.parts.join('\n').length ?? 0, detailSeen: pending?.detailSeen ?? false,
        target: sourcingTargetDiagnostic(page, call.args.ref, pending?.name ?? job.candidates.find(row => row.key === greeter.awaiting)?.name) }) } catch { /* Retain the original rejection. */ }
      throw error
    }
  })
  broker.setAroundCall(async (call, dispatch) => {
    const page = call.args.tabId ? (() => { try { return broker.getPage(call.args.tabId) } catch { return undefined } })() : undefined
    const result = await positionRoute.dispatch(call, page, () => searchTracker.dispatch(call, page, dispatch, () => {
      try { return broker.getPage(call.args.tabId) } catch { return undefined }
    }), page && call.args.ref ? searchEvidence.control(page, String(call.args.ref))?.kind === 'position' : false)
    if (call.purpose !== 'business_write') {
      assertPlatformPageLogin(result?.output ?? result, channel.platform)
      assertPlatformPageLogin(result?.snapshot ?? result?.output?.snapshot, channel.platform)
      assertPlatformPageLogin(broker.currentPage(), channel.platform)
    }
    try { positionSelectorSeen ||= hasSourcingPositionSelector(broker.getPage(call.args.tabId)) } catch { /* list_tabs has no page */ }
    return result
  })
  const hook = <T extends z.ZodType>(name: string, description: string, schema: T, execute: (input: z.infer<T>, signal: AbortSignal) => Promise<unknown>): BrowserAgentTool => ({
    name, description, inputSchema: z.toJSONSchema(schema) as Record<string, unknown>, readOnly: false,
    contextSnapshot: (args, value) => broker.contextSnapshot(args, value),
    maxRecoverableFailures: ['sourcing_read_resume', 'sourcing_record_candidate'].includes(name) ? 5 : undefined,
    failureKey: args => {
      const candidate = `${name}:${pending?.key ?? greeter.awaiting ?? 'search'}`
      if (!['sourcing_read_resume', 'sourcing_record_candidate'].includes(name)) return candidate
      try {
        const page = broker.getPage(Number(args.tabId))
        const describe = (ref: unknown) => {
          const item = page.items?.find((row: any) => row.ref === ref)
          return item ? { role: item.role, text: itemText(item), states: statesOf(item) } : { missing: true }
        }
        // A changed identity/evidence choice gets a correction budget; merely
        // regenerating refs for identical content must not reset the counter.
        return `${candidate}:${hash({ document: page.documentId ?? page.url, identity: describe(args.identityRef),
          evidence: [...new Set((Array.isArray(args.resumeRefs) ? args.resumeRefs : []).map(ref => hash(describe(ref))))].sort() })}`
      } catch { return candidate }
    },
    recover: async (error, args, toolSignal) => {
      let correction: unknown
      const selected = pending ?? job.candidates.find(row => row.key === greeter.awaiting)
      const code = browserFailureCode(error)
      if (selected && (name === 'sourcing_select_candidate' && code === 'TASK_RESULT_REQUIRED'
        || ['sourcing_read_resume', 'sourcing_record_candidate', 'sourcing_greet_candidate'].includes(name)
        && ['SNAPSHOT_EXPIRED', 'PAGE_CHANGED', 'ELEMENT_NOT_FOUND', 'CANDIDATE_EVIDENCE_INVALID', 'CANDIDATE_EVIDENCE_UNREADABLE'].includes(code ?? ''))) {
        try {
          const snapshot = broker.tools.find(tool => tool.name === 'browser_snapshot')!
          const supportsFormat = !!(snapshot.inputSchema.properties as any)?.format
          correction = { observation: await snapshot.execute({ tabId: Number(args.tabId), ...(supportsFormat ? { format: 'dom' } : {}) }, toolSignal),
            selectedCandidate: selectedCandidate(),
            reason: browserFailureReason(error),
            next: name === 'sourcing_greet_candidate'
              ? '当前人选已保存且招呼尚未派发。详情页无列表ID时，可引用同一前景简历及其内部招呼按钮，宿主会核对本轮已读全文和文档；也可返回同一列表卡片。不要重选人或操作其他候选人的按钮。'
              : '当前候选人仍待处理。请从新快照定位姓名及同一简历容器，必要时inspect；不要再次select覆盖当前人选。无法核验时调用sourcing_skip_candidate放弃后继续其他人。' }
        } catch (refreshError) {
          toolSignal.throwIfAborted()
          correction = { observationError: browserFailureCode(refreshError), next: name === 'sourcing_greet_candidate'
            ? '重新读取DOM快照或inspect核对当前已保存的人选、简历及其按钮；不能跳过或覆盖待核对的招呼。'
            : '可自行读取DOM快照或inspect定位同一候选人；无法核验时用sourcing_skip_candidate放弃后继续。' }
        }
      }
      return { phase, lastIssue, requirements: job.requirements, searchFilters: job.searchFilters, positionSelectorSeen,
      selectedCandidate: selectedCandidate(),
      ...(correction ? { correction } : {}),
      ...(name === 'sourcing_select_candidate' && previewEvidence && args.tabId === previewEvidence.tabId && args.snapshotId === previewEvidence.snapshotId && args.name === previewEvidence.name
        ? { candidateEvidence: previewEvidence, note: '这是本次评分实际校验的同一候选人列表原文。宿主会独立评估这份原文；只需提供当前同一候选人的引用，不要自行填写引用或评分。' } : {}),
      ...(name === 'sourcing_confirm_search' && args.tabId ? { observedSearch: (() => { try { return searchEvidence.summary(broker.getPage(Number(args.tabId)), job.searchFilters) } catch { return undefined } })() } : {}),
      ...(pending?.parts.length ? { capturedResume: { name: pending.name, characters: pending.parts.join('\n').length, scope: pending.detailSeen ? 'online' : 'summary' },
        note: '原文已由宿主保存和独立评估；继续处理同一候选人，只提供当前身份及简历引用，不必复制原文或重做评分。' } : {}) }
    },
    execute: async (args, toolSignal) => {
      toolSignal.throwIfAborted()
      if (name === 'sourcing_select_candidate') previewEvidence = undefined
      try { const result = await execute(schema.parse(args), toolSignal); lastIssue = ''; return result }
      catch (error) {
        const message = safeError(error)
        lastIssue = message
        ctx.logger?.write('warn', 'sourcing.validation_failed', { phase, tool: name,
          errorReason: browserFailureReason(error),
          errorCode: /\b[A-Z][A-Z0-9_]{3,}\b/.exec(message)?.[0] ?? 'SOURCING_ARGUMENT_INVALID' })
        if (name === 'sourcing_select_candidate' || name === 'sourcing_record_candidate') {
          try { diagnose('warn', 'assessment_rejected', { tool: name, errorCode: browserFailureCode(error), candidateKey: pending?.key,
            tabId: args.tabId, snapshotId: args.snapshotId,
            evidenceCharacters: name === 'sourcing_select_candidate' ? previewEvidence?.text.length ?? 0 : pending?.parts.join('\n').length ?? 0,
            ...(name === 'sourcing_select_candidate'
              ? { listConditions: (job.requirements?.listCriteria ?? []).map(criterion => ({ field: criterion.field })) }
              : { criteria: sourcingAssessmentDiagnostic(job.requirements?.criteria ?? [], args.assessments, pending?.parts.join('\n') ?? '') }) }) } catch { /* Retain the original validation error. */ }
        }
        if (/\b[A-Z][A-Z0-9_]{3,}\b/.test(message)) throw error
        throw new Error(`SOURCING_ARGUMENT_INVALID: ${message}`)
      }
    },
  })
  const status = () => ({ recorded: qualifiedCount(), limit: totalTarget, channelCount: qualifiedCount() - before, channelLimit: quota, requirements: job.requirements, searchFilters: job.searchFilters, minimumScore, searchReady, phase, pending: pending?.name, scanned: job.scanned, skippedLowScore: job.skippedLowScore, needsGreeting: !!greeter.awaiting, candidateKey: greeter.awaiting ?? pending?.key, selectedCandidate: selectedCandidate() })
  const confirmSearch = async (input: z.infer<typeof sourcingSearchConfirmationSpec>, toolSignal: AbortSignal) => {
    if (!job.requirements) throw new Error('SEARCH_CONDITIONS_UNVERIFIED: 请先提炼职位要求')
    const page = broker.getPage(input.tabId, input.snapshotId), item = readableIdentityRef(page, input.ref)
    if (recommendation) {
      assertRecommendationPage(page, entryUrl, entryAliases)
      if (input.mode !== 'position') throw new Error('SOURCING_POSITION_SELECTION_REQUIRED: 推荐寻聘必须确认当前招聘职位，不能使用关键词搜索代替')
    }
    await broker.inspectRefs(page, [input.ref, ...input.filters.map(row => row.ref)], toolSignal, true)
    await searchEvidence.inspect(page, [input.ref, ...input.filters.map(row => row.ref)], toolSignal)
    await searchEvidence.scan(page, platformPositions?.map(row => row.name) ?? [job.jobName || ''], job.searchFilters ?? {}, toolSignal)
    positionSelectorSeen ||= hasSourcingPositionSelector(page)
    let positionLevel: string | undefined
    if (input.mode === 'position') {
      const observed = searchEvidence.position(page, { jobId: job.jobId, jobName: job.position?.name || job.jobName, platformJobs: job.platformJobs?.[channel.platform] }, input)
      if (observed && !observed.ok) throw new Error(`SOURCING_POSITION_SELECTION_REQUIRED: ${observed.error}`)
      positionLevel = observed?.ok ? observed.verification.level : verifySourcingSearchPosition(page, job, channel.platform, input,
        positionRoute.isSelectedTrigger(input.tabId, page, input.ref)).level
    }
    else {
      if (positionSelectorSeen) throw new Error('SOURCING_POSITION_SELECTION_REQUIRED: 请先选择平台对应职位，并以mode=position确认')
      searchTracker.assertSubmitted(input.tabId)
      if (!['textbox', 'searchbox', 'combobox'].includes(item.role) || normalized(item.value).toLowerCase() !== normalized(job.requirements.keyword).toLowerCase()) throw new Error('SEARCH_CONDITIONS_UNVERIFIED: 缺少已生效搜索关键词的输入值')
    }
    const proofs = searchEvidence.completeFilterProofs(page, input.filters)
    if (recommendation && page.dialogs?.length) throw new Error('SEARCH_CONDITIONS_UNVERIFIED: 请先完成并关闭当前筛选面板，再确认推荐职位')
    const expected = job.searchFilters ?? deriveSourcingSearchFilters(job.position!, job.supplement)
    // Recommendation UI filters are an optional accelerator. A missing city
    // control never proves eligibility: every candidate is checked below.
    const pageExpected = recommendation ? Object.fromEntries(Object.entries(expected).filter(([field]) => proofs.some(proof => proof.field === field))) : expected
    const filters = verifySourcingSearchFilters(searchEvidence.filterPage(page, proofs), pageExpected, proofs)
    diagnose('info', 'search_prepared', { mode: input.mode, positionLevel, filters, tabId: input.tabId, snapshotId: input.snapshotId })
    searchReady = true; phase = 'reading'
    preparedSearch = { tabId: input.tabId, documentId: page.documentId }
    await ctx.progress(job, 'reading', recommendation ? '推荐职位已确认，将按本轮要求逐项核验列表初筛条件' : `职位与搜索筛选已确认${filters.some(row => row.state === 'unsupported') ? '，部分平台限制条件将逐人核对' : ''}，正在识别候选人`)
    return status()
  }
  const collectResume = async (input: z.infer<typeof readResumeSpec>, toolSignal: AbortSignal) => {
    if (!pending) throw new Error('先选择当前候选人')
    const selected = pending
    const page = broker.getPage(input.tabId, input.snapshotId)
    const platformCapture = await platform.readResume?.({ broker, page, candidate: selected, input, signal: toolSignal, readVisual })
    if (platformCapture) {
      if (normalized(selected.listText).includes(normalized(platformCapture.resumeText))) throw new Error('SOURCING_RESUME_DETAIL_REQUIRED: 详情正文仍是列表摘要')
      selected.parts = mergeSourcingResumeParts([...selected.parts, platformCapture.resumeText])
      selected.detailSeen = true
      return platformCapture
    }
    await broker.inspectRefs(page, [input.identityRef, ...input.resumeRefs], toolSignal, true)
    broker.candidateContext(page, [input.identityRef, ...input.resumeRefs], selected.name)
    let parts: string[]
    try {
      parts = sourcingResumeParts(page, selected.name, input.identityRef, input.resumeRefs)
      assertSourcingResumeDetail(page, input.identityRef, selected.selectionPage)
    }
    catch (error) {
      diagnose('warn', 'resume_evidence_rejected', { candidateKey: selected.key, errorCode: browserFailureCode(error), errorReason: browserFailureReason(error),
        anchor: sourcingTargetDiagnostic(page, input.identityRef, selected.name),
        fragments: input.resumeRefs.map(ref => sourcingTargetDiagnostic(page, ref, selected.name)) })
      throw error
    }
    toolSignal.throwIfAborted()
    selected.parts = mergeSourcingResumeParts([...selected.parts, ...parts])
    const merged = selected.parts.join('\n')
    if (merged.length > 60000) selected.parts = [merged.slice(0, 60000)]
    selected.detailSeen ||= /(?:工作经历|工作经验|工作履历|项目经历|项目经验)[\s\S]{12,}/.test(merged)
      && !normalized(selected.listText).includes(normalized(merged))
    return { page, resumeText: merged.slice(0, 30000), truncated: merged.length > 30000,
      foregroundSource: sourcingResumeDialog(page, input.identityRef)?.text, evidence: undefined }
  }
  const readCard = async (input: Pick<z.infer<typeof selectionSpec>, 'tabId' | 'snapshotId' | 'ref' | 'name' | 'evidenceRefs' | 'profileRef'>, toolSignal: AbortSignal) => {
    const page = broker.getPage(input.tabId, input.snapshotId)
    if (recommendation) assertRecommendationPage(page, entryUrl, entryAliases)
    if (input.tabId !== preparedSearch?.tabId || preparedSearch.documentId && page.documentId !== preparedSearch.documentId) throw new Error('SEARCH_CONDITIONS_UNVERIFIED: 列表页面已改变，请重新确认当前职位和筛选条件')
    await broker.inspectRefs(page, [input.ref, ...input.evidenceRefs, ...(input.profileRef ? [input.profileRef] : [])], toolSignal, true, !!platform.candidateIdentity)
    broker.candidateContext(page, [input.ref, ...input.evidenceRefs], input.name)
    const quote = assertCandidateQuote(page, input), profile = candidateProfile(page, input, origins)
    // Identity quotes can be just the name. Score against all verified,
    // related card sources, never arbitrary text elsewhere on the page.
    const evidenceRefs = [...new Set([input.ref, ...input.evidenceRefs])]
    const evidenceText = sourcingResumeParts(page, input.name, input.ref, evidenceRefs).join('\n').slice(0, 30000)
    previewEvidence = { tabId: input.tabId, snapshotId: input.snapshotId, name: input.name, refs: evidenceRefs, text: evidenceText }
    const platformIdentity = platform.candidateIdentity?.(page, evidenceRefs, broker)
    const textIdentity = platform.candidateTextIdentity?.(evidenceText)
    const key = platformIdentity ? platformIdentityKey(channel.platform, platformIdentity) : hash({ platform: channel.platform, identity: profile.url || textIdentity?.canonical || normalized(evidenceText) })
    const legacyKey = hash({ platform: channel.platform, identity: profile.url || normalized(quote) })
    const identityAliases = !platformIdentity && !profile.url && textIdentity
      ? [...new Set(textIdentity.aliases.map(identity => hash({ platform: channel.platform, identity })))].filter(alias => alias !== key) : []
    const keys = [key, legacyKey, ...identityAliases]
    // Persist reads before deciding eligibility, including cards rejected by
    // the list screen and all candidates read for a batched AI assessment.
    const viewed = job.viewedCandidates ??= []
    if (!viewed.some(row => row.platform === channel.platform && [row.key, ...(row.identityAliases ?? [])].some(alias => keys.includes(alias)))) {
      viewed.push({ key, platform: channel.platform, identityAliases, platformIdentity })
      await ctx.save(job)
    }
    const duplicate = keys.some(alias => rejected.has(alias) || previous.has(alias)) || job.candidates.some(row => {
      if (row.platform !== channel.platform) return false
      if (platformIdentity && row.platformIdentity && platformIdentityKey(channel.platform, platformIdentity) !== platformIdentityKey(channel.platform, row.platformIdentity)) return false
      return [row.key, ...(row.identityAliases ?? [])].some(alias => keys.includes(alias))
    })
    return { page, key, identityAliases, quote, profile, platformIdentity, evidenceText, duplicate }
  }
  const selectCandidate = async (input: z.infer<typeof selectionSpec>, toolSignal: AbortSignal, evidence?: Awaited<ReturnType<typeof readCard>>) => {
    if (greeter.awaiting) throw new Error('TASK_RESULT_REQUIRED: 先完成当前候选人的招呼')
    if (!searchReady || !job.requirements) throw new Error('SEARCH_CONDITIONS_UNVERIFIED: 先确认实际搜索条件')
    const { page, key, identityAliases, quote, profile, platformIdentity, evidenceText, duplicate } = evidence ?? await readCard(input, toolSignal)
    if (pending) {
      if (key !== pending.key) throw new Error('TASK_RESULT_REQUIRED: 先完成已选候选人的评估，不能覆盖为其他人')
      return { ...status(), alreadySelected: true, qualified: true, duplicate: false,
        next: '当前候选人已完成列表初筛，沿用本次选择打开并读取同一人的在线简历；不要重复选择。无法定位时显式跳过。' }
    }
    if (duplicate) {
      const attempts = (duplicateAttempts.get(key) ?? 0) + 1
      duplicateAttempts.set(key, attempts)
      diagnose('info', 'candidate_preflight', { candidateKey: key, decision: 'duplicate', tabId: input.tabId, snapshotId: input.snapshotId })
      if (attempts > 1) throw new Error('SOURCING_DUPLICATE_REPEAT: 同一已处理人选被重复选择；请滚动候选列表找到新人，不要再次选择或调用skip')
      pending = undefined; return { duplicate: true, candidateKey: key,
        next: '此人已处理，无需调用skip；直接处理下一个当前可见候选人。当前屏都是旧人时，滚动候选列表或调用sourcing_collect继续。' }
    }
    const preview = assessListCandidate(job.requirements.listCriteria, input.listAssessments, evidenceText)
    diagnose('info', 'candidate_preflight', { candidateKey: key, decision: preview.qualified ? 'qualified' : preview.mismatch ? 'skip_conditions' : 'skip_unverified',
      conditionStates: input.listAssessments.map(row => ({ field: row.field, state: row.state })),
      score: preview.score, matchedCount: preview.matchedCount, requiredCount: preview.requiredCount, evidenceCharacters: evidenceText.length,
      tabId: input.tabId, snapshotId: input.snapshotId })
    job.scanned = (job.scanned ?? 0) + 1
    if (!preview.qualified) {
      rejected.add(key)
      if (preview.mismatch) job.skippedByFilters = (job.skippedByFilters ?? 0) + 1
      else job.skippedUnverified = (job.skippedUnverified ?? 0) + 1
      await ctx.progress(job, 'reading', `候选人[${input.name}]列表初筛 ${preview.matchedCount}/${preview.requiredCount} 项符合；${listAssessmentFailure(job.requirements.listCriteria!, input.listAssessments)}；已跳过并继续寻聘`)
      return { skipped: true, qualified: false, score: preview.score, matchedCount: preview.matchedCount, requiredCount: preview.requiredCount, next: '列表初筛要求必须全部符合，不打开详情' }
    }
    pending = { refs: [input.ref, ...input.evidenceRefs], identity: quote, name: input.name, key, identityAliases, profileUrl: profile.url, platformIdentity, selectionSnapshot: input.snapshotId,
      selectionPage: { tabId: page.tabId, url: page.url, documentId: page.documentId }, listText: evidenceText, listAssessments: input.listAssessments, parts: [], detailSeen: false }
    phase = 'reading'
    await ctx.progress(job, 'reading', `候选人[${input.name}]列表初筛通过，准备打开简历详情`)
    return { duplicate: false, qualified: true, score: preview.score, matchedCount: preview.matchedCount, requiredCount: preview.requiredCount, name: input.name, next: '读取当前候选人简历后逐项分析' }
  }
  const recordCandidate = async (input: z.infer<typeof recordSpec>, toolSignal: AbortSignal, captured?: Awaited<ReturnType<typeof collectResume>>) => {
    if (!pending || !job.requirements) throw new Error('先选择当前候选人')
    if (qualifiedCount() >= totalTarget || qualifiedCount() - before >= quota) throw new Error('TASK_LIMIT_REACHED: 本渠道或本轮已达到人数上限')
    const capture = captured ?? await collectResume(input, toolSignal)
    const { page, resumeText, truncated, foregroundSource } = capture
    const candidateLabel = `候选人[${pending.name}]`
    if (!resumeText) throw new Error('未读取到可归属当前候选人的简历')
    assertResumeContent(resumeText)
    for (const field of input.fields) if (!normalized(resumeText).includes(normalized(field.value))) throw new Error(`SOURCING_FIELD_EVIDENCE_MISSING: ${field.label}无法在已读原文定位，请逐字摘录；原文没有则省略该字段`)
    const assessment = assessCandidate(job.requirements.criteria, input.assessments, resumeText)
    const eligibility = assessCandidateFilters(candidateFilters, input.filterAssessments, resumeText)
    toolSignal.throwIfAborted()
    if (!eligibility.matched) {
      diagnose('info', 'candidate_discarded', { candidateKey: pending.key, reason: eligibility.mismatch ? 'final_conditions_mismatch' : 'final_conditions_unknown',
        conditionStates: input.filterAssessments.map(row => ({ field: row.field, state: row.state })) })
      rejected.add(pending.key); pending = undefined; job.skippedByFilters = (job.skippedByFilters ?? 0) + 1
      await ctx.progress(job, 'reading', `${candidateLabel}：${candidateFilterFailure(candidateFilters, input.filterAssessments)}；未保存本次人选`)
      return { skipped: true, qualified: false, score: assessment.score }
    }
    const hardConflict = !!assessment.scoring && assessment.verdict === 'unqualified'
    const insufficientEvidence = !!assessment.scoring?.needsReview
    if (hardConflict || insufficientEvidence || assessment.score < minimumScore) {
      diagnose('info', 'candidate_discarded', { candidateKey: pending.key, reason: hardConflict ? 'final_required_condition_mismatch' : insufficientEvidence ? 'final_evidence_insufficient' : 'final_score_below_minimum', score: assessment.score, coverage: assessment.coverage, minimumScore })
      rejected.add(pending.key); pending = undefined
      if (insufficientEvidence) job.skippedUnverified = (job.skippedUnverified ?? 0) + 1
      else job.skippedLowScore = (job.skippedLowScore ?? 0) + 1
      await ctx.progress(job, 'reading', hardConflict ? `${candidateLabel}详细评估发现硬性条件明确不符，已跳过并继续寻聘` : insufficientEvidence ? `${candidateLabel}详细评估的硬性条件或核心能力证据不足，未达标，已跳过并继续寻聘` : `${candidateLabel}详细评估未达到${minimumScore}分，已丢弃本次采集信息并跳过`)
      return { skipped: true, qualified: false, score: assessment.score }
    }
    const scope = 'online' as const
    const candidateKey = pending.key
    job.candidates.push({ name: pending.name, key: pending.key, ...(pending.identityAliases.length ? { identityAliases: pending.identityAliases } : {}), profileUrl: pending.profileUrl, platformIdentity: pending.platformIdentity, platform: channel.platform, sourceUrl: safePageUrl(page.url), collectedAt: now(), scope, resumeTruncated: truncated,
      fields: input.fields, listProfile: candidateListProfile(resumeText, pending.listText, channel.platform), resumeText, ...(capture.evidence ? { resumeEvidence: capture.evidence } : {}), listAssessments: pending.listAssessments, assessments: input.assessments, filterAssessments: input.filterAssessments, analysis: input.analysis, ...assessment })
    channel.candidateCount = qualifiedCount() - before
    job.results.push({ key: pending.key, name: pending.name, stage: 'succeeded', detail: `匹配 ${assessment.score}/100 · ${assessment.coverage < 100 ? '达标，部分材料未说明' : '已读原文评估'}`, updatedAt: now() })
    greeter.queue(job.candidates[job.candidates.length - 1], pending.identity, page, foregroundSource)
    previous.add(pending.key); pending = undefined
    phase = 'reading'
    await ctx.progress(job, 'reading', `${PLATFORMS[channel.platform].label}已保存 ${channel.candidateCount}/${quota} 位达标人选 · ${candidateLabel}`)
    diagnose('info', 'candidate_recorded', { candidateKey, scope, score: assessment.score, coverage: assessment.coverage,
      capturedCharacters: resumeText.length, candidateCount: job.candidates.length, saved: true })
    return status()
  }
  const assertResumeContent = (text: string) => {
    if (!pending?.detailSeen || !/(?:工作经历|工作经验|工作履历|项目经历|项目经验)[\s\S]{12,}/.test(text)
      || normalized(pending.listText).includes(normalized(text))) {
      throw new Error('SOURCING_RESUME_DETAIL_REQUIRED: 尚未取得超出列表摘要的工作或项目经历；请继续读取当前简历详情，无法读取时跳过，不能按完成采集保存')
    }
  }
  const tools: BrowserAgentTool[] = [...broker.tools,
    hook('sourcing_inspect_search', `${recommendation ? '只读核对推荐页当前招聘职位和已生效的筛选，不要求搜索按钮。' : '只读核对当前顶部招聘职位、筛选行的真实选中状态与活动搜索按钮。'}先调用本工具；已正确选择的条件不要重复点击。DOM页会返回新语义快照，请使用返回的新引用。`, z.object(pageSpec).strict(), async (input, toolSignal) => {
      let page = broker.getPage(input.tabId, input.snapshotId)
      let observation: unknown
      if (searchEvidence.enabled(page) && page.format !== 'semantic') {
        observation = await broker.tools.find(tool => tool.name === 'browser_snapshot')!.execute({ tabId: input.tabId, format: 'semantic' }, toolSignal)
        page = broker.getPage(input.tabId)
      }
      await searchEvidence.scan(page, platformPositions?.map(row => row.name) ?? [job.jobName || ''], job.searchFilters ?? {}, toolSignal)
      return { ...searchEvidence.summary(page, job.searchFilters), ...(observation ? { observation } : {}) }
    }),
    hook('sourcing_define_requirements', '按recruitment-matching技能提炼分层匹配标准、补充要求覆盖关系及搜索关键词。已有标准不可修改。', rubricRequirementsSpec, async input => {
      if (job.requirements?.listCriteria) return job.requirements
      input = { ...input, listCriteria: withFixedListCriteria(job.position!, job.supplement, input.listCriteria) }
      validateCriteria(input.criteria, sourcingSource(job.position!, job.supplement))
      validateListCriteria(input.listCriteria, sourcingSource(job.position!, job.supplement))
      validateSupplementCoverage(input, job.supplement)
      if (!normalized(sourcingSource(job.position!, job.supplement)).toLowerCase().includes(normalized(input.keyword).toLowerCase())) throw new Error('搜索关键词必须出自职位名称或要求')
      job.requirements = { ...input, basicFilters: job.searchFilters ?? deriveSourcingSearchFilters(job.position!, job.supplement), rubricVersion: 2 }
      phase = 'searching'
      await ctx.store.put(`criteria-${job.requirementVersion}`, job.requirements)
      await ctx.progress(job, 'searching', `已提炼 ${input.criteria.length} 个匹配维度`)
      return job.requirements
    }),
    hook('sourcing_search', '仅无职位选择器时使用主关键词输入框填写并提交搜索，随后必须sourcing_confirm_search核验已生效的固定筛选；有职位选择器时请先选职位。', z.object({ ...pageSpec, inputRef: z.string().min(1) }).strict(), async (input, toolSignal) => {
      if (recommendation) throw new Error('SOURCING_RECOMMENDATION_REQUIRED: 本轮从人才推荐寻聘，不能自动调用关键词搜索')
      if (searchReady) return { ...status(), note: '搜索已确认，不再重复提交，请继续读取候选人' }
      if (!job.requirements) throw new Error('SEARCH_CONDITIONS_UNVERIFIED: 请先提炼职位要求')
      const page = broker.getPage(input.tabId, input.snapshotId)
      positionSelectorSeen ||= hasSourcingPositionSelector(page)
      if (positionSelectorSeen) throw new Error('SOURCING_POSITION_SELECTION_REQUIRED: 页面有职位选择器，请先选择对应职位，不使用关键词搜索')
      await broker.inspectRefs(page, [input.inputRef], toolSignal, true)
      const field = readableIdentityRef(page, input.inputRef)
      if (!['textbox', 'searchbox'].includes(field.role)) throw new Error('SOURCING_MAIN_SEARCH_REQUIRED: 请选择主关键词输入框，不是高级职位筛选下拉框')
      const nativeType = broker.tools.find(tool => tool.name === 'browser_type')!
      const nativeKey = broker.tools.find(tool => tool.name === 'browser_press_key')
      if (!nativeKey) throw new Error('SOURCING_SEARCH_KEY_UNAVAILABLE: 当前扩展没有回车工具，请使用原生搜索按钮并核验')
      const snapshot = broker.tools.find(tool => tool.name === 'browser_snapshot')!
      await nativeType.execute({ tabId: input.tabId, snapshotId: input.snapshotId, ref: input.inputRef, text: job.requirements.keyword,
        ...((nativeType.inputSchema.properties as any)?.clear ? { clear: true } : {}) }, toolSignal)
      await snapshot.execute({ tabId: input.tabId, format: 'dom' }, toolSignal)
      await nativeKey.execute({ tabId: input.tabId, key: 'Enter' }, toolSignal)
      const observation = await snapshot.execute({ tabId: input.tabId, format: 'dom' }, toolSignal)
      const resultPage = broker.getPage(input.tabId)
      const inputs = resultPage.items.filter((item: any) => item.role === field.role
        && (field.elementId ? item.elementId === field.elementId : normalized(item.name) === normalized(field.name))
        && normalized(item.value).toLowerCase() === normalized(job.requirements!.keyword).toLowerCase())
      if (inputs.length !== 1) throw new Error('SEARCH_CONDITIONS_UNVERIFIED: 提交后未能唯一定位原关键词搜索框')
      return { ...status(), observation, inputRef: inputs[0].ref, next: '关键词已提交；请核对searchFilters各字段，调用sourcing_confirm_search后再读取候选人' }
    }),
    hook('sourcing_confirm_search', recommendation ? '关闭筛选面板后以mode=position核验当前招聘职位；filters仅提供可证实已应用的页面条件，可留空。所有城市/经验/学历要求仍由宿主按候选人原文逐项核验，不需要关键词搜索。' : '读取候选人前统一核验：有职位选择器用mode=position引用当前选中职位，否则mode=keyword引用已提交搜索框；filters必须逐项提供城市/经验/学历已生效证据。', sourcingSearchConfirmationSpec, confirmSearch),
    hook('sourcing_select_candidate', '从已搜索列表建立当前候选身份；duplicate为true时跳过，不重复读。', selectionSpec, selectCandidate),
    hook('sourcing_skip_candidate', '放弃当前已初筛但无法可靠读取的人选，丢弃未保存片段并允许继续选人。不是保存成功，不计入达标人数；不能撤销已发出或待核对的招呼。',
      z.object({ reason: z.string().trim().min(1).max(300) }).strict(), async () => {
        if (greeter.awaiting) throw new Error('TASK_RESULT_REQUIRED: 当前招呼尚未完成或待核对，不能通过跳过解除保护')
        if (!pending) return { skipped: false, next: '当前没有待处理人选，无需skip；只选择当前可见且未处理的新人，或滚动候选列表继续。' }
        const key = pending.key, name = pending.name, discardedCharacters = pending.parts.join('\n').length
        rejected.add(key); pending = undefined; previewEvidence = undefined; lastIssue = ''; phase = 'reading'
        job.skippedUnverified = (job.skippedUnverified ?? 0) + 1
        diagnose('info', 'candidate_abandoned', { candidateKey: key, discardedCharacters, saved: false })
        await ctx.progress(job, 'reading', `已放弃候选人[${name}]，未保存，可返回列表继续寻聘`)
        return { skipped: true, saved: false, discardedCharacters, next: '返回原推荐或搜索列表，核对筛选后选择下一人；不重复选择已放弃的人选' }
      }),
    hook('sourcing_read_resume', '滚动前保存当前候选人的已读简历片段，随后可继续滚动；宿主核验身份并累积真实原文。', readResumeSpec, async (input, toolSignal) => {
      const captured = await collectResume(input, toolSignal)
      diagnose('info', 'resume_read', { candidateKey: pending?.key, tabId: input.tabId, snapshotId: input.snapshotId,
        anchorRef: input.identityRef, resumeRefs: input.resumeRefs, capturedCharacters: captured.resumeText.length,
        truncated: captured.truncated, scope: pending?.detailSeen ? 'online' : 'summary',
        sourceKind: captured.evidence?.kind ?? 'dom', imagePages: captured.evidence?.pages, imageHashes: captured.evidence?.imageHashes, saved: false })
      phase = 'evaluating'
      if (!pending?.detailSeen) throw new Error('SOURCING_RESUME_DETAIL_REQUIRED: 尚未取得超出列表摘要的简历详情正文')
      await ctx.progress(job, 'evaluating', `候选人[${pending!.name}]已读取简历详情 ${captured.resumeText.length} 字${captured.evidence ? '（图片识别）' : ''}，正在分析匹配度`)
      return { capturedCharacters: captured.resumeText.length, truncated: captured.truncated, scope: pending?.detailSeen ? 'online' : 'summary' }
    }),
    hook('sourcing_record_candidate', '保存当前候选人已读取原文、基本信息和带证据的逐项分析，宿主计算得分。', recordSpec, recordCandidate),
    hook('sourcing_greet_candidate', '仅在autoGreet开启且当前人选评分达标并保存后，核验身份与职位，点击平台默认单人招呼；由宿主记录实际结果，未知结果停止且不重发。', sourcingGreetingSpec, async (input, toolSignal) => {
      phase = 'greeting'
      const result = await greeter.execute(input, toolSignal)
      phase = 'reading'
      return result
    }),
    hook('sourcing_finish', '本平台达到channelLimit后才完成；不足人数必须引用平台明确的末尾或无结果提示exhaustion。操作受阻用stopped，本轮将停止并保留已有结果。', z.object({ status: z.enum(['completed', 'stopped']), reason: z.string().min(1).max(500), exhaustion: z.object({ ...pageSpec, ref: z.string().min(1), quote: z.string().min(1).max(300) }).strict().optional() }).strict(), async input => {
      if (input.status === 'completed' && !searchReady) throw new Error('SEARCH_CONDITIONS_UNVERIFIED: 尚未完成实际搜索，只能停止')
      if (input.status === 'completed' && (greeter.awaiting || pending)) throw new Error('TASK_RESULT_REQUIRED: 请先完成当前候选人的评估和招呼或停止并说明')
      if (input.status === 'completed' && qualifiedCount() - before < quota) {
        if (!input.exhaustion) throw new Error('SOURCING_QUOTA_NOT_REACHED: 本平台未达到目标人数，请继续翻页；确无更多结果需引用exhaustion证据，操作受阻请停止')
        const page = broker.getPage(input.exhaustion.tabId, input.exhaustion.snapshotId)
        if (input.exhaustion.tabId !== preparedSearch?.tabId || preparedSearch.documentId && page.documentId !== preparedSearch.documentId) throw new Error('SEARCH_CONDITIONS_UNVERIFIED: 请先重新确认当前列表职位和筛选，再核对末尾提示')
        if (recommendation) assertRecommendationPage(page, entryUrl, entryAliases)
        verifySourcingExhaustion(page, input.exhaustion)
        diagnose('info', 'channel_exhausted', { channelCount: qualifiedCount() - before, channelLimit: quota, tabId: input.exhaustion.tabId, snapshotId: input.exhaustion.snapshotId, ref: input.exhaustion.ref })
      }
      done = true; channel.status = input.status; channel.detail = safeError(input.status === 'completed' && qualifiedCount() - before < quota ? `已找到 ${qualifiedCount() - before}/${quota} 人，${recommendation ? '人才推荐已无更多结果，本渠道结束，未转人才搜索' : '平台已无更多结果'}；${input.reason}` : input.reason); await ctx.save(job); return status()
    }),
  ]

  // Recovery changes navigation ownership only. The model supplies locators;
  // immutable, ownership-checked text goes through the same isolated evaluator.
  // Commit consumes that captured evidence without re-reading expiring refs
  // after the model call. Subsequent browser inputs still require fresh refs.
  const recoveryTools = (evaluator: BrowserAgentRunner) => tools.map(tool => {
    if (tool.name === 'sourcing_select_candidate') return hook(tool.name,
      '引用同一卡片的候选身份和证据节点；宿主读取原文、独立初筛并计算分数。无需填写assessments。只有qualified=true才能打开详情。',
      selectionSpec.omit({ listAssessments: true }).strip(), async (input, s) => {
        if (greeter.awaiting) throw new Error('TASK_RESULT_REQUIRED: 先完成当前候选人的招呼')
        if (!searchReady || !job.requirements) throw new Error('SEARCH_CONDITIONS_UNVERIFIED: 先确认实际搜索条件')
        const evidence = await readCard(input, s)
        if (pending) return selectCandidate({ ...input, listAssessments: [] }, s, evidence)
        if (evidence.duplicate) return selectCandidate({ ...input, listAssessments: [] }, s, evidence)
        const [row] = await evaluateSources(evaluator, job.requirements, [{ sourceId: evidence.key, name: input.name, text: evidence.evidenceText }], s, ctx.logger, 'preview', candidateFilters)
        return selectCandidate({ ...input, listAssessments: row!.listAssessments }, s, evidence)
      })
    if (tool.name === 'sourcing_record_candidate') return hook(tool.name,
      '引用当前候选人的已读简历节点；宿主读取原文、独立评估并保存。无需填写fields、assessments、analysis。',
      recordSpec.omit({ fields: true, assessments: true, analysis: true, filterAssessments: true }).strip(), async (input, s) => {
        if (!pending || !job.requirements) throw new Error('先选择当前候选人')
        if (qualifiedCount() >= totalTarget || qualifiedCount() - before >= quota) throw new Error('TASK_LIMIT_REACHED: 本渠道或本轮已达到人数上限')
        const captured = await collectResume(input, s)
        if (!captured.resumeText) throw new Error('未读取到可归属当前候选人的简历')
        assertResumeContent(captured.resumeText)
        const [row] = await evaluateSources(evaluator, job.requirements, [{ sourceId: hash({ candidate: pending.key, text: captured.resumeText }), name: pending.name, text: captured.resumeText }], s, ctx.logger, 'detail', candidateFilters)
        return recordCandidate({ ...input, fields: row!.fields, assessments: row!.assessments, filterAssessments: row!.filterAssessments, analysis: judgementAnalysis(row!, job.requirements) }, s, captured)
      })
    return tool
  })

  return {
    run: async () => runSourcingWorkflow(platform, { broker, job, signal }, { tools, recoveryTools,
      preview: async (card, previewSignal) => {
        const page = broker.currentPage()
        const evidence = await readCard({ ...card, tabId: page.tabId, snapshotId: page.snapshotId }, previewSignal)
        return { text: evidence.evidenceText, duplicate: evidence.duplicate, candidateKey: evidence.key }
      },
      complete: () => done || !greeter.awaiting && qualifiedCount() - before >= quota,
      remaining: () => Math.max(0, quota - (qualifiedCount() - before)),
      progress: message => ctx.progress(job, 'reading', message),
      state: () => ({ searchReady, pending: pending?.name, needsGreeting: !!greeter.awaiting, candidateKey: greeter.awaiting ?? pending?.key, selectedCandidate: selectedCandidate() }),
      captured: () => pending && ({ name: pending.name, text: pending.parts.join('\n').slice(0, 30000), scope: pending.detailSeen ? 'online' : 'summary' }),
    }, agent, { system: sourcingSystem(sourceMode) + `\n${recommendation ? platform.sourcingHints : platform.sourcingSearchHints ?? ''}`, goal: { task: recommendation ? '从人才推荐寻聘并评估职位匹配度' : '搜索人才并评估职位匹配度', platform: channel.platform,
      entryUrl, sourceMode,
      position: job.position && { id: job.position.id, name: job.position.name, city: job.position.city, department: job.position.department, description: job.position.description }, supplement: job.supplement, supplementParts: supplementParts(job.supplement), requirements: job.requirements, autoGreet: !!job.autoGreet, minimumScore, platformJobs: job.platformJobs?.[channel.platform],
      searchFilters: job.searchFilters, searchOrder: ['select_platform_position', 'apply_city_experience_education', 'confirm_search', 'read_and_score_candidates'], channelLimit: quota, totalLimit: totalTarget, limitScope: job.limitScope, previousCount: previous.size }, tools, signal,
      initialToolResults: await bootstrapSourcing(broker, entryUrl, recommendation, signal, entryAliases, channel.platform), maxTurns: 24 + quota * 14, maxDurationMs: 20 * 60 * 1000,
      modelPurpose: 'navigation', maxOutputTokens: 2048,
      logger: ctx.logger, isComplete: () => done || !greeter.awaiting && qualifiedCount() - before >= quota,
      isFatal: error => isPlatformLoginRequired(error) || /OUTCOME_UNKNOWN|RESULT_UNKNOWN|TASK_STORAGE_UNAVAILABLE/.test(String(error)),
      // Only host-verified milestones enter the persisted progress feed; rejected list identities stay transient.
      onProgress: async () => { signal.throwIfAborted() } }),
    complete: () => done || !greeter.awaiting && qualifiedCount() - before >= quota,
    failureDetail: () => `停止环节：${({ preparing: '提炼职位要求', searching: recommendation ? '核对推荐职位和筛选' : '提交和核对搜索', reading: '定位或读取候选人', evaluating: '匹配分析与保存', greeting: '核验职位并打招呼' })[phase]}${lastIssue ? `；最近问题：${lastIssue}` : ''}`,
    finish: () => diagnose('info', 'channel_finished', { status: channel.status, aborted: signal.aborted, scanned: job.scanned ?? 0, skippedLowScore: job.skippedLowScore ?? 0,
      candidateCount: job.candidates.length, channelCount: qualifiedCount() - before, channelLimit: quota, candidatePending: !!pending, candidateKey: pending?.key,
      pendingResumeCharacters: pending?.parts.join('\n').length ?? 0, detailSeen: pending?.detailSeen ?? false, greetingPending: !!greeter.awaiting }),
  }
}
