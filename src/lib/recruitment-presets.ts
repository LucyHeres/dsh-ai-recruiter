import { createHash } from 'node:crypto'
import type { AgentBrowserTools } from './agent-browser-tools.js'
import type { BrowserAgentOptions, BrowserAgentResult, BrowserAgentSeed } from './browser-agent.js'
import type { BrowserAgentRunner } from './host-browser-agent.js'
import { readCandidate } from './candidate-entry.js'
import { findPositionEvidence, type PositionEvidence, type PositionVerification } from './position-evidence.js'
import { positionChoices, positionControl, positionNameMatches } from './position-controls.js'
import { itemText, normalized, safePageUrl, statesOf } from './page-actions.js'
import { safeError } from './task-error.js'
import { browserFailureCode } from './browser-errors.js'
import { greetingEntry, type GreetingJob, type WorkbenchJob } from '../shared/workbench.js'
import { greetingLabels, completedGreetingLabels as completedLabels } from './recruitment-controls.js'
import { platformDefinition } from './platforms/catalog.js'

type Current = { name: string; dispatched: boolean } | undefined
type Step = { name: string; args: Record<string, any> }
type Entry = { item: any; name: string; identity: string }
type Dependencies = { broker: AgentBrowserTools; job: WorkbenchJob; current: () => Current; agent: () => BrowserAgentRunner; ready?: () => boolean }
const downloadLabel = /^(?:下载(?:附件)?简历|下载附件|附件下载|下载原始?简历|下载)$/
const previewLabel = /^(?:预览附件|查看附件|附件简历|查看简历|预览简历|预览)$/
const readable = (item: any) => item.ref && !statesOf(item).some(state => ['hidden', 'invisible', 'blocked_by_dialog'].includes(state))
const actionable = (item: any) => readable(item) && !statesOf(item).includes('disabled')
const label = (item: any) => normalized(item.name)
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const single = <T>(items: T[]): T | undefined => items.length === 1 ? items[0] : undefined
const identity = (text: string) => {
  if (new Set([...text.matchAll(/[\u4e00-\u9fa5A-Za-z·]{1,12}(?:先生|女士|同学)/g)].map(match => match[0])).size > 1) return undefined
  const body = text.replace(/^(?:(?:在线|离线|活跃|刚刚活跃|今天活跃|今日活跃|近期活跃)\s+)+/, '')
  return readCandidate(body, 'button').candidate
}
const contains = (outer: any, inner: any) => outer && inner
  && [outer.x, outer.y, outer.width, outer.height, inner.x, inner.y, inner.width, inner.height].every(Number.isFinite)
  && outer.width > 0 && outer.height > 0 && inner.width > 0 && inner.height > 0
  && outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height

function related(page: any, target: any, card: any, useContext = true) {
  if (target.ref === card.ref || contains(card.bounds, target.bounds)) return true
  if (useContext && card.context?.text && normalized(card.context.text) === normalized(target.context?.text)) return true
  const seen = new Set<string>()
  let parent = target.parentRef
  while (parent && !seen.has(parent)) {
    if (parent === card.ref) return true
    seen.add(parent)
    parent = page.items.find((item: any) => item.ref === parent)?.parentRef
  }
  return false
}

function entries(page: any): Entry[] {
  return page.items.filter((item: any) => readable(item) && ['article', 'listitem', 'row', 'button', 'link', 'div', 'li', 'cell'].includes(item.role))
    .flatMap((item: any) => {
      const candidate = identity(normalized(item.name)) ?? identity(normalized(item.context?.text))
      return candidate ? [{ item, name: candidate.name, identity: candidate.identity }] : []
    })
}

function belongs(page: any, item: any, name: string, cards: Entry[]) {
  const own = identity(normalized(item.context?.text)) ?? identity(label(item))
  if (own) return own.name === name
  const owners = cards.filter(card => related(page, item, card.item))
  return owners.length > 0 && owners.every(card => card.name === name)
}

