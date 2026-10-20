import { setTimeout as delay } from 'node:timers/promises'
import { PLATFORMS, type Platform } from '../shared/workbench.js'
import { findPlatformTab } from './platform-tabs.js'
import type { LoginClassifier } from './login-planner.js'

type Call = (tool: string, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>

const STALE_EXTENSION = '浏览器扩展连接已失效：请在 Chrome 打开 chrome://extensions，重新加载「薪招」扩展（或重启 Chrome）后重试'

/** 扩展的 service worker 被 Chrome 挂起后，网关会返回 PLUGIN_TOOL_PIPELINE_ERROR。 */
const isPipelineError = (error: unknown) =>
  /PLUGIN_TOOL_PIPELINE_ERROR/.test(String((error as { message?: unknown } | undefined)?.message ?? error ?? ''))

/** 「去登录」是用户显式动作，允许新开页面；自愈一次以应对扩展瞬时失效。 */
async function openPlatformTab(call: Call, platform: Platform, policy: Record<string, unknown>, signal?: AbortSignal) {
  const open = () => call('browser_open_tab', { url: PLATFORMS[platform].url, policy }, signal)
  try {
    return (await open())?.tabId
  } catch (error) {
    if (!isPipelineError(error)) throw error
  }
  await call('browser_ensure', { timeoutSeconds: 20 }, signal).catch(() => undefined)
  return (await open())?.tabId
}

/**
 * 首选方案：让扩展在后台用既有 cookie 直接请求平台用户信息接口，全程不开页面，
 * 因此不会触发平台的重复登录校验。扩展未提供该能力（旧版）时返回 undefined 交由调用方回退。
 */
async function detectByChannelSession(call: Call, platform: Platform, signal?: AbortSignal) {
  try {
    const result = await call('browser_channel_login', {
      platform, policy: { allowedOrigins: [...PLATFORMS[platform].origins], riskLevel: 'read' }
    }, signal)
    if (typeof result?.loggedIn !== 'boolean') return undefined
    const who = [result.accountName, result.companyName].filter(Boolean).join(' · ')
    return result.loggedIn
      ? { status: 'logged_in', detail: who ? `已登录：${who}` : '已登录' }
      : { status: 'logged_out', detail: '当前平台未登录，请完成登录后刷新' }
  } catch (error) {
    if (signal?.aborted) throw error
    return undefined
  }
}

/**
 * 判定平台登录状态。
 *
 * 自动检测优先走无页签的渠道请求；不可用时才回退到页面快照。回退路径遵循：
 * 触发平台重复登录校验的是「同一账号同时存在多个平台页面」，所以已有同源页签
 * 只读复用它、绝不新开；完全没有时才新开一个——此时不存在重复会话，是安全的。
 * 用户自己的页签永不被关闭。
 */
export async function detectPlatformLogin(call: Call, platform: Platform, open: boolean, signal?: AbortSignal, classify?: LoginClassifier) {
  const policy = { allowedOrigins: [...PLATFORMS[platform].origins], riskLevel: 'browser_mutation' }
  let tabId: number | undefined
  let owned = false
  try {
    // 「去登录」需要把平台页面呈现给用户，故只走页签路径。
    if (!open) {
      const session = await detectByChannelSession(call, platform, signal)
      if (session) return session
    }
    const existing = await findPlatformTab(call, platform, policy, signal)
    if (existing) {
      tabId = existing
      owned = false
      // 用户显式点「去登录」时，把已有页签导航到目标页；自动检测只读、不打扰用户页面。
      if (open) await call('browser_navigate', { tabId: existing, url: PLATFORMS[platform].url, policy }, signal)
    } else {
      // 没有已打开的同源页签时新开不会造成重复登录，可以安全新建。
      tabId = await openPlatformTab(call, platform, policy, signal)
      owned = true
    }
    if (!Number.isInteger(tabId) || !tabId) throw new Error('平台页面未成功打开')
    for (let attempt = 0; attempt < 12; attempt++) {
      signal?.throwIfAborted()
      const page = await call('browser_snapshot', { tabId, viewportOnly: true, policy }, signal)
      const text = String(page.text ?? '')
      if (page.isLoginPage) return { status: 'logged_out', detail: '当前平台未登录，请完成登录后刷新' }
      if (text.trim() && classify) return await classify(page, platform, signal)
      await delay(500, undefined, { signal })
    }
    return { status: 'unknown', detail: '页面未提供明确登录状态，请打开平台完成加载或验证后刷新' }
  } catch (error) {
    // Never surface the raw pipeline code; it is not actionable for the user.
    if (isPipelineError(error)) throw new Error(STALE_EXTENSION)
    throw error
  } finally {
    // 只关闭本次探测新开的页面；用户自己的页签永远保留。
    if (tabId && owned && !open) await call('browser_close_tab', { tabId, policy }).catch(() => undefined)
  }
}
