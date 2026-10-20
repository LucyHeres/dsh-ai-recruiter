import type { BrowserAgentOptions, BrowserAgentResult, BrowserAgentSeed } from '../browser-agent.js'
import type { BrowserAgentRunner } from '../host-browser-agent.js'
import type { RecruitmentPlatform } from '../platforms/types.js'
import type { SourcingCard, SourcingDriverContext, SourcingOperations } from './types.js'
import { evaluateSources, judgementAnalysis } from './evaluator.js'
import { hash } from '../store.js'
import { recoverablePageError } from '../page-actions.js'
import { SourcingHandoff } from './browser.js'
import { browserFailureCode } from '../browser-errors.js'
import { sourcingMode } from './source.js'

/** A bounded code-driven workflow. The platform driver knows page semantics;
 * the existing session hooks own policy/state; the evaluator has no browser.
 * A handoff keeps the very same pending candidate and dispatch ledger. */
export async function runSourcingWorkflow(platform: RecruitmentPlatform, context: SourcingDriverContext,
  operations: SourcingOperations, agent: BrowserAgentRunner, fallback: BrowserAgentOptions, allowResume = true): Promise<BrowserAgentResult> {
  const started = Date.now(), budget = fallback.maxDurationMs ?? 20 * 60 * 1000
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new Error('SOURCING_DURATION_BUDGET')), budget)
  const signal = AbortSignal.any([context.signal, deadline.signal])
  const seeds: BrowserAgentSeed[] = []
  const candidateFilters = sourcingMode(context.job) === 'recommend' ? context.job.searchFilters : undefined
  let modelMs = 0, turns = 0, driverRecognized = false
  const scopedAgent: BrowserAgentRunner = async options => {
    const result = await agent({ ...options, signal, maxDurationMs: Math.min(options.maxDurationMs ?? budget, Math.max(1, budget - (Date.now() - started))) })
    modelMs += result.modelMs; turns += result.turns
    return result
  }
  const log = (event: string, fields: Record<string, unknown>) => {
    try { fallback.logger?.write('info', `sourcing.fast_${event}`, fields) } catch {}
  }
  const execute = async (name: string, args: Record<string, unknown>) => {
    signal.throwIfAborted()
    const tool = operations.tools.find(t => t.name === name)
    if (!tool) throw new Error('SOURCING_OPERATION_MISSING')
    const value = await tool.execute(args, signal)
    // Only the latest host state is needed for recovery. Do not re-inject old
    // snapshots, resume text or every successful navigation into AI history.
    seeds.splice(0, seeds.length, { name, args: {}, value })
    return value as any
  }
  try {
    if (platform.createSourcingDriver) {
      const driver = platform.createSourcingDriver({ ...context, signal })
      try {
        if (!await driver.recognizes()) throw new SourcingHandoff('page_not_recognized')
        driverRecognized = true
        if (!context.job.requirements) {
          let defined = false
          const define = operations.tools.find(t => t.name === 'sourcing_define_requirements')!
          await scopedAgent({ system: '从职位原文提炼1至8个技能/职责/项目经历匹配维度，权重合计100；quote逐字引用职位要求，关键词出自职位名或要求。不得使用年龄、性别、婚育等维度。只调用 sourcing_define_requirements 一次。',
            goal: { position: context.job.position, supplement: context.job.supplement }, signal, tools: [{ ...define, execute: async (args, s) => {
              const result = await define.execute(args, s); defined = true; return result
            } }], maxTurns: 2, isComplete: () => defined, logger: fallback.logger })
          if (!defined) throw new SourcingHandoff('requirements_incomplete')
        }
        await execute('sourcing_confirm_search', await driver.prepareSearch())
        log('search_ready', { durationMs: Date.now() - started })
        const seen = new Set<string>()
        for (let step = 0; step < 150 && !operations.complete(); step++) {
          signal.throwIfAborted()
          const state = operations.state()
          if (state.pending || state.needsGreeting) throw new SourcingHandoff('unfinished_candidate')
          const cards: SourcingCard[] = []
          for (const card of (await driver.cards()).filter(c => !seen.has(c.sourceId)).slice(0, Math.min(3, operations.remaining()))) {
            const preview = await operations.preview(card, signal)
            if (preview.duplicate) seen.add(card.sourceId)
            else cards.push({ ...card, text: preview.text })
          }
          if (!cards.length) {
            // Duplicates may precede unseen cards on this same page; consume
            // those before advancing the browser or asking the model again.
            if ((await driver.cards()).some(c => !seen.has(c.sourceId))) continue
            const next = await driver.advance()
            if (next.exhaustion) {
              await execute('sourcing_finish', { status: 'completed', reason: '平台已无更多结果', exhaustion: next.exhaustion })
              break
            }
            continue
          }
          const assessments = await evaluateSources(scopedAgent, context.job.requirements!, cards, signal, fallback.logger, 'preview', candidateFilters)
          for (const capturedCard of cards) {
            if (operations.complete()) break
            // Model latency or a previous detail invalidates old refs. Re-read
            // and resolve the exact source, never a name-only masked match.
            const card = (await driver.cards()).find(c => c.sourceId === capturedCard.sourceId)
            if (!card) throw new SourcingHandoff('assessed_card_changed')
            const freshPreview = await operations.preview(card, signal)
            if (freshPreview.text !== capturedCard.text) throw new SourcingHandoff('assessed_evidence_changed')
            const judgement = assessments.find(a => a.sourceId === card.sourceId)!
            const page = context.broker.currentPage()
            const selected = await execute('sourcing_select_candidate', { tabId: page.tabId, snapshotId: page.snapshotId,
              name: card.name, ref: card.ref, evidenceRefs: card.evidenceRefs, ...(card.profileRef ? { profileRef: card.profileRef } : {}), assessments: judgement.assessments, filterAssessments: judgement.filterAssessments })
            seen.add(card.sourceId)
            if (!selected.qualified) continue
            const locator = await driver.open(card)
            await execute('sourcing_read_resume', locator)
            const captured = operations.captured()
            if (!captured?.text) throw new SourcingHandoff('resume_not_captured')
            const sourceId = hash({ candidate: card.sourceId, text: captured.text })
            const [full] = await evaluateSources(scopedAgent, context.job.requirements!, [{ sourceId, name: card.name, text: captured.text }], signal, fallback.logger, 'detail', candidateFilters)
            // Renew refs after the model call, while score evidence remains the
            // already captured immutable text. Existing record hook rechecks it.
            const fresh = await driver.resume(card.name)
            const recorded = await execute('sourcing_record_candidate', { ...fresh, scope: captured.scope, fields: full!.fields,
              assessments: full!.assessments, filterAssessments: full!.filterAssessments, analysis: judgementAnalysis(full!, context.job.requirements!) })
            if (recorded.needsGreeting) await execute('sourcing_greet_candidate', await driver.greeting(card.name, recorded.candidateKey))
            if (!operations.complete()) {
              const returned = await driver.returnToList()
              if (returned) await execute('sourcing_confirm_search', returned)
            }
          }
        }
        if (!operations.complete()) throw new SourcingHandoff('step_budget')
        log('completed', { durationMs: Date.now() - started, modelMs, modelTurns: turns })
        return { status: 'completed', message: '寻聘目标已完成', turns, modelMs, toolMs: Date.now() - started - modelMs }
      } catch (error) {
        signal.throwIfAborted()
        // Unknown dispatch/storage outcomes NEVER fall through to AI replay.
        if (/OUTCOME_UNKNOWN|RESULT_UNKNOWN|TASK_STORAGE_UNAVAILABLE/.test(String(error))) throw error
        const recoverable = error instanceof SourcingHandoff || recoverablePageError(error)
          || /^(?:SOURCING_|SEARCH_CONDITIONS_UNVERIFIED|SEMANTIC_DETAILS_UNAVAILABLE)/.test(error instanceof Error ? error.message : '')
        if (!recoverable) throw error
        const state = operations.state()
        log('handoff', { reason: error instanceof SourcingHandoff ? error.reason : browserFailureCode(error),
          durationMs: Date.now() - started, modelMs, modelTurns: turns, searchReady: state.searchReady,
          candidatePending: !!state.pending, needsGreeting: state.needsGreeting })
      }
    }
    const page = context.broker.currentPage()
    let observations = fallback.initialToolResults ?? []
    if (page?.tabId) {
      const tool = context.broker.tools.find(t => t.name === 'browser_snapshot')!
      const args = { tabId: page.tabId }
      observations = [{ name: tool.name, args, value: await tool.execute(args, signal) }]
    }
    const preparingRecovery = allowResume && driverRecognized && !operations.state().searchReady
    const canResume = () => preparingRecovery && operations.state().searchReady && !operations.state().pending && !operations.state().needsGreeting
    const result = await agent({ ...fallback, tools: operations.recoveryTools(scopedAgent), signal, initialToolResults: [...observations, ...seeds],
      goal: { ...fallback.goal, requirements: context.job.requirements, hostState: operations.state(), capturedResume: operations.captured() },
      isComplete: () => operations.complete() || canResume(),
      maxDurationMs: Math.max(1, budget - (Date.now() - started)) })
    if (/OUTCOME_UNKNOWN|RESULT_UNKNOWN|TASK_STORAGE_UNAVAILABLE/.test(result.message)) throw new Error(result.message)
    if (!operations.complete() && canResume() && result.status === 'completed') {
      const resumed = await runSourcingWorkflow(platform, { ...context, signal }, operations, agent,
        { ...fallback, maxDurationMs: Math.max(1, budget - (Date.now() - started)) }, false)
      return { ...resumed, turns: turns + result.turns + resumed.turns, modelMs: modelMs + result.modelMs + resumed.modelMs,
        toolMs: Math.max(0, Date.now() - started - modelMs - result.modelMs - resumed.modelMs) }
    }
    return { ...result, turns: turns + result.turns, modelMs: modelMs + result.modelMs, toolMs: Math.max(0, Date.now() - started - result.modelMs - modelMs) }
  } finally { clearTimeout(timer) }
}
