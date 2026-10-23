import { setTimeout as delay } from 'node:timers/promises'
import { AgentBrowserTools, type AgentBrowserCall } from './agent-browser-tools.js'
import { normalized, statesOf } from './page-actions.js'
import { hash, type Store } from './store.js'
import { platformDefinition } from './platforms/catalog.js'
import { candidateContactKeys, saveCandidateContact } from './candidate-contact.js'
import { PLATFORMS, type Platform } from '../shared/workbench.js'
import type { SourcingCandidate, CommunicationSyncResult } from '../shared/sourcing.js'

const receivedText = /^(?:已收到(?:对方)?简历|已接收简历|已交换简历|对方已(?:发送|发来)简历|收到(?:了)?(?:对方的)?简历)$/
const greetedText = /^(?:已打招呼|已沟通|继续沟通)$/
const unreadable = (item: any) => statesOf(item).some(state => ['hidden', 'invisible', 'blocked_by_dialog'].includes(state))
const readable = (item: any) => item?.ref && !unreadable(item)
const emptyText = /暂无(?:数据|简历|沟通|联系人)|没有(?:收到的简历|更多|符合)|暂时没有|已经到底|已到底|全部加载完/
const profilePath = /\/(?:resume|geek|candidate|profile)(?:[/.]|$)/i
const fields = new Map([
  ['resumeid', 'resume'], ['resid', 'resume'], ['resumeno', 'resume'],
  ['geekid', 'geek'], ['encryptgeekid', 'geek'], ['encgeekid', 'geek'],
])
const fieldKey = (key: string) => fields.get(key.replace(/[_-]/g, '').toLowerCase())
const validId = (value: string) => /^[A-Za-z0-9_-]{4,180}$/.test(value)
const personRow = (item: any) => ['article', 'listitem', 'row', 'li'].includes(item.role)
const recordText = (item: any) => normalized(item.context?.text || item.name)

/** Identity comes from explicitly named business fields or an observed profile
 * URL. A DOM widget ID and a display name never identify a platform person. */
export function communicationIdentityTokens(platform: Platform, value: { href?: string; platformIdentity?: SourcingCandidate['platformIdentity'] }, pageUrl: string) {
  const tokens: string[] = []
  if (value.platformIdentity) tokens.push(`resume:${value.platformIdentity.id}`)
  if (value.href) try {
    const url = new URL(value.href, pageUrl)
    if (!(PLATFORMS[platform].origins as readonly string[]).includes(url.origin)) return tokens
    if (profilePath.test(url.pathname) && !/\/(?:apply|list|search|recommend)\/?$/.test(url.pathname)) {
      url.hash = ''; tokens.push(`url:${url.href}`)
      for (const [key, id] of url.searchParams) if (fieldKey(key) && validId(id)) tokens.push(`${fieldKey(key)}:${id}`)
    }
  } catch { /* No observed profile identity. */ }
  return [...new Set(tokens)]
}

function within(page: any, item: any, ancestor: any) {
  const seen = new Set<string>()
  for (let node = item; node && !seen.has(node.ref); node = page.items.find((row: any) => row.ref === node.parentRef)) {
    if (node.ref === ancestor.ref) return true
    seen.add(node.ref)
  }
  return false
}
function cardScope(page: any, item: any) {
  const seen = new Set<string>(), candidates: any[] = []
  for (let node = item; node && !seen.has(node.ref); node = page.items.find((row: any) => row.ref === node.parentRef)) {
    if (['main', 'section', 'navigation', 'body', 'RootWebArea', 'dialog'].includes(node.role)) break
    seen.add(node.ref); candidates.push(node)
  }
  const row = candidates.find(personRow)
  if (row) return row
  // Button context can repeat the whole card. Choose the outermost single-
  // person container, not each nested footer button as an independent person.
  return candidates.filter(node => [...recordText(node).matchAll(/\d{2}\s*岁/g)].length === 1).at(-1)
    ?? candidates.find(node => node.context?.text && normalized(node.context.text).length < 2400) ?? item
}
export function communicationScope(page: any, platform: Platform): 'chat' | 'received_list' | undefined {
  try {
    const url = new URL(page.url)
    if (!(PLATFORMS[platform].origins as readonly string[]).includes(url.origin) || page.isLoginPage || page.dialogs?.length) return
    // 页面语义由平台自己声明；通用流程不按平台名判断路径。
    return platformDefinition(platform).communication?.scope(page)
  } catch { /* Unsupported source. */ }
}

