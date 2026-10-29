import type { BrowserAgentOptions, BrowserAgentResult, BrowserAgentTool, BrowserAgentSeed } from '../browser-agent.js'
import type { BrowserAgentRunner } from '../host-browser-agent.js'
import type { RecruitmentPlatform } from '../platforms/types.js'
import type { ResumeLocator, SourcingCard, SourcingDriverContext, SourcingOperations } from './types.js'
import { evaluateSources, judgementAnalysis } from './evaluator.js'
import { hash } from '../store.js'
import { recoverablePageError } from '../page-actions.js'
import { SourcingHandoff } from './browser.js'
import { browserFailureCode } from '../browser-errors.js'
import { sourcingMode } from './source.js'
import { LIST_REQUIREMENTS_PROMPT } from './list-screening.js'
import { matchingInstructions, requirementsGoal } from './matching-skill.js'
import { assertPlatformPageLogin, isPlatformLoginRequired } from '../platform-login.js'

/** Platform code runs first. Navigation inference starts only at an unexpected
 * state and yields back to the same driver after recovery. Assessment models
 * receive immutable business evidence, never browser tools. */
export async function runSourcingWorkflow(platform: RecruitmentPlatform, context: SourcingDriverContext,
  operations: SourcingOperations, agent: BrowserAgentRunner, fallback: BrowserAgentOptions): Promise<BrowserAgentResult> {
  const started = Date.now(), budget = fallback.maxDurationMs ?? 20 * 60 * 1000
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new Error('SOURCING_DURATION_BUDGET')), budget)
  const signal = AbortSignal.any([context.signal, deadline.signal])
  const candidateFilters = sourcingMode(context.job) === 'recommend' ? context.job.searchFilters : undefined
  let modelMs = 0, turns = 0
  let failedState: string | undefined
  let lastHandoff: string | undefined
  let obstructionFrame: number | undefined
  let unreadableResumes = 0
  const seen = new Set<string>()
  const driver = platform.createSourcingDriver?.({ ...context, signal, progress: operations.progress })
  let prepared = false
  const scopedAgent: BrowserAgentRunner = async options => {
    const result = await agent({ ...options, signal: AbortSignal.any([signal, options.signal]),
      maxDurationMs: Math.min(options.maxDurationMs ?? budget, Math.max(1, budget - (Date.now() - started))) })
    modelMs += result.modelMs; turns += result.turns
    if (/OUTCOME_UNKNOWN|RESULT_UNKNOWN|TASK_STORAGE_UNAVAILABLE/.test(result.message)) throw new Error(result.message)
    return result
  }
  const log = (event: string, fields: Record<string, unknown>) => {
    try { fallback.logger?.write('info', `sourcing.fast_${event}`, fields) } catch {}
  }
  const finish = (result: BrowserAgentResult) => {
    log('execution_finished', { durationMs: Date.now() - started, navigationTurns: result.turns - turns,
      assessmentTurns: turns, modelMs: result.modelMs, toolMs: result.toolMs, completed: operations.complete() })
    return result
  }
  const executeOperation = async (name: string, args: Record<string, unknown>, executionSignal: AbortSignal) => {
    executionSignal.throwIfAborted()
    const tool = operations.tools.find(t => t.name === name)
    if (!tool) throw new Error('SOURCING_OPERATION_MISSING')
    const value = await tool.execute(args, executionSignal)
    return value as any
  }
  const stateKey = () => {
    const page = context.broker.currentPage()
    return hash({ state: operations.state(), document: page?.documentId, url: page?.url,
      // Refreshing refs/online hints cannot restart a failed fixed route. A
      // real input or a host milestone can; the driver still checks its result.
      inputRevision: context.broker.inputRevision,
      ...(context.broker.inputRevision === undefined ? { items: page?.items?.map((item: any) => [item.role, item.name, item.value, item.states]) } : {}) })
  }
  const recoverable = (error: unknown) => !isPlatformLoginRequired(error) && !/OUTCOME_UNKNOWN|RESULT_UNKNOWN|TASK_STORAGE_UNAVAILABLE/.test(String(error))
    && (error instanceof SourcingHandoff || recoverablePageError(error)
      || /^(?:SOURCING_|SEARCH_CONDITIONS_UNVERIFIED|SEMANTIC_DETAILS_UNAVAILABLE)/.test(error instanceof Error ? error.message : ''))
  const collection: BrowserAgentTool = {
    name: 'sourcing_collect',
    description: '恢复到已知页面后继续平台固定流程。宿主已先执行过，并会在你处理异常后自动接回；无需逐个选择、滚动或读取已知列表。尚未改变页面时不要重复调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readOnly: false,
    failureKey: () => 'platform-collection',
    contextSnapshot: (args, value) => context.broker.contextSnapshot(args, value),
    recover: async (error, _args, toolSignal) => {
      const page = context.broker.currentPage()
      const hostState = operations.state()
      const obstruction = /ELEMENT_OCCLUDED|PAGE_DIALOG_BLOCKED|(?:unexpected.*dialog|list_has_dialog|scroll_anchor_missing)/.test(String(error))
      let obstructionContext: Record<string, unknown> | undefined
      let observation: unknown
      if (page?.tabId) {
        const snapshot = context.broker.tools.find(tool => tool.name === 'browser_snapshot')!
        const supportsFormat = !!(snapshot.inputSchema?.properties as any)?.format
        try {
          observation = await snapshot.execute({ tabId: page.tabId,
            ...(supportsFormat && (obstruction || hostState.pending || hostState.needsGreeting) ? { format: 'dom' } : {}) }, toolSignal)
          if (obstruction) {
            const current = context.broker.currentPage()
            obstructionContext = { blockedFrameId: page.frameId ?? 0, activeFrameId: current?.frameId ?? 0,
              next: '先识别并处理遮挡，再继续人选。检查前景弹窗和关闭控件；无文字的关闭图标先browser_inspect_element核对其关闭语义及弹窗归属，再点击。不要点击被遮挡的姓名或招呼按钮，也不要用确认/购买/发送代替关闭。关闭后读取新快照确认弹窗消失，再恢复原列表帧和当前候选人。' }
            // An outer-page overlay can cover an otherwise readable iframe.
            // Keep only the latest observation actionable for this tab.
            const closeInFrame = current?.items?.some((item: any) =>
              (/^(?:关闭|close|×)$/i.test(String(item.name ?? '').trim())
                || current?.dialogs?.some((dialog: any) => dialog.closeRef === item.ref))
              && !/(?:hidden|invisible|occluded|blocked_by_dialog)/.test(JSON.stringify(item.states ?? [])))
            if (page.frameId && !closeInFrame && (snapshot.inputSchema?.properties as any)?.frameId) {
              observation = await snapshot.execute({ tabId: page.tabId, frameId: 0, ...(supportsFormat ? { format: 'dom' } : {}) }, toolSignal)
              obstructionContext.activeFrameId = 0
              obstructionContext.returnFrameId = page.frameId
              obstructionFrame = page.frameId
            }
          }
        } catch (error) {
          toolSignal.throwIfAborted()
          observation = { error: browserFailureCode(error) ?? 'OBSERVATION_UNAVAILABLE' }
        }
      }
      if (obstruction) failedState = stateKey()
      const captured = operations.captured()
      return { hostState, requirements: context.job.requirements, observation, ...(obstructionContext ? { obstruction: obstructionContext } : {}), processedCandidateKeys: [...seen].slice(-80),
        capturedResume: captured && { name: captured.name, characters: captured.text.length, scope: captured.scope },
        next: hostState.pending
          ? '候选人已完成列表初筛并处于待处理状态。hostState.selectedCandidate 是当前人选的稳定身份和列表依据；按当前平台的简历入口（链接或明确的查看控件）打开同一人的详情，再读取、评估和保存。姓名文本本身不一定是入口，找不到可验证的入口时不要反复点击同一节点，按平台提示停止并说明。不要再次选择或替换候选人；确实无法定位时调用sourcing_skip_candidate后继续。'
          : hostState.needsGreeting ? '当前人选已保存，先核对并完成同一人的招呼；不能重选、跳过或重发结果未知的动作。'
          : '本轮已处理的候选标识在processedCandidateKeys中。只处理当前可见的新人；duplicate=true不需要再调用skip。当前屏都已处理时，滚动实际候选列表或准备好页面后调用sourcing_collect。不要反复选择旧人；不得重发结果未知的动作。' }
    },
    execute: async (args, executionSignal) => {
      const signal = AbortSignal.any([context.signal, deadline.signal, executionSignal])
      const execute = (name: string, input: Record<string, unknown>) => executeOperation(name, input, signal)
      if (Object.keys(args).length) throw new Error('SOURCING_ARGUMENT_INVALID: sourcing_collect 不接受额外参数')
      signal.throwIfAborted()
      assertPlatformPageLogin(context.broker.currentPage())
      if (failedState === stateKey()) throw new SourcingHandoff('collection_state_unchanged')
      if (!driver) throw new SourcingHandoff('platform_driver_missing')
      try {
        if (!await driver.recognizes()) throw new SourcingHandoff('page_not_recognized')
        if (!context.job.requirements?.listCriteria) {
          let defined = false
          const define = operations.tools.find(t => t.name === 'sourcing_define_requirements')!
          await scopedAgent({ system: matchingInstructions() + '\n当前阶段：提炼要求。quote逐字引用职位或补充原文，关键词出自职位名或要求。已有criteria时原样保留。' + LIST_REQUIREMENTS_PROMPT + '只调用 sourcing_define_requirements 一次。',
            goal: requirementsGoal(context.job.position, context.job.supplement ?? '', context.job.requirements), signal, tools: [{ ...define, execute: async (args, s) => {
              const result = await define.execute(args, s); defined = true; return result
            } }], maxTurns: 2, modelPurpose: 'assessment', isComplete: () => defined, logger: fallback.logger })
          if (!defined) throw new SourcingHandoff('requirements_incomplete')
        }
        const returnToList = async () => {
          if (operations.complete()) return
          const returned = await driver.returnToList()
          if (returned) await execute('sourcing_confirm_search', returned)
        }
        const finishSelected = async (name: string, candidateSource: string, locator: ResumeLocator) => {
          try { await execute('sourcing_read_resume', locator) }
          catch (error) {
            // A known, owned detail whose transcription is incomplete can be
            // abandoned safely. Provider failures and uncertain inputs remain fatal.
            if (!driver.hasOpenResume?.(name) || !/^RESUME_IMAGE_(?:UNREADABLE|TRANSCRIPTION_INVALID|INCOMPLETE)(?::|$)/.test(error instanceof Error ? error.message : '')) throw error
            await execute('sourcing_skip_candidate', { reason: '简历图片未完整识别，未保存，继续寻找下一位候选人' })
            await returnToList()
            unreadableResumes++
            log('resume_unreadable', { consecutive: unreadableResumes, skipped: true })
            if (unreadableResumes >= 3) throw new Error('RESUME_IMAGE_REPEATED_UNREADABLE: 连续 3 位候选人的简历图片未完整识别，已停止；请检查图片读取能力，已有结果保留')
            await operations.progress?.(`候选人[${name}]简历图片未完整识别，已跳过，正在继续寻聘`)
            return
          }
          unreadableResumes = 0
          const captured = operations.captured()
          if (!captured?.text || captured.scope !== 'online') throw new SourcingHandoff('resume_detail_incomplete')
          const sourceId = hash({ candidate: operations.state().selectedCandidate?.candidateKey ?? candidateSource, text: captured.text })
          const [full] = await evaluateSources(scopedAgent, context.job.requirements!, [{ sourceId, name, text: captured.text }], signal, fallback.logger, 'detail', candidateFilters)
          const fresh = await driver.resume(name)
          const recorded = await execute('sourcing_record_candidate', { ...fresh, scope: captured.scope, fields: full!.fields,
            assessments: full!.assessments, filterAssessments: full!.filterAssessments, analysis: judgementAnalysis(full!, context.job.requirements!) })
          if (recorded.needsGreeting) await execute('sourcing_greet_candidate', await driver.greeting(name, recorded.candidateKey))
          await returnToList()
        }
        const state = operations.state(), selected = state.selectedCandidate
        if (state.needsGreeting) {
          if (!selected) throw new SourcingHandoff('unfinished_candidate')
          await execute('sourcing_greet_candidate', await driver.greeting(selected.name, selected.candidateKey))
          await returnToList()
        } else if (state.pending) {
          if (!selected) throw new SourcingHandoff('unfinished_candidate')
          let locator: ResumeLocator | undefined
          if (driver.hasOpenResume?.() && !driver.hasOpenResume(selected.name)) await returnToList()
          if (context.broker.currentPage()?.dialogs?.length || driver.hasOpenResume?.(selected.name)) {
            try { locator = await driver.resume(selected.name) }
            catch (error) { if (!(error instanceof SourcingHandoff && error.reason === 'resume_closed')) throw error }
          }
          if (!locator) {
            const cards = await driver.cards()
            const matching: SourcingCard[] = []
            for (const card of cards.filter(card => card.name === selected.name)) {
              // Driver text is a raw card view; selection uses verified source
              // parts and its own key. Compare those same sources on recovery.
              const preview = await operations.preview(card, signal)
              const sameEvidence = selected.listEvidenceHash ? hash(preview.text) === selected.listEvidenceHash
                : !!selected.verifiedListText && preview.text === selected.verifiedListText
              if (!preview.duplicate && sameEvidence && (preview.candidateKey === undefined || preview.candidateKey === selected.candidateKey)) matching.push(card)
            }
            if (matching.length === 1) locator = await driver.open(matching[0]!)
            else {
              await execute('sourcing_skip_candidate', { reason: '已选候选人的列表依据已变化或无法唯一定位，未保存，继续寻找下一位候选人' })
              log('selected_card_unavailable', { matchingCount: matching.length, skipped: true })
              await returnToList()
            }
          }
          if (locator) await finishSelected(selected.name, selected.candidateKey, locator)
        } else if (driver.hasOpenResume?.()) {
          // An explicit skip discards the selected source, not its UI modal.
          // Return through the owning driver before looking for the next card.
          await returnToList()
        }
        if (!prepared || !operations.state().searchReady) {
          if (operations.state().pending || operations.state().needsGreeting) throw new SourcingHandoff('unfinished_candidate')
          await execute('sourcing_confirm_search', await driver.prepareSearch())
          prepared = true
          log('search_ready', { durationMs: Date.now() - started })
        }
        for (let step = 0; step < 150 && !operations.complete(); step++) {
          signal.throwIfAborted()
          const state = operations.state()
          if (state.pending || state.needsGreeting) throw new SourcingHandoff('unfinished_candidate')
          const cards: SourcingCard[] = []
          const visible = await driver.cards({ refresh: false })
          // Remaining quota limits accepted resumes, not screening throughput.
          // Even the final vacancy can require rejecting many visible cards.
          for (const card of visible.filter(c => !seen.has(c.sourceId)).slice(0, 3)) {
            const preview = await operations.preview(card, signal)
            if (preview.duplicate) seen.add(card.sourceId)
            else cards.push({ ...card, text: preview.text })
          }
          if (!cards.length) {
            // Duplicates may precede unseen cards on this same page; consume
            // those before advancing the browser or asking the model again.
            if (visible.some(c => !seen.has(c.sourceId))) continue
            await operations.progress?.('当前可见人选已处理，正在滚动查找下一批候选人')
            const next = await driver.advance()
            if (next.exhaustion) {
              await execute('sourcing_finish', { status: 'completed', reason: '平台已无更多结果', exhaustion: next.exhaustion })
              break
            }
            continue
          }
          await operations.progress?.(`正在对当前可见的 ${cards.length} 位候选人进行列表初筛：${cards.map(card => `候选人[${card.name}]`).join('、')}`)
          log('preview_batch', { count: cards.length, remaining: operations.remaining() })
          const assessments = await evaluateSources(scopedAgent, context.job.requirements!, cards, signal, fallback.logger, 'preview', candidateFilters)
          for (const capturedCard of cards) {
            if (operations.complete()) break
            let card: SourcingCard | undefined, ready = false, assessedText = capturedCard.text
            let judgement = assessments.find(row => row.sourceId === capturedCard.sourceId)!
            for (let refresh = 0; refresh < 3; refresh++) {
              // Rebind by stable identity after inference or returning from a
              // resume. A different visible window is left for the next batch.
              card = (await driver.cards()).find(c => c.sourceId === capturedCard.sourceId)
              if (!card) break
              const preview = await operations.preview(card, signal)
              if (preview.duplicate) { seen.add(card.sourceId); card = undefined; break }
              if (preview.text === assessedText) { ready = true; break }
              // Text changes require a new source-bound assessment, not a
              // browser navigation model. Renew refs again after that call.
              if (refresh === 2) break
              assessedText = preview.text
              judgement = (await evaluateSources(scopedAgent, context.job.requirements!, [{ ...card, text: assessedText }], signal, fallback.logger, 'preview', candidateFilters))[0]!
              log('preview_reassessed', { refresh: refresh + 1, reason: 'source_text_changed' })
            }
            if (!card) continue
            if (!ready) throw new SourcingHandoff('candidate_evidence_unstable')
            const page = context.broker.currentPage()
            const selected = await execute('sourcing_select_candidate', { tabId: page.tabId, snapshotId: page.snapshotId,
              name: card.name, ref: card.ref, evidenceRefs: card.evidenceRefs, ...(card.profileRef ? { profileRef: card.profileRef } : {}), listAssessments: judgement!.listAssessments })
            seen.add(card.sourceId)
            if (!selected.qualified) continue
            const locator = await driver.open(card)
            await finishSelected(card.name, card.sourceId, locator)
          }
        }
        if (!operations.complete()) throw new SourcingHandoff('step_budget')
        log('completed', { durationMs: Date.now() - started, modelMs, modelTurns: turns })
        return { completed: operations.complete(), hostState: operations.state() }
      } catch (error) {
        signal.throwIfAborted()
        // Unknown dispatch/storage outcomes NEVER fall through to AI replay.
        if (/OUTCOME_UNKNOWN|RESULT_UNKNOWN|TASK_STORAGE_UNAVAILABLE/.test(String(error))) throw error
        if (!recoverable(error)) throw error
        const state = operations.state()
        failedState = stateKey()
        lastHandoff = error instanceof SourcingHandoff ? error.reason : browserFailureCode(error)
        log('navigation_required', { reason: lastHandoff,
          durationMs: Date.now() - started, modelMs, modelTurns: turns, searchReady: state.searchReady,
          candidatePending: !!state.pending, needsGreeting: state.needsGreeting })
        throw error
      }
    },
  }
  try {
    let recoverySeeds: BrowserAgentSeed[] = []
    if (driver) {
      try {
        await collection.execute({}, signal)
        if (operations.complete()) return finish({ status: 'completed', message: '平台固定流程已完成', turns, modelMs,
          toolMs: Math.max(0, Date.now() - started - modelMs) })
      } catch (error) {
        signal.throwIfAborted()
        if (!recoverable(error)) throw error
        const value = await collection.recover!(error, {}, signal)
        recoverySeeds = [{ name: collection.name, args: {}, value: { error: { code: browserFailureCode(error),
          message: error instanceof Error ? error.message : String(error) }, recovery: value } }]
      }
    }
    const tools = operations.recoveryTools(scopedAgent)
    if (driver) tools.unshift(collection)
    const result = await agent({ ...fallback, tools, signal,
      system: fallback.system + '\n平台固定流程已在模型之前直接执行。你只处理当前异常或未识别页面；宿主会在你改变页面后自动尝试接回固定流程，不必逐个选择已知列表的人选、反复读取或调用sourcing_collect。保留当前人选与结果；不要重新启动任务。若recovery.obstruction存在，优先完成其中的遮挡恢复：识别弹窗、inspect核实关闭入口、关闭一次、读取新快照确认、返回returnFrameId。不要反复点击被遮挡目标，也不要在遮挡未消除时反复调用sourcing_collect。',
      goal: { ...fallback.goal, requirements: context.job.requirements, hostState: operations.state() },
      initialToolResults: recoverySeeds.length ? [...(fallback.initialToolResults ?? []).filter(seed => seed.name === 'browser_list_tabs'), ...recoverySeeds] : fallback.initialToolResults,
      beforeTurn: driver ? async toolSignal => {
        const seeds = await fallback.beforeTurn?.(toolSignal) ?? []
        if (obstructionFrame !== undefined) {
          if (context.broker.currentPage()?.frameId !== obstructionFrame) return seeds
          obstructionFrame = undefined
        }
        if (operations.complete() || failedState === stateKey()) return seeds
        try {
          const value = await collection.execute({}, toolSignal)
          return [...seeds, { name: collection.name, args: {}, value }]
        } catch (error) {
          toolSignal.throwIfAborted()
          if (!recoverable(error)) throw error
          const value = await collection.recover!(error, {}, toolSignal)
          return [...seeds, { name: collection.name, args: {}, value: { error: { code: browserFailureCode(error),
            message: error instanceof Error ? error.message : String(error) }, recovery: value } }]
        }
      } : fallback.beforeTurn,
      isComplete: operations.complete,
      maxTurns: driver ? Math.min(fallback.maxTurns ?? 8, 8) : fallback.maxTurns,
      maxDurationMs: Math.max(1, budget - (Date.now() - started)) })
    if (/OUTCOME_UNKNOWN|RESULT_UNKNOWN|TASK_STORAGE_UNAVAILABLE/.test(result.message)) throw new Error(result.message)
    return finish({ ...result, ...(result.status === 'budget' && lastHandoff ? { message: `${result.message}；最近固定流程问题：${lastHandoff}` } : {}),
      turns: turns + result.turns, modelMs: modelMs + result.modelMs, toolMs: Math.max(0, Date.now() - started - result.modelMs - modelMs) })
  } finally { clearTimeout(timer) }
}
