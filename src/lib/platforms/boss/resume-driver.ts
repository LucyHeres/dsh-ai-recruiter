import { setTimeout as delay } from 'node:timers/promises'
import { SourcingBrowser, SourcingHandoff, requireSingle } from '../../sourcing/browser.js'
import type { SourcingCard, SourcingDriverContext, ResumeLocator } from '../../sourcing/types.js'
import type { AgentBrowserTools } from '../../agent-browser-tools.js'
import type { ResumeCaptureContext } from '../types.js'
import { assertCandidateQuote } from '../../candidate-evidence.js'
import { frameUrl, normalized, statesOf } from '../../page-actions.js'
import { bossDocumentUrl } from './search-evidence.js'

const bindings = new WeakMap<AgentBrowserTools, { name: string; documentId: string; frameId: number }>()
const hasClass = (node: any, name: string) => String(node?.attributes?.class ?? '').split(/\s+/).includes(name)
const readable = (item: any) => item?.ref && !statesOf(item).some(state => ['hidden', 'invisible', 'blocked_by_dialog'].includes(state))
const resumeFrame = (frame: any) => {
  try { const url = new URL(frameUrl({ ...frame, url: bossDocumentUrl(frame) })); return frame.frameId > 0 && url.origin === 'https://www.zhipin.com' && url.pathname.replace(/\/$/, '') === '/web/frame/c-resume' } catch { return false }
}
export function bossResumeClose(page: any, ref: string, broker: AgentBrowserTools) {
  const detail = broker.getInspection(page, ref)
  return hasClass(detail?.element, 'close-btn') && detail?.ancestors?.some((node: any) => hasClass(node, 'lib-standard-resume'))
}
export function bossReadOnlyControl(page: any, ref: string, broker: AgentBrowserTools) {
  const detail = broker.getInspection(page, ref)
  return bossResumeClose(page, ref, broker) || hasClass(detail?.element, 'card-inner')
    && detail?.ancestors?.some((node: any) => hasClass(node, 'candidate-card-wrap'))
}
export async function readBossResume(context: ResumeCaptureContext) {
  const { broker, page, candidate, input, signal, readVisual } = context
  const binding = bindings.get(broker)
  if (!resumeFrame(page)) return undefined
  if (!binding || binding.name !== candidate.name || binding.frameId !== page.frameId || binding.documentId !== page.documentId) {
    throw new Error('CANDIDATE_EVIDENCE_INVALID: 请先从已初筛候选人的卡片打开对应简历详情')
  }
  const canvases = page.items.filter((item: any) => readable(item) && item.tagName === 'canvas')
  const canvas = requireSingle<any>(canvases, 'boss_resume_canvas_ambiguous')
  if (input.identityRef !== canvas.ref || input.resumeRefs.length !== 1 || input.resumeRefs[0] !== canvas.ref) throw new Error('CANDIDATE_EVIDENCE_INVALID')
  const visual = await readVisual(page, candidate.name, signal)
  return { page: broker.currentPage(), resumeText: visual.text, truncated: false, foregroundSource: visual.text,
    evidence: { kind: 'visual' as const, imageHashes: visual.imageHashes, pages: visual.pages } }
}

/** BOSS opens a modal in the recommendation frame; its full body can be a
 * separate Canvas iframe. Neither the list card nor the side overview is a resume. */