export interface CommunicationObservation {
  identityTokens: string[]; greeted: boolean; resumeReceived: boolean
  source: 'chat' | 'received_list'; ref: string
}
/** Same-page card ownership binds each status to its profile evidence. */
export async function readCommunicationObservations(platform: Platform, page: any, broker: AgentBrowserTools,
  targets: SourcingCandidate[], signal: AbortSignal, listEvidence?: 'greeted' | 'resume_received'): Promise<CommunicationObservation[]> {
  const communication = platformDefinition(platform).communication
  const source = communicationScope(page, platform)
  if (!source) return []
  const seeds = page.items.filter((item: any) => readable(item) && !item.dialogRef && (
    item.href && communicationIdentityTokens(platform, item, page.url).some(token => !token.startsWith('url:') || targets.some(target => target.profileUrl && token === `url:${target.profileUrl}`))
    || targets.some(target => normalized(item.name) === normalized(target.name))
    || /\d{2}\s*岁/.test(recordText(item))
    || personRow(item)))
  const result: CommunicationObservation[] = [], visited = new Set<string>()
  for (const seed of seeds) {
    const root = cardScope(page, seed)
    if (visited.has(root.ref)) continue
    visited.add(root.ref)
    // A shared multi-person container is never a candidate evidence scope.
    if ([...recordText(root).matchAll(/\d{2}\s*岁/g)].length > 1) continue
    const members = page.items.filter((item: any) => readable(item) && within(page, item, root))
    const identityTokens: string[] = members.flatMap((item: any) => communicationIdentityTokens(platform, item, page.url))
    await broker.inspectRefs(page, [seed.ref], signal, true, true)
    const inspection = broker.getInspection(page, seed.ref)
    const inspectedNodes = [inspection?.element, ...(inspection?.ancestors ?? [])]
    const receivedCard = !!communication?.receivedWrapper
      && inspectedNodes.some(node => String(node?.attributes?.class ?? '').split(/\s+/).includes(communication.receivedWrapper!))
    for (const node of inspectedNodes) {
      if (!node || ['body', 'html', 'main'].includes(node.tagName)) break
      const attrs = node.attributes ?? {}, before = identityTokens.length
      for (const [key, raw] of Object.entries(attrs)) {
        if (!key.startsWith('data-')) continue
        const kind = fieldKey(key.slice(5)), value = String(raw)
        if (kind && validId(value)) identityTokens.push(`${kind}:${value}`)
      }
      // 平台自己声明的包装类/节点语义；通用代码不解析具体类名。
      for (const token of communication?.identity?.(node, source) ?? []) identityTokens.push(token)
      if (identityTokens.length > before) break
    }
    if (!identityTokens.length) continue
    // A common ancestor containing different business IDs is a list, not a
    // person's record. It cannot lend one person's receipt to another.
    if (['resume', 'geek'].some(kind => new Set(identityTokens.filter(token => token.startsWith(`${kind}:`))).size > 1)) continue
    result.push({ identityTokens: [...new Set(identityTokens)], source, ref: root.ref,
      greeted: listEvidence === 'greeted' && !receivedCard || members.some((item: any) => greetedText.test(normalized(item.name))),
      resumeReceived: source === 'received_list' || listEvidence === 'resume_received' && !receivedCard || members.some((item: any) => receivedText.test(normalized(item.name))) })
  }
  return result
}

/** Input allowlist for a status read: no messages, greetings, requests, file
 * downloads or platform business mutations can pass through this broker. */
