import { setTimeout as delay } from 'node:timers/promises'
import { SourcingBrowser, SourcingHandoff, requireSingle } from '../../sourcing/browser.js'
import type { SourcingCard, SourcingDriver, SourcingDriverContext, ResumeLocator, SearchConfirmation } from '../../sourcing/types.js'
import { findPositionEvidence } from '../../position-evidence.js'
import { positionBusinessIds, positionChoices, positionControl, positionNameMatches } from '../../position-controls.js'
import { bossDocumentSelector, bossDocumentTitle, bossDocumentUrl, bossPositionMenu, bossPositionChoices, isBossRecommendationDocument, verifyBossDocumentPosition } from './search-evidence.js'
import { readCandidate } from '../../candidate-entry.js'
import { assertCandidateQuote } from '../../candidate-evidence.js'
import { frameUrl, normalized, statesOf } from '../../page-actions.js'
import { hash } from '../../store.js'
import { bossDefinition } from './definition.js'
import { isSourcingDocument, isSourcingEntry } from '../../sourcing/source.js'
import type { GreetingJob } from '../../../shared/workbench.js'
import { BossResumeDriver } from './resume-driver.js'
import { bossCandidateTextIdentity } from './candidate-identity.js'

const readable = (item: any) => item.ref && !statesOf(item).some(state => ['hidden', 'invisible', 'blocked_by_dialog'].includes(state))
const visible = (item: any, page: any) => readable(item) && (!item.bounds || !page.viewport
  || item.bounds.width > 0 && item.bounds.height > 0 && item.bounds.y < page.viewport.height && item.bounds.y + item.bounds.height > 0)
const endLabel = /^(?:没有更多|暂无.*(?:人才|牛人|简历|结果)|没有符合|已.*最后一页)/
const labels = new Set([...bossDefinition.greetingLabels, '继续沟通', '已沟通'])
const positionTriggers = /^(?:切换职位|选择职位|全部职位|更多职位|招聘职位|职位)$/

/** BOSS recommendation's fixed route: job tab/selector -> card name -> resume
 * dialog -> its own close -> next card. No model locates normal steps,
 * no site API or injected write, and no coordinates/old refs are persisted. */
