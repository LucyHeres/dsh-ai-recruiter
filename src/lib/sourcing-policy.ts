import { z } from 'zod'
import { hash } from './store.js'
import { identityObservation, itemText, normalized, readableIdentityRef } from './page-actions.js'
import type { AgentBrowserCall } from './agent-browser-tools.js'
import type { SourcingAssessment, SourcingCriterion, SourcingPosition } from '../shared/sourcing.js'
import { DEFAULT_MINIMUM_SCORE, sourcingCriterionScore } from '../shared/sourcing-score.js'
import { isSourcingFilterControl } from './sourcing-search.js'

export const sourcingStartSpec = z.object({ id: z.string().uuid(), jobId: z.string().min(1).max(64),
  sourceMode: z.enum(['recommend', 'search']).default('recommend').describe('默认从人才推荐寻聘；只有用户明确要求主动搜索时才传 search，不能因推荐不足自动切换'),
  platforms: z.array(z.enum(['liepin', 'boss'])).min(1).max(2).refine(rows => new Set(rows).size === rows.length).describe('仅从所选职位的 jobs[].platforms 中选择已对接同步的平台，不默认同时选择两个平台'),
  minimumScore: z.number().int().min(0).max(100).default(DEFAULT_MINIMUM_SCORE), autoGreet: z.boolean().default(false), supplement: z.string().trim().max(4000).default(''), limit: z.number().int().min(1).max(50).describe('每个平台独立目标人数，例如选择两个平台、limit=5表示每平台5人，共10人'), confirmed: z.literal(true),
}).strict()
export const sourcingSource = (position: SourcingPosition, supplement: string) => [position.name, position.city, position.description, supplement].filter(Boolean).join('\n')
export const sourcingVersion = (position: SourcingPosition, supplement: string) => hash({ id: position.id, name: position.name, city: position.city, description: position.description, supplement })
export function validateCriteria(criteria: SourcingCriterion[], source: string) {
  if (criteria.length < 1 || criteria.length > 8 || new Set(criteria.map(row => row.id)).size !== criteria.length || criteria.reduce((sum, row) => sum + row.weight, 0) !== 100) throw new Error('匹配维度须唯一且权重合计 100')
  for (const row of criteria) {
    if (!normalized(row.label) || normalized(row.quote).length < 2 || !normalized(source).includes(normalized(row.quote))) throw new Error('匹配标准缺少职位要求原文依据')
    if (/性别|年龄|婚育|婚姻|民族|宗教|照片|颜值|星座/.test(row.label + row.quote)) throw new Error('匹配维度应使用岗位职责、技能和项目经历')
  }
}
export function assessCandidate(criteria: SourcingCriterion[], assessments: SourcingAssessment[], resumeText: string) {
  if (assessments.length !== criteria.length || new Set(assessments.map(row => row.criterionId)).size !== criteria.length) throw new Error('必须逐项评估全部匹配维度')
  let score = 0, coverage = 0, unknownMust = false, conflict = false
  for (const criterion of criteria) {
    const row = assessments.find(item => item.criterionId === criterion.id)
    if (!row) throw new Error('存在未知或遗漏的匹配维度')
    if (row.state !== 'unknown') {
      if (!normalized(row.quote) || !normalized(resumeText).includes(normalized(row.quote))) throw new Error(`SOURCING_ASSESSMENT_EVIDENCE_MISSING: ${criterion.id} 的分析证据引用不在当前候选人的已读简历中，请从宿主已采集原文引用，未提及应填 unknown`)
      coverage += criterion.weight
      score += sourcingCriterionScore(criterion.weight, row.state)
    }
    if (criterion.must && row.state === 'unknown') unknownMust = true
    if (criterion.must && row.state === 'mismatch') conflict = true
  }
  return { score: Math.round(score), coverage, verdict: conflict ? 'unqualified' as const : unknownMust || score < 70 ? 'review' as const : 'recommended' as const }
}

