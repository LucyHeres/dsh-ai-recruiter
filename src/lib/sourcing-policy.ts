import { z } from 'zod'
import { hash } from './store.js'
import { identityObservation, itemText, normalized, readableIdentityRef, statesOf } from './page-actions.js'
import type { AgentBrowserCall } from './agent-browser-tools.js'
import type { SourcingAssessment, SourcingCandidate, SourcingCriterion, SourcingPosition, SourcingRequirements } from '../shared/sourcing.js'
import { PLATFORM_KEYS } from '../shared/workbench.js'
import { DEFAULT_MINIMUM_SCORE, SOURCING_MAX_BONUS, SOURCING_MAX_CRITERIA, SOURCING_RUBRIC_VERSION, sourcingCriterionScore, sourcingRubricScore } from '../shared/sourcing-score.js'
import { supplementParts } from './sourcing/matching-skill.js'
import { isSourcingFilterControl } from './sourcing-search.js'
import { resumeDetailContent } from './resume-detail-identity.js'
import { fixedSourcingFields } from './sourcing/requirement-policy.js'
import { SOURCING_MAX_LIMIT } from '../shared/sourcing-settings.js'

export const sourcingStartSpec = z.object({ id: z.string().uuid(), jobId: z.string().min(1).max(64),
  jobDescription: z.string().max(20000).optional().describe('本轮编辑后的职位描述；省略则读取当前职位描述，硬性条件仍采用职位固定字段'),
  sourceMode: z.enum(['recommend', 'search']).default('recommend').describe('默认从人才推荐寻聘；只有用户明确要求主动搜索时才传 search，不能因推荐不足自动切换'),
  platforms: z.array(z.enum(PLATFORM_KEYS)).min(1).max(PLATFORM_KEYS.length).refine(rows => new Set(rows).size === rows.length).describe('仅从所选职位的 jobs[].platforms 中选择已对接同步的平台，不默认同时选择两个平台'),
  minimumScore: z.number().int().min(0).max(100).default(DEFAULT_MINIMUM_SCORE), autoGreet: z.boolean().default(true), supplement: z.string().trim().max(4000).default(''), limit: z.number().int().min(1).max(SOURCING_MAX_LIMIT).describe('每个平台独立目标打招呼人数，范围1至100，例如选择两个平台、limit=5表示每平台5人，共10人'), confirmed: z.literal(true),
}).strict()
export const sourcingSource = (position: SourcingPosition, supplement: string) => {
  const fixed = fixedSourcingFields(position)
  return [position.name, position.city, position.description, ...Object.entries(fixed).filter(([, value]) => value)
    .map(([field, value]) => `${({ city: '工作地点', experience: '工作经验', education: '学历要求' } as Record<string, string>)[field]}：${value}`), supplement].filter(Boolean).join('\n')
}
export const sourcingVersion = (position: SourcingPosition, supplement: string) => hash({ listScreeningVersion: 1, fixedFieldPriorityVersion: 1, rubricVersion: SOURCING_RUBRIC_VERSION, id: position.id, name: position.name, city: position.city, description: position.description, basicRequirements: position.basicRequirements, searchFields: position.searchFields, supplement })
export function validateCriteria(criteria: SourcingCriterion[], source: string) {
  const tiered = criteria.some(row => row.tier !== undefined)
  if (criteria.length < 1 || criteria.length > (tiered ? SOURCING_MAX_CRITERIA : 8) || new Set(criteria.map(row => row.id)).size !== criteria.length) throw new Error('匹配维度须唯一且数量在允许范围内')
  if (tiered) {
    if (criteria.some(row => !row.tier || !['must', 'core', 'bonus', 'verify'].includes(row.tier) || !Number.isInteger(row.weight) || row.weight < 0 || row.weight > 100
      || row.must !== (row.tier === 'must') || ['must', 'verify'].includes(row.tier) && row.weight !== 0
      || ['core', 'bonus'].includes(row.tier) && row.weight === 0)) throw new Error('SOURCING_RUBRIC_INVALID: 每项须分层，硬条件和面试核实权重为0，核心能力和加分项权重大于0')
    if (criteria.filter(row => row.tier === 'core').reduce((sum, row) => sum + row.weight, 0) !== 100
      || criteria.filter(row => row.tier === 'bonus').reduce((sum, row) => sum + row.weight, 0) > SOURCING_MAX_BONUS) throw new Error('SOURCING_RUBRIC_INVALID: 核心权重合计100，加分总权重不超过10')
  } else if (criteria.reduce((sum, row) => sum + row.weight, 0) !== 100) throw new Error('匹配维度须唯一且权重合计 100')
  for (const row of criteria) {
    if (!normalized(row.label) || normalized(row.quote).length < 2 || !normalized(source).includes(normalized(row.quote))) throw new Error('匹配标准缺少职位要求原文依据')
    if (/性别|年龄|婚育|婚姻|民族|宗教|照片|颜值|星座/.test(row.label + row.quote)) throw new Error('匹配维度应使用岗位职责、技能和项目经历')
    if (tiered && row.tier !== 'bonus' && /优先|加分|最好|倾向|nice.to.have|preferred/i.test(row.quote)) throw new Error('SOURCING_RUBRIC_INVALID: 明确优先或加分的要求必须保留为bonus，不占基础分或变成硬条件')
  }
}
/** Every host-split supplement segment must have an explicit, source-linked disposition. */
export function validateSupplementCoverage(requirements: SourcingRequirements, supplement: string) {
  const parts = supplementParts(supplement), rows = requirements.supplementCoverage ?? []
  if (parts.length !== rows.length || new Set(rows.map(row => row.quote)).size !== new Set(parts).size
    || parts.some(part => !rows.some(row => row.quote === part)) || rows.some(row => !parts.includes(row.quote))) {
    throw new Error('SOURCING_SUPPLEMENT_UNCOVERED: 必须逐段覆盖supplementParts中的全部补充要求')
  }
  for (const row of rows) {
    const linked = [...row.criterionIds.map(id => requirements.criteria.find(item => item.id === id)),
      ...row.listFields.map(field => requirements.listCriteria?.find(item => item.field === field))]
    if (linked.some(item => !item || !normalized(row.quote).includes(normalized(item.quote)))
      || !linked.length && !normalized(row.reason)) throw new Error('SOURCING_SUPPLEMENT_UNCOVERED: 补充要求须引用对应标准及其原文，无法评估时说明原因')
  }
}
export function assessCandidate(criteria: SourcingCriterion[], assessments: SourcingAssessment[], resumeText: string): Pick<SourcingCandidate, 'score' | 'coverage' | 'verdict' | 'scoring'> {
  if (assessments.length !== criteria.length || new Set(assessments.map(row => row.criterionId)).size !== criteria.length) throw new Error('必须逐项评估全部匹配维度')
  let score = 0, coverage = 0, unknownMust = false, conflict = false
  for (const criterion of criteria) {
    const row = assessments.find(item => item.criterionId === criterion.id)
    if (!row) throw new Error('存在未知或遗漏的匹配维度')
    if (!['match', 'partial', 'mismatch', 'unknown'].includes(row.state)) throw new Error('存在无效的匹配判断')
    if (row.state !== 'unknown') {
      if (!normalized(row.quote) || ![row.quote, ...(row.evidenceQuotes ?? [])].every(quote => normalized(quote) && normalized(resumeText).includes(normalized(quote)))) throw new Error(`SOURCING_ASSESSMENT_EVIDENCE_MISSING: ${criterion.id} 的分析证据引用不在当前候选人的已读简历中，请从宿主已采集原文引用，未提及应填 unknown`)
      coverage += criterion.weight
      score += sourcingCriterionScore(criterion.weight, row.state)
    }
    if (criterion.must && row.state === 'unknown') unknownMust = true
    if (criterion.must && row.state === 'mismatch') conflict = true
  }
  if (criteria.some(row => row.tier)) return sourcingRubricScore(criteria, assessments)
  return { score: Math.round(score), coverage, verdict: conflict ? 'unqualified' as const : unknownMust || score < 70 ? 'review' as const : 'recommended' as const }
}

