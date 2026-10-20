import { PLATFORMS, type Platform } from '../shared/workbench.js'

type Call = (tool: string, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>

export const platformOrigin = (platform: Platform) => new URL(PLATFORMS[platform].url).origin

/**
 * 只读用户已经打开的平台页签。
 *
 * 平台（尤其 BOSS）会把同一账号重复打开发起登录校验，甚至判定为异常登录。因此
 * 插件不得为了探测状态而主动新开平台页面，只能复用用户自己的页签。
 */
export async function findPlatformTab(call: Call, platform: Platform, policy: Record<string, unknown>, signal?: AbortSignal): Promise<number | undefined> {
  const origin = platformOrigin(platform)
  const listed = await call('browser_list_tabs', { policy }, signal).catch(() => undefined)
  const tabs = Array.isArray(listed?.tabs) ? listed.tabs : []
  const match = tabs.find((tab: any) => {
    if (!Number.isInteger(tab?.tabId)) return false
    try { return new URL(String(tab.url)).origin === origin } catch { return false }
  })
  return match?.tabId
}