function unambiguous(page: any, cards: Entry[], name: string) {
  const candidates = cards.filter(card => card.name === name)
  if (candidates.length < 2) return true
  const roots = candidates.filter(card => ['article', 'listitem', 'row'].includes(card.item.role))
  const connected = new Set([candidates[0]])
  const remaining = new Set(candidates.slice(1))
  for (const source of connected) for (const candidate of remaining) {
    const sharedIdentity = roots.length === 1 && source.identity === candidate.identity && (!source.item.bounds || !candidate.item.bounds)
    if (sharedIdentity || related(page, source.item, candidate.item, false) || related(page, candidate.item, source.item, false)) {
      connected.add(candidate); remaining.delete(candidate)
    }
  }
  const ages = candidates.flatMap(card => /\d{2}\s*岁/.exec(card.identity)?.[0].replace(/\s/g, '') ?? [])
  return remaining.size === 0 && new Set(ages).size <= 1
}

function onScreen(page: any, item: any) {
  const bounds = item.bounds, viewport = page.viewport
  if (!bounds || !viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) return true
  const centerX = bounds.x + bounds.width / 2, centerY = bounds.y + bounds.height / 2
  return bounds.width > 0 && bounds.height > 0 && centerX >= 0 && centerX < viewport.width && centerY >= 0 && centerY < viewport.height
}

/** 参数校验失败的字段路径与规则；只含 schema 路径，不含页面或用户内容。 */
function presetFailureDetail(error: unknown) {
  const issues = (error as { validationIssues?: unknown } | null)?.validationIssues
  if (!Array.isArray(issues) || !issues.length) return undefined
  return issues.slice(0, 6).map((issue: any) => `${issue?.path || '/'}:${issue?.keyword ?? 'invalid'}`)
}