const blockedControl = /沟通|打招呼|开聊|发送|联系|索要|交换|购买|付费|支付|解锁|下载|导出|收藏|不合适|邀约|邀请|删除|保存|提交简历|举报|投递|申请|屏蔽|短信|拨打|\b(?:send|greet|chat|purchase|pay|unlock|download|export|favorite|delete|submit|apply|report)\b/i
const searchField = /搜索|搜人才|关键词|关键字|职位|城市|地区|地点|经验|学历|薪资|行业|职能|search|keyword/i
/** Inspection can establish the meaning of an otherwise unnamed close icon.
 * A bare cross/class without foreground ownership is not sufficient. */
export function inspectedSourcingClose(page: any, ref: string, inspection: any) {
  const item = page?.items?.find((row: any) => row.ref === ref), element = inspection?.element
  if (!item || !element || element.visible === false || element.ref && element.ref !== ref) return false
  if (blockedControl.test(normalized(item.name))) return false
  if (statesOf(item).some(state => ['hidden', 'invisible', 'blocked_by_dialog', 'disabled'].includes(state))) return false
  const closeLabel = /^(?:关闭(?:此|当前)?(?:弹窗|窗口|对话框|提示|浮层|广告)?|close(?: (?:dialog|modal|popup|window))?|×)$/i
  const attributes = element.attributes ?? {}
  if ([attributes['aria-label'], attributes.title].some(label => closeLabel.test(normalized(label)))) return true
  const isClose = String(attributes.class ?? '').split(/\s+/).some(token => /^(?:(?:[\w-]+[-_])?close(?:[-_](?:btn|button|icon))?)$/i.test(token))
  const foreground = page.dialogs?.some((dialog: any) => dialog.closeRef === ref || dialog.ref === item.dialogRef)
    || inspection.ancestors?.some((node: any) => ['dialog', 'alertdialog'].includes(node.role ?? node.attributes?.role)
      || /(?:^|[\s_-])(?:modal|dialog|popup|popover|drawer)(?:$|[\s_-])/i.test(String(node.attributes?.class ?? '')))
  return !!(isClose && foreground)
}
/** The model chooses navigation from observed semantics. Code rejects business
 * writes and unsafe input; website-specific positive button lists do not gate clicks. */