export function assertCommunicationRead(call: AgentBrowserCall, page: any) {
  if (call.readOnly && ['browser_snapshot', 'browser_list_tabs', 'browser_inspect_element', 'browser_read_observation'].includes(call.name)) return
  if (call.readOnly && call.name === 'browser_wait' && call.args.condition?.type === 'dom_quiet') return
  if (['browser_navigate', 'browser_scroll', 'browser_open_tab', 'browser_close_tab'].includes(call.name) && call.purpose !== 'business_write') return
  if (call.name === 'browser_click' && call.purpose !== 'business_write') {
    const item = page?.items?.find((item: any) => item.ref === call.args.ref)
    if (item && readable(item) && /^(?:全部|全部沟通|我发起的|我发起|有简历|已收简历|收到简历|下一页)$/.test(normalized(item.name))) return
  }
  throw new Error('COMMUNICATION_SYNC_READ_ONLY: 状态同步只能读取和切换列表，不能发送或索要简历')
}
async function selectedFilter(broker: AgentBrowserTools, page: any, item: any, signal: AbortSignal) {
  if (statesOf(item).some(state => ['selected', 'checked', 'current'].includes(state))) return true
  await broker.inspectRefs(page, [item.ref], signal, true, true)
  const detail = broker.getInspection(page, item.ref)
  return [detail?.element, ...(detail?.ancestors ?? []).slice(0, 2)].some(node =>
    String(node?.attributes?.class ?? '').split(/\s+/).some(token => /(?:^|[-_])(?:checked|selected|active)$/.test(token)))
}

