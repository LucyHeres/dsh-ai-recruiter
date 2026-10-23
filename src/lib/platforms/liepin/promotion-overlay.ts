import { setTimeout as delay } from 'node:timers/promises'
import type { AgentBrowserTools } from '../../agent-browser-tools.js'
import { normalized, statesOf } from '../../page-actions.js'
import { SourcingBrowser, SourcingHandoff } from '../../sourcing/browser.js'

const hasClass = (node: any, name: string) => String(node?.attributes?.class ?? '').split(/\s+/).includes(name)
export const LIEPIN_PROMOTION_GUIDANCE = '遇到推广遮罩先关闭最上层弹窗，再操作背景职位或列表。推广层可能没有dialogs，图标名为close-circle，父级adslot-sdk-dialog-close可能没有文字；先inspect核对其广告层祖先，再点击图标或对应关闭容器。不要将被遮挡的通知关闭按钮、候选人标签叉号当作当前遮罩关闭入口，不点查看特权或立即查看。关闭后读取新快照确认并继续固定流程；不能反复点击仍被遮挡的背景控件。'

const visible = (item: any, page: any, actionable: boolean) => item?.ref && !statesOf(item).some(state =>
  ['hidden', 'invisible', 'blocked_by_dialog', 'disabled', ...(actionable ? ['occluded'] : [])].includes(state))
  && item.bounds?.width > 0 && item.bounds.width <= 64 && item.bounds.height > 0 && item.bounds.height <= 64
  && item.bounds.x >= 0 && item.bounds.y >= 0 && item.bounds.x + item.bounds.width <= page.viewport?.width
  && item.bounds.y + item.bounds.height <= page.viewport?.height

/** Observed Liepin ad-slot close ownership. The blank div and its close-circle
 * icon may be clicked; the surrounding advertising link is never a close. */
export function liepinPromotionClose(page: any, ref: string, broker: AgentBrowserTools): string | undefined {
  try { if (new URL(page.url).origin !== 'https://lpt.liepin.com') return } catch { return }
  const detail = broker.getInspection(page, ref)
  if (!detail?.element || detail.element.visible === false) return
  const nodes = [detail.element, ...(detail.ancestors ?? [])]
  const owner = nodes.find(node => hasClass(node, 'adslot-sdk-dialog-close'))
  if (!owner || !nodes.some(node => hasClass(node, 'adslot-sdk-dialog-content'))
    || !nodes.some(node => hasClass(node, 'adslot-sdk-dialog-container') && node.visible !== false)) return
  const closeRef = owner === detail.element ? ref : owner.ref
  return page.items?.some((item: any) => item.ref === closeRef) ? closeRef : undefined
}

async function promotionCloses(browser: SourcingBrowser, actionable = true) {
  const page = browser.page()
  const icons = (page.items ?? []).filter((item: any) => visible(item, page, actionable) && /^close-circle$/i.test(normalized(item.name)))
  const refs = [...new Set<string>(icons.flatMap((item: any) => [item.ref, ...(item.parentRef ? [item.parentRef] : [])]))]
  if (!refs.length) return []
  await browser.broker.inspectRefs(page, refs, browser.signal, true, true)
  return [...new Set(refs.map(ref => liepinPromotionClose(page, ref, browser.broker)).filter((ref): ref is string => !!ref))]
}

/** Close a known promotional layer once, then verify with fresh observations.
 * Standard dialogs, candidate drawers and notification dismissals are separate. */
export async function dismissLiepinPromotion(browser: SourcingBrowser, progress?: (message: string) => Promise<void>) {
  const closes = await promotionCloses(browser)
  if (!closes.length) return false
  if (closes.length !== 1) throw new SourcingHandoff('liepin_promotion_close_ambiguous')
  await progress?.('识别到猎聘推广弹窗，正在关闭后继续寻聘')
  await browser.click(closes[0])
  for (const ms of [0, 100, 200, 400]) {
    if (ms) await delay(ms, undefined, { signal: browser.signal })
    await browser.snapshot('dom', true)
    if (!(await promotionCloses(browser, false)).length && !browser.page().truncated) {
      await progress?.('猎聘推广弹窗已关闭，正在继续读取候选人列表')
      return true
    }
  }
  throw new Error('LIEPIN_PROMOTION_CLOSE_UNCONFIRMED: 推广弹窗关闭后仍可见，已停止且未重复点击关闭控件')
}