export class BossSourcingDriver implements SourcingDriver {
  private readonly browser: SourcingBrowser
  private readonly positionJob: GreetingJob
  private readonly resumes: BossResumeDriver
  private readonly entryAliases = bossDefinition.sourcingEntryAliases ?? []
  private view?: { page: any; cards: SourcingCard[] }
  private opened?: SourcingCard
  private previous?: string
  private stalled = 0
  private readonly positionAttempts = new Set<string>()
  constructor(private readonly context: SourcingDriverContext) {
    this.browser = new SourcingBrowser(context.broker, context.signal)
    this.resumes = new BossResumeDriver(context)
    this.positionJob = { ...context.job, kind: 'greeting', platform: 'boss', platformJobs: context.job.platformJobs?.boss } as unknown as GreetingJob
  }
  private page() {
    const page = this.browser.page()
    if (!isSourcingDocument(page.url, bossDefinition.sourcingEntry, this.entryAliases) || page.isLoginPage) throw new SourcingHandoff('boss_source_page_changed')
    return page
  }
  async recognizes() {
    const page = this.context.broker.currentPage()
    return (isSourcingDocument(page?.url, bossDefinition.sourcingEntry, this.entryAliases) || this.resumes.ownsPage(page)) && !page?.isLoginPage
  }
  private targets() {
    return this.context.job.platformJobs?.boss?.length ? this.context.job.platformJobs.boss : [{ id: '', name: this.context.job.jobName || '' }]
  }
  private listReady(page: any) {
    if (!page?.snapshotId || !Array.isArray(page.items)) return false
    if (findPositionEvidence(page, this.positionJob)[0]) return true
    const items = page.items.filter((item: any) => visible(item, page))
    if (items.some((item: any) => ['tab', 'option', 'menuitem'].includes(item.role)
      && this.targets().some(target => positionNameMatches(page, item, target.name || '')))) return true
    if (items.some((item: any) => labels.has(normalized(item.name))
      && readCandidate(item.context?.text, 'button').candidate)) return true
    return items.some((item: any) => endLabel.test(normalized(item.name)))
  }
  /** 推荐文档依赖外层页面。只读取原页面内的帧，不能把它单独导航到顶层。 */
  private async prepareRecommendationList() {
    let page = this.page()
    if (this.onEntryDocument(page)) {
      this.requireFrameInteraction(page)
      return this.awaitRecommendationList()
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) {
        await delay(450, undefined, { signal: this.context.signal })
        page = await this.browser.snapshot('dom', true)
      }
      if (this.listReady(page)) return
      if (await this.enterRecommendationFrame(page)) return this.awaitRecommendationList()
    }
    throw new SourcingHandoff('boss_recommendation_not_ready')
  }
  private onEntryDocument(page: any) {
    return isBossRecommendationDocument(page)
  }
  private async awaitRecommendationList() {
    for (let settle = 0; settle < 6; settle++) {
      if (this.listReady(this.browser.page())) return
      await delay(450, undefined, { signal: this.context.signal })
      await this.browser.snapshot('dom', true)
    }
    throw new SourcingHandoff('boss_recommendation_not_ready')
  }
  private requireFrameInteraction(page: any) {
    if (!page.frameId || page.frameInteraction !== 'same-origin') {
      throw new Error('BOSS_FRAME_INTERACTION_UNSUPPORTED: 请更新薪招扩展后重试，当前扩展不支持在原页面内操作推荐列表')
    }
  }
  private async enterRecommendationFrame(page: any) {
    const tool = this.browser.broker.tools.find(tool => tool.name === 'browser_list_frames')
    if (!tool) throw new SourcingHandoff('boss_frame_capability_missing')
    const value: any = await tool.execute({ tabId: page.tabId }, this.context.signal)
    const frames = ((Array.isArray(value) ? value : value?.frames ?? []) as any[])
      .filter(frame => Number.isInteger(frame.frameId) && frame.frameId > 0
        && this.entryAliases.some(alias => isSourcingEntry(frameUrl(frame), alias)))
    if (!frames.length) return false
    const id = this.targets().find(target => target.id)?.id
    const matching = id ? frames.filter(frame => positionBusinessIds({ url: frameUrl(frame) }).includes(id)) : []
    const frame = requireSingle(matching.length ? matching : frames, 'boss_recommendation_frame_ambiguous')
    await this.browser.execute('browser_snapshot', { tabId: page.tabId, frameId: frame.frameId, format: 'dom', viewportOnly: true })
    this.requireFrameInteraction(this.browser.page())
    return true
  }
  private position() { return findPositionEvidence(this.page(), this.positionJob)[0] }
  /** 独立推荐文档没有职位控件：URL jobid 与顶部职位标题共同构成证明。 */
  private documentProof(): SearchConfirmation | undefined {
    const page = this.page()
    const title = bossDocumentTitle(page, this.targets().map(target => target.name).filter(Boolean))
    if (!title) return undefined
    const outcome = verifyBossDocumentPosition(page, this.positionJob, { ref: title.ref })
    if (!outcome?.ok) return undefined
    const position = outcome.verification
    return { tabId: page.tabId, snapshotId: page.snapshotId, mode: 'position', ref: position.ref, quote: position.quote,
      ...(position.platformJobId ? { platformJobId: position.platformJobId } : {}), filters: [] }
  }
  private proof(): SearchConfirmation {
    const document = this.documentProof()
    if (document) return document
    const position = this.position()
    if (!position) throw new SourcingHandoff('boss_position_unverified')
    const page = this.page()
    // Unsupported UI narrowing stays in the isolated candidate assessment.
    return { tabId: page.tabId, snapshotId: page.snapshotId, mode: 'position', ref: position.ref, quote: position.quote, filters: [] }
  }
  async prepareSearch() {
    if (this.page().dialogs?.length) throw new SourcingHandoff('boss_unexpected_startup_dialog')
    await this.prepareRecommendationList()
    if (await this.resumes.dismissExisting()) {
      this.view = undefined
      await this.browser.snapshot('dom', true)
    }
    if (this.page().dialogs?.length) throw new SourcingHandoff('boss_unexpected_startup_dialog')
    const targets = this.targets()
    for (let step = 0; step < 3; step++) {
      if (this.documentProof()) return this.proof()
      if (this.position()) return this.proof()
      const page = this.page()
      const menu = bossPositionMenu(page)
      const menuChoices = bossPositionChoices(page, targets.map(target => target.name || ''))
      const choices = page.items.filter((item: any) => visible(item, page) && !statesOf(item).some(state => ['selected', 'checked', 'current'].includes(state)) && ['tab', 'option', 'menuitem'].includes(item.role)
        && targets.some(target => normalized(item.name) === normalized(target.name)))
      const signature = hash({ url: bossDocumentUrl(page), title: bossDocumentSelector(page)?.name,
        options: (menu?.options ?? choices).map((item: any) => normalized(item.name)) })
      if (this.positionAttempts.has(signature)) throw new SourcingHandoff('boss_job_selection_stalled')
      this.positionAttempts.add(signature)
      if (menu) await this.browser.click(requireSingle<any>(menuChoices, menuChoices.length ? 'boss_job_choices_ambiguous' : 'boss_job_choice_missing').ref)
      else if (choices.length) await this.browser.click(requireSingle<any>(positionChoices(page, choices, targets), 'boss_job_choices_ambiguous').ref)
      else {
        // 顶部「职位名 _ 城市 薪资」自身就是招聘职位下拉触发器（没有独立的
        // 「不限职位」控件）。URL jobid 没能切到目标职位时，点它打开职位列表。
        const title = bossDocumentSelector(page)
        const triggers = page.items.filter((item: any) => visible(item, page) && positionControl(page, item) && !statesOf(item).includes('expanded')
          && (item.ref === title?.ref || item.role === 'combobox' && !['input', 'textarea'].includes(item.tagName) || ['button', 'combobox'].includes(item.role) && positionTriggers.test(normalized(item.name))))
        await this.browser.click(requireSingle<any>(triggers, 'boss_job_selector_missing').ref)
      }
    }
    return this.proof()
  }
  /** 快照会把长卡片根节点的文本截断，按钮原文则完整；卡片根的原文仍是按钮原文
   * （去掉末尾动作文案）的前缀。取最短的前缀匹配，避免把整列表容器当成单人卡片。 */
  private cardRoot(page: any, item: any, body: string, nameLength: number) {
    const matches: any[] = []
    const seen = new Set<string>()
    for (let ref = item.parentRef; ref && !seen.has(ref);) {
      seen.add(ref)
      const node = page.items.find((row: any) => row.ref === ref)
      if (!node) break
      if (['article', 'listitem', 'row', 'li', 'div'].includes(node.role) && readable(node)) {
        const text = normalized(node.name)
        if (text.length >= nameLength + 6 && body.startsWith(text)) matches.push(node)
      }
      ref = node.parentRef
    }
    return matches.sort((left, right) => normalized(left.name).length - normalized(right.name).length)[0]
  }
  private contains(page: any, child: any, parent: any) {
    const seen = new Set<string>()
    for (let node = child; node && !seen.has(node.ref); node = page.items.find((item: any) => item.ref === node.parentRef)) {
      if (node.ref === parent.ref) return true
      seen.add(node.ref)
    }
    return false
  }
  private resolveCards(page: any): SourcingCard[] {
    if (page.dialogs?.length) throw new SourcingHandoff('boss_list_has_dialog')
    const cards: SourcingCard[] = []
    for (const button of page.items.filter((item: any) => visible(item, page) && labels.has(normalized(item.name)))) {
      const candidate = readCandidate(button.context?.text, 'button').candidate
      if (!candidate) continue
      const text = normalized(button.context.text)
      // 招呼按钮可能在卡片容器之外，按钮文本则包含整张卡片原文；
      // 从姓名节点向上找卡片根，再按祖先关系关联同一卡片内的资料链接。
      let body = text
      for (const label of labels) if (body.endsWith(` ${label}`)) { body = body.slice(0, -label.length - 1).trim(); break }
      const named = page.items.filter((item: any) => visible(item, page) && normalized(item.name) === candidate.name)
        .map((item: any) => ({ item, root: this.cardRoot(page, item, body, candidate.name.length) }))
        .filter((entry: any) => entry.root)
      const anchors = named.filter((entry: any) => !named.some((other: any) => other !== entry && this.contains(page, entry.item, other.item)))
      if (anchors.length !== 1) continue
      const root = anchors[0].root
      const related = (item: any) => normalized(item.context?.text) === text || this.contains(page, item, root)
      const links = page.items.filter((item: any) => readable(item) && item.href && related(item) && (() => {
        try { const url = new URL(item.href); return url.origin === 'https://www.zhipin.com' && /\/(?:geek|resume|candidate|profile)(?:\/|\?|$)/.test(url.pathname) } catch { return false }
      })())
      const profile = links.length === 1 ? links[0] : undefined
      const sourceId = hash({ platform: 'boss', identity: profile?.href ?? bossCandidateTextIdentity(text).canonical })
      if (cards.some(card => card.sourceId === sourceId)) continue
      const anchor = anchors[0].item
      assertCandidateQuote(page, { ref: button.ref, name: candidate.name, evidenceRefs: [anchor.ref] })
      cards.push({ sourceId, name: candidate.name, text, ref: button.ref, openRef: anchor.ref,
        evidenceRefs: [anchor.ref], ...(profile ? { profileRef: profile.ref } : {}) })
    }
    return cards
  }
  async cards(options: { refresh?: boolean } = {}) {
    const current = this.page()
    if (options.refresh === false && this.view && this.view.page === current) return this.view.cards
    if (options.refresh !== false || current.format !== 'dom') await this.browser.snapshot('dom', true)
    let cards = this.resolveCards(this.page())
    if (!cards.length && !this.page().items.some((item: any) => visible(item, this.page()) && endLabel.test(normalized(item.name)))) {
      await this.browser.snapshot('dom', true)
      cards = this.resolveCards(this.page())
      if (!cards.length && !this.page().items.some((item: any) => visible(item, this.page()) && endLabel.test(normalized(item.name)))) throw new SourcingHandoff('boss_card_structure_changed')
    }
    this.view = { page: this.page(), cards }
    return cards
  }
  async open(card: SourcingCard) {
    this.opened = card
    return this.resumes.open(card)
  }
  async resume(name: string): Promise<ResumeLocator> {
    return this.resumes.resume(name)
  }
  hasOpenResume(name?: string) { return this.resumes.hasOpen(name) }
  async returnToList() {
    await this.resumes.close()
    return this.proof()
  }
  async advance() {
    const cards = await this.cards({ refresh: false }), page = this.page()
    const ends = page.items.filter((item: any) => visible(item, page) && endLabel.test(normalized(item.name)))
    if (ends.length === 1) return { exhaustion: { tabId: page.tabId, snapshotId: page.snapshotId, ref: ends[0].ref, quote: normalized(ends[0].name).slice(0, 300) } }
    const signature = hash(cards.map(card => card.sourceId).sort())
    this.stalled = signature === this.previous ? this.stalled + 1 : 0
    if (this.stalled >= 2) throw new SourcingHandoff('boss_list_no_progress')
    this.previous = signature
    const next = page.items.filter((item: any) => visible(item, page) && normalized(item.name) === '下一页' && !statesOf(item).includes('disabled'))
    if (next.length === 1) await this.browser.click(next[0].ref)
    else {
      const anchor = cards[0]
      if (!anchor) throw new SourcingHandoff('boss_scroll_anchor_missing')
      await this.browser.execute('browser_scroll', { ...this.browser.locator(anchor.ref), deltaY: Math.max(120, Math.floor(Number(page.viewport?.height ?? 700) * 0.65)), purpose: 'navigation' })
    }
    return {}
  }
  async greeting(name: string, candidateKey: string) {
    if (!this.opened || this.opened.name !== name) throw new SourcingHandoff('boss_greeting_owner_missing')
    await this.returnToList()
    const card = requireSingle((await this.cards()).filter(card => card.sourceId === this.opened!.sourceId), 'boss_greeting_card_changed')
    const page = this.page(), position = this.proof()
    return { tabId: page.tabId, snapshotId: page.snapshotId, candidateKey, ref: card.ref, identityRef: card.ref,
      evidenceRefs: card.evidenceRefs, ...(card.profileRef ? { profileRef: card.profileRef } : {}), position: { ref: position.ref } }
  }
}
