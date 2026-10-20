import { z } from 'zod'
import { itemText, normalized, readableIdentityRef, statesOf } from './page-actions.js'
import { verifyPositionEvidence } from './position-evidence.js'
import type { SourcingJob, SourcingPosition, SourcingSearchFilters } from '../shared/sourcing.js'
import type { GreetingJob, Platform } from '../shared/workbench.js'

const compact = (value: unknown) => normalized(value).replace(/\s/g, '').replace(/[–—~～至到]/g, '-')
const degree = ['小学', '初中', '中专', '高中', '大专', '本科', '硕士', '博士']
export const sourcingEducationLevels = (value: string): string[] => {
  const minimum = degree.findIndex(label => value.replace(/中职|中技/g, '中专').includes(label))
  return minimum >= 0 ? degree.slice(minimum) : []
}
const fieldLabels = { city: /城市|地区|地点/, experience: /经验|工作年限/, education: /学历|教育/ }
export function deriveSourcingSearchFilters(position: SourcingPosition, supplement: string): SourcingSearchFilters {
  const text = position.description
  const requiredSupplement = supplement.split(/[\n，。；]/).filter(clause => !/优先|加分/.test(clause)).join('\n')
  const experience = /(?:工作经验|工作年限|经验要求)[：:]\s*([^\n，。；]+)/.exec(supplement)?.[1]
    || /\d+\s*(?:[-–—~～至到]\s*\d+\s*年|年(?:及)?以上|年以下)/.exec(requiredSupplement)?.[0]
    || position.searchFields?.experience || /(?:工作经验|工作年限|经验要求)[：:]\s*([^\n，。；]+)/.exec(text)?.[1]
    || /\d+\s*(?:[-–—~～至到]\s*\d+\s*年|年以上|年以下)/.exec(text)?.[0]
  const education = /(?:学历要求|学历)[：:]\s*([^\n，。；]+)/.exec(supplement)?.[1]
    || /(博士|硕士|本科|大专|高中|中专)(?:及以上|以上)/.exec(requiredSupplement)?.[0]
    || position.searchFields?.education || /(?:学历要求|学历)[：:]\s*([^\n，。；]+)/.exec(text)?.[1]
    || /(博士|硕士|本科|大专|高中|中专)(?:及以上|以上)/.exec(text)?.[0]
  const city = /(?:工作地点|工作城市|期望城市)[：:]\s*([^\n，。；]+)/.exec(supplement)?.[1] || position.searchFields?.city || position.city
  return { ...(!/不限|无要求/.test(city || '') && city ? { city: city.trim() } : {}),
    ...(!/不限/.test(experience || '') && experience ? { experience: experience.trim() } : {}),
    ...(!/不限/.test(education || '') && education ? { education: education.trim() } : {}) }
}

