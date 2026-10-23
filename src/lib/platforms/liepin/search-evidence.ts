import type { AgentBrowserTools } from '../../agent-browser-tools.js'
import type { PositionEvidence, PositionOutcome } from '../../position-evidence.js'
import type { GreetingJob } from '../../../shared/workbench.js'
import { normalized, readableIdentityRef, statesOf } from '../../page-actions.js'
import type { SourcingSearchFilters } from '../../../shared/sourcing.js'
import { sourcingEducationLevels, verifySourcingSearchFilters } from '../../sourcing-search.js'
import { liepinRecommendationControl, recommendationFilterDialog } from './recommendation-controls.js'
import { verifyPositionEvidence } from '../../position-evidence.js'
import { positionBusinessIds } from '../../position-controls.js'
import { liepinDefinition } from './definition.js'

type Field = 'city' | 'experience' | 'education' | 'current_city'
type Control = { kind: 'position' | 'position_confirm' | 'job_option' | 'filter' | 'filter_open' | 'confirm' | 'search'; field?: Field; selected: boolean; active: boolean; expanded: boolean }
const classes = (node: any): string[] => String(node?.attributes?.class ?? '').split(/\s+/)
const hasClass = (node: any, name: string) => classes(node).some(token => token === name || token.startsWith(`${name}--`))
const selectedClass = (node: any) => classes(node).some(token => /^(?:active|selected|checked)(?:--|$)/.test(token) || token === 'search-page-filter-item-active')

/** Platform semantics stay in the recruiter. Both native inspection shapes
 * (AX item + DOM detail, or DOM detail alone) describe the same observed control. */
export function liepinSearchControl(item: any, detail: any): Control | undefined {
  if (!item || !detail?.element) return
  const nodes = [detail.element, ...(detail.ancestors ?? [])], own = detail.element
  const editable = ['input', 'textarea'].includes(String(own.tagName).toLowerCase()) || ['textbox', 'searchbox'].includes(item.role)
  const visible = own.visible !== false && own.css?.display !== 'none' && own.css?.visibility !== 'hidden'
    && !statesOf(item).some(s => ['hidden', 'invisible', 'blocked_by_dialog'].includes(s))
  // pointer-events may be re-enabled by a descendant (the sticky search bar
  // does exactly this). Use the target's computed value; ancestry alone is not
  // a hit-test. Snapshot occlusion remains advisory to the real browser.
  const active = visible && own.css?.pointerEvents !== 'none' && !nodes.some(node => node.css?.opacity === '0' || node.css?.display === 'none')
    && !statesOf(item).includes('disabled')
  const expanded = nodes.some(node => node.attributes?.['aria-expanded'] === 'true' || hasClass(node, 'ant-lpt-dropdown-open'))
  const base = { active, expanded, selected: visible && (selectedClass(own) || statesOf(item).some(s => ['selected', 'checked', 'current'].includes(s))) }
  if (!editable && nodes.some(n => hasClass(n, 'search-page-select-jobs-wrap') || hasClass(n, 'selectJobWrap'))
    && nodes.some(n => hasClass(n, 'dropdown-button') || hasClass(n, 'job-title'))) return { ...base, kind: 'position', selected: visible && !expanded && normalized(item.name) !== '不限职位' }
  if (!editable && nodes.some(n => hasClass(n, 'jobs-item')) && nodes.some(n => hasClass(n, 'jobs-list'))) return { ...base, kind: 'job_option', selected: visible && selectedClass(nodes.find(n => hasClass(n, 'jobs-item'))) }
  if (own.tagName === 'label' && (hasClass(own, 'search-page-filter-item') || selectedClass(own)
    || nodes.some(n => hasClass(n, 'checkboxBox')))) {
    // Only the nearest observed filter row can give a plain label its meaning.
    // Candidate-card occurrences of 武汉/本科 are not search controls.
    const row = nodes.slice(1).map(n => normalized(n.text)).find(text => /^(?:期望城市|工作城市|目前城市|教育经历|学历|工作经验|经\s*验)\s/.test(text))
    const field: Field | undefined = row && (/^(?:期望城市|工作城市)/.test(row) ? 'city' : /^目前城市/.test(row) ? 'current_city'
      : /^(?:教育经历|学历)/.test(row) ? 'education' : 'experience') || undefined
    if (field) return { ...base, kind: 'filter', field }
  }
  const button = own.tagName === 'button' || item.role === 'button'
  if (button && normalized(item.name) === '搜索' && nodes.some(n => hasClass(n, 'searchInputBox'))) return { ...base, kind: 'search' }
  if (button && normalized(item.name) === '确定' && nodes.some(n => hasClass(n, 'select-jobs-content-wrap')) && nodes.some(n => hasClass(n, 'jobs-handle'))) return { ...base, kind: 'position_confirm' }
  if (button && normalized(item.name) === '确定' && nodes.some(n => hasClass(n, 'select-jobs-content-wrap') || hasClass(n, 'searchInputBox')
    || hasClass(n, 'inputGroup') || n.attributes?.role === 'dialog' && /职位|筛选/.test(normalized(n.text)))) return { ...base, kind: 'confirm' }
}

