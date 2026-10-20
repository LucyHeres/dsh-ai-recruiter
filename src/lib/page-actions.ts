import { z } from 'zod'

export const actionRef = z.string().min(1).max(120)
export const actionReason = z.string().min(1).max(240)
const ref = actionRef, reason = actionReason
export const navigationActionOptions = [
  z.object({ action: z.literal('click'), ref, reason }).strict(),
  z.object({ action: z.literal('hover'), ref, reason }).strict(),
  z.object({ action: z.literal('type'), ref, text: z.string().max(4000), clear: z.boolean().default(true), reason }).strict(),
  z.object({ action: z.literal('press_key'), key: z.string().min(1).max(32), ref: ref.optional(), reason }).strict(),
  z.object({ action: z.literal('select_option'), ref, value: z.string().max(1000), reason }).strict(),
  z.object({ action: z.literal('scroll'), ref: ref.optional(), deltaY: z.number().int().min(-900).max(900), reason }).strict(),
  z.object({ action: z.literal('wait'), reason }).strict(),
  z.object({ action: z.literal('back'), reason }).strict(),
  z.object({ action: z.literal('navigate'), url: z.string().url().max(4000), reason }).strict(),
  z.object({ action: z.literal('inspect_frame'), frameId: z.number().int().nonnegative(), reason }).strict(),
  z.object({ action: z.literal('switch_tab'), tabId: z.number().int().positive(), reason }).strict(),
] as const
export const navigationActionSpec = z.discriminatedUnion('action', navigationActionOptions)
export type NavigationAction = z.infer<typeof navigationActionSpec>
export const PAGE_INTERACTION_GUIDANCE = `通用交互：下拉触发器、更多菜单、卡片操作可能靠 hover 悬停展开。不确定触发方式时先 hover 观察；hover 会移动并停留鼠标，不点击，然后必须读取新快照。已展开时直接选择选项，不要再点触发器。点击后菜单短暂出现又消失、或页面没有变化时，不要重复点击触发器；尝试有依据的 hover 并核对展开内容。recentActions 包含动作 ref、目标、简短理由及前后状态，pageChanged 仅表示可观察变化，不等于目标已完成。相同状态下的同一动作最多执行两次，回到旧状态也不能清除历史；PAGE_ACTION_REPEAT_BLOCKED 表示此次没有执行，必须换有依据的交互或 stop。不得换 ref、改理由或穿插等待绕过保护。`
export const normalized = (value: unknown) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
export const statesOf = (item: any): string[] => Array.isArray(item?.states) ? item.states : Object.keys(item?.states ?? {}).filter(key => item.states[key])
export const blocked = (item: any) => statesOf(item).some(state => ['disabled', 'hidden', 'invisible', 'occluded', 'blocked_by_dialog'].includes(state))
export const itemText = (item: any) => normalized([item?.name, item?.context?.text].filter(Boolean).join(' '))
export function snapshotRef(page: any, ref: string) {
  if (!page?.snapshotId) throw new Error('PAGE_WITHOUT_SNAPSHOT')
  const item = (page.items ?? []).find((item: any) => item.ref === ref)
  if (!item) throw new Error('ELEMENT_NOT_FOUND')
  return item
}
export function observedRef(page: any, ref: string) {
  const item = snapshotRef(page, ref)
  if (blocked(item)) throw new Error('ELEMENT_OCCLUDED')
  return item
}
/** Readable identity is not an executable input target. Occlusion/disabled
 * state alone does not hide text; genuinely hidden or background-modal data
 * cannot establish the current candidate. */