export function assertSourcingNavigation(call: AgentBrowserCall, page: any, selectedName?: string, focusedSearch = false, positionControl = false, platformReadOnlyControl = false) {
  if (call.readOnly) return
  if (call.purpose === 'business_write') throw new Error('SOURCING_READ_ONLY: 寻聘不能沟通、购买或修改业务数据')
  if (['browser_scroll', 'browser_wait', 'browser_open_tab', 'browser_navigate', 'browser_history'].includes(call.name)) return
  if (call.name === 'browser_press_key' && /^(Escape|ESC|Tab|ArrowDown|ArrowUp|ArrowLeft|ArrowRight)$/.test(String(call.args.key))) return
  if (call.name === 'browser_press_key' && /^(Enter|Return)$/.test(String(call.args.key)) && !call.args.ref) {
    if (focusedSearch) return
    throw new Error('SOURCING_SEARCH_FOCUS_REQUIRED: 回车没有 ref，必须先成功输入搜索关键词且期间没有其他输入动作')
  }
  // Snapshot occluded flags are advisory. The browser performs the actual hit-test.
  // Hidden and background-modal controls remain forbidden.
  const item = readableIdentityRef(page, String(call.args.ref || ''))
  const label = normalized(item.name), text = normalized([item.name, item.description, item.placeholder,
    typeof item.context?.text === 'string' && item.context.text.length <= 300 ? item.context.text : ''].filter(Boolean).join(' '))
  if (platformReadOnlyControl && ['browser_click', 'browser_hover'].includes(call.name)) return
  if (blockedControl.test(label)) throw new Error('SOURCING_READ_ONLY: 该控件不属于只读寻聘')
  const closing = /^(关闭|返回|取消|×|close|cancel|back)$/i.test(label)
  const dialog = page?.dialogs?.find((row: any) => row.ref === item.dialogRef)
  if (!closing && /^(确定|确认|继续|是|ok|confirm|yes|continue)$/i.test(label)
    && blockedControl.test(normalized(dialog?.text ?? item.context?.text))) {
    throw new Error('SOURCING_READ_ONLY: 当前确认属于业务提交，不能用普通导航派发')
  }
  if (positionControl && ['browser_click', 'browser_hover'].includes(call.name)) return
  if (['browser_type', 'browser_select_option', 'browser_press_key'].includes(call.name)) {
    if (!searchField.test(text) || !['textbox', 'searchbox', 'combobox', 'spinbutton', 'option'].includes(item.role)) throw new Error('SOURCING_SEARCH_INPUT_REQUIRED: 只能在已观察的搜索筛选控件输入')
    if (call.name === 'browser_press_key' && !/^(Enter|Return)$/.test(String(call.args.key))) throw new Error('SOURCING_READ_ONLY: 不支持该按键')
    return
  }
  if (['browser_click', 'browser_hover'].includes(call.name)) {
    if (label || item.href || item.description) return
  }
  throw new Error('SOURCING_NAVIGATION_UNVERIFIED: 目标缺少可读语义，请先inspect确认目标，再使用真实引用操作')
}

