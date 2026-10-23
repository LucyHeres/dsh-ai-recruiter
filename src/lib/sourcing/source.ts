import type { SourcingJob } from '../../shared/sourcing.js'
import type { RecruitmentPlatform } from '../platforms/types.js'
import type { AgentBrowserCall } from '../agent-browser-tools.js'
import type { AgentBrowserTools } from '../agent-browser-tools.js'
import type { BrowserAgentSeed } from '../browser-agent.js'
import { normalized } from '../page-actions.js'

export const sourcingMode = (job: Pick<SourcingJob, 'sourceMode'>) => job.sourceMode ?? 'recommend'
export function sourcingEntry(platform: RecruitmentPlatform, job: Pick<SourcingJob, 'sourceMode'>) {
  if (sourcingMode(job) === 'recommend') return platform.sourcingEntry
  if (!platform.sourcingSearchEntry) throw new Error('SOURCING_SEARCH_UNSUPPORTED: 当前平台尚未适配主动搜索，请使用人才推荐寻聘')
  return platform.sourcingSearchEntry
}
export function isSourcingEntry(url: unknown, entry: string): boolean {
  try {
    const actual = new URL(String(url)), expected = new URL(entry)
    return actual.origin === expected.origin && actual.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '')
      && [...expected.searchParams].every(([key, value]) => actual.searchParams.get(key) === value)
  } catch { return false }
}
/** 别名识别同一推荐来源内的 iframe 文档，启动入口仍使用外层页面。 */
export function isSourcingDocument(url: unknown, entry: string, aliases: readonly string[] = []): boolean {
  return [entry, ...aliases].some(candidate => isSourcingEntry(url, candidate))
}
export function assertRecommendationPage(page: any, entry: string, aliases: readonly string[] = []) {
  if (!isSourcingDocument(page?.url, entry, aliases) || page?.isLoginPage) throw new Error('SOURCING_RECOMMENDATION_REQUIRED: 请进入人才推荐页并核对目标职位；本轮不会自动转到人才搜索')
}
/** A unique already-observed platform tab can return to the configured entry
 * without spending a model turn. Ambiguous tabs and authentication stay with
 * the agent; navigation failures are never blindly replayed here. */
export async function bootstrapSourcing(broker: AgentBrowserTools, entry: string, recommendation: boolean, signal: AbortSignal, aliases: readonly string[] = []): Promise<BrowserAgentSeed[]> {
  const seeds = await broker.bootstrap(undefined, signal, entry)
  if (!recommendation) return seeds
  const page = broker.currentPage()
  if (isSourcingEntry(page?.url, entry) || page?.frameId && isSourcingDocument(page.url, entry, aliases) || page?.isLoginPage) return seeds
  let name: string | undefined, args: Record<string, unknown> = {}
  if (page) {
    try {
      if (new URL(page.url).origin === new URL(entry).origin) { name = 'browser_navigate'; args = { tabId: page.tabId, url: entry, purpose: 'navigation' } }
    } catch { return seeds }
  } else {
    const listed = seeds.find(seed => seed.name === 'browser_list_tabs')?.value as any
    const tabs = Array.isArray(listed) ? listed : listed?.tabs
    if (Array.isArray(tabs) && !tabs.some(tab => { try { return new URL(tab.url).origin === new URL(entry).origin } catch { return false } })) {
      name = 'browser_open_tab'; args = { url: entry, purpose: 'navigation' }
    }
  }
  const tool = broker.tools.find(tool => tool.name === name)
  if (!tool) return seeds
  return [...seeds.filter(seed => seed.name === 'browser_list_tabs'), { name: tool.name, args, value: await tool.execute(args, signal) }]
}
/** Check the observed destination before dispatch, including AI recovery. A
 * fallback changes navigation ownership, never the authorized source. */
export function assertRecommendationNavigation(call: AgentBrowserCall, page: any, entry: string, frameEntries: readonly string[] = []) {
  if (call.readOnly) return
  const target = page?.items?.find((item: any) => item.ref === call.args.ref)
  const destination = call.name === 'browser_open_tab' || call.name === 'browser_navigate' ? call.args.url : target?.href
  if (destination) {
    let url: URL | undefined
    try { url = new URL(destination, page?.url ?? entry) } catch { /* Generic URL policy reports malformed URLs. */ }
    if (url && frameEntries.some(frame => isSourcingEntry(url!.href, frame))) {
      throw new Error('SOURCING_FRAME_NAVIGATION_FORBIDDEN: 请在原推荐页内读取 iframe，不能将推荐文档单独打开到顶层')
    }
    if (url && /(?:^|\/)(?:search|talent-search|resume-search)(?:\/|$)/i.test(url.pathname)) {
      throw new Error('SOURCING_RECOMMENDATION_REQUIRED: 本轮仅从人才推荐寻聘，禁止跳转人才搜索')
    }
  }
  const label = normalized(target?.name)
  if (/^(?:人才搜索|搜索人才|搜人才|搜索简历|搜简历)$/.test(label)
    || call.name === 'browser_type' && /关键词|关键字|搜索人才|搜人才|人才搜索/.test(normalized([target?.name, target?.placeholder].join(' ')))) {
    throw new Error('SOURCING_RECOMMENDATION_REQUIRED: 请选择推荐页的招聘职位，不进行关键词搜人才')
  }
}
