import { setTimeout as delay } from 'node:timers/promises'
import { SourcingBrowser, SourcingHandoff, requireSingle } from '../../sourcing/browser.js'
import type { SourcingCard, SourcingDriver, SourcingDriverContext, ResumeLocator, SearchConfirmation } from '../../sourcing/types.js'
import { findPositionEvidence } from '../../position-evidence.js'
import { positionChoices, positionControl } from '../../position-controls.js'
import { readCandidate } from '../../candidate-entry.js'
import { assertCandidateQuote } from '../../candidate-evidence.js'
import { normalized, statesOf } from '../../page-actions.js'
import { hash } from '../../store.js'
import { bossDefinition } from './definition.js'
import { isSourcingEntry } from '../../sourcing/source.js'
import type { GreetingJob } from '../../../shared/workbench.js'

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
  private view?: { page: any; cards: SourcingCard[] }
  private opened?: SourcingCard
  private previous?: string
  private stalled = 0
  constructor(private readonly context: SourcingDriverContext) {
    this.browser = new SourcingBrowser(context.broker, context.signal)
    this.positionJob = { ...context.job, kind: 'greeting', platform: 'boss', platformJobs: context.job.platformJobs?.boss } as unknown as GreetingJob
  }
  private page() {
    const page = this.browser.page()
    if (!isSourcingEntry(page.url, bossDefinition.sourcingEntry) || page.isLoginPage) throw new SourcingHandoff('boss_source_page_changed')
    return page
  }
  async recognizes() {
    const page = this.context.broker.currentPage()
    return isSourcingEntry(page?.url, bossDefinition.sourcingEntry) && !page?.isLoginPage
  }
  private position() { return findPositionEvidence(this.page(), this.positionJob)[0] }
  private proof(): SearchConfirmation {
    const position = this.position()
    if (!position) throw new SourcingHandoff('boss_position_unverified')
    const page = this.page()
    // Unsupported UI narrowing stays in the isolated candidate assessment.
    return { tabId: page.tabId, snapshotId: page.snapshotId, mode: 'position', ref: position.ref, quote: position.quote, filters: [] }
  }
  async prepareSearch() {
    if (this.page().dialogs?.length) throw new SourcingHandoff('boss_unexpected_startup_dialog')
    const targets = this.context.job.platformJobs?.boss?.length ? this.context.job.platformJobs.boss : [{ id: '', name: this.context.job.jobName || '' }]
    for (let step = 0; step < 3; step++) {
      if (this.position()) return this.proof()
      const page = this.page()
      const choices = page.items.filter((item: any) => visible(item, page) && !statesOf(item).some(state => ['selected', 'checked', 'current'].includes(state)) && ['tab', 'option', 'menuitem'].includes(item.role)
        && targets.some(target => normalized(item.name) === normalized(target.name)))
      if (choices.length) await this.browser.click(requireSingle<any>(positionChoices(page, choices, targets), 'boss_job_choices_ambiguous').ref)
      else {
        const triggers = page.items.filter((item: any) => visible(item, page) && positionControl(page, item) && !statesOf(item).includes('expanded')
          && (item.role === 'combobox' && !['input', 'textarea'].includes(item.tagName) || ['button', 'combobox'].includes(item.role) && positionTriggers.test(normalized(item.name))))
        await this.browser.click(requireSingle<any>(triggers, 'boss_job_selector_missing').ref)
      }
    }
    return this.proof()
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
      const related = (item: any) => normalized(item.context?.text) === text
        || page.items.some((root: any) => ['article', 'listitem', 'row', 'li'].includes(root.role)
          && normalized(root.name) === text && this.contains(page, button, root) && this.contains(page, item, root))
      const names = page.items.filter((item: any) => visible(item, page) && normalized(item.name) === candidate.name && related(item))
      const anchors = names.filter((item: any) => !names.some((other: any) => other !== item && this.contains(page, item, other)))
      if (anchors.length !== 1) continue
      const links = page.items.filter((item: any) => readable(item) && item.href && related(item) && (() => {
        try { const url = new URL(item.href); return url.origin === 'https://www.zhipin.com' && /\/(?:geek|resume|candidate|profile)(?:\/|\?|$)/.test(url.pathname) } catch { return false }
      })())
      const profile = links.length === 1 ? links[0] : undefined
      const sourceId = hash({ platform: 'boss', identity: profile?.href ?? candidate.identity })
      if (cards.some(card => card.sourceId === sourceId)) continue
      assertCandidateQuote(page, { ref: button.ref, name: candidate.name, evidenceRefs: [anchors[0].ref] })
      cards.push({ sourceId, name: candidate.name, text, ref: button.ref, openRef: anchors[0].ref,
        evidenceRefs: [anchors[0].ref], ...(profile ? { profileRef: profile.ref } : {}) })
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
    assertCandidateQuote(this.page(), { ref: card.ref, name: card.name, evidenceRefs: card.evidenceRefs })
    this.opened = card
    await this.browser.click(card.openRef)
    return this.resume(card.name)
  }
  async resume(name: string): Promise<ResumeLocator> {
    for (const ms of [0, 200, 400, 800]) {
      if (ms) await delay(ms, undefined, { signal: this.context.signal })
      await this.browser.snapshot('dom', false)
      const page = this.page()
      const dialogs = (page.dialogs ?? []).filter((dialog: any) => normalized(dialog.text).includes(normalized(name)) && /工作经历|工作经验|项目经历|项目经验/.test(dialog.text))
      if (dialogs.length) {
        const dialog = requireSingle<any>(dialogs, 'boss_detail_ambiguous')
        const root = page.items.find((item: any) => item.ref === dialog.ref && readable(item))
        if (root) return { tabId: page.tabId, snapshotId: page.snapshotId, identityRef: root.ref, resumeRefs: [root.ref] }
      }
    }
    throw new SourcingHandoff('boss_resume_structure_changed')
  }
  async returnToList() {
    const page = this.page()
    if (page.dialogs?.length) {
      const dialog = requireSingle<any>(page.dialogs, 'boss_close_dialog_ambiguous')
      if (!this.opened || !normalized(dialog.text).includes(normalized(this.opened.name))) throw new SourcingHandoff('boss_close_owner_changed')
      const closes = page.items.filter((item: any) => readable(item) && (item.dialogRef === dialog.ref || this.contains(page, item, { ref: dialog.ref }))
        && (item.ref === dialog.closeRef || /^(?:关闭|close|×)$/i.test(normalized(item.name))))
      const target = dialog.closeRef ? closes.filter((item: any) => item.ref === dialog.closeRef) : closes
      await this.browser.click(requireSingle<any>(target, 'boss_close_control_missing').ref)
      if (this.page().dialogs?.length) throw new SourcingHandoff('boss_close_unconfirmed')
    }
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