export async function syncPlatformCommunication(broker: AgentBrowserTools, platform: Platform, candidates: SourcingCandidate[],
  store: Store, signal: AbortSignal): Promise<CommunicationSyncResult['platforms'][number] & { updated: number }> {
  const targets = candidates.filter(candidate => candidate.platform === platform)
  const targetTokens = new Map<SourcingCandidate, Set<string>>(targets.map(target => [target,
    new Set(communicationIdentityTokens(platform, { href: target.profileUrl, platformIdentity: target.platformIdentity }, PLATFORMS[platform].url))]))
  if (![...targetTokens.values()].some(tokens => tokens.size)) return { platform, matched: 0, updated: 0, detail: '候选人缺少可匹配的平台标识，未按姓名推断，已有状态保留' }
  const facts = new Map(targets.map(target => [candidateContactKeys(target)[0]!, { greeted: target.communication === 'recorded', resumeReceived: !!target.resumeReceived }]))
  const complete = () => [...facts.values()].every(row => row.greeted && row.resumeReceived)
  const matched = new Set<string>(), updated = new Set<string>(); let sourceCount = 0, partial = false
  const communication = platformDefinition(platform).communication
  // 缺能力时明确失败，不让通用流程在未知页面上静默返回“未匹配”。
  if (!communication?.entries.length) throw new Error(`PLATFORM_CAPABILITY_UNSUPPORTED: ${platform} 尚未声明沟通列表入口`)
  const entries = communication.entries
  const existingTabs = (await broker.tools.find(tool => tool.name === 'browser_list_tabs')!.execute({}, signal) as any).tabs ?? []
  const origin = new URL(PLATFORMS[platform].url).origin
  const existing = existingTabs.filter((tab: any) => { try { return new URL(tab.url).origin === origin } catch { return false } })
  if (existing.length > 1 && existing.filter((tab: any) => tab.active).length !== 1) throw new Error('COMMUNICATION_SYNC_TAB_AMBIGUOUS: 请保留一个目标平台页面或切到需要同步的页面')
  let tab = existing.find((tab: any) => tab.active) ?? existing[0], created = false
  const restoreUrl = tab?.url
  let navigationUnknown = false, restoreFailed = false
  const execute = async (name: string, args: Record<string, unknown>) => broker.tools.find(tool => tool.name === name)!.execute(args, signal)
  try {
    if (!tab) { const opened: any = await execute('browser_open_tab', { url: entries[0] }); tab = { tabId: opened.tabId }; created = true }
    for (const entry of entries) {
      if (complete()) break
      await execute('browser_navigate', { tabId: tab.tabId, url: entry })
      if (broker.tools.some(tool => tool.name === 'browser_wait')) await execute('browser_wait', { tabId: tab.tabId, condition: { type: 'dom_quiet' }, timeoutMs: 3000 })
      let page: any
      for (let attempt = 0; attempt < 20; attempt++) {
        page = (await execute('browser_snapshot', { tabId: tab.tabId, format: 'dom', viewportOnly: true }) as any)
        page = broker.currentPage()
        if (page.isLoginPage) throw new Error('COMMUNICATION_SYNC_LOGIN_REQUIRED: 请先完成平台登录或验证')
        const filtersSettled = page.items.some((item: any) => readable(item) && ['全部', '全部沟通'].includes(normalized(item.name)) && !statesOf(item).includes('occluded'))
        const hasRecords = /\d{2}\s*岁/.test(page.text ?? '') || page.items.some((item: any) => readable(item) &&
          (personRow(item) || item.href && communicationIdentityTokens(platform, item, page.url).some(token => !token.startsWith('url:')) || targets.some(target => normalized(item.name) === normalized(target.name))))
        if (communicationScope(page, platform) && (hasRecords || filtersSettled && emptyText.test(page.text ?? ''))) break
        if (attempt < 19) await delay(200, undefined, { signal })
      }
      const source = communicationScope(page, platform)
      if (!source) { partial = true; continue }
      sourceCount++
      const views: ('all' | 'greeted' | 'resume_received')[] = source === 'chat' ? ['all', 'greeted', 'resume_received'] : ['all']
      for (const view of views) {
        if (view === 'greeted' && [...facts.values()].every(row => row.greeted) || view === 'resume_received' && [...facts.values()].every(row => row.resumeReceived)) continue
        page = broker.currentPage()
        const filterNames = view === 'greeted' ? ['我发起的', '我发起'] : view === 'resume_received' ? ['有简历', '已收简历', '收到简历'] : source === 'chat' ? ['全部', '全部沟通'] : []
        if (filterNames.length) {
          const filters = page.items.filter((item: any) => readable(item) && filterNames.includes(normalized(item.name))
            && !page.items.some((parent: any) => parent !== item && readable(parent) && normalized(parent.name) === normalized(item.name) && within(page, item, parent)))
          if (filters.length !== 1) { partial = true; if (view !== 'all') continue }
          else {
            let control = filters[0]
            if (!await selectedFilter(broker, page, control, signal)) {
              // During Liepin's initial layout the filter is above its final
              // position and covered by the header. Wait for reachable DOM
              // controls; the AX radio is a zero-size, non-interactive input.
              const name = normalized(control.name), role = control.role
              for (let attempt = 0; statesOf(control).includes('occluded') && attempt < 10; attempt++) {
                await delay(200, undefined, { signal })
                await execute('browser_snapshot', { tabId: page.tabId, format: 'dom', viewportOnly: true })
                page = broker.currentPage()
                const fresh = page.items.filter((item: any) => readable(item) && item.role === role && normalized(item.name) === name)
                if (fresh.length !== 1) break
                control = fresh[0]
              }
              if (statesOf(control).includes('occluded')) { partial = true; continue }
              if (!statesOf(control).some(state => ['selected', 'checked', 'current'].includes(state))) {
                try { await execute('browser_click', { tabId: page.tabId, snapshotId: page.snapshotId, ref: control.ref, purpose: 'navigation' }) }
                catch (error) {
                  if (!/^(?:Error: )?(?:McpError: )?(?:PAGE_CHANGED|SNAPSHOT_EXPIRED|ELEMENT_NOT_FOUND)\b/.test(String(error))) throw error
                  // These are explicit pre-dispatch rejections. Read once and
                  // rebind the same filter; ambiguous inputs are never retried.
                  const name = normalized(control.name), role = control.role
                  await execute('browser_snapshot', { tabId: page.tabId, format: page.format, viewportOnly: true })
                  page = broker.currentPage()
                  const fresh = page.items.filter((item: any) => readable(item) && item.role === role && normalized(item.name) === name)
                  if (fresh.length !== 1 || !communicationScope(page, platform)) { partial = true; continue }
                  control = fresh[0]
                  if (!statesOf(control).some(state => ['selected', 'checked', 'current'].includes(state))) {
                    await execute('browser_click', { tabId: page.tabId, snapshotId: page.snapshotId, ref: control.ref, purpose: 'navigation' })
                  }
                }
              }
              await execute('browser_snapshot', { tabId: page.tabId, format: 'dom', viewportOnly: true })
            }
            page = broker.currentPage()
            const fresh = page.items.filter((item: any) => readable(item) && normalized(item.name) === normalized(filters[0].name))
            let selected = false
            for (const item of fresh) if (await selectedFilter(broker, page, item, signal)) { selected = true; break }
            if (view !== 'all' && !selected) { partial = true; continue }
          }
        }
        let previous = '', repeats = 0
        for (let screen = 0; screen < 12; screen++) {
          page = broker.currentPage()
          if (!communicationScope(page, platform)) { partial = true; break }
          let observations: CommunicationObservation[]
          try { observations = await readCommunicationObservations(platform, page, broker, targets, signal, view === 'all' ? undefined : view) }
          catch (error) {
            if (!/\b(?:PAGE_CHANGED|SNAPSHOT_EXPIRED|ELEMENT_NOT_FOUND)\b/.test(String(error))) throw error
            await execute('browser_snapshot', { tabId: page.tabId, format: 'dom', viewportOnly: true })
            page = broker.currentPage()
            observations = await readCommunicationObservations(platform, page, broker, targets, signal, view === 'all' ? undefined : view)
          }
          for (const observation of observations) {
            const matches = targets.filter(target => observation.identityTokens.some(token => targetTokens.get(target)!.has(token)))
            // An observation exposing conflicting IDs is ambiguous, even when
            // two candidates have the same display name or profile text.
            const identities = new Set(matches.map(target => [...targetTokens.get(target)!].sort().join('|')))
            if (!matches.length || identities.size !== 1 || !observation.greeted && !observation.resumeReceived) continue
            for (const target of matches) {
              if (await saveCandidateContact(store, target, observation)) updated.add(candidateContactKeys(target)[0]!)
              const key = candidateContactKeys(target)[0]!
              matched.add(key)
              const state = facts.get(key)!
              state.greeted ||= observation.greeted; state.resumeReceived ||= observation.resumeReceived
            }
          }
          if (complete() || !observations.length && emptyText.test(page.text ?? '')) break
          const signature = hash(observations.map(row => row.identityTokens.slice().sort()).sort())
          repeats = signature === previous ? repeats + 1 : 0; previous = signature
          if (repeats >= 1 || !observations.length) { partial = true; break }
          const next = page.items.filter((item: any) => readable(item) && normalized(item.name) === '下一页' && !statesOf(item).includes('disabled'))
          if (next.length === 1) await execute('browser_click', { tabId: page.tabId, snapshotId: page.snapshotId, ref: next[0].ref, purpose: 'navigation' })
          else await execute('browser_scroll', { tabId: page.tabId, snapshotId: page.snapshotId, ref: observations.at(-1)!.ref, deltaY: Math.floor((page.viewport?.height ?? 700) * 0.6), purpose: 'navigation' })
          await execute('browser_snapshot', { tabId: page.tabId, format: 'dom', viewportOnly: true })
          if (screen === 11) partial = true
        }
      }
    }
  } catch (error) {
    navigationUnknown = /OUTCOME_UNKNOWN|RESULT_UNKNOWN/.test(String(error)); throw error
  } finally {
    if (!navigationUnknown) {
      if (created && tab) await broker.tools.find(tool => tool.name === 'browser_close_tab')?.execute({ tabId: tab.tabId, purpose: 'navigation' }, AbortSignal.timeout(5000)).catch(() => { restoreFailed = true })
      else if (restoreUrl && tab) await broker.tools.find(tool => tool.name === 'browser_navigate')?.execute({ tabId: tab.tabId, url: restoreUrl, purpose: 'navigation' }, AbortSignal.timeout(5000)).catch(() => { restoreFailed = true })
    }
  }
  return { platform, matched: matched.size, updated: updated.size, detail: (!sourceCount ? '未识别到可读取的聊天或收到简历列表，已有状态保留' : partial ? '已同步可匹配记录；列表尚未读取完整，未匹配人选保持原状态' : '已同步平台可匹配记录') + (restoreFailed ? '；页面未能自动恢复，请手动返回' : '') }
}