/** Prefer the outer foreground dialog over nested experience articles. */
function resumeScope(page: any, item: any) {
  const seen = new Set<string>()
  let article: any
  for (let node = item; node && !seen.has(node.ref); node = page.items?.find((row: any) => row.ref === (node.dialogRef && node.dialogRef !== node.ref ? node.dialogRef : node.parentRef))) {
    seen.add(node.ref)
    if (['article', 'dialog', 'alertdialog'].includes(node.role)) {
      readableIdentityRef(page, node.ref)
      if (node.role !== 'article') return node
      article ??= node
    }
  }
  return article
}

/** The full foreground text is one versioned source, not a new resume fragment
 * on every read. Resolve it through the same ownership chain as the fragments. */
export function sourcingResumeDialog(page: any, identityRef: string): { ref: string; text: string } | undefined {
  const scope = resumeScope(page, readableIdentityRef(page, identityRef))
  return page.dialogs?.find((dialog: any) => dialog.ref === scope?.ref && typeof dialog.text === 'string')
}

/** A fresh list snapshot/document is still a list. Same-page resumes need a
 * foreground dialog; standalone resumes need a different observed URL and article. */
export function assertSourcingResumeDetail(page: any, identityRef: string, selection: { tabId: number; url: string; documentId?: string }) {
  const scope = resumeScope(page, readableIdentityRef(page, identityRef))
  if (scope && scope.role !== 'article') return
  if (scope && page.url !== selection.url) return
  throw new Error('SOURCING_RESUME_DETAIL_REQUIRED: 当前仍是列表或无法核验详情容器；请打开已选候选人的在线简历，引用前景简历容器，不能保存列表摘要')
}

/** Keep source order, and discard snippets already contained in a larger source.
 * Node names and their parent context are alternative views, not separate text. */
export function mergeSourcingResumeParts(parts: string[]): string[] {
  const result: string[] = []
  for (const text of parts.filter(Boolean)) {
    const key = resumeDetailContent(text)
    if (!key) continue
    // Exact resume content with a changed activity hint is a refreshed source,
    // not another section. Keep the latest original text for audit/assessment.
    const equivalent = result.findIndex(part => resumeDetailContent(part) === key)
    if (equivalent >= 0) { result[equivalent] = text; continue }
    if (result.some(parent => resumeDetailContent(parent).includes(key))) continue
    const contained = result.findIndex(part => key.includes(resumeDetailContent(part)))
    if (contained < 0) result.push(text)
    else {
      result[contained] = text
      for (let i = result.length - 1; i > contained; i--) if (key.includes(resumeDetailContent(result[i]))) result.splice(i, 1)
    }
  }
  return result
}

/** DOM node names may contain only the first 200 characters. A verified foreground
 * dialog is the authoritative full text; never import a different dialog/background. */