const blockedControl = /沟通|打招呼|开聊|发送|联系|索要|交换|购买|付费|解锁|下载|导出|收藏|不合适|邀约|邀请|删除|保存|提交简历|举报|投递|申请|屏蔽|短信|拨打/
const searchField = /搜索|搜人才|关键词|关键字|职位|城市|地区|地点|经验|学历|薪资|行业|职能|search|keyword/i
/** Code boundary: only observed search/navigation controls; no model-declared writes. */
export function assertSourcingNavigation(call: AgentBrowserCall, page: any, selectedName?: string, focusedSearch = false, positionControl = false) {
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
  if (blockedControl.test(label)) throw new Error('SOURCING_READ_ONLY: 该控件不属于只读寻聘')
  if (positionControl && ['browser_click', 'browser_hover'].includes(call.name)) return
  if (['browser_type', 'browser_select_option', 'browser_press_key'].includes(call.name)) {
    if (!searchField.test(text) || !['textbox', 'searchbox', 'combobox', 'spinbutton', 'option'].includes(item.role)) throw new Error('SOURCING_SEARCH_INPUT_REQUIRED: 只能在已观察的搜索筛选控件输入')
    if (call.name === 'browser_press_key' && !/^(Enter|Return)$/.test(String(call.args.key))) throw new Error('SOURCING_READ_ONLY: 不支持该按键')
    return
  }
  if (['browser_click', 'browser_hover'].includes(call.name)) {
    if (selectedName && label === normalized(selectedName)
      || label.toLowerCase() === 'close' && !!item.dialogRef && ['button', 'img'].includes(item.role)
      || ['option', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox'].includes(item.role) || ['checkbox', 'radio', 'combobox'].includes(item.role) && (searchField.test(text) || /^(?:本科|大专|硕士|博士|高中|中专|不限|\d+[-–~至]\d+年|\d+年以上)(?:及以上)?$/.test(label))
      || (item.role === 'button' || label === '不限职位') && isSourcingFilterControl(item)
      || item.role === 'link' && !!item.href
      || /搜索|搜人才|筛选|清空|重置|详情|查看简历|在线简历|人才|下一页|上一页|更多|关闭|返回|展开|收起|工作经历|项目经历|教育经历|^\d+$|^×$|^关闭$/.test(label)
      || label === '确定' && searchField.test(text)) return
  }
  throw new Error('SOURCING_NAVIGATION_UNVERIFIED: 请使用可识别的搜索、筛选或简历入口，不能操作未知按钮')
}

/** DOM node names may contain only the first 200 characters. A verified foreground
 * dialog is the authoritative full text; never import a different dialog/background. */
export function sourcingResumeParts(page: any, name: string, identityRef: string, refs: string[]): string[] {
  const identity = readableIdentityRef(page, identityRef)
  const compact = (text: unknown) => normalized(text).replace(/\s/g, '')
  if (!compact(name) || !compact(itemText(identity)).includes(compact(name))) throw new Error('CANDIDATE_EVIDENCE_INVALID: IDENTITY_NAME_MISMATCH 身份节点没有当前候选人姓名，请重新定位姓名或其所属简历容器')
  // AX snapshots carry parentRef even when dialogRef/geometry is unavailable.
  // A real candidate article or foreground dialog can own separate name/body
  // nodes; a page-wide generic/root/list is never an ownership witness.
  const scopeFor = (item: any) => {
    const seen = new Set<string>()
    let article: string | undefined
    for (let node = item; node && !seen.has(node.ref); node = page.items?.find((row: any) => row.ref === (node.dialogRef || node.parentRef))) {
      seen.add(node.ref)
      if (['article', 'dialog', 'alertdialog'].includes(node.role)) {
        readableIdentityRef(page, node.ref)
        if (node.role !== 'article') return node.ref as string
        article ??= node.ref
      }
    }
    return article
  }
  const identityScope = scopeFor(identity)
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
    parts.add(itemText(item))
    const dialogRef = item.dialogRef || (item.role === 'dialog' ? item.ref : undefined)
    const identityDialog = identity.dialogRef || (identity.role === 'dialog' ? identity.ref : undefined)
    if (!dialogRef || dialogRef !== identityDialog) continue
    const dialog = page.dialogs?.find((row: any) => row.ref === dialogRef)
    const root = page.items?.find((row: any) => row.ref === dialogRef)
    if (!dialog || !root) continue
    readableIdentityRef(page, dialogRef)
    if (typeof dialog.text === 'string' && normalized(dialog.text).includes(normalized(name))) parts.add(dialog.text)
  }
  const ordered = [...parts].filter(Boolean).sort((a, b) => b.length - a.length)
  return ordered.filter((text, index) => !ordered.slice(0, index).some(parent => normalized(parent).includes(normalized(text))))
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