export function readableIdentityRef(page: any, ref: string) {
  if (!page?.snapshotId) throw new Error('PAGE_WITHOUT_SNAPSHOT')
  const item = (page.items ?? []).find((item: any) => item.ref === ref)
  if (!item) throw new Error(`ELEMENT_NOT_FOUND: ${ref}`)
  const states = statesOf(item)
  if (states.some(state => ['hidden', 'invisible', 'blocked_by_dialog'].includes(state))) {
    throw new Error(`CANDIDATE_EVIDENCE_UNREADABLE: ref=${ref}; states=${states.join(',')}; 请选择当前前景中可读的身份依据`)
  }
  return item
}
/** 姓名可位于控件所属内容块或有几何关联的证据元素中，不用年龄/学历规则。 */
export function identityEvidence(page: any, ref: string, name: string, evidenceRefs: string[] = []) {
  const target = observedRef(page, ref)
  return checkIdentity(page, target, name, evidenceRefs)
}
export function identityObservation(page: any, ref: string, name: string, evidenceRefs: string[] = []) {
  return checkIdentity(page, readableIdentityRef(page, ref), name, evidenceRefs)
}
function checkIdentity(page: any, target: any, name: string, evidenceRefs: string[]) {
  const related = evidenceRefs.map(value => readableIdentityRef(page, value))
  const contains = (a: any, b: any) => a && b && [a.x, a.y, a.width, a.height, b.x, b.y, b.width, b.height].every(Number.isFinite)
    && a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
    && a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height
  const compact = (value: unknown) => normalized(value).replace(/\s/g, '')
  const matches = (item: any) => compact(itemText(item)).includes(compact(name))
  if (!compact(name)) throw new Error('CANDIDATE_EVIDENCE_INVALID')
  if (matches(target)) return target
  if (!related.some(item => matches(item) && (item === target || contains(item.bounds, target.bounds)
    || contains(target.bounds, item.bounds) || (!!item.dialogRef && item.dialogRef === target.dialogRef)
    || (!!item.context?.text && item.context.text === target.context?.text)))) throw new Error('CANDIDATE_EVIDENCE_INVALID')
  return target
}
export function safePageUrl(value: unknown) {
  try {
    const url = new URL(String(value))
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return ''
    for (const key of [...url.searchParams.keys()]) if (/token|session|secret|csrf|signature|nonce|password|code|ticket/i.test(key)) url.searchParams.delete(key)
    url.hash = ''; return url.href
  } catch { return '' }
}
export function pageObservation(page: any, maxCharacters = 140000) {
  const all = Array.isArray(page.items) ? page.items : []
  const visible = all.filter((item: any) => !statesOf(item).some(state => ['hidden', 'invisible', 'occluded', 'blocked_by_dialog'].includes(state)))
  let remaining = 70000
  const items = visible.flatMap((item: any) => {
    const entry = { ref: item.ref, role: item.role, name: String(item.name ?? '').slice(0, 1200), states: item.states,
      bounds: item.bounds, elementId: item.elementId, parentRef: item.parentRef, tagName: item.tagName, controls: item.controls, hasPopup: item.hasPopup, description: item.description, value: item.value, dialogRef: item.dialogRef, href: safePageUrl(item.href) || undefined,
      context: item.context?.text ? { text: String(item.context.text).slice(0, 2400) } : undefined }
    const size = JSON.stringify(entry).length
    if (size > remaining) return []
    remaining -= size; return [entry]
  })
  const result = { url: safePageUrl(page.url), snapshotId: page.snapshotId, text: String(page.text ?? '').slice(0, 18000),
    format: page.format,
    viewport: page.viewport,
    truncated: !!page.truncated, isLoginPage: page.isLoginPage,
    selectedTabs: (page.selectedTabs ?? []).map((item: any) => ({ name: String(item.name ?? '').slice(0, 1200), elementId: item.elementId, states: item.states })),
    dialogs: (page.dialogs ?? []).map((item: any) => ({ ref: item.ref, role: item.role, name: String(item.name ?? '').slice(0, 1000),
      text: String(item.text ?? '').slice(0, 2400), closeRef: item.closeRef })),
    tree: items.map((item: any) => {
      let depth = 0, parent = item.parentRef
      const seen = new Set<string>()
      while (parent && !seen.has(parent) && depth < 12) { seen.add(parent); depth++; parent = items.find((node: any) => node.ref === parent)?.parentRef }
      return `${'  '.repeat(depth)}${item.role} ${JSON.stringify(item.name)} [ref=${item.ref}]${item.controls ? ` controls=${item.controls}` : ''} ${(statesOf(item)).join(',')}`
    }).join('\n').slice(0, 36000),
    items, hiddenElementCount: all.length - visible.length, omittedElementCount: visible.length - items.length,
    omittedDialogCount: 0, omittedSelectedTabCount: 0 }
  // The tool result has a smaller budget than a normal observation. Drop the
  // duplicate tree first, then bound metadata and whole items, never half JSON.
  if (JSON.stringify(result).length > maxCharacters) {
    result.truncated = true; result.tree = ''
    result.text = result.text.slice(0, 2000)
    result.omittedDialogCount = Math.max(0, result.dialogs.length - 4); result.dialogs = result.dialogs.slice(0, 4)
    result.omittedSelectedTabCount = Math.max(0, result.selectedTabs.length - 10); result.selectedTabs = result.selectedTabs.slice(0, 10)
    let low = 0, high = items.length
    while (low < high) {
      const count = Math.ceil((low + high) / 2)
      result.items = items.slice(0, count); result.omittedElementCount = visible.length - count
      if (JSON.stringify(result).length <= maxCharacters) low = count
      else high = count - 1
    }
    result.items = items.slice(0, low); result.omittedElementCount = visible.length - low
  }
  return result
}
export const allowedTab = (tab: any, origins: readonly string[]) => {
  try { return Number.isInteger(tab.tabId) && origins.includes(new URL(tab.url).origin) } catch { return false }
}
/** 兼容网关 documentId = `${location.href}:${performance.timeOrigin}` 的通用文档标识。 */
export const frameUrl = (frame: any): string => safePageUrl(frame.url || String(frame.documentId ?? '').replace(/:\d+(?:\.\d+)?$/, ''))
export const allowedFrame = (frame: any, origins: readonly string[]) => {
  try { return Number.isInteger(frame.frameId) && frame.frameId >= 0 && origins.includes(new URL(frameUrl(frame)).origin) } catch { return false }
}
export const recoverablePageError = (error: unknown) => /\b(?:PAGE_OPERATION_RESULT_REQUIRED|ELEMENT_NOT_FOUND|ELEMENT_OCCLUDED|ELEMENT_HIDDEN|ELEMENT_DISABLED|PAGE_DIALOG_BLOCKED|ELEMENT_NOT_IN_VIEWPORT|SNAPSHOT_EXPIRED|PAGE_CHANGED|PAGE_WITHOUT_SNAPSHOT|CANDIDATE_EVIDENCE_INVALID|CANDIDATE_IDENTITY_QUOTE_INVALID|CANDIDATE_PROFILE_EVIDENCE_INVALID|CANDIDATE_PROFILE_URL_INVALID|CANDIDATE_PROFILE_ORIGIN_NOT_ALLOWED|POSITION_EVIDENCE_INVALID|TAB_NOT_OBSERVED|FRAME_NOT_OBSERVED|URL_NOT_OBSERVED|PAGE_ACTION_REPEAT_BLOCKED)\b/.test(String(error))
  && !/RESULT_UNKNOWN|OUTCOME_UNKNOWN/.test(String(error))