export function sourcingResumeParts(page: any, name: string, identityRef: string, refs: string[]): string[] {
  const identity = readableIdentityRef(page, identityRef)
  const compact = (text: unknown) => normalized(text).replace(/\s/g, '')
  const identityScope = resumeScope(page, identity)?.ref
  const identityDialog = page.dialogs?.find((row: any) => row.ref === identityScope)
  if (!compact(name) || ![itemText(identity), identityDialog?.text].some(text => compact(text).includes(compact(name)))) throw new Error('CANDIDATE_EVIDENCE_INVALID: IDENTITY_NAME_MISMATCH 身份节点没有当前候选人姓名，请重新定位姓名或其所属简历容器')
  // AX snapshots carry parentRef even when dialogRef/geometry is unavailable.
  // A real candidate article or foreground dialog can own separate name/body
  // nodes; a page-wide generic/root/list is never an ownership witness.
  const scopeFor = (item: any) => resumeScope(page, item)?.ref
  const parts = new Set<string>()
  for (const ref of new Set(refs)) {
    const item = readableIdentityRef(page, ref)
    const scope = scopeFor(item)
    if (scope && identityScope && scope !== identityScope) throw new Error('CANDIDATE_EVIDENCE_INVALID: RESUME_SCOPE_MISMATCH 简历片段来自另一个候选人容器，请更换引用或放弃当前人选')
    if (!scope || scope !== identityScope) {
      try { identityObservation(page, ref, name, [identityRef]) }
      catch (error) {
        if (!String(error).includes('CANDIDATE_EVIDENCE_INVALID')) throw error
        throw new Error('CANDIDATE_EVIDENCE_INVALID: RESUME_FRAGMENT_UNRELATED 简历片段与身份节点没有可核验关联；请检查共同容器，必要时用DOM快照或跳过当前人选')
      }
    }
    const dialog = scope && scope === identityScope && page.dialogs?.find((row: any) => row.ref === scope)
    if (dialog && typeof dialog.text === 'string' && compact(dialog.text).includes(compact(name))) {
      parts.add(dialog.text)
      // DOM dialog text has its own transport limit. Keep explicitly quoted
      // descendant text beyond that limit, without appending its parent context.
      if (item.ref !== scope && item.name) parts.add(normalized(item.name))
      continue
    }
    for (const text of [item.name, item.context?.text]) if (text) parts.add(normalized(text))
  }
  return mergeSourcingResumeParts([...parts])
}

type SearchFocus = { tabId: number; documentId?: string; role: string; name: string; elementId?: string }
export class SourcingSearchTracker {
  private focus?: SearchFocus
  private submission?: { tabId: number; keyword: string }
  constructor(private readonly keyword: () => string) {}
  hasFocusedSearch(call: AgentBrowserCall, page: any): boolean {
    const focus = this.focus
    if (!focus || call.args.tabId !== focus.tabId || (focus.documentId && page?.documentId !== focus.documentId)) return false
    const inputs = (page?.items ?? []).filter((item: any) => item.role === focus.role
      && (focus.elementId ? item.elementId === focus.elementId : normalized(item.name) === focus.name
        || (Array.isArray(item.states) ? item.states : Object.keys(item.states ?? {}).filter(key => item.states[key])).includes('focused'))
      && normalized(item.value).toLowerCase() === normalized(this.keyword()).toLowerCase()
      && !(Array.isArray(item.states) ? item.states : Object.keys(item.states ?? {}).filter(key => item.states[key])).some((state: string) => ['hidden', 'invisible', 'blocked_by_dialog'].includes(state)))
    return inputs.length === 1
  }
  async dispatch(call: AgentBrowserCall, page: any, dispatch: () => Promise<any>, currentPage: () => any) {
    const item = page?.items?.find((row: any) => row.ref === call.args.ref)
    const submit = this.hasFocusedSearch(call, page) && (call.name === 'browser_press_key' && /^(Enter|Return)$/.test(String(call.args.key))
      || call.name === 'browser_click' && /^(搜索|搜索人才|搜人才|搜索简历|搜简历)$/.test(normalized(item?.name)))
    const typed = call.name === 'browser_type' && normalized(call.args.text).toLowerCase() === normalized(this.keyword()).toLowerCase()
    // Any attempted browser input invalidates focus before dispatch. A failed input
    // must never authorize a later Enter on an unknown target.
    if (!call.readOnly) this.focus = undefined
    if (call.name === 'browser_type' || call.name === 'browser_select_option') this.submission = undefined
    const result = await dispatch()
    if (typed && item) {
      const next = currentPage()
      this.focus = { tabId: call.args.tabId, documentId: next?.documentId ?? page?.documentId, role: item.role, name: normalized(item.name), elementId: item.elementId }
    }
    if (submit) this.submission = { tabId: call.args.tabId, keyword: normalized(this.keyword()).toLowerCase() }
    return result
  }
  assertSubmitted(tabId: number) {
    if (!this.submission || this.submission.tabId !== tabId || this.submission.keyword !== normalized(this.keyword()).toLowerCase()) throw new Error('SEARCH_CONDITIONS_UNVERIFIED: 请在当前标签页实际提交关键词搜索')
  }
}