export class BossResumeDriver {
  private readonly browser: SourcingBrowser
  private listFrameId = 0
  private detailFrameId?: number
  private detailSeen = false
  private opened?: SourcingCard
  private ownerTabId?: number
  constructor(private readonly context: SourcingDriverContext) { this.browser = new SourcingBrowser(context.broker, context.signal) }
  private async frames() {
    const value: any = await this.browser.execute('browser_list_frames', { tabId: this.browser.page().tabId })
    return (Array.isArray(value) ? value : value?.frames ?? []) as any[]
  }
  private async snapshot(frameId: number, viewportOnly = false) {
    await this.browser.execute('browser_snapshot', { tabId: this.browser.page().tabId, frameId, format: 'dom', viewportOnly })
    return this.browser.page()
  }
  private release() {
    this.detailFrameId = undefined; this.detailSeen = false; this.opened = undefined; this.ownerTabId = undefined
    bindings.delete(this.context.broker)
  }
  hasOpen(name?: string) { return !!this.opened && (!name || this.opened.name === name) }
  ownsPage(page: any) {
    return this.hasOpen() && page?.tabId === this.ownerTabId && resumeFrame(page)
      && (this.detailFrameId === undefined || page.frameId === this.detailFrameId)
  }
  /** A previous task can leave a Canvas modal without any dialog metadata.
   * Close only its inspected shell; never adopt its candidate or image body. */
  async dismissExisting() {
    if (this.opened) throw new SourcingHandoff('boss_resume_owner_pending')
    const frames = (await this.frames()).filter(resumeFrame)
    if (!frames.length) return false
    requireSingle(frames, 'boss_resume_frame_ambiguous')
    this.listFrameId = this.browser.page().frameId ?? 0
    await this.closeModal()
    return true
  }
  async open(card: SourcingCard) {
    const page = this.browser.page()
    assertCandidateQuote(page, { ref: card.ref, name: card.name, evidenceRefs: card.evidenceRefs })
    if ((await this.frames()).some(resumeFrame)) throw new SourcingHandoff('boss_resume_already_open')
    await this.context.broker.inspectRefs(page, [card.openRef], this.context.signal, true, true)
    const detail = this.context.broker.getInspection(page, card.openRef)
    const roots = [detail?.element, ...(detail?.ancestors ?? [])].filter(node => node?.ref && hasClass(node, 'card-inner') && page.items.some((item: any) => item.ref === node.ref))
    const anchor = page.items.find((item: any) => item.ref === card.openRef)
    const target = roots.length === 1 ? roots[0].ref : anchor?.role === 'link' && anchor.href ? anchor.ref : undefined
    if (!target) throw new SourcingHandoff('boss_resume_entry_unverified')
    await this.context.broker.inspectRefs(page, [target], this.context.signal, true, true)
    this.opened = card; this.ownerTabId = page.tabId; this.listFrameId = page.frameId ?? 0; this.detailFrameId = undefined; this.detailSeen = false
    bindings.delete(this.context.broker)
    await this.browser.click(target)
    return this.resume(card.name)
  }
  async resume(name: string): Promise<ResumeLocator> {
    if (!this.opened || this.opened.name !== name) throw new SourcingHandoff('boss_resume_owner_missing')
    if (this.ownerTabId !== this.browser.page().tabId) throw new SourcingHandoff('boss_resume_owner_page_changed')
    if (this.detailFrameId !== undefined && !(await this.frames()).some(frame => frame.frameId === this.detailFrameId && resumeFrame(frame))) {
      const list = await this.snapshot(this.listFrameId, true)
      if (!list.dialogs?.length && !(await this.frames()).some(resumeFrame)) {
        this.release()
        throw new SourcingHandoff('resume_closed')
      }
      throw new SourcingHandoff('boss_resume_frame_changed')
    }
    for (const ms of [0, 200, 400, 800, 1600, 2400]) {
      if (ms) await delay(ms, undefined, { signal: this.context.signal })
      const page = await this.snapshot(this.detailFrameId ?? this.listFrameId)
      const dialogs = (page.dialogs ?? []).filter((dialog: any) => normalized(dialog.text).includes(normalized(name)) && /工作经历|工作经验|工作履历|项目经历|项目经验/.test(dialog.text))
      if (dialogs.length) {
        const dialog = requireSingle<any>(dialogs, 'boss_resume_detail_ambiguous')
        if (!page.items.some((item: any) => item.ref === dialog.ref && readable(item))) throw new SourcingHandoff('boss_resume_identity_missing')
        this.detailSeen = true
        return { tabId: page.tabId, snapshotId: page.snapshotId, identityRef: dialog.ref, resumeRefs: [dialog.ref] }
      }
      if (this.detailFrameId && resumeFrame(page)) {
        const canvases = page.items.filter((item: any) => readable(item) && item.tagName === 'canvas' && item.bounds?.width > 0 && item.bounds?.height > 0)
        if (canvases.length === 1 && page.frameInteraction === 'same-origin') {
          bindings.set(this.context.broker, { name, frameId: page.frameId, documentId: page.documentId })
          this.detailSeen = true
          return { tabId: page.tabId, snapshotId: page.snapshotId, identityRef: canvases[0].ref, resumeRefs: [canvases[0].ref] }
        }
      } else {
        const frames = (await this.frames()).filter(resumeFrame)
        if (frames.length) { this.detailFrameId = requireSingle<any>(frames, 'boss_resume_frame_ambiguous').frameId; continue }
        if (this.detailSeen && !page.dialogs?.length) {
          this.release()
          throw new SourcingHandoff('resume_closed')
        }
      }
    }
    throw new SourcingHandoff('boss_resume_detail_not_loaded')
  }
  async close() {
    if (!this.opened) return
    await this.closeModal(this.opened.name)
  }
  private async closeModal(name?: string) {
    if (this.ownerTabId !== undefined && this.ownerTabId !== this.browser.page().tabId) throw new SourcingHandoff('boss_resume_owner_page_changed')
    // A long recommendation list can truncate the modal shell out of a full
    // DOM snapshot. The close control must be visible to be clicked anyway.
    const page = await this.snapshot(this.listFrameId, true)
    if (!page.dialogs?.length && !(await this.frames()).some(resumeFrame)) {
      this.release()
      return
    }
    const dialogs = name ? (page.dialogs ?? []).filter((dialog: any) => normalized(dialog.text).includes(normalized(name))) : []
    const known = dialogs.flatMap((dialog: any) => dialog.closeRef ? [dialog.closeRef] : [])
    let closeRef: string
    if (known.length === 1) closeRef = known[0]
    else {
      const candidates = page.items.filter((item: any) => readable(item) && item.tagName === 'div' && !normalized(item.name)
        && item.bounds?.width > 0 && item.bounds.width <= 48 && item.bounds.height > 0 && item.bounds.height <= 48)
      await this.context.broker.inspectRefs(page, candidates.map((item: any) => item.ref), this.context.signal, true, true)
      closeRef = requireSingle<any>(candidates.filter((item: any) => bossResumeClose(page, item.ref, this.context.broker)), 'boss_resume_close_ambiguous').ref
    }
    await this.browser.click(closeRef)
    for (const ms of [0, 100, 200, 400]) {
      if (ms) await delay(ms, undefined, { signal: this.context.signal })
      const current = await this.snapshot(this.listFrameId, true)
      if (!current.dialogs?.length && !(await this.frames()).some(resumeFrame)) {
        this.release(); return
      }
    }
    throw new SourcingHandoff('boss_resume_close_unconfirmed')
  }
}