export interface PageNavigation {
  tabId: number
  frameId?: number
  page: any
  tabs: any[]
  frames: any[]
  origins: readonly string[]
  call(tool: string, args: Record<string, unknown>): Promise<any>
}
/** 只执行通用导航动作；候选人发送与文件入库由各自执行器控制。 */
export async function executeNavigation(action: NavigationAction, view: PageNavigation) {
  const { page, tabId, call } = view
  const locator = (ref: string) => { snapshotRef(page, ref); return { tabId, snapshotId: page.snapshotId, documentId: page.documentId, ref } }
  const observe = { wait: page.format === 'semantic' ? 'none' : 'dom_quiet', timeoutMs: 1500 }
  switch (action.action) {
    case 'click': return call('browser_click', { ...locator(action.ref), observe })
    case 'hover': return call('browser_hover', { ...locator(action.ref), settleMs: page.format === 'semantic' ? 80 : 350, observe })
    case 'type': return call('browser_type', { ...locator(action.ref), text: action.text, clear: action.clear, observe })
    case 'press_key':
      if (action.ref) await call('browser_click', locator(action.ref))
      return call('browser_press_key', { tabId, key: action.key })
    case 'select_option': return call('browser_select_option', { ...locator(action.ref), value: action.value })
    case 'scroll': return call('browser_scroll', { tabId, deltaY: action.deltaY, ...(action.ref ? locator(action.ref) : {}) })
    case 'wait': return call('browser_wait', { tabId, condition: { type: 'dom_quiet' }, timeoutMs: 10000 })
    case 'back': await call('browser_history', { tabId, action: 'back' }); view.frameId = undefined; break
    case 'switch_tab':
      if (!view.tabs.some(tab => tab.tabId === action.tabId && allowedTab(tab, view.origins))) throw new Error('TAB_NOT_OBSERVED')
      view.tabId = action.tabId; view.frameId = undefined; break
    case 'inspect_frame':
      if (!view.frames.some(frame => frame.frameId === action.frameId && allowedFrame(frame, view.origins))) throw new Error('FRAME_NOT_OBSERVED')
      view.frameId = action.frameId; break
    case 'navigate': {
      const url = safePageUrl(action.url)
      const urls = [page.url, ...view.tabs.map(tab => tab.url), ...view.frames.map(frameUrl), ...(page.items ?? []).map((item: any) => item.href)].map(safePageUrl)
      if (!url || action.url !== url || !urls.includes(url) || !view.origins.includes(new URL(url).origin)) throw new Error('URL_NOT_OBSERVED')
      await call('browser_navigate', { tabId, url }); view.frameId = undefined; break
    }
  }
}
