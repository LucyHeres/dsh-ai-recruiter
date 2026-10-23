import { normalized, statesOf } from '../../page-actions.js'
import { positionControl, positionNameMatches } from '../../position-controls.js'
import type { SearchControl } from '../types.js'
import { liepinDefinition } from './definition.js'
const hasClass = (node: any, value: string) => String(node?.attributes?.class ?? '').split(/\s+/).some(token => token === value || token.startsWith(`${value}--`))
export function recommendationFilterDialog(page: any) {
  return (page?.dialogs ?? []).find((dialog: any) => normalized(dialog.text).startsWith('筛选条件') && /学历要求|工作经验/.test(dialog.text))
}
export const recommendationFilterLabel = (name: unknown) => normalized(name).startsWith('筛选')

/** Recognize the observed job title and tab state, independent of DOM IDs. */
export function liepinRecommendationControl(item: any, names: string[], page?: any, detail?: any): (Omit<SearchControl, 'field'> & { field?: 'city' | 'education' | 'experience' }) | undefined {
  const states = statesOf(item)
  const active = !states.some(s => ['hidden', 'invisible', 'blocked_by_dialog', 'disabled'].includes(s)) && detail?.element?.visible !== false && detail?.element?.css?.pointerEvents !== 'none'
  const selected = states.some(s => ['selected', 'checked', 'current'].includes(s))
  const expanded = states.includes('expanded')
  const name = normalized(item.name)
  if (item.role === 'button' && !item.dialogRef && recommendationFilterLabel(name)) return { kind: 'filter_open', active, selected: false, expanded }
  if (item.role === 'tab' && positionControl(page, item) && names.some(n => positionNameMatches(page, item, n, liepinDefinition.positionAlias))) {
    return { kind: selected ? 'position' : 'job_option', active, selected, expanded }
  }
  if (!expanded && ['button', 'combobox'].includes(item.role) && !['input', 'textarea'].includes(String(item.tagName).toLowerCase())) {
    const field = /^(?:期望城市|工作城市)(?:[：:\s]|$)/.test(name) ? 'city'
      : /^(?:学历|教育经历)(?:[：:\s]|$)/.test(name) ? 'education'
      : /^(?:工作经验|经验)(?:[：:\s]|$)/.test(name) ? 'experience' : undefined
    if (field && (item.value || /[：:]\s*\S/.test(name))) return { kind: 'filter', field, active, expanded, selected: active }
  }
  const dialog = recommendationFilterDialog(page)
  if (dialog && item.dialogRef === dialog.ref) {
    const nodes = [detail?.element, ...(detail?.ancestors ?? [])]
    if (name === '确定' && (item.role === 'button' || nodes.some(node => node?.tagName === 'button'))) return { kind: 'confirm', active, selected: false, expanded: false }
    // The clickable tag is a normal filter control even when its AX role is
    // span. Its surrounding filter drawer and checkable component establish
    // navigation intent; candidate-card text with the same label cannot pass.
    if (hasClass(detail?.element, 'ant-lpt-tag-checkable') && nodes.some(node => hasClass(node, 'filterItems'))) {
      const row = page.items?.find((node: any) => node.ref === item.parentRef && node.dialogRef === dialog.ref && node.role !== 'dialog')
      const field = /本科.*硕士.*博士/.test(normalized(row?.name)) ? 'education'
        : /(?:1-3年|3-5年).*(?:5-10年|10年以上)/.test(normalized(row?.name)) ? 'experience' : undefined
      return { kind: 'filter', field, active, expanded: false, selected: active && (selected || hasClass(detail?.element, 'ant-lpt-tag-checkable-checked')) }
    }
  }
}
