import { z } from 'zod'
import { hash } from './store.js'
import { actionRef, actionReason, itemText, normalized, statesOf, snapshotRef, type PageNavigation } from './page-actions.js'
import { readablePageEvidence } from './page-evidence.js'

/** Workflow-neutral tools. The model interprets the UI; the host owns the
 * operation record, write dispatch and outcome uncertainty. */
export const operationActionOptions = [
  z.object({ action: z.literal('submit'), ref: actionRef, reason: actionReason }).strict(),
  z.object({ action: z.literal('record_result'), outcome: z.enum(['completed', 'not_completed', 'unknown']),
    evidenceRefs: z.array(actionRef).min(1).max(6), reason: actionReason }).strict(),
] as const

const evidenceKey = (item: any) => hash([itemText(item), statesOf(item).slice().sort(), item.value, item.controlState])
const stateKey = (page: any) => hash([page.documentId ?? page.url,
  (page.items ?? []).map((item: any) => [item.role, evidenceKey(item), item.bounds])])
const resultSources = (page: any) => readablePageEvidence(page).map(evidence => {
  const item = (page.items ?? []).find((item: any) => item.ref === evidence.ref)
  const bounds = item?.bounds
  const keys = item ? [
    ...(item.elementId ? [hash(['id', item.elementId])] : []),
    ...(normalized(item.context?.text) ? [hash(['context', item.role, normalized(item.context.text)])] : []),
    ...(bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) && bounds.width > 0 && bounds.height > 0
      ? [hash(['position', item.role, bounds.x, bounds.y])] : []),
  ] : [hash(['observation', evidence.ref])]
  return { ...evidence, keys, signature: hash([evidence.text, evidence.states.slice().sort()]) }
})

export class PageOperation {
  private readonly before: ReturnType<typeof resultSources>
  private readonly document: unknown
  private readonly writes = new Set<string>()
  constructor(private readonly snapshotId: string, page: any) {
    this.before = resultSources(page)
    this.document = page.documentId ?? page.url
  }
  assertResult(page: any, outcome: 'completed' | 'not_completed' | 'unknown', refs: string[]) {
    if (!page.snapshotId || page.snapshotId === this.snapshotId) throw new Error('PAGE_OPERATION_RESULT_REQUIRED: SAME_SNAPSHOT 请读取操作后的新页面')
    const sources = resultSources(page)
    const evidence = refs.map(ref => {
      const item = sources.find(item => item.ref === ref)
      if (!item) {
        throw new Error(`PAGE_OPERATION_RESULT_REQUIRED: EVIDENCE_REF_MISSING 引用 ${ref} 不在当前可读证据中。可引用 items.ref、dialogs.evidenceRef 或 textEvidenceRef；请读取当前观察，不要重复旧引用。当前文本证据源：${JSON.stringify(sources.filter(item => item.ref.startsWith('evidence:')).map(({ ref }) => ref))}`)
      }
      return item
    })
    const changed = (item: typeof sources[number]) => {
      if (this.document === (page.documentId ?? page.url)) {
        for (const key of item.keys) {
          const previous = this.before.filter(source => source.keys.includes(key))
          if (previous.length === 1 && sources.filter(source => source.keys.includes(key)).length === 1) {
            return previous[0]!.signature !== item.signature
          }
        }
      }
      return !this.before.some(source => source.signature === item.signature)
    }
    if (outcome === 'completed' && !evidence.some(changed)) {
      throw new Error('PAGE_OPERATION_RESULT_REQUIRED: EVIDENCE_UNCHANGED 所引证据未变化，不能把派发动作当作目标完成')
    }
  }
  async submit(ref: string, view: PageNavigation, dispatch: () => Promise<any>, isNotDispatched: (error: unknown) => boolean) {
    const item = snapshotRef(view.page, ref)
    const key = hash([view.tabId, view.frameId, stateKey(view.page), item.role, evidenceKey(item), item.bounds])
    if (this.writes.has(key)) throw new Error('PAGE_ACTION_REPEAT_BLOCKED: 此状态下的提交已派发，必须核实结果，不能再次提交')
    this.writes.add(key)
    try { return await dispatch() }
    catch (error) {
      // Only a guaranteed pre-dispatch error may release the reservation.
      if (isNotDispatched(error)) this.writes.delete(key)
      throw error
    }
  }
}

/** Independent recoverable errors are observations, not three strikes. Bound
 * repeated identical failures separately from the overall recovery budget. */
export class PageRecovery {
  private failures = new Map<string, number>()
  private consecutive = 0
  reset() { this.failures.clear(); this.consecutive = 0 }
  failed(error: unknown, action: { action: string; ref?: string }, page: any) {
    const code = /\b[A-Z][A-Z0-9_]{3,}\b/.exec(String(error))?.[0] ?? 'PAGE_ERROR'
    const target = (page.items ?? []).find((item: any) => item.ref === action.ref)
    const key = hash([code, action.action, target?.role, itemText(target), target?.bounds])
    const count = (this.failures.get(key) ?? 0) + 1
    this.failures.set(key, count)
    return { exhausted: ++this.consecutive >= 8 || count >= 3, repeated: count, consecutive: this.consecutive }
  }
}
