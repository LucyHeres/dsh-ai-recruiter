import { z } from 'zod'
import { itemText, normalized, readableIdentityRef, statesOf } from './page-actions.js'
import type { GreetingJob } from '../shared/workbench.js'

export const searchConfirmationSpec = z.object({ tabId: z.number().int().positive(), snapshotId: z.string().min(1),
  evidence: z.array(z.object({ field: z.enum(['keyword', 'city', 'ageUnder', 'experienceMin', 'experienceMax']), ref: z.string().min(1), quote: z.string().min(1).max(500) }).strict()).min(1).max(10),
}).strict()

export function assertSearchEvidence(page: any, query: NonNullable<GreetingJob['search']>, evidence: z.infer<typeof searchConfirmationSpec>['evidence']) {
  if (new URL(page.url).pathname !== '/search') throw new Error('SEARCH_CONDITIONS_UNVERIFIED: 当前不是猎聘搜索人才页')
  for (const [field, expected] of Object.entries(query)) {
    if (expected === undefined) continue
    const matching = evidence.filter(proof => proof.field === field).some(proof => {
      const item = readableIdentityRef(page, proof.ref)
      const quote = normalized(proof.quote), text = normalized(`${itemText(item)} ${item.value ?? ''}`)
      if (!quote || !text.includes(quote)) return false
      const input = ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(item.role) && normalized(item.value)
      const selected = statesOf(item).some(state => ['selected', 'checked', 'current'].includes(state)) || /已选|筛选条件|搜索条件/.test(text)
      if (!input && !selected) return false
      if (typeof expected === 'string') return normalized(input ? item.value : quote).toLocaleLowerCase().includes(normalized(expected).toLocaleLowerCase())
      if (field === 'ageUnder') return new RegExp(`(?:小于|未满|不到|[<＜])\\s*${expected}(?!\\d)|(?:^|\\D)${expected}\\s*岁?\\s*(?:以下|以内)`).test(text)
      const lower = query.experienceMin, upper = query.experienceMax
      if (lower !== undefined && upper !== undefined && new RegExp(`(?:^|\\D)${lower}\\s*(?:年)?\\s*[-~～至到–—]\\s*${upper}(?!\\d)`).test(quote)) return true
      if (input && normalized(item.value) === String(expected) && /经验|工作年限/.test(text)) {
        return field === 'experienceMin' ? /最低|最少|起|从|下限/.test(text) : /最高|最多|止|到|上限/.test(text)
      }
      return new RegExp(`(?:^|\\D)${expected}\\s*年?\\s*${field === 'experienceMin' ? '(?:以上|起)' : '(?:以下|以内)'}`).test(text)
    })
    if (!matching) throw new Error(`SEARCH_CONDITIONS_UNVERIFIED: ${field} 缺少当前输入值或已生效筛选条件的证据；不能用未选中的选项冒充生效条件`)
  }
}