function log(options: BrowserAgentOptions, event: string, fields: Record<string, unknown>) {
  try { options.logger?.write('info', event, fields) } catch {}
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

class PlatformPreset {
  private readonly attempted = new Set<string>()
  private readonly inspected = new Set<string>()
  private readonly selected = new Set<string>()
  private returnToList = false
  private listUrl?: string
  private writeSnapshot?: string
  private writeTarget?: { document: unknown; item: any }
  private steps = 0
  private completedImports = 0
  private readonly loadingPolls = new Map<string, number>()
  private readonly hoveredTriggers = new Set<string>()
  private readonly notedPositions = new Set<string>()
  private reason = 'unrecognized_state'
  /** 连续相同原因 + 相同页面即视为没有推进：预设与模型都不该在这里反复空转。 */
  private paused?: { reason: string; signature: string; repeats: number }
  private static readonly MAX_IDENTICAL_PAUSES = 3
  /** 模型无法解决的暂停原因：立即停止并给出可操作结论，而不是交给模型重试。 */
  private static readonly TERMINAL_REASONS = new Set(['duplicate_target_jobs'])
  /**
   * 只有「预设自己识别不了、且模型同样识别不了」的停滞才计入收敛。
   * unrecognized_state / tool_failed / 搜索准备等本来就该由模型多轮处理，不能提前终止。
   */
  private static readonly CONVERGENCE_REASONS = new Set(['position_unverified', 'repeated_step'])
  constructor(private readonly dependencies: Dependencies, private readonly options: BrowserAgentOptions) {}
  private startup(): Step | undefined {
    const { job } = this.dependencies
    const entry = new URL(greetingEntry(job as GreetingJob))
    if (job.kind === 'resume_import') entry.pathname = new URL(platformDefinition(job.platform).receivedEntry).pathname
    const seed = this.options.initialToolResults?.find(seed => seed.name === 'browser_list_tabs')
    const value = seed?.value as any
    if (!value) { this.reason = 'tab_observation_missing'; return }
    const tabs: any[] = (Array.isArray(value) ? value : value.tabs ?? []).map((tab: any) => ({ ...tab, tabId: tab.tabId ?? tab.id }))
      .filter((tab: any) => { try { return Number.isInteger(tab.tabId) && new URL(tab.url).origin === entry.origin } catch { return false } })
    const matches = tabs.filter(tab => new URL(tab.url).pathname === entry.pathname)
    const selected = tabs.find(tab => tab.tabId === job.tabId) ?? single(matches) ?? single(matches.filter(tab => tab.active))
      ?? (!matches.length ? single(tabs) ?? single(tabs.filter(tab => tab.active)) : undefined)
    if (selected) return { name: 'browser_snapshot', args: { tabId: selected.tabId } }
    if (!tabs.length) return { name: 'browser_open_tab', args: { url: entry.href, purpose: 'navigation' } }
    this.reason = 'platform_tabs_ambiguous'
  }
  private position(page: any): PositionEvidence | undefined {
    const job = this.dependencies.job as GreetingJob
    if (!job.jobId) return undefined
    const [found] = findPositionEvidence(page, job)
    if (!found) return undefined
    this.notePosition(found)
    return { ref: found.ref, ...(found.platformJobId ? { platformJobId: found.platformJobId } : {}) }
  }
  /** 降级通过必须留痕：只记一次每文档级别，不记录页面原文。 */
  private notePosition(verification: PositionVerification) {
    if (verification.level !== 'degraded') return
    const key = `${verification.ref}:${verification.level}`
    if (this.notedPositions.has(key)) return
    this.notedPositions.add(key)
    log(this.options, 'recruitment.position_evidence', { level: verification.level, reason: verification.reason,
      platformJobId: verification.platformJobId })
  }
  private positionStep(page: any): Step | undefined {
    const job = this.dependencies.job as GreetingJob
    const items: any[] = Array.isArray(page?.items) ? page.items : []
    const targets = job.platformJobs?.length ? job.platformJobs : [{ name: job.jobName, id: '' }]
    const alias = platformDefinition(job.platform).positionAlias
    const named = items.filter((item: any) => actionable(item) && positionControl(page, item) && !statesOf(item).some(state => ['selected', 'checked', 'current'].includes(state)) && ['tab', 'option', 'menuitem'].includes(item.role)
      && targets.some(target => positionNameMatches(page, item, target.name || '', alias)))
    const choices = positionChoices(page, named, targets, job.selectedPlatformJob?.id, alias)
    const option = single(choices)
    if (option) return this.input(page, option, 'browser_click')
    // A unique name is enough; multiple same-name jobs need observed business
    // evidence. A widget's dynamic DOM ID cannot resolve the user's intent.
    if (named.length > 1 || named.length && targets.filter(target => named.some(item => positionNameMatches(page, item, target.name || '', alias))).length > 1) {
      this.reason = 'duplicate_target_jobs'; return
    }
    const trigger = single(items.filter((item: any) => actionable(item) && (item.role === 'combobox'
      || /^(?:切换职位|选择职位|全部职位|更多职位)$/.test(label(item))) && (item.hasPopup || item.role === 'combobox')))
    if (trigger) {
      // 有些门户 click 展开、有些 hover 展开。按稳定身份记住已 hover 过的触发器，
      // 第二次仍未展开时改用一次 click，而不是重复 hover 或直接交棒。
      const key = `${safePageUrl(page.url)}|${trigger.elementId ?? ''}|${label(trigger)}`
      if (this.hoveredTriggers.has(key)) return this.input(page, trigger, 'browser_click')
      this.hoveredTriggers.add(key)
      return this.input(page, trigger, 'browser_hover')
    }
  }
  /** 只有声明了 frameId 的工具才接受它；0（顶层）与未声明都不传。 */
  private acceptsFrameId(name: string) {
    const schema: any = this.options.tools.find(tool => tool.name === name)?.inputSchema
    return schema?.properties?.frameId !== undefined
  }
  private locator(page: any, name: string, ref: string) {
    return { tabId: page.tabId, snapshotId: page.snapshotId, ref,
      ...(page.frameId && this.acceptsFrameId(name) ? { frameId: page.frameId } : {}) }
  }
  private input(page: any, item: any, name = 'browser_click', purpose = 'navigation'): Step {
    return { name, args: { ...this.locator(page, name, item.ref), purpose } }
  }
  private reveal(page: any, item: any): Step | undefined {
    const bounds = item.bounds, viewport = page.viewport
    if (!bounds || !viewport || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))
      || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.height <= 0
      || bounds.width <= 0 || bounds.height <= 0) return
    const centerX = bounds.x + bounds.width / 2, centerY = bounds.y + bounds.height / 2
    if (centerX < 0 || centerX >= viewport.width || (centerY >= 0 && centerY < viewport.height)) return
    return { name: 'browser_scroll', args: { ...this.locator(page, 'browser_scroll', item.ref),
      deltaY: Math.max(-650, Math.min(650, Math.round(centerY - viewport.height / 2))), purpose: 'navigation' } }
  }
  private inspect(page: any, items: any[]): Step | undefined {
    const item = items.find(item => !this.inspected.has(`${page.snapshotId}:${item.ref}`))
    if (item) return { name: 'browser_inspect_element', args: { tabId: page.tabId, snapshotId: page.snapshotId, ref: item.ref } }
  }
  private dom(page: any): Step | undefined {
    const snapshot = this.options.tools.find(tool => tool.name === 'browser_snapshot')
    const format = (snapshot?.inputSchema.properties as any)?.format
    if (page.format === 'semantic' && format && (!format.enum || format.enum.includes('dom'))) {
      return { name: 'browser_snapshot', args: { tabId: page.tabId, format: 'dom',
        ...(page.frameId === undefined ? {} : { frameId: page.frameId }) } }
    }
  }
  private next(page: any): Step | undefined {
    const { job, current } = this.dependencies
    this.reason = 'unrecognized_state'
    if (!page?.snapshotId || !Array.isArray(page.items)) return this.startup()
    const entry = new URL(greetingEntry(job as GreetingJob))
    let url: URL
    try { url = new URL(page.url) } catch { return }
    if (url.origin !== entry.origin || page.isLoginPage || /login|passport|captcha|verify/i.test(url.pathname)) { this.reason = 'platform_or_login_boundary'; return }
    if (job.kind === 'greeting' && current() && url.pathname !== entry.pathname) { this.reason = 'unsupported_greeting_page'; return }
    const readinessKey = `${page.tabId}:${url.pathname}`
    if (page.items.length <= 1 && !normalized(page.text)
      && page.items.every((item: any) => ['RootWebArea', 'WebArea', 'document'].includes(item.role) || !label(item))) {
      this.reason = 'page_loading'
      // browser_wait 在网关里是只读能力（不产生页面改动），schema 不接受 purpose。
      // 传了会被参数校验直接拒绝，预设随即以 tool_failed 交棒——这正是「新开标签页
      // 首屏必定失败、永远进不了预设」的根因。
      if ((this.loadingPolls.get(readinessKey) ?? 0) < 5) return { name: 'browser_wait', args: { tabId: page.tabId,
        condition: { type: 'time', delayMs: 400 }, timeoutMs: 2500 } }
      return
    }
    const pending = current()
    const base = { tabId: page.tabId, snapshotId: page.snapshotId }
    const items: any[] = page.items.filter(readable)
    const cards = entries(page)
    if (pending && !unambiguous(page, cards, pending.name)) { this.reason = 'candidate_ambiguous'; return }
    if (pending?.dispatched) {
      if (this.writeSnapshot === page.snapshotId) return { name: 'browser_snapshot', args: { tabId: page.tabId } }
      const paid = (page.dialogs ?? []).some((dialog: any) => /购买|支付|付费|权益|超级聊聊|开通|充值/.test(`${dialog.name} ${dialog.text}`))
      if (paid) { this.reason = 'paid_foreground'; return }
      const evidence = items.filter((item: any) => completedLabels.has(label(item)) && belongs(page, item, pending.name, cards))
      const toast = items.filter((item: any) => ['status', 'alert'].includes(item.role) && /^(?:打招呼成功|招呼已发送|发送成功|沟通成功)[！!。]?$/.test(label(item)))
      const result = evidence[0] ?? single(toast)
      if (result) return { name: 'task_report_result', args: { ...base, outcome: 'completed', evidenceRefs: [result.ref], reason: '平台预设核对到当前候选人的发送完成证据' } }
      const controls = items.filter((item: any) => completedLabels.has(label(item)))
      const previous = this.writeTarget
      const sameDocument = previous?.document === (page.documentId ?? page.url)
      const matching = previous && sameDocument ? controls.filter((item: any) => previous.item.elementId
        ? item.elementId === previous.item.elementId
        : previous.item.bounds && item.bounds && ['x', 'y', 'width', 'height'].every(key => item.bounds[key] === previous.item.bounds[key])) : []
      const inspect = single(matching) ?? single(controls)
      if (inspect) return this.inspect(page, [inspect])
      this.reason = 'greeting_result_unverified'
      return
    }
    if ((page.dialogs ?? []).length) {
      if (job.kind === 'greeting' && !pending) {
        const dialog = single<any>(page.dialogs)
        if (dialog && /相似候选人/.test(`${dialog.name} ${dialog.text}`) && /免费开聊/.test(`${dialog.name} ${dialog.text}`)
          && !/购买|支付|充值/.test(`${dialog.name} ${dialog.text}`)) {
          const close = dialog.closeRef && items.find((item: any) => item.ref === dialog.closeRef && actionable(item))
          if (close) return this.input(page, close)
          return { name: 'browser_press_key', args: { tabId: page.tabId, key: 'Escape', purpose: 'navigation' } }
        }
      }
      if (job.kind === 'resume_import' && !pending) {
        const dialog = single<any>(page.dialogs)
        const close = dialog?.closeRef && items.find((item: any) => item.ref === dialog.closeRef && actionable(item))
        if (dialog && /简历|附件|预览/.test(`${dialog.name} ${dialog.text}`)) {
          if (close) return this.input(page, close)
          return { name: 'browser_press_key', args: { tabId: page.tabId, key: 'Escape', purpose: 'navigation' } }
        }
      }
      if (!pending || job.kind === 'greeting') { this.reason = 'foreground_present'; return }
    }
    const listPath = job.kind === 'greeting' ? entry.pathname : new URL(platformDefinition(job.platform).receivedEntry).pathname
    if (!pending && url.pathname !== listPath) {
      if (!this.returnToList && !platformDefinition(job.platform).listPaths.includes(url.pathname)) return
      return { name: 'browser_navigate', args: { tabId: page.tabId, url: this.returnToList && this.listUrl ? this.listUrl : `${entry.origin}${listPath}`, purpose: 'navigation' } }
    }
    if (job.kind === 'greeting') {
      if (this.dependencies.ready?.() === false) { this.reason = 'search_setup_required'; return }
      const position = this.position(page)
      if ((job as GreetingJob).jobId && !position) {
        this.reason = 'position_unverified'
        return (pending ? undefined : this.positionStep(page)) ?? this.dom(page)
      }
      const buttons = items.filter((item: any) => actionable(item) && onScreen(page, item) && ['button', 'link'].includes(item.role) && greetingLabels(job.platform).has(label(item)))
      const matches = buttons.flatMap((item: any) => {
        const own = identity(normalized(item.context?.text))
        const owners = cards.filter(card => related(page, item, card.item))
        const owner = own ? { item, name: own.name, identity: own.identity } : owners.length && owners.every(card => card.name === owners[0]!.name)
          ? owners.slice().sort((first, second) => first.identity.length - second.identity.length)[0] : undefined
        return owner && !/付费|购买|消耗.*权益|超级聊聊|支付|充值/.test(itemText(item)) ? [{ ...owner, button: item }] : []
      })
      if (pending) {
        const match = single(matches.filter(match => match.name === pending.name))
        return match ? this.input(page, match.button, 'browser_click', 'business_write') : undefined
      }
      if (matches.some(match => !unambiguous(page, cards, match.name))) { this.reason = 'candidate_ambiguous'; return }
      const match = matches.find(match => !this.selected.has(match.identity)
        || job.results.some(row => row.name === match.name && row.stage === 'skipped' && row.retryable))
      if (match) {
        const profile = items.find((item: any) => item.role === 'link' && item.href && belongs(page, item, match.name, [match])
          && related(page, item, match.item) && normalized(itemText(item)).includes(match.name))
        return { name: 'task_select_candidate', args: { ...base, ref: match.button.ref, name: match.name,
          evidenceRefs: match.item.ref === match.button.ref ? [] : [match.item.ref],
          ...(profile ? { profileRef: profile.ref } : {}), ...(position ? { position } : {}) } }
      }
      const inspection = this.inspect(page, buttons.filter((item: any) => !matches.some(match => match.button.ref === item.ref)))
      if (inspection) return inspection
      if (buttons.some(item => !matches.some(match => match.button.ref === item.ref))) { this.reason = 'candidate_identity_unreadable'; return }
    } else if (pending) {
      const context = cards.filter(card => card.name === pending.name)
      const inDetail = context.length > 0 && cards.every(card => card.name === pending.name)
      const dialog = single<any>(page.dialogs ?? [])
      const identity = dialog && items.find((item: any) => item.ref === dialog.ref
        && normalized(itemText(item)).replace(/\s/g, '').includes(pending.name.replace(/\s/g, '')))
      const inDialog = (item: any) => identity && (item.dialogRef === dialog.ref || related(page, item, identity, false))
      const attachments = items.filter((item: any) => actionable(item) && ['button', 'link'].includes(item.role) && downloadLabel.test(label(item))
        && (inDialog(item) || belongs(page, item, pending.name, cards) || (inDetail && new Set(cards.map(card => card.name)).size <= 1)))
      const attachment = single(attachments)
      if (attachment) {
        if (!onScreen(page, attachment)) { this.reason = 'attachment_outside_viewport'; return this.reveal(page, attachment) }
        return { name: 'task_import_attachment', args: { ...base, ref: attachment.ref,
          ...(inDialog(attachment) ? { evidenceRefs: [identity.ref] } : {}) } }
      }
      const previews = items.filter((item: any) => actionable(item) && ['button', 'link', 'tab'].includes(item.role) && previewLabel.test(label(item))
        && (inDialog(item) || belongs(page, item, pending.name, cards) || (inDetail && new Set(cards.map(card => card.name)).size <= 1)))
      const preview = single(previews)
      if (preview) return onScreen(page, preview) ? this.input(page, preview) : this.reveal(page, preview)
      const selected = context.filter(card => actionable(card.item) && label(card.item).includes(pending.name)
        && ['button', 'link', 'article', 'listitem', 'row', 'div', 'li'].includes(card.item.role))
        .sort((first, second) => Number(!['button', 'link'].includes(first.item.role)) - Number(!['button', 'link'].includes(second.item.role))
          || first.identity.length - second.identity.length)[0]
      if (selected && url.pathname === listPath && !(page.dialogs ?? []).length) return this.input(page, selected.item)
      return this.dom(page)
    } else {
      const receivedTab = platformDefinition(job.platform).receivedTab
      if (receivedTab) {
        const received = single(items.filter((item: any) => actionable(item) && item.role === 'tab' && label(item) === receivedTab))
        if (received && !statesOf(received).includes('selected') && !(page.selectedTabs ?? []).some((tab: any) => normalized(tab.name) === receivedTab)) return this.input(page, received)
        if (!received && !(page.selectedTabs ?? []).some((tab: any) => normalized(tab.name) === receivedTab)) { this.reason = 'received_tab_unverified'; return this.dom(page) }
      }
      if (this.dependencies.ready?.() === false) { this.reason = 'source_position_unverified'; return this.dom(page) }
      this.returnToList = false
      if (cards.some(card => !unambiguous(page, cards, card.name))) return
      const card = cards.find(card => actionable(card.item) && onScreen(page, card.item) && !this.selected.has(card.identity))
      if (card) return { name: 'task_select_candidate', args: { ...base, ref: card.item.ref, name: card.name } }
      if (!cards.length) return this.dom(page)
    }
    if (!pending && cards.length) {
      const next = single(items.filter((item: any) => actionable(item) && ['button', 'link'].includes(item.role) && /^(?:下一页|下页)$/.test(label(item))))
      if (next) return this.input(page, next)
      if (!page.truncated && /(?:暂无更多(?:人才|简历)|没有更多(?:人才|简历)|已加载全部)/.test(normalized(page.text))) {
        return { name: 'task_finish', args: { reason: '平台列表已明确显示没有更多待处理候选人' } }
      }
      const anchor = cards.filter(card => onScreen(page, card.item)).at(-1)
      if (anchor) return { name: 'browser_scroll', args: { tabId: page.tabId, deltaY: 650,
        snapshotId: page.snapshotId, ref: anchor.item.ref, purpose: 'navigation' } }
    }
  }
  record(step: Step, page: any) {
    if (!page?.snapshotId) return
    const target = page.items.find((item: any) => item.ref === step.args.ref)
    if (step.name === 'task_select_candidate') {
      const candidate = entries(page).find(card => card.name === step.args.name
        && (card.item.ref === step.args.ref || related(page, target, card.item)))
      if (candidate) this.selected.add(candidate.identity)
      this.listUrl = safePageUrl(page.url)
    }
    if (step.args.purpose === 'business_write') {
      this.writeSnapshot = page.snapshotId
      this.writeTarget = { document: page.documentId ?? page.url, item: target }
    }
    if (step.name === 'task_import_attachment') this.returnToList = true
  }
  async run(signal: AbortSignal): Promise<BrowserAgentSeed[]> {
    const seeds: BrowserAgentSeed[] = []
    let failedTool: string | undefined, errorCode: string | undefined, failedDetail: unknown
    while (!this.options.isComplete?.() && this.steps < 40 + this.dependencies.job.limit * 16) {
      signal.throwIfAborted()
      if (this.dependencies.job.kind === 'resume_import') {
        const completed = this.dependencies.job.results.filter(row => ['succeeded', 'failed', 'skipped'].includes(row.stage)).length
        if (completed > this.completedImports) this.returnToList = true
        this.completedImports = completed
      }
      const page = this.dependencies.broker.currentPage()
      const step = this.next(page)
      if (!step) break
      const tool = this.options.tools.find(tool => tool.name === step.name)
      if (!tool) { this.reason = 'tool_unavailable'; break }
      const target = page?.items.find((item: any) => item.ref === step.args.ref)
      const readinessKey = page && `${page.tabId}:${new URL(page.url).pathname}`
      // 刻意不哈希整页 items：那是一份逐元素快照，任何无关文案变化都会改写签名，
      // 于是同一步骤看似「没做过」而被反复执行。改用页面身份 + 元素数量（真实推进
      // 会改变它）+ 目标自身身份，既允许进展后重试，也能识别原地打转。
      const signature = hash([step.name, this.pageIdentity(page), (page?.items ?? []).length,
        step.args.tabId, step.args.url, step.args.name, step.args.purpose, step.args.outcome,
        step.name === 'browser_wait' ? this.loadingPolls.get(readinessKey) ?? 0 : undefined,
        target && [target.role, itemText(target), target.elementId, target.href, statesOf(target).slice().sort().join(',')],
        this.progressKey()])
      if (this.attempted.has(signature)) { this.reason = 'repeated_step'; break }
      this.attempted.add(signature); this.steps++
      const started = Date.now()
      try {
        const value = await tool.execute(step.args, signal)
        seeds.push({ ...step, value })
        if (step.name === 'browser_wait') this.loadingPolls.set(readinessKey, (this.loadingPolls.get(readinessKey) ?? 0) + 1)
        if (step.name === 'browser_inspect_element') this.inspected.add(`${page.snapshotId}:${step.args.ref}`)
        this.record(step, page)
        log(this.options, 'recruitment.preset_step', { platform: this.dependencies.job.platform,
          kind: this.dependencies.job.kind, tool: step.name, durationMs: Date.now() - started })
        if (!this.dependencies.current() && seeds.length > 16) seeds.splice(0, seeds.length - 16)
      } catch (error) {
        signal.throwIfAborted()
        if (this.options.isFatal?.(error) || /OUTCOME_UNKNOWN|RESULT_UNKNOWN|TASK_STORAGE_UNAVAILABLE|TASK_(?:DAILY_)?LIMIT_REACHED/.test(String(error))) throw error
        let recovery: unknown
        try { recovery = await tool.recover?.(error, step.args, signal) } catch { signal.throwIfAborted() }
        seeds.push({ ...step, isError: true, value: { error: { message: safeError(error) }, recovery,
          note: '平台预设未完成此操作，请根据当前状态处理；不得重放结果未知的输入。' } })
        if (step.name === 'task_select_candidate' && /TASK_DUPLICATE_BLOCKED|RESUME_CANDIDATE_ALREADY_PROCESSED/.test(String(error))) {
          const candidate = entries(page).find(card => card.name === step.args.name && (card.item.ref === step.args.ref || related(page, target, card.item)))
          if (candidate) { this.selected.add(candidate.identity); continue }
        }
        this.reason = 'tool_failed'
        failedTool = step.name; errorCode = browserFailureCode(error) ?? 'PRESET_TOOL_ERROR'
        // 只记错误码是不够的：参数校验类失败必须带上具体字段路径，否则排障只能靠猜
        // （真实事故：连续两轮只看到 BROWSER_ARGUMENT_INVALID，无法知道是哪个参数）。
        failedDetail = presetFailureDetail(error)
        break
      }
    }
    if (!this.options.isComplete?.()) {
      const page = this.dependencies.broker.currentPage()
      log(this.options, 'recruitment.preset_paused', { reason: this.reason, elementCount: page?.items?.length ?? 0,
        candidateCount: page ? entries(page).length : 0, format: page?.format, dialogCount: page?.dialogs?.length ?? 0,
        truncated: !!page?.truncated, hasCoverage: !!page?.coverage, failedTool, errorCode,
        ...(failedDetail === undefined ? {} : { failedDetail }) })
      this.observePause(page, errorCode)
    }
    return seeds
  }
  /**
   * 同一暂停原因在未变化的页面上重复出现，说明预设与模型都没有推进。
   * 到阈值就停止并给出可操作结论，而不是继续「预设试一次 → 交棒模型」的空转。
   */
  /**
   * 页面身份：只描述「还是不是同一个页面、前景有没有变」。刻意不含逐元素快照，
   * 也不含元素数量——无关文案滚动、时间戳刷新、列表轻微增减都不该被当成推进。
   */
  private pageIdentity(page: any) {
    const items: any[] = Array.isArray(page?.items) ? page.items : []
    return hash([safePageUrl(page?.url), page?.documentId,
      (page?.dialogs ?? []).map((dialog: any) => [dialog.ref, label(dialog)]),
      items.filter((item: any) => statesOf(item).some(state => ['hidden', 'invisible', 'blocked_by_dialog'].includes(state))).length])
  }
  private progressKey() {
    return [this.dependencies.current(), this.dependencies.job.results.map(row => [row.key, row.stage])]
  }
  private observePause(page: any, errorCode: string | undefined) {
    if (PlatformPreset.TERMINAL_REASONS.has(this.reason)) {
      throw new Error(`PRESET_POSITION_AMBIGUOUS: 平台存在多个同名职位关联，无法自动确定发送职位（${this.reason}）；`
        + '未执行任何发送。请在平台确认目标职位，或在工作台指定平台职位后重试')
    }
    if (!PlatformPreset.CONVERGENCE_REASONS.has(this.reason)) { this.paused = undefined; return }
    const signature = hash([this.reason, errorCode ?? '', this.pageIdentity(page), this.progressKey()])
    if (this.paused?.reason === this.reason && this.paused.signature === signature) {
      this.paused.repeats += 1
    } else {
      this.paused = { reason: this.reason, signature, repeats: 1 }
    }
    if (this.paused.repeats >= PlatformPreset.MAX_IDENTICAL_PAUSES) {
      throw new Error(`PRESET_NO_PROGRESS: 页面连续 ${this.paused.repeats} 次停在「${this.reason}」且没有任何变化，已停止空转；`
        + '请核对平台页面或在工作台确认职位后重试')
    }
  }
}

