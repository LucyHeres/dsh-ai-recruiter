import { itemText, normalized, readableIdentityRef, statesOf } from './page-actions.js'
import { distinctPositionControls, positionBusinessIds, positionControl, positionNameMatches, samePositionComponent } from './position-controls.js'
import type { GreetingJob } from '../shared/workbench.js'

export interface PositionEvidence { ref: string; quote?: string; platformJobId?: string }
/** exact adds observed business-ID corroboration; degraded verifies a unique
 * name and selected control. Dynamic DOM IDs never establish business identity. */
export type PositionEvidenceLevel = 'exact' | 'degraded'
export interface PositionVerification {
  ref: string
  quote: string
  platformJobId?: string
  level: PositionEvidenceLevel
  reason: string
}
export type PositionOutcome = { ok: true; verification: PositionVerification } | { ok: false; error: string }

const selectedItem = (item: any) => statesOf(item).some(state => ['selected', 'checked', 'current'].includes(state))
const choiceRoles = ['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'radio', 'checkbox', 'treeitem', 'switch', 'tab']

function selectedControl(page: any, item: any): boolean {
  if (statesOf(item).includes('expanded') && ['button', 'combobox'].includes(item.role)) return false
  if (selectedItem(item)) return true
  if (statesOf(item).includes('expanded') || choiceRoles.includes(item.role) && item.role !== 'tab') return false
  const tabs = (page.selectedTabs ?? []).filter((tab: any) => !statesOf(tab).some(state => ['hidden', 'invisible', 'blocked_by_dialog'].includes(state)) && normalized(tab.name) === normalized(item.name))
  if (tabs.length !== 1) return false
  const tab = tabs[0]
  // DOM identity may associate two observations of one widget, never a job ID.
  if (tab.ref) return tab.ref === item.ref
  if (tab.elementId && item.elementId) return tab.elementId === item.elementId
  return (page.items ?? []).filter((row: any) => positionControl(page, row) && normalized(row.name) === normalized(item.name)).length === 1
}

export function verifyPositionEvidence(page: any, job: Pick<GreetingJob, 'jobId' | 'jobName' | 'platformJobs'>, evidence?: PositionEvidence): PositionOutcome {
  if (!job.jobId) return ok(evidence?.ref ?? '', '', undefined, 'exact', '未选择薪人薪事职位，无需核验')
  const fail = (error: string): PositionOutcome => ({ ok: false, error })
  if (!evidence?.ref || !job.jobName) return fail('缺少 position 或目标职位名称')
  const item = readableIdentityRef(page, evidence.ref)
  const quote = normalized(evidence.quote ?? itemText(item)), text = itemText(item)
  if (!quote || !text.includes(quote)) return fail('position.quote 未在所引元素的 name/context.text 中逐字出现')
  if (!positionControl(page, item)) return fail('所引元素不属于可读招聘职位控件')
  const targets = job.platformJobs?.length ? job.platformJobs : [{ id: '', name: job.jobName }]
  const matching = targets.filter(target => positionNameMatches(page, item, target.name))
  if (!matching.length) return fail('所引职位名称与目标职位不一致')
  if (evidence.platformJobId && job.platformJobs?.length && !matching.some(target => target.id === evidence.platformJobId)) {
    return fail('position.platformJobId 不属于名称匹配的目标平台职位')
  }
  if (!selectedControl(page, item)) return fail('所引职位没有选中状态；URL 或展开选项不能代替当前职位')

  const namedControls = (page.items ?? []).filter((candidate: any) => positionControl(page, candidate)
    && matching.some(target => positionNameMatches(page, candidate, target.name)))
  const claimants = distinctPositionControls(page, namedControls.filter((candidate: any) => selectedControl(page, candidate)))
  if (claimants.length !== 1 || !samePositionComponent(page, claimants[0], item)) return fail(`当前页面有 ${claimants.length} 个控件同时声称选中了目标职位，无法确定发送职位`)
  const ids = [...new Set([...positionBusinessIds(page), ...positionBusinessIds(page, item)])]
  if (job.platformJobs?.length && ids.some(id => !matching.some(target => target.id === id))) return fail('页面暴露的招聘职位 ID 与目标关联冲突')
  if (evidence.platformJobId && ids.length && !ids.includes(evidence.platformJobId)) return fail('position.platformJobId 与当前页面招聘职位 ID 冲突')
  const exact = matching.filter(target => target.id && ids.includes(target.id))
  if (exact.length > 1) return fail('多个目标平台职位 ID 同时与当前页面对应，无法确定发送职位')
  if (exact.length === 1) return ok(evidence.ref, quote, exact[0]!.id, 'exact', '当前选中职位名称及页面招聘职位 ID 一致')
  if (matching.length !== 1) return fail('平台存在多个同名职位关联，名称不足以确定发送职位')
  const options = distinctPositionControls(page, namedControls.filter((candidate: any) => choiceRoles.includes(candidate.role) || selectedControl(page, candidate)))
  if (options.length !== 1) return fail('页面存在多个同名招聘职位控件，名称不足以确定发送职位')
  return ok(evidence.ref, quote, undefined, 'degraded', '招聘职位控件的名称唯一且已选中；页面未暴露可核对的业务 ID')
}

function ok(ref: string, quote: string, platformJobId: string | undefined, level: PositionEvidenceLevel, reason: string): PositionOutcome {
  return { ok: true, verification: { ref, quote, ...(platformJobId ? { platformJobId } : {}), level, reason } }
}

export function findPositionEvidence(page: any, job: GreetingJob): PositionVerification[] {
  const found: PositionVerification[] = []
  for (const item of page.items ?? []) {
    if (!positionControl(page, item)) continue
    try {
      const result = verifyPositionEvidence(page, job, { ref: item.ref })
      if (result.ok) found.push(result.verification)
    } catch { /* A stale or unreadable element cannot establish position. */ }
  }
  return found.sort((first, second) => Number(second.level === 'exact') - Number(first.level === 'exact'))
}

export function assertPositionEvidence(page: any, job: GreetingJob, evidence?: PositionEvidence) {
  const outcome = verifyPositionEvidence(page, job, evidence)
  if (!outcome.ok) throw new Error(`POSITION_EVIDENCE_INVALID: ${outcome.error}；未执行发送，请核对反馈中的选中职位及最新快照`)
  return outcome.verification
}
