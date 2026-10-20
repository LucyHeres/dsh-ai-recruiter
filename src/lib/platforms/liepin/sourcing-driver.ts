import { setTimeout as delay } from 'node:timers/promises'
import { LiepinSearchEvidence } from './search-evidence.js'
import { SourcingBrowser, SourcingHandoff, requireSingle } from '../../sourcing/browser.js'
import type { ResumeLocator, SearchConfirmation, SourcingCard, SourcingDriver, SourcingDriverContext } from '../../sourcing/types.js'
import { hash } from '../../store.js'
import { assertCandidateQuote } from '../../candidate-evidence.js'
import { normalized, statesOf } from '../../page-actions.js'
import { sourcingEducationLevels, sourcingExperienceRange, verifySourcingSearchFilters } from '../../sourcing-search.js'
import { greetingLabels, completedGreetingLabels } from '../../recruitment-controls.js'
import { sourcingMode, isSourcingEntry } from '../../sourcing/source.js'
import { liepinDefinition } from './definition.js'
import { recommendationFilterDialog, recommendationFilterLabel } from './recommendation-controls.js'

const readable = (item: any) => item.ref && !statesOf(item).some(s => ['hidden', 'invisible', 'blocked_by_dialog'].includes(s))
const hasClass = (node: any, name: string) => String(node?.attributes?.class ?? '').split(/\s+/).some(token => token === name || token.startsWith(`${name}--`))
const nameOf = (text: string) => /(?:^|\s)([\u4e00-\u9fffA-Za-z·*＊]{1,16})\s*(?=\d{2}\s*岁)/.exec(text)?.[1]

/** Known Liepin component semantics, paths and navigation live together here.
 * Decisions are re-derived from each current snapshot; no cached coordinates,
 * persisted refs, guessed candidate links or direct site API calls. */