export const sourcingSearchConfirmationSpec = z.object({ tabId: z.number().int().positive(), snapshotId: z.string().min(1), ref: z.string().min(1),
  mode: z.enum(['position', 'keyword']).default('keyword'), quote: z.string().min(1).max(300).optional(), platformJobId: z.string().optional(),
  filters: z.array(z.object({ field: z.enum(['city', 'experience', 'education']), ref: z.string().min(1), quote: z.string().min(1).max(300),
    state: z.enum(['applied', 'unsupported']).default('applied') }).strict()).max(20).default([]),
}).strict()
export function hasSourcingPositionSelector(page: any): boolean {
  return (page?.items ?? []).some((item: any) => !statesOf(item).some(s => ['hidden','invisible','blocked_by_dialog'].includes(s))
    && (normalized(item.name) === '不限职位' && String(item.tagName).toLowerCase() !== 'input'
      || ['button','combobox','listbox'].includes(item.role) && /职位|岗位/.test(normalized([item.name, item.description, item.placeholder, item.context?.text?.slice(0, 200)].filter(Boolean).join(' '))) && !/搜索职位名称|职位关键词/.test(normalized(item.name))))
}
/** Only search controls invalidate the prepared list; candidate detail tabs do not. */
export function isSourcingFilterControl(item: any): boolean {
  return ['option','menuitem','menuitemradio','menuitemcheckbox','checkbox','radio','combobox','listbox','searchbox','textbox','spinbutton'].includes(item.role)
    || item.role === 'button' && hasSourcingPositionSelector({ items: [item] })
    || item.role === 'button' && /城市|地区|地点|经验|学历/.test(normalized(item.context?.text?.slice(0, 150))) && /不限|本科|硕士|博士|大专|\d+.*年|城市|地区|经验|学历/.test(normalized(item.name))
    || /^(?:搜索|搜人才|搜索人才|人才搜索|筛选|清空|重置|确定|不限职位)$/.test(normalized(item.name))
    || /^(?:(?:当前|期望|工作)?城市|地区|地点|工作经验|经验|学历|教育学历|职位|选择职位|招聘职位)(?:[：:\s]|$)/.test(normalized(item.name))
}
export function sourcingExperienceRange(text: string): [number, number] | undefined {
  const value = compact(text)
  const between = /(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)年?/.exec(value)
  if (between) return [Number(between[1]), Number(between[2])]
  const lower = /(\d+(?:\.\d+)?)年(?:及)?以上/.exec(value), upper = /(\d+(?:\.\d+)?)年以[下内]/.exec(value)
  if (lower) return [Number(lower[1]), Infinity]
  if (upper) return [0, Number(upper[1])]
  if (/无经验|应届/.test(value)) return [0, 0]
  if (/经验不限|不限/.test(value)) return [0, Infinity]
}
function appliedText(page: any, proof: { ref: string; quote: string }, field: keyof SourcingSearchFilters): string {
  const item = readableIdentityRef(page, proof.ref), body = normalized(`${itemText(item)} ${item.value ?? ''}`), quote = normalized(proof.quote)
  if (!body.includes(quote)) throw new Error(`SEARCH_CONDITIONS_UNVERIFIED: ${field} 引用不在当前控件中`)
  const selected = statesOf(item).some(s => ['selected','checked','current'].includes(s))
  const valueControl = item.role === 'combobox' && String(item.tagName).toLowerCase() !== 'input' && !statesOf(item).includes('expanded') && normalized(item.value)
    && fieldLabels[field].test(normalized(`${item.name || ''} ${item.context?.text?.slice(0, 150) || ''}`))
  const ownText = normalized(`${item.name || ''} ${item.value || ''}`)
  const summaryControl = item.role === 'button' && fieldLabels[field].test(normalized(item.name)) && !statesOf(item).includes('expanded') && ownText.includes(quote)
  if (!selected && !valueControl && !summaryControl && !(/已选|筛选条件/.test(normalized(item.name)) && ownText.includes(quote))) throw new Error(`SEARCH_CONDITIONS_UNVERIFIED: ${field} 必须引用已选条件，不能使用未选中的选项`)
  return valueControl ? String(item.value) : quote
}
function covers(expected: [number, number], actual: [number, number][]): boolean {
  let end = expected[0]
  for (const [min, max] of actual.sort((a,b) => a[0]-b[0])) { if (min > end) break; if (max >= end) end = max; if (end >= expected[1]) return true }
  return false
}
export function verifySourcingSearchFilters(page: any, expected: SourcingSearchFilters, proofs: z.infer<typeof sourcingSearchConfirmationSpec>['filters']) {
  const verified: { field: string; state: string }[] = []
  for (const field of Object.keys(expected) as (keyof SourcingSearchFilters)[]) {
    const value = expected[field]!, evidence = proofs.filter(row => row.field === field)
    if (!evidence.length) throw new Error(`SEARCH_CONDITIONS_UNVERIFIED: 请先设置${field}=${value}并提供已生效控件证据`)
    const unsupported = evidence.filter(row => row.state === 'unsupported')
    if (unsupported.length) {
      if (evidence.length !== 1) throw new Error('SEARCH_CONDITIONS_UNVERIFIED: 不支持状态与已选条件冲突')
      const item = readableIdentityRef(page, unsupported[0].ref), quote = normalized(unsupported[0].quote)
      if (!itemText(item).includes(quote) || !/不支持|暂不可用|无法使用|开通.*(?:会员|权益)|升级.*(?:会员|套餐)/.test(quote)) throw new Error(`SEARCH_CONDITIONS_UNVERIFIED: ${field} 缺少平台不支持的明确证据；找不到控件不能视为已设置`)
      verified.push({ field, state: 'unsupported' }); continue
    }
    const texts = evidence.map(proof => appliedText(page, proof, field))
    let matches = false
    if (field === 'city') {
      const city = value.split(/[\/／]/).pop()!.replace(/^.*(?:省|自治区|自治州)/, '').replace(/市$/, '')
      matches = texts.some(text => compact(text).includes(compact(city)))
    } else if (field === 'experience') {
      const expectedRange = sourcingExperienceRange(value)
      const actual = texts.flatMap(text => { const result = sourcingExperienceRange(text); return result ? [result] : [] })
      matches = !!expectedRange && !texts.some(text => /不限/.test(text)) && covers(expectedRange, actual)
    } else {
      const minimum = degree.findIndex(label => value.replace(/中职|中技/g, '中专').includes(label))
      const levels = texts.flatMap(text => degree.flatMap((label,index) => text.replace(/中职|中技/g, '中专').includes(label) ? [index] : []))
      const atLeast = texts.some(text => /以上|及以上|不限/.test(text) && degree.some((label,index) => text.includes(label) && index <= minimum))
      matches = minimum >= 0 && (atLeast || degree.slice(minimum).every((_,index) => levels.includes(index+minimum)))
    }
    if (!matches) throw new Error(`SEARCH_CONDITIONS_UNVERIFIED: ${field} 的已选条件未覆盖职位要求 ${value}，请检查选项范围`)
    verified.push({ field, state: 'applied' })
  }
  return verified
}
export function verifySourcingSearchPosition(page: any, job: SourcingJob, platform: Platform, proof: { ref: string; quote?: string; platformJobId?: string }, selectedTrigger = false) {
  const item = readableIdentityRef(page, proof.ref)
  if (['input', 'textarea'].includes(String(item.tagName).toLowerCase()) || ['textbox', 'searchbox'].includes(item.role)) throw new Error('SOURCING_POSITION_SELECTION_REQUIRED: 输入框中的职位文字不是已选招聘职位，请引用关闭下拉后的当前职位')
  // A non-editable select's current value is selection evidence; a typed search is not.
  const valueSelected = !statesOf(item).includes('expanded') && (selectedTrigger || item.role === 'combobox' && !!item.tagName && String(item.tagName).toLowerCase() !== 'input' && !!item.value
    || item.role === 'button' && hasSourcingPositionSelector({ items: [item] }) && !/不限职位|选择职位|请选择/.test(normalized(item.name)))
  const adapted = valueSelected ? { ...page, items: page.items.map((row: any) => row.ref === item.ref ? { ...row, name: `${row.name || ''} ${row.value || ''}`.trim(), states: [...statesOf(row), 'selected'] } : row) } : page
  const outcome = verifyPositionEvidence(adapted, { jobId:job.jobId,jobName:job.position?.name || job.jobName,platformJobs:job.platformJobs?.[platform] } as GreetingJob, proof)
  if (!outcome.ok) throw new Error(`SOURCING_POSITION_SELECTION_REQUIRED: ${outcome.error}`)
  return outcome.verification
}
export function verifySourcingExhaustion(page: any, proof: { ref: string; quote: string }) {
  const item = readableIdentityRef(page, proof.ref), quote = normalized(proof.quote)
  if (!itemText(item).includes(quote) || !/没有更多|暂无.*(?:人才|简历|结果)|没有.*(?:人才|简历|结果)|无更多|已到.*(?:末尾|底部|最后)|没有符合|已.*最后一页/.test(quote)) throw new Error('SOURCING_EXHAUSTION_UNVERIFIED: 未达到人数时，结束必须有平台无更多结果的明确证据')
}
