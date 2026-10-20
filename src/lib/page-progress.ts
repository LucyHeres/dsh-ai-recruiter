import { hash } from './store.js'
import { logKey, type DeveloperLog } from './developer-log.js'
import { executeNavigation, normalized, snapshotRef, pageObservation, safePageUrl, type NavigationAction, type PageNavigation } from './page-actions.js'
import { safeError } from './task-error.js'

interface PageState {
  key: string
  tabId: number
  frameId?: number
  snapshotId?: string
  url: string
  elementCount: number
  dialogCount: number
  selectedTabs: { name: string; elementId: string }[]
}
export interface PageActionRecord {
  action: string
  ref?: string
  reason?: string
  target?: { ref: string; role: string; name: string; elementId: string }
  before?: PageState
  after?: PageState
  pageChanged?: boolean
  attemptsInState?: number
  outcome: string
  receipt?: Record<string, unknown>
}
export function rememberPageAction(history: PageActionRecord[], record: PageActionRecord) {
  history.push(record)
  if (history.length > 12) history.shift()
}

// Snapshot/ref IDs identify an observation, not a change in page state. Exclude them
// so fresh references cannot hide repeated clicks or an A -> B -> A menu loop.
function pageState(view: Pick<PageNavigation, 'page' | 'tabId' | 'frameId' | 'tabs'>): PageState {
  const p = pageObservation(view.page)
  const semantic = {
    url: p.url, text: normalized(p.text),
    items: p.items.map(({ ref: _ref, parentRef: _parentRef, dialogRef: _dialogRef, ...item }: any) => item),
    selectedTabs: p.selectedTabs,
    dialogs: p.dialogs.map(({ ref: _ref, closeRef: _closeRef, ...dialog }: any) => dialog),
    tabs: view.tabs.map(tab => ({ tabId: tab.tabId, url: safePageUrl(tab.url) })).sort((a, b) => a.tabId - b.tabId),
    viewport: view.page.viewport,
  }
  return { key: hash([view.tabId, view.frameId ?? null, semantic]).slice(0, 24), tabId: view.tabId, frameId: view.frameId,
    snapshotId: p.snapshotId, url: p.url, elementCount: p.items.length, dialogCount: p.dialogs.length,
    selectedTabs: p.selectedTabs.map((tab: any) => ({ name: normalized(tab.name), elementId: String(tab.elementId ?? '') })) }
}
const targetOf = (action: NavigationAction, page: any): PageActionRecord['target'] => {
  if (!('ref' in action) || !action.ref) return undefined
  const item = snapshotRef(page, action.ref)
  return { ref: action.ref, role: String(item.role ?? ''), name: String(item.name ?? '').slice(0, 1200), elementId: String(item.elementId ?? '') }
}

/** Bounded navigation retries. This guard never retries a dispatched action or business write. */
export class PageProgress {
  private readonly attempts = new Map<string, number>()
  private pending?: PageActionRecord
  lastReceipt?: Record<string, unknown>
  constructor(private readonly history: PageActionRecord[], private readonly feature: 'greeting' | 'resume', private readonly logger?: DeveloperLog) {}

  /** Called with the next fresh snapshot, before asking the model for another action. */
  observe(view: Pick<PageNavigation, 'page' | 'tabId' | 'frameId' | 'tabs'>) {
    if (!this.pending) return
    const record = this.pending
    this.pending = undefined
    record.after = pageState(view)
    record.pageChanged = record.before!.key !== record.after.key
    record.outcome = record.pageChanged
      ? '浏览器动作已执行，页面可观察状态发生变化；请核对目标是否完成，不能把变化当成职位已选中。'
      : '浏览器动作已执行，但页面可观察状态未变化；不要原样重复。检查目标与展开状态，必要时改用 hover、等待加载或其他有依据的操作。'
    this.log('info', 'action_result', record)
  }

  /** Clear navigation history only after a candidate has been conclusively processed. */
  checkpoint() { this.attempts.clear(); this.pending = undefined }