export class LiepinSourcingDriver implements SourcingDriver {
  private readonly browser: SourcingBrowser
  private readonly evidence: LiepinSearchEvidence
  private readonly names: string[]
  private listDocument?: string
  private advanced?: string
  private openedSource?: string
  private readonly recommendation: boolean
  private readonly entry: string
  constructor(private readonly context: SourcingDriverContext) {
    this.browser = new SourcingBrowser(context.broker, context.signal)
    this.evidence = new LiepinSearchEvidence(context.broker)
    this.names = (context.job.platformJobs?.liepin?.length ? context.job.platformJobs.liepin.map(j => j.name) : [context.job.jobName || '']).map(normalized)
    this.recommendation = sourcingMode(context.job) === 'recommend'
    this.entry = this.recommendation ? liepinDefinition.sourcingEntry : liepinDefinition.sourcingSearchEntry
  }
  private page() {
    const page = this.browser.page()
    if (!isSourcingEntry(page.url, this.entry) || page.isLoginPage) throw new SourcingHandoff('unsupported_source_page')
    return page
  }
  async recognizes() {
    if (!this.context.broker.tools.some(t => t.name === 'browser_inspect_element')) return false
    const page = this.context.broker.currentPage()
    // Routing recognises the entry, not just currently visible header controls.
    // prepareSearch still requires observed components before any selection.
    return isSourcingEntry(page?.url, this.entry) && !page?.isLoginPage
  }
  private async controls() {
    const page = this.page()
    await this.evidence.scan(page, this.names, this.context.job.searchFilters ?? {}, this.context.signal)
    const controls = page.items.flatMap((item: any) => {
      const control = this.evidence.control(page, item.ref)
      return control ? [{ ...control, ref: item.ref, name: normalized(control.kind === 'filter' ? item.value || item.name : item.name) }] : []
    }) as { ref: string; name: string; kind: string; field?: string; active: boolean; selected: boolean; expanded: boolean }[]
    // DOM exposes both the dropdown trigger and its nested title. They are
    // one component, whereas two unrelated matching selectors remain ambiguous.
    return controls.filter(control => control.kind !== 'position' || !controls.some(parent => {
      if (parent === control || parent.kind !== 'position' || parent.name !== control.name) return false
      const seen = new Set<string>()
      for (let ref = page.items.find((i: any) => i.ref === control.ref)?.parentRef; ref && !seen.has(ref);) {
        if (ref === parent.ref) return true
        seen.add(ref); ref = page.items.find((i: any) => i.ref === ref)?.parentRef
      }
      return false
    }))
  }
  private async positionProof(controls: Awaited<ReturnType<LiepinSourcingDriver['controls']>>) {
    const page = this.page()
    const top = requireSingle(controls.filter(c => c.kind === 'position' && c.selected && (this.recommendation
      ? this.evidence.position(page, { jobId: this.context.job.jobId, jobName: this.context.job.jobName, platformJobs: this.context.job.platformJobs?.liepin }, { ref: c.ref })?.ok
      : this.names.includes(c.name))), 'position_not_selected')
    const position = this.evidence.position(page, { jobId: this.context.job.jobId, jobName: this.context.job.jobName, platformJobs: this.context.job.platformJobs?.liepin }, { ref: top.ref })
    if (!position?.ok) throw new SourcingHandoff('position_unverified')
    return { tabId: page.tabId, snapshotId: page.snapshotId, mode: 'position' as const, ref: top.ref, quote: top.name }
  }
  private async searchProof(): Promise<SearchConfirmation> {
    const page = this.page(), controls = await this.controls()
    const position = await this.positionProof(controls)
    const filters: SearchConfirmation['filters'] = controls.filter(c => c.kind === 'filter' && c.selected && c.field && c.field !== 'current_city')
      .map(c => ({ field: c.field as 'city' | 'experience' | 'education', ref: c.ref, quote: c.name, state: 'applied' }))
    if (!this.recommendation) verifySourcingSearchFilters(this.evidence.filterPage(page, filters), this.context.job.searchFilters ?? {}, filters)
    return { ...position, filters }
  }
  private async revealSearchHeader() {
    for (let attempt = 0; attempt < 3; attempt++) {
      if ((await this.controls()).some(c => (c.kind === 'position' || this.recommendation && c.kind === 'job_option') && (c.selected || c.active))) return
      const page = this.page(), scrollY = Number(page.viewport?.scrollY)
      if (!Number.isFinite(scrollY) || scrollY <= 0) throw new SourcingHandoff('search_header_not_visible')
      // Returning from a resume retains the list's scroll position. Restore the
      // observed top-level offset, then re-observe; no coordinates or key focus.
      await this.browser.execute('browser_scroll', { tabId: page.tabId, deltaY: -Math.ceil(scrollY), purpose: 'navigation' })
    }
    throw new SourcingHandoff('search_header_no_progress')
  }
  async prepareSearch(): Promise<SearchConfirmation> {
    this.page()
    if (this.recommendation) return this.prepareRecommendation()
    if (this.page().dialogs?.length) await this.returnToList()
    await this.revealSearchHeader()
    let positionReady = false
    for (let step = 0; step < 6; step++) {
      const controls = await this.controls()
      const selected = controls.filter(c => c.kind === 'position' && c.selected && this.names.includes(c.name))
      if (selected.length === 1) { positionReady = true; break }
      const choices = controls.filter(c => c.kind === 'job_option' && c.active && this.names.includes(c.name))
      if (choices.length) {
        const choice = requireSingle(choices, 'job_choices_ambiguous')
        if (!choice.selected) await this.browser.click(choice.ref)
        // This is a two-phase selector: choosing an option updates its draft,
        // then the panel's own confirm commits it and dismisses the overlay.
        // Never toggle an already selected draft or use another filter's 确定.
        const afterChoice = await this.controls()
        if (afterChoice.some(c => c.kind === 'position' && c.selected && this.names.includes(c.name))) continue
        requireSingle(afterChoice.filter(c => c.kind === 'job_option' && c.active && c.selected && this.names.includes(c.name)), 'job_draft_unverified')
        await this.browser.click(requireSingle(afterChoice.filter(c => c.kind === 'position_confirm' && c.active), 'job_confirmation_missing').ref)
        continue
      }
      const trigger = requireSingle(controls.filter(c => c.kind === 'position' && c.active && !c.expanded), 'job_trigger_unknown')
      await this.browser.click(trigger.ref)
    }
    if (!positionReady) throw new SourcingHandoff('job_selection_did_not_converge')
    const expected = this.context.job.searchFilters ?? {}
    for (const field of ['city', 'experience', 'education'] as const) {
      const value = expected[field]
      if (!value) continue
      // A fresh snapshot after every click is required even for additive labels.
      for (let step = 0; step < 10; step++) {
        const controls = (await this.controls()).filter(c => c.kind === 'filter' && c.field === field && c.active)
        let wanted: typeof controls
        if (field === 'education') {
          const degrees = sourcingEducationLevels(value)
          wanted = controls.filter(c => degrees.some(degree => c.name.includes(degree)))
          if (!degrees.length || degrees.some(degree => !wanted.some(c => c.name.includes(degree)))) throw new SourcingHandoff('education_options_missing')
        } else if (field === 'city') {
          const city = value.split(/[\/／]/).pop()!.replace(/市$/, '')
          wanted = [requireSingle(controls.filter(c => c.name === city), 'city_option_missing')]
        } else {
          const range = sourcingExperienceRange(value)
          if (!range) throw new SourcingHandoff('experience_range_unknown')
          wanted = controls.filter(c => {
            const actual = sourcingExperienceRange(c.name)
            return actual && !/不限/.test(c.name) && (range[0] === range[1] ? actual[0] <= range[0] && actual[1] >= range[1] : actual[0] < range[1] && actual[1] > range[0])
          })
          if (!wanted.length) throw new SourcingHandoff('experience_options_missing')
        }
        const missing = wanted.find(c => !c.selected)
        const extra = controls.find(c => c.selected && !/不限/.test(c.name) && !wanted.some(w => w.ref === c.ref))
        if (!missing && !extra) break
        await this.browser.click((extra ?? missing)!.ref)
        if (step === 9) throw new SourcingHandoff('filter_did_not_converge')
      }
    }
    // Verify actual controls before submitting; do not search using guessed filters.
    await this.searchProof()
    const search = requireSingle((await this.controls()).filter(c => c.kind === 'search' && c.active), 'active_search_missing')
    await this.browser.click(search.ref)
    const proof = await this.searchProof()
    this.listDocument = this.page().documentId
    this.advanced = undefined
    return proof
  }
  private async prepareRecommendation(): Promise<SearchConfirmation> {
    const dialog = recommendationFilterDialog(this.page())
    if (dialog) {
      const targets = this.context.job.platformJobs?.liepin?.length ? this.context.job.platformJobs.liepin : [{ id: '', name: this.context.job.jobName || '' }]
      const matching = (this.page().selectedTabs ?? []).filter((tab: any) => targets.some(target =>
        (normalized(tab.name) === normalized(target.name) || normalized(tab.name).startsWith(normalized(target.name) + ' '))
        && (!target.id || String(tab.elementId ?? '').endsWith('-tab-' + target.id))))
      if (matching.length !== 1) throw new SourcingHandoff('filter_position_context_unverified')
    } else if (this.page().dialogs?.length) throw new SourcingHandoff('recommendation_dialog_requires_interpretation')
    if (!dialog) await this.revealSearchHeader()
    let ready = !!dialog
    for (let step = 0; step < 3; step++) {
      if (ready) break
      const controls = await this.controls()
      try { await this.positionProof(controls); ready = true; break } catch { /* Select one observed target tab below. */ }
      const choices = controls.filter(control => {
        if (control.kind !== 'job_option' || !control.active || !this.names.some(name => control.name === name || control.name.startsWith(name + ' '))) return false
        const id = /rc-tabs-\d+-tab-(\d+)$/.exec(String(this.page().items.find((item: any) => item.ref === control.ref)?.elementId ?? ''))?.[1]
        return !id || !this.context.job.platformJobs?.liepin?.length || this.context.job.platformJobs.liepin.some(job => job.id === id)
      })
      await this.browser.click(requireSingle(choices, 'recommendation_job_choices_ambiguous').ref)
    }
    if (!ready) throw new SourcingHandoff('recommendation_position_unverified')
    const expected = this.context.job.searchFilters ?? {}
    const missing = (await this.controls())
    const fields = (['education', 'experience'] as const).filter(field => {
      if (!expected[field]) return false
      const proofs = missing.filter(c => c.kind === 'filter' && c.field === field && c.selected).map(c => ({ field, ref: c.ref, quote: c.name, state: 'applied' as const }))
      try { verifySourcingSearchFilters(this.evidence.filterPage(this.page(), proofs), { [field]: expected[field] }, proofs); return false } catch { return true }
    })
    if (fields.length || dialog) {
      const triggers = this.page().items.filter((item: any) => readable(item) && item.role === 'button' && recommendationFilterLabel(item.name))
      if (dialog || triggers.length === 1) {
        if (!dialog) await this.browser.click(triggers[0].ref)
        if (!recommendationFilterDialog(this.page())) throw new SourcingHandoff('recommendation_filter_dialog_changed')
        for (const field of fields) for (let step = 0; step < 10; step++) {
          const options = (await this.controls()).filter(c => c.kind === 'filter' && c.field === field && c.active)
          const levels = field === 'education' ? sourcingEducationLevels(expected.education!) : []
          const range = field === 'experience' ? sourcingExperienceRange(expected.experience!) : undefined
          const wanted = options.filter(option => field === 'education'
            ? levels.some(level => option.name.includes(level)) || levels.includes('硕士') && /MBA|EMBA/.test(option.name)
            : range && !/不限/.test(option.name) && (() => { const actual = sourcingExperienceRange(option.name); return actual && actual[0] <= range[1] && actual[1] >= range[0] })())
          if (!wanted.length) break // Unsupported page narrowing is checked per candidate instead.
          const change = options.find(c => c.selected && !/不限/.test(c.name) && !wanted.some(w => w.ref === c.ref)) ?? wanted.find(c => !c.selected)
          if (!change) break
          await this.browser.click(change.ref)
          if (step === 9) throw new SourcingHandoff('recommendation_filter_no_progress')
        }
        const confirms = (await this.controls()).filter(c => c.kind === 'confirm' && c.active && this.page().items.find((item: any) => item.ref === c.ref)?.role === 'button')
        await this.browser.click(requireSingle(confirms, 'recommendation_filter_confirmation_ambiguous').ref)
        if (this.page().dialogs?.length) throw new SourcingHandoff('recommendation_filter_commit_unconfirmed')
      }
    }
    const proof = await this.searchProof()
    this.listDocument = this.page().documentId; this.advanced = undefined
    return proof
  }
  async cards(): Promise<SourcingCard[]> {
    // DOM exposes whole per-card context and dialog ownership, not only AX names.
    // A viewport-only DOM tree can include the greeting button but omit the
    // same card's name/ancestors (or vice versa). Resolve ownership from the
    // whole observed tree. Input visibility is checked separately in open().
    await this.browser.snapshot('dom', false)
    // Search submission can precede asynchronous results. Wait only while no
    // result/end component exists, with bounded cancellable observation.
    for (const ms of [200, 400, 800, 1600, 2400]) {
      const page = this.page()
      if (page.dialogs?.length || page.items.some((i: any) => readable(i) &&
        ([...greetingLabels('liepin'), ...completedGreetingLabels].includes(normalized(i.name)) || /^(?:没有更多|暂无.*(?:人才|简历|结果)|没有符合|已.*最后一页)/.test(normalized(i.name))))) break
      await delay(ms, undefined, { signal: this.context.signal })
      await this.browser.snapshot('dom', false)
    }
    const page = this.page()
    if (page.dialogs?.length) throw new SourcingHandoff('list_has_dialog')
    if (this.listDocument && page.documentId !== this.listDocument) throw new SourcingHandoff('list_document_changed')
    const result: SourcingCard[] = []
    const labels = new Set([...greetingLabels('liepin'), ...completedGreetingLabels])
    for (const item of page.items.filter((i: any) => readable(i) && labels.has(normalized(i.name)))) {
      const text = normalized(item.context?.text), name = nameOf(text)
      if (!name || text.length < 40 || [...text.matchAll(/\d{2}\s*岁/g)].length !== 1) continue
      const sourceId = hash({ name, text })
      if (result.some(r => r.sourceId === sourceId)) continue
      // Only a name inside the exact same single-person context can be opened.
      const parentHas = (child: any, ancestor: any) => {
        const seen = new Set<string>()
        for (let node = child; node && !seen.has(node.ref); node = page.items.find((i: any) => i.ref === node.parentRef)) {
          if (node.ref === ancestor.ref) return true
          seen.add(node.ref)
        }
        return false
      }
      const roots: any[] = [], visited = new Set<string>()
      for (let ref = item.parentRef; ref && !visited.has(ref);) {
        visited.add(ref)
        const root = page.items.find((i: any) => i.ref === ref)
        if (!root) break
        if (normalized(root.name).includes(name) && [...normalized(root.name).matchAll(/\d{2}\s*岁/g)].length === 1) { roots.push(root); break }
        ref = root.parentRef
      }
      const named = page.items.filter((i: any) => readable(i) && normalized(i.name) === name
        && (normalized(i.context?.text) === text || roots.some(root => parentHas(i, root))))
      // DOM duplicates the same name on a div and its nested em. Keep one
      // outer name node within this card, never merge masked names across cards.
      const anchors = named.filter((i: any) => !named.some((other: any) => other.ref !== i.ref && parentHas(i, other)))
      if (anchors.length !== 1) continue
      const anchor = anchors[0]
      // The read-only identity anchor carries the whole single-person context.
      // The click target is a distinct name node. A masked name alone is not a
      // stable dedupe identity, and a greeting button must never open details.
      const ref = item.ref
      const evidenceRefs = [anchor.ref]
      assertCandidateQuote(page, { ref, name, evidenceRefs })
      result.push({ sourceId, name, text, ref, openRef: anchor.ref, evidenceRefs })
      if (result.length >= 30) break
    }
    return result
  }
  async open(card: SourcingCard) {
    const page = this.page()
    assertCandidateQuote(page, { ref: card.ref, name: card.name, evidenceRefs: card.evidenceRefs })
    this.openedSource = card.sourceId
    const anchor = page.items.find((i: any) => i.ref === card.openRef)
    const y = Number(anchor?.bounds?.y), height = Number(page.viewport?.height)
    if (Number.isFinite(y) && height > 0 && (y < 0 || y >= height)) {
      await this.browser.execute('browser_scroll', { tabId: page.tabId, deltaY: Math.round(y - height / 3), purpose: 'navigation' })
      const fresh = requireSingle((await this.cards()).filter(c => c.sourceId === card.sourceId), 'candidate_after_scroll_ambiguous')
      await this.browser.click(fresh.openRef)
    } else await this.browser.click(card.openRef)
    return this.resume(card.name)
  }
  async resume(name: string): Promise<ResumeLocator> {
    await this.browser.snapshot('dom')
    const page = this.page()
    const dialog = requireSingle((page.dialogs ?? []).filter((d: any) => normalized(d.text).includes(normalized(name)) && /工作经历|项目经历|项目经验/.test(d.text)), 'candidate_detail_unknown') as any
    const root = page.items.find((i: any) => i.ref === dialog.ref && readable(i))
    if (!root || !normalized(root.name).includes(normalized(name))) throw new SourcingHandoff('detail_identity_unverified')
    return { tabId: page.tabId, snapshotId: page.snapshotId, identityRef: root.ref, resumeRefs: [root.ref] }
  }
  async returnToList() {
    const page = this.page()
    if (!(page.dialogs ?? []).length) return this.confirmReturnedList()
    // Distinguish the resume close button from tooltip/tag closes using the
    // observed component ancestry. Never click an arbitrary same-name close.
    const closes = page.items.filter((i: any) => readable(i) && /^close$|^关闭$|^×$/i.test(normalized(i.name)) && i.dialogRef)
    await this.context.broker.inspectRefs(page, closes.map((i: any) => i.ref), this.context.signal, true, true)
    const targets = closes.filter((i: any) => {
      const d = this.context.broker.getInspection(page, i.ref)
      return [d?.element, ...(d?.ancestors ?? [])].some(node => hasClass(node, 'closeBtn'))
        && (page.dialogs ?? []).some((dialog: any) => dialog.ref === i.dialogRef && /工作经历|项目经历|项目经验/.test(dialog.text))
    })
    await this.browser.click(requireSingle<any>(targets, 'resume_close_ambiguous').ref)
    if (this.page().dialogs?.length) throw new SourcingHandoff('resume_close_unconfirmed')
    return this.confirmReturnedList()
  }
  private async confirmReturnedList() {
    if (!this.listDocument) return
    // Opening/closing the SPA resume can renew the browser document identity.
    // Rebind only after independently re-reading position and active filters;
    // the session must also confirm this proof before reading the next card.
    await this.revealSearchHeader()
    const proof = await this.searchProof()
    this.listDocument = this.page().documentId
    return proof
  }
  async advance() {
    const page = this.page()
    const ends = page.items.filter((i: any) => readable(i) && /^(?:没有更多|暂无.*(?:人才|简历|结果)|没有符合|已.*最后一页)/.test(normalized(i.name)))
    if (ends.length === 1) return { exhaustion: { tabId: page.tabId, snapshotId: page.snapshotId, ref: ends[0].ref, quote: normalized(ends[0].name).slice(0, 300) } }
    const signature = hash({ scroll: [page.viewport?.scrollX, page.viewport?.scrollY], items: page.items.filter((i: any) => readable(i)).map((i: any) => [i.role, i.name, i.context?.text]) })
    if (signature === this.advanced) throw new SourcingHandoff('list_no_progress')
    this.advanced = signature
    const next = page.items.filter((i: any) => readable(i) && normalized(i.name) === '下一页' && !statesOf(i).includes('disabled'))
    if (next.length === 1) await this.browser.click(next[0].ref)
    else await this.browser.execute('browser_scroll', { tabId: page.tabId,
      deltaY: Math.min(500, Math.max(120, Math.floor(Number(page.viewport?.height ?? 600) * 0.5))), purpose: 'navigation' })
    return {}
  }
  async greeting(name: string, candidateKey: string) {
    const detail = this.page()
    if (detail.dialogs?.length === 1) {
      const dialog = detail.dialogs[0]
      const targets = detail.items.filter((item: any) => readable(item) && item.dialogRef === dialog.ref && greetingLabels('liepin').has(normalized(item.name)))
      const position = this.evidence.position(detail, { jobId: this.context.job.jobId, jobName: this.context.job.jobName, platformJobs: this.context.job.platformJobs?.liepin }, { ref: dialog.ref })
      if (targets.length === 1 && position?.ok && normalized(dialog.text).includes(normalized(name))) {
        return { tabId: detail.tabId, snapshotId: detail.snapshotId, candidateKey, ref: targets[0].ref, identityRef: dialog.ref, evidenceRefs: [], position: { ref: dialog.ref } }
      }
    }
    // Return to the same verified card so text dedupe identity and position
    // evidence have the same shape as preflight, then use the sole write hook.
    await this.returnToList()
    const cards = await this.cards()
    const card = requireSingle(cards.filter(c => c.sourceId === this.openedSource && c.name === name), 'greeting_card_ambiguous')
    const page = this.page()
    const target = requireSingle<any>(page.items.filter((i: any) => i.ref === card.ref), 'greeting_target_missing')
    // returnToList already revalidated all search filters. The DOM card tree
    // may omit filter-row ancestors; greeting needs the current position and
    // candidate in this same fresh snapshot, not a second full search proof.
    const position = await this.positionProof(await this.controls())
    return { tabId: page.tabId, snapshotId: page.snapshotId, candidateKey, ref: target.ref, identityRef: card.ref, evidenceRefs: card.evidenceRefs, position: { ref: position.ref, quote: position.quote } }
  }
}
