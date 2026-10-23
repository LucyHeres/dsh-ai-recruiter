import { normalized, statesOf } from './page-actions.js'

/** Only explicit business fields count as job IDs. DOM IDs are widget identity. */
export function positionBusinessIds(page: any, item?: any): string[] {
  const value = item ? item.href : page.url
  if (!value) return []
  try {
    const base = new URL(page.url), url = new URL(value, base)
    if (url.origin !== base.origin) return []
    return [...new Set([...url.searchParams].filter(([key, value]) => value
      && /^(?:e?jobid|positionid|recruitjobid|thirdjobid|encryptjobid)$/i.test(key)).map(([, value]) => value))]
  } catch { return [] }
}

/** 平台推荐页给职位名加的业务后缀；由 PlatformDefinition 声明，通用代码不认平台。 */
export interface PositionTitleAlias { suffix: string; path: string }

/** Match the control's title/value, never a job name buried in candidate text. */
export function positionNameMatches(page: any, item: any, name: string, alias?: PositionTitleAlias): boolean {
  const target = normalized(name)
  if (!target) return false
  const title = normalized(item.value || item.name)
  if (title === target) return true
  // 平台声明的标题后缀只在对应路径上生效；任意职位名后缀仍不匹配。
  if (!alias) return false
  try {
    return new URL(page.url).pathname.replace(/\/$/, '') === alias.path
      && item.role === 'tab' && title === `${target} ${alias.suffix}`
  } catch { return false }
}

export function positionControl(page: any, item: any): boolean {
  const foreground = (ref: string) => page?.dialogs?.length === 1 && page.dialogs[0].ref === ref
  if (!item?.ref || item.dialogRef && (!foreground(item.dialogRef) || !['tab', 'option', 'combobox', 'button'].includes(item.role))
    || ['input', 'textarea'].includes(String(item.tagName).toLowerCase())
    || ['textbox', 'searchbox', 'article', 'listitem', 'row', 'dialog'].includes(item.role)
    || statesOf(item).some(state => ['hidden', 'invisible', 'blocked_by_dialog'].includes(state))) return false
  const seen = new Set<string>()
  for (let node = item; node && !seen.has(node.ref); node = page?.items?.find((row: any) => row.ref === node.parentRef)) {
    if (node.dialogRef && !foreground(node.dialogRef) || node.role === 'article'
      || ['row', 'listitem'].includes(node.role) && /\d{2}\s*岁|工作经历|项目经历|求职意向/.test(String(node.name))) return false
    seen.add(node.ref)
  }
  return true
}

function within(page: any, child: any, parent: any): boolean {
  const seen = new Set<string>()
  for (let node = child; node && !seen.has(node.ref); node = page?.items?.find((row: any) => row.ref === node.parentRef)) {
    if (node.ref === parent.ref) return true
    seen.add(node.ref)
  }
  return false
}

export function samePositionComponent(page: any, first: any, second: any): boolean {
  return within(page, first, second) || within(page, second, first)
}

export function distinctPositionControls(page: any, items: any[]): any[] {
  return items.filter(item => !items.some(parent => parent !== item && parent.ref !== item.ref && within(page, item, parent)))
}

/** Disambiguate only with business evidence attached to the option itself.
 * The current page URL says nothing about an unselected option. */
export function positionChoices(page: any, items: any[], targets: { id: string; name?: string }[], preferredId?: string, alias?: PositionTitleAlias): any[] {
  const candidates = items.filter(item => positionControl(page, item) && !statesOf(item).includes('disabled'))
  const eligible = candidates.filter(item => {
    const matching = targets.filter(target => positionNameMatches(page, item, target.name || '', alias))
    const ids = positionBusinessIds(page, item)
    if (!matching.length || preferredId && !matching.some(target => target.id === preferredId)) return false
    if (ids.length && matching.some(target => target.id)) return ids.length === 1 && ids.every(id => matching.some(target => target.id === id))
      && (!preferredId || ids.includes(preferredId))
    return matching.length === 1
  })
  const identified = eligible.filter(item => positionBusinessIds(page, item).some(id => targets.some(target => target.id === id)))
  return distinctPositionControls(page, identified.length ? identified : eligible)
}