export class LiepinSearchEvidence {
  private names: string[] = []
  constructor(private readonly broker: AgentBrowserTools) {}
  enabled(page: any) {
    try { const url = new URL(page.url); return url.origin === 'https://lpt.liepin.com' && ['/search', '/recommend'].includes(url.pathname.replace(/\/$/, '')) } catch { return false }
  }
  private recommendation(page: any) { try { return new URL(page.url).pathname.replace(/\/$/, '') === '/recommend' } catch { return false } }
  async inspect(page: any, refs: string[], signal: AbortSignal, reuse = false) {
    if (this.enabled(page)) await this.broker.inspectRefs(page, refs.filter(ref => !this.recommendation(page)
      || !liepinRecommendationControl(page.items.find((item: any) => item.ref === ref) ?? {}, this.names, page)), signal, reuse, true)
  }
  control(page: any, ref: string): Control | undefined {
    if (!this.enabled(page)) return
    const item = page.items?.find((item: any) => item.ref === ref), detail = this.broker.getInspection(page, ref)
    if (this.recommendation(page) && item) {
      const control = liepinRecommendationControl(item, this.names, page, detail)
      if (control) return control
    }
    // DOM inspection omits ancestor text; the same snapshot's parent chain can
    // supply it. Never borrow arbitrary nearby text or another snapshot's row.
    const parents: any[] = [], seen = new Set<string>()
    for (let parent = item?.parentRef; parent && !seen.has(parent);) {
      seen.add(parent)
      const node = page.items.find((row: any) => row.ref === parent)
      if (!node) break
      parents.push({ text: node.name }); parent = node.parentRef
    }
    return liepinSearchControl(item, detail && { ...detail, ancestors: [...(detail.ancestors ?? []), ...parents] })
  }
  position(page: any, job: Pick<GreetingJob, 'jobId' | 'jobName' | 'platformJobs'>, proof: PositionEvidence): PositionOutcome | undefined {
    // The foreground recommendation resume has a literal header, not a
    // selected tab. Never borrow the covered background job selector.
    if (this.recommendation(page) && page.dialogs?.length === 1 && proof.ref === page.dialogs[0].ref) {
      const item = readableIdentityRef(page, proof.ref)
      const header = /^推荐职位[：:]\s*([^\n]+)/.exec(String(page.dialogs[0].text ?? ''))
      if (item.role === 'dialog' && header) {
        const name = normalized(header[1]), targets = job.platformJobs?.length ? job.platformJobs : [{ id: '', name: job.jobName || '' }]
        const matching = targets.filter(target => normalized(target.name) === name)
        if (matching.length !== 1 || proof.platformJobId && proof.platformJobId !== matching[0]?.id) return { ok: false, error: '详情顶部推荐职位与唯一目标职位关联不一致' }
        if (proof.quote && !normalized(item.name).includes(normalized(proof.quote))) return { ok: false, error: '职位引用原文不在当前详情标题中' }
        return { ok: true, verification: { ref: proof.ref, quote: `推荐职位：${name}`, level: 'degraded', reason: '当前前景简历顶部明确显示唯一关联推荐职位' } }
      }
    }
    const control = this.control(page, proof.ref)
    if (control?.kind !== 'position') return
    if (this.recommendation(page) && page.items.find((item: any) => item.ref === proof.ref)?.role === 'tab') return verifyPositionEvidence(page, job, proof, liepinDefinition.positionAlias)
    const item = readableIdentityRef(page, proof.ref), name = normalized(item.name || item.value)
    const fail = (error: string): PositionOutcome => ({ ok: false, error })
    if (!control.selected) return fail('请关闭顶部招聘职位下拉并核对当前职位，展开选项不能作为已选职位')
    if (proof.quote && !normalized([item.name, item.value, item.context?.text].filter(Boolean).join(' ')).includes(normalized(proof.quote))) return fail('所引原文不在当前顶部招聘职位中')
    const targets = job.platformJobs?.length ? job.platformJobs : [{ id: '', name: job.jobName || '' }]
    const matching = targets.filter(target => normalized(target.name) === name)
    if (!matching.length) return fail('顶部当前招聘职位与目标职位不一致')
    if (proof.platformJobId && !matching.some(target => target.id === proof.platformJobId)) return fail('所传关联 ID 不属于当前名称匹配的目标职位')
    // A requested linked ID is a target constraint, not a claim that the UI
    // exposes it. Only explicit job query parameters are business-ID evidence.
    const observed = [...new Set([...positionBusinessIds(page), ...positionBusinessIds(page, item)])]
    if (observed.some(id => !matching.some(target => target.id === id))) return fail('页面暴露的招聘职位 ID 与目标关联冲突')
    const exact = matching.filter(target => target.id && observed.includes(target.id))
    if (exact.length > 1 || !exact.length && matching.length !== 1) return fail('存在同名招聘职位且页面未暴露唯一 ID，无法确认')
    return { ok: true, verification: { ref: proof.ref, quote: proof.quote || name, level: exact.length === 1 ? 'exact' : 'degraded',
      ...(exact.length === 1 ? { platformJobId: exact[0]!.id } : {}), reason: exact.length ? '顶部当前职位及页面招聘职位 ID 一致' : '顶部当前招聘职位显示唯一关联名称；页面未暴露职位 ID' } }
  }
  filterPage(page: any, proofs: { ref: string; field: string }[]) {
    const selected = new Set<string>()
    for (const proof of proofs) {
      const control = this.control(page, proof.ref)
      if (control?.kind !== 'filter') continue
      if (control.field !== proof.field) throw new Error('SEARCH_CONDITIONS_UNVERIFIED: 引用的筛选项不属于所声明字段，工作城市须使用期望城市')
      if (control.selected) selected.add(proof.ref)
      else throw new Error(`SEARCH_CONDITIONS_UNVERIFIED: ${proof.field} 所引筛选项当前未选中`)
    }
    return { ...page, items: page.items.map((item: any) => selected.has(item.ref) ? { ...item, states: [...statesOf(item), 'selected'] } : item) }
  }
  async scan(page: any, names: string[], expected: SourcingSearchFilters, signal: AbortSignal) {
    this.names = names
    const recommendation = this.recommendation(page), drawer = recommendationFilterDialog(page)
    const targets = new Set(['不限职位', ...names, expected.city?.split(/[\/／]/).pop()?.replace(/市$/, ''),
      '不限', '本科', '硕士', 'MBA/EMBA', '博士', '博士/博士后', '大专', '高中', '高中及以下', '中专/中技', '搜索', '在校/应届', '1年以下', '1-3年', '3-5年', '5-10年', '10年以上', '确定'])
    const counts = new Map<string, number>()
    const items = page.items.filter((item: any) => {
      const name = normalized(item.name), count = counts.get(name) ?? 0
      if (recommendation && !drawer && !names.includes(name) && name !== '不限职位') return false
      if (recommendation && drawer && item.dialogRef !== drawer.ref && !names.includes(name)) return false
      if (!item.ref || !targets.has(name) || name === '确定' && item.role !== 'button' || count >= (name === '不限' ? 4 : name === '确定' ? 6 : 2)) return false
      counts.set(name, count + 1); return true
    }).slice(0, 28)
    await this.inspect(page, items.map((item: any) => item.ref), signal, true)
  }
  completeFilterProofs<T extends { ref: string; field: string; quote: string; state?: string }>(page: any, proofs: T[]): T[] {
    const completed = [...proofs]
    for (const proof of proofs) {
      if (proof.state === 'unsupported' || this.control(page, proof.ref)?.kind !== 'filter') continue
      for (const item of page.items) {
        const control = this.control(page, item.ref)
        if (control?.kind === 'filter' && control.field === proof.field && control.selected && !completed.some(row => row.field === proof.field && row.ref === item.ref)) {
          completed.push({ ...proof, ref: item.ref, quote: normalized(item.name), state: 'applied' })
        }
      }
    }
    return completed
  }
  summary(page: any, expected: SourcingSearchFilters = {}) {
    const controls = (page.items ?? []).flatMap((item: any) => {
      const control = this.control(page, item.ref)
      return control ? [{ ref: item.ref, name: item.name, ...control }] : []
    }).slice(0, 40)
    const levels = expected.education ? sourcingEducationLevels(expected.education) : []
    let educationApplied = false
    if (expected.education) {
      const proofs = controls.filter((row: any) => row.field === 'education' && row.selected)
        .map((row: any) => ({ field: 'education' as const, ref: row.ref, quote: normalized(page.items.find((item: any) => item.ref === row.ref)?.value || row.name), state: 'applied' as const }))
      try { verifySourcingSearchFilters(this.filterPage(page, proofs), { education: expected.education }, proofs); educationApplied = true } catch { /* Keep missing-level guidance below. */ }
    }
    return { snapshotId: page.snapshotId, controls, expectedFilters: expected,
      ...(levels.length ? { educationPlan: { requiredLevels: levels,
        missingLevels: educationApplied ? [] : levels.filter(level => !controls.some((row: any) => row.field === 'education' && row.selected && normalized(row.name).includes(level))),
        instruction: this.recommendation(page) ? '已生效的“本科及以上”等条件摘要可直接复用。仅当实际控件为多选时按 missingLevels 补选，已选项不要重复点击。' : '猎聘学历为多选。“本科及以上”须同时勾选本科、硕士、博士/博士后；按 missingLevels 补选，已选项不要重复点击。' } } : {}) }
  }
}
