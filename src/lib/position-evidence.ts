import { itemText, normalized, readableIdentityRef, statesOf } from './page-actions.js'
import type { GreetingJob } from '../shared/workbench.js'

export interface PositionEvidence { ref: string; quote?: string; platformJobId?: string }
/**
 * exact：平台职位 ID 与 URL／选中元素／选中标签逐字对应。
 * degraded：拿不到 ID 证据，按「目标名称唯一 + 页面唯一选中项」通过。
 * 两级都必须逐字核对原文；展开但未选中的选项永远不能当作已选中职位。
 */
export type PositionEvidenceLevel = 'exact' | 'degraded'
export interface PositionVerification {
  ref: string
  quote: string
  platformJobId?: string
  level: PositionEvidenceLevel
  reason: string
}
export type PositionOutcome = { ok: true; verification: PositionVerification } | { ok: false; error: string }

const SELECTED_STATES = ['selected', 'checked', 'current']
/**
 * 「选项列表里的一员」：未选中时它代表一个可切换的目标，绝不是当前职位。
 * 平台职位下拉选项常常带平台职位 ID，若让它们参与核验，会出现「页面上有个该职位的
 * 选项 + URL 带该职位 ID」就等于「当前职位已核验」的假通过。
 */
const CHOICE_ROLES = ['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'radio', 'checkbox', 'treeitem', 'switch', 'tab']
const selectedItem = (item: any) => statesOf(item).some(state => SELECTED_STATES.includes(state))
const quoted = (value: unknown) => normalized(value).replace(/\s/g, '')

/**
 * 核验结果优先用返回值表达，让调用方能区分「严格证据」与「降级通过」并写入日志；
 * 读取身份本身的失败（元素不存在／不可读）继续抛出，保持原有可恢复错误语义。
 */
export function verifyPositionEvidence(page: any, job: Pick<GreetingJob, 'jobId' | 'jobName' | 'platformJobs'>, evidence?: PositionEvidence): PositionOutcome {
  if (!job.jobId) return { ok: true, verification: { ref: evidence?.ref ?? '', quote: '', level: 'exact', reason: '未选择薪人薪事职位，无需核验' } }
  if (!evidence?.ref || !job.jobName) return { ok: false, error: '缺少 position 或目标职位名称' }
  const item = readableIdentityRef(page, evidence.ref)
  const quote = normalized(evidence.quote ?? itemText(item)), text = itemText(item)
  if (!quote || !text.includes(quote)) return { ok: false, error: 'position.quote 未在所引元素的 name/context.text 中逐字出现' }
  const targets = job.platformJobs?.length ? job.platformJobs : []
  const matching = targets.length
    ? targets.filter(target => quote.includes(normalized(target.name)))
    : quote.includes(normalized(job.jobName)) ? [{ id: '', name: job.jobName }] : []
  if (!matching.length) return { ok: false, error: '所引职位原文不包含目标职位名称' }
  const selected = selectedItem(item)
  const selectedTabs = Array.isArray(page.selectedTabs) ? page.selectedTabs : []
  const sameTab = selectedTabs.filter((tab: any) => normalized(tab.name) === normalized(item.name))
  const idIn = (value: unknown, id: string) => {
    const value2 = String(value ?? ''), start = value2.indexOf(id)
    return start >= 0 && !/[A-Za-z0-9]/.test(value2[start - 1] ?? '') && !/[A-Za-z0-9]/.test(value2[start + id.length] ?? '')
  }
  let urlIds: string[] = []
  try { urlIds = [...new URL(page.url).searchParams.values()] } catch { /* no URL evidence */ }
  const observedId = (id: string) => urlIds.includes(id) || (selected && idIn(item.elementId, id)) || sameTab.some((tab: any) => idIn(tab.elementId, id))

  if (!targets.length) {
    const platformJobId = evidence.platformJobId && urlIds.includes(evidence.platformJobId) ? evidence.platformJobId : undefined
    if (platformJobId) return ok(evidence.ref, quote, platformJobId, 'exact', '平台职位 ID 与当前 URL 对应')
    if (selected || sameTab.length === 1) return ok(evidence.ref, quote, undefined, 'degraded', '未配置平台职位关联，按选中状态与原文通过')
    return { ok: false, error: '所引职位缺少选中状态或对应的 URL/标签证据' }
  }

  if (evidence.platformJobId) {
    const target = matching.find(candidate => candidate.id === evidence.platformJobId)
    if (!target) return { ok: false, error: 'position.platformJobId 不属于名称匹配的目标平台职位' }
    if (!observedId(target.id)) return { ok: false, error: '目标职位 ID 未与当前 URL 或选中标签 ID 对应，不能将展开选项当作已选中' }
    return ok(evidence.ref, quote, target.id, 'exact', 'position.platformJobId 与当前页面证据逐字对应')
  }

  const exact = matching.filter(target => observedId(target.id))
  if (exact.length === 1) return ok(evidence.ref, quote, exact[0]!.id, 'exact', '平台职位 ID 与 URL／选中元素 ID 逐字对应')
  if (exact.length > 1) return { ok: false, error: '多个目标平台职位的 ID 同时与当前页面证据对应，无法确定发送职位' }

  // 降级：目标名称在关联列表里唯一，页面上只有一个带该名称的选中条目，
  // 并且页面上根本没有出现过可对照的职位 ID —— 有 ID 却对不上就说明选错了。
  const names = [...new Set(matching.map(target => normalized(target.name)))]
  if (names.length !== 1) return { ok: false, error: '多个不同名称的目标平台职位都与所引原文匹配，无法确定发送职位' }
  const sameName = targets.filter(target => normalized(target.name) === names[0]).length
  if (sameName !== 1) return { ok: false, error: `平台存在 ${sameName} 个同名职位关联（${names[0]}），名称不足以确定发送职位` }
  const exposedIds = [item.elementId, ...sameTab.map((tab: any) => tab.elementId)].filter(Boolean)
  if (exposedIds.length) {
    return { ok: false, error: `所引职位的 ID（${String(exposedIds[0])}）与目标平台职位 ${matching[0]!.id || names[0]} 不对应，不能按名称降级通过` }
  }
  if (!selected && sameTab.length !== 1) {
    return { ok: false, error: '目标职位 ID 未与当前 URL 或选中标签 ID 对应，且所引元素没有选中状态' }
  }
  if (selected) {
    // 只统计可读的已选中条目；读取身份本身失败的元素不算竞争者。
    const claimants = (page.items ?? []).filter((candidate: any) => candidate?.ref
      && !statesOf(candidate).some(state => ['hidden', 'invisible', 'blocked_by_dialog'].includes(state))
      && selectedItem(candidate) && quoted(itemText(candidate)).includes(quoted(names[0])))
    const own = claimants.filter((candidate: any) => candidate.ref === evidence.ref)
    if (claimants.length !== 1 || own.length !== 1) {
      return { ok: false, error: `当前页面有 ${claimants.length} 个元素同时声称选中了目标职位，无法确定发送职位` }
    }
  }
  return ok(evidence.ref, quote, undefined, 'degraded', '平台职位 ID 不可得，按唯一同名与唯一选中状态通过')
}

function ok(ref: string, quote: string, platformJobId: string | undefined, level: PositionEvidenceLevel, reason: string): PositionOutcome {
  return { ok: true, verification: { ref, quote, ...(platformJobId ? { platformJobId } : {}), level, reason } }
}

/**
 * 发现当前页面上能核验通过的目标职位证据元素，严格证据排在降级证据之前。
 * 候选发现放宽到「原文提到目标职位名」：平台的已选职位常常是普通文本节点，
 * 没有 AX 选中状态；通过与否仍由 verifyPositionEvidence 决定，不是看到名字就算对。
 */
export function findPositionEvidence(page: any, job: GreetingJob): PositionVerification[] {
  const targets = job.platformJobs?.length ? job.platformJobs : job.jobName ? [{ id: '', name: job.jobName }] : []
  const names = targets.map(target => normalized(target.name)).filter(Boolean)
  if (!names.length) return []
  const items: any[] = Array.isArray(page?.items) ? page.items : []
  // 页面上提到目标职位名的元素数量：只有唯一一处提及时，普通文本节点才可能
  // 就是「当前职位」；多处提及（标题、推荐位、筹码）时不能按 URL 里的 ID 反推。
  const mentions = items.filter((item: any) => item?.ref && names.some(name => quoted(itemText(item)).includes(quoted(name)))).length
  const found: PositionVerification[] = []
  for (const item of items) {
    if (!item?.ref) continue
    if (statesOf(item).some(state => ['hidden', 'invisible', 'blocked_by_dialog'].includes(state))) continue
    const named = names.some(name => quoted(itemText(item)).includes(quoted(name)))
    const choice = CHOICE_ROLES.includes(String(item.role))
    // 未选中的选项/标签只是「可以切换过去的目标」，不参与当前职位核验。
    if (choice && !selectedItem(item)) continue
    if (!named && !selectedItem(item) && !['button', 'combobox'].includes(item.role)) continue
    const plain = !selectedItem(item) && !['button', 'combobox'].includes(item.role)
    if (plain && mentions !== 1) continue
    let outcome: PositionOutcome
    try { outcome = verifyPositionEvidence(page, job, { ref: item.ref }) } catch { continue }
    if (outcome.ok) found.push(outcome.verification)
  }
  return found.sort((first, second) => Number(second.level === 'exact') - Number(first.level === 'exact'))
}

/**
 * 抛出式包装：调用方无法处理降级信息时使用。降级通过不抛错，但调用方应通过
 * verifyPositionEvidence 取得 level 并写入日志，便于事后审计。
 */
export function assertPositionEvidence(page: any, job: GreetingJob, evidence?: PositionEvidence) {
  const outcome = verifyPositionEvidence(page, job, evidence)
  if (!outcome.ok) {
    throw new Error(`POSITION_EVIDENCE_INVALID: ${outcome.error}；未执行发送，请核对反馈中的选中职位及最新快照`)
  }
  return outcome.verification
}
