import type { AgentBrowserCall } from '../../agent-browser-tools.js'
import { samePositionComponent } from '../../position-controls.js'
import { StandardPositionRoute } from '../types.js'
import { bossDocumentSelector, bossDocumentUrl, bossPositionMenu } from './search-evidence.js'

/** Shared by model recovery and the fixed route, so either cannot toggle an
 * already open menu or reset its retry budget by receiving new refs. */
export class BossPositionRoute extends StandardPositionRoute {
  private readonly opened = new Set<string>()
  async dispatch(call: AgentBrowserCall, page: any, dispatch: () => Promise<any>) {
    if (call.name !== 'browser_click' || !page) return dispatch()
    const selector = bossDocumentSelector(page), target = page.items?.find((item: any) => item.ref === call.args.ref)
    if (!selector || !target || !samePositionComponent(page, selector, target)) return dispatch()
    if (bossPositionMenu(page)) throw new Error('SOURCING_POSITION_MENU_OPEN: 职位菜单已展开，请选择菜单内的目标职位，不要再点击顶部开关')
    const key = JSON.stringify([page.tabId, bossDocumentUrl(page), selector.name])
    if (this.opened.has(key)) throw new Error('SOURCING_POSITION_SELECTION_STALLED: 同一职位菜单已打开过且职位未变化，请读取菜单选项或停止，不能重复开关')
    const result = await dispatch()
    this.opened.add(key)
    return result
  }
}