  async execute(action: NavigationAction, view: PageNavigation) {
    const before = pageState(view), target = targetOf(action, view.page)
    const item = target ? snapshotRef(view.page, target.ref) : undefined
    const { reason: _reason, ...parameters } = action
    const { ref: _ref, ...withoutRef } = parameters as Record<string, unknown>
    const lastScroll = action.action === 'scroll' ? this.history.filter(row => row.action === 'scroll' && row.receipt?.after).at(-1)?.receipt : undefined
    const actionKey = hash([before.key, withoutRef, lastScroll ? { container: lastScroll.container, position: lastScroll.after } : null, target ? {
      role: target.role, name: target.name, elementId: target.elementId, href: safePageUrl(item?.href), bounds: item?.bounds,
    } : null])
    const attempts = this.attempts.get(actionKey) ?? 0
    const record: PageActionRecord = { action: action.action, ref: target?.ref, target, reason: safeError(action.reason), before,
      attemptsInState: attempts, outcome: '尚未执行' }
    if (action.action !== 'wait' && attempts >= 2) {
      record.outcome = 'PAGE_ACTION_REPEAT_BLOCKED：相同页面状态下的同一动作已执行两次，或交互反复回到原状态。此次未执行；请改用 hover 等其他有依据的操作，无法推进时 stop。'
      rememberPageAction(this.history, record)
      this.log('warn', 'action_repeat_blocked', record)
      throw new Error(record.outcome)
    }
    this.attempts.set(actionKey, attempts + 1)
    record.attemptsInState = attempts + 1
    rememberPageAction(this.history, record)
    this.log('info', 'navigation_started', record)
    try {
      const raw = await executeNavigation(action, view)
      const payload = raw?.output ?? raw
      const verification = payload?.verification ?? raw?.verification
      const receipt = Object.fromEntries(['dispatched', 'clicked', 'hovered', 'pressed', 'typed', 'inputDispatched', 'conditionMet', 'timeout', 'reason', 'changed', 'before', 'after', 'beforeControl', 'afterControl', 'evidence', 'requestedRef', 'requestedTarget', 'target', 'hitTarget', 'atBoundary', 'atTop', 'atEnd', 'scrollX', 'scrollY', 'container', 'fallbackApplied', 'values', 'point'].filter(key => payload?.[key] !== undefined).map(key => [key, payload[key]]))
      const evidence = verification && Object.fromEntries(['domMutated', 'urlChanged', 'documentChanged', 'dataChanged', 'conditionMet', 'reason', 'timeout', 'snapshotStale', 'waitedMs', 'focusConfirmed', 'valueConfirmed'].filter(key => verification[key] !== undefined).map(key => [key, verification[key]]))
      record.receipt = this.lastReceipt = { ...receipt, ...(evidence ? { verification: evidence } : {}) }
    } catch (error) {
      // Keep the original error and uncertainty classification. Do not auto-retry.
      record.outcome = safeError(error)
      throw error
    }
    record.outcome = '浏览器动作已执行，等待新快照核对结果'
    this.pending = record
  }

  private log(level: 'info' | 'warn', event: string, record: PageActionRecord) {
    this.logger?.write(level, `${this.feature}.${event}`, { action: record.action, ref: record.ref,
      reasonKey: logKey(record.reason), reasonLength: record.reason?.length,
      targetRole: record.target?.role, targetElementId: record.target?.elementId,
      targetLabelKey: record.target ? logKey(record.target.name) : undefined, targetLabelLength: record.target?.name.length,
      dispatched: record.receipt?.dispatched, changed: record.receipt?.changed,
      verification: record.receipt?.verification,
      attemptsInState: record.attemptsInState, beforeStateKey: record.before?.key, afterStateKey: record.after?.key,
      beforeSnapshotId: record.before?.snapshotId, afterSnapshotId: record.after?.snapshotId, pageChanged: record.pageChanged,
      beforeElementCount: record.before?.elementCount, afterElementCount: record.after?.elementCount,
      beforeDialogCount: record.before?.dialogCount, afterDialogCount: record.after?.dialogCount,
      beforeSelectedElementIds: record.before?.selectedTabs.map(tab => tab.elementId),
      afterSelectedElementIds: record.after?.selectedTabs.map(tab => tab.elementId),
    })
  }
}
