import type { AgentBrowserCall } from '../../agent-browser-tools.js'
import { normalized, statesOf } from '../../page-actions.js'

export const LIEPIN_POSITION_ROUTE = '猎聘人才搜索：从顶部大搜索框最左侧的“不限职位”下拉触发器选择 platformJobs 对应的招聘职位。下方单独一行的“职位 / 搜索职位名称 / 全部职位”是候选人简历职位筛选，不是招聘职位选择器，不能在这里填写本轮职位名。先调用 sourcing_inspect_search 核对当前职位和筛选状态；顶部当前职位已正确时直接复用，不重复打开下拉。需要切换时打开顶部下拉，读取新快照，再选目标职位；如需检索，只能使用该顶部下拉面板内部的搜索框。选中目标后，若面板仍展开，点击该招聘职位面板内部的“确定”提交；已勾选的目标不要重复点击。然后核对关闭下拉后的顶部当前职位，再设置期望城市、经验、学历，点击顶部搜索并核验结果。城市、学历选项可为 label/StaticText，不能因没有 option 角色就放弃；sourcing_inspect_search 返回宿主核验的所属筛选行和真实选中状态。仅使用当前活动组件里的确定按钮，搜索筛选确认属于 navigation，不是 business_write。不要点击下拉组件隐藏的内部 input；应从当前快照选择可见触发器或展示文字，不确定时只读 inspect 并读取 DOM 快照。'
export const LIEPIN_RECOMMENDATION_ROUTE = '猎聘人才推荐：只在 entryUrl 对应的人才推荐页寻聘，不进入人才搜索，也不套用人才搜索页的顶部大搜索框路径。优先选择推荐页的对应招聘职位标签；按目标职位名称唯一匹配并核验选中状态；platformJobs 关联 ID 仅在页面明确提供业务 ID 时辅助核对，不能从 DOM 元素 ID 推断，已正确选中的职位和筛选直接复用。更多职位或筛选只操作当前快照中的真实控件；先 sourcing_inspect_search 核对。筛选生效且职位已确认后直接读取推荐卡片，不为寻聘而填写主关键词或点击搜索人才。推荐页布局变化时重新观察和核验；推荐耗尽时引用真实末尾提示结束，不转搜索。'

const editable = (item: any) => ['input', 'textarea'].includes(String(item?.tagName).toLowerCase()) || ['textbox', 'searchbox'].includes(item?.role)
const readable = (item: any) => !statesOf(item).some(state => ['hidden', 'invisible', 'blocked_by_dialog'].includes(state))

/** Scope plain-text job choices to a successfully opened recruiting-position
 * menu. A job name elsewhere on the page is never enough to authorize a click. */
export class LiepinPositionRoute {
  private menu?: { tabId: number; documentId?: string; snapshotId: string; trigger: any }
  private selector?: LiepinPositionRoute['menu']
  constructor(private readonly names: string[], private readonly hints = LIEPIN_POSITION_ROUTE) {}

  private trigger(item: any): boolean {
    return readable(item) && !editable(item) && (normalized(item?.name) === '不限职位'
      || this.names.includes(normalized(item?.name)) && (item?.hasPopup || item?.role === 'combobox'))
  }
  private samePage(call: AgentBrowserCall, page: any) {
    return this.menu && this.menu.tabId === call.args.tabId && (!this.menu.documentId || this.menu.documentId === page?.documentId)
  }
  private inMenu(call: AgentBrowserCall, page: any, item: any): boolean {
    if (!this.samePage(call, page)) return false
    const trigger = this.menu!.trigger
    const controls = Array.isArray(trigger.controls) ? trigger.controls : String(trigger.controls ?? '').split(/\s+/)
    const seen = new Set<string>()
    for (let node = item; node?.ref && !seen.has(node.ref); node = page.items?.find((row: any) => row.ref === node.parentRef)) {
      seen.add(node.ref)
      if ((page.snapshotId === this.menu!.snapshotId && node.ref === trigger.ref) || (trigger.elementId && node.elementId === trigger.elementId)
        || controls.some((id: string) => id && (id === node.ref || id === node.elementId))) return true
    }
    return false
  }
  assertInput(call: AgentBrowserCall, page: any) {
    if (call.readOnly || !['browser_click', 'browser_hover', 'browser_type', 'browser_select_option', 'browser_press_key'].includes(call.name)) return
    const target = page?.items?.find((item: any) => item.ref === call.args.ref)
    if (!target || this.inMenu(call, page, target)) return
    const label = normalized([target.name, target.placeholder, target.description].filter(Boolean).join(' '))
    if (editable(target) && /职位|岗位|职能/.test(label)) throw new Error(`SOURCING_POSITION_ROUTE_REQUIRED: ${this.hints}`)
  }
  allowsChoice(call: AgentBrowserCall, page: any): boolean {
    if (!['browser_click', 'browser_hover'].includes(call.name)) return false
    const item = page?.items?.find((row: any) => row.ref === call.args.ref)
    return !!item && readable(item) && !editable(item) && !item.href && (this.trigger(item) || this.isSelectedTrigger(call.args.tabId, page, item.ref)
      || !!this.samePage(call, page) && this.names.includes(normalized(item.name)))
  }
  isSelectedTrigger(tabId: number, page: any, ref: string): boolean {
    const anchor = this.selector, item = page?.items?.find((row: any) => row.ref === ref)
    if (this.menu || !anchor || anchor.tabId !== tabId || anchor.documentId && anchor.documentId !== page?.documentId
      || !item || !readable(item) || editable(item) || item.href || statesOf(item).includes('expanded')
      || !['button', 'combobox', 'div', 'span', 'generic', 'StaticText', 'text'].includes(item.role)
      || !this.names.includes(normalized(item.name || item.value))) return false
    if (anchor.trigger.elementId && item.elementId === anchor.trigger.elementId) return true
    if (page.snapshotId === anchor.snapshotId && ref === anchor.trigger.ref) return true
    // A custom select may expose only its display span, without an AX selected
    // state. Require the currently observed target text at the original trigger
    // location; the clicked menu option or text typed into another row cannot pass.
    const a = anchor.trigger.bounds, b = item.bounds
    return !!a && !!b && [a.x, a.y, a.width, a.height, b.x, b.y, b.width, b.height].every(Number.isFinite)
      && a.width > 0 && b.width > 0 && a.height > 0 && b.height > 0
      && Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.height - b.height) <= 2
  }
  async dispatch(call: AgentBrowserCall, page: any, dispatch: () => Promise<any>, verifiedTrigger = false) {
    if (call.readOnly) return dispatch()
    const item = page?.items?.find((row: any) => row.ref === call.args.ref)
    const opens = ['browser_click', 'browser_hover'].includes(call.name) && item
      && (verifiedTrigger || this.trigger(item) || this.isSelectedTrigger(call.args.tabId, page, item.ref))
    // Inputs can close menus or change focus; failures must not authorize a
    // later click using a stale open-menu assumption.
    const prior = this.menu
    const keepsMenu = call.name === 'browser_type' && item && this.inMenu(call, page, item)
    this.menu = undefined
    const result = await dispatch()
    if (opens) {
      this.menu = { tabId: call.args.tabId, documentId: page?.documentId, snapshotId: page.snapshotId, trigger: structuredClone(item) }
      this.selector = this.menu
    }
    else if (keepsMenu) this.menu = prior
    return result
  }
}