export async function runRecruitmentAgent(options: BrowserAgentOptions, dependencies: Dependencies): Promise<BrowserAgentResult> {
  const deadline = new AbortController()
  const duration = options.maxDurationMs ?? 30 * 60 * 1000
  const timer = setTimeout(() => deadline.abort(new Error('BROWSER_AGENT_DURATION_BUDGET')), duration)
  const signal = AbortSignal.any([options.signal, deadline.signal])
  const started = Date.now()
  try {
    const preset = new PlatformPreset(dependencies, options)
    const seeds = await untilAborted(preset.run(signal), signal)
    if (options.isComplete?.()) return { status: 'completed', message: '平台预设已完成目标', turns: 0, modelMs: 0, toolMs: Date.now() - started }
    log(options, 'recruitment.ai_handoff', { platform: dependencies.job.platform, kind: dependencies.job.kind })
    if (seeds.length) await options.onProgress?.('平台预设遇到未识别状态，AI 正在处理页面变化')
    const toolMs = Date.now() - started
    let firstTurn = true
    const tools = options.tools.map(tool => ({ ...tool, execute: async (args: Record<string, unknown>, executionSignal: AbortSignal) => {
      let page = dependencies.broker.currentPage()
      if (args.tabId) try { page = dependencies.broker.getPage(Number(args.tabId), args.snapshotId == null ? undefined : String(args.snapshotId)) } catch { page = undefined }
      const value = await tool.execute(args, executionSignal)
      preset.record({ name: tool.name, args }, page)
      return value
    } }))
    const result = await dependencies.agent()({ ...options, signal, maxDurationMs: Math.max(1, duration - toolMs),
      tools,
      initialToolResults: [...(options.initialToolResults ?? []), ...seeds],
      goal: { ...options.goal, presetProgress: { results: dependencies.job.results, current: dependencies.current() ?? null } },
      beforeTurn: async turnSignal => {
        const seeds = firstTurn ? [] : await preset.run(turnSignal)
        firstTurn = false
        return options.isComplete?.() ? seeds : [...seeds, ...(await options.beforeTurn?.(turnSignal) ?? [])]
      } })
    return { ...result, toolMs: result.toolMs + toolMs }
  } finally { clearTimeout(timer) }
}
