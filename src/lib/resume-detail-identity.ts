import type { SourcingCandidate } from '../shared/sourcing.js'
import { normalized, readableIdentityRef, safePageUrl } from './page-actions.js'

type DetailIdentity = { candidateKey: string; tabId: number; documentId: string; url: string; resume: string }
const compact = (text: string) => normalized(text).replace(/\s/g, '')
const foreground = (page: any) => {
  if (page.dialogs?.length !== 1) return
  const dialog = page.dialogs[0]
  try { readableIdentityRef(page, dialog.ref) } catch { return }
  return { ref: dialog.ref, text: normalized(dialog.text) }
}

/** A task-local bridge from the already verified list identity to the exact
 * resume read before evaluation. Never reconstruct this grant from history. */
export function bindResumeDetail(page: any, candidate: SourcingCandidate): DetailIdentity | undefined {
  const dialog = foreground(page), resume = normalized(candidate.resumeText)
  if (!dialog || !page.documentId || resume.length < 120 || !compact(resume).includes(compact(candidate.name))
    || !dialog.text.includes(resume) || safePageUrl(page.url) !== candidate.sourceUrl) return
  return { candidateKey: candidate.key, tabId: page.tabId, documentId: page.documentId, url: safePageUrl(page.url), resume }
}

export function matchesResumeDetail(binding: DetailIdentity | undefined, page: any, candidateKey: string, refs: string[]): boolean {
  if (!binding || binding.candidateKey !== candidateKey || binding.tabId !== page.tabId || binding.documentId !== page.documentId
    || binding.url !== safePageUrl(page.url)) return false
  const dialog = foreground(page)
  if (!dialog?.text.includes(binding.resume)) return false
  return refs.every(ref => {
    let node: any
    try { node = readableIdentityRef(page, ref) } catch { return false }
    const seen = new Set<string>()
    while (node && !seen.has(node.ref)) {
      if (node.ref === dialog.ref || node.dialogRef === dialog.ref) return true
      seen.add(node.ref)
      node = page.items?.find((item: any) => item.ref === node.parentRef)
    }
    return false
  })
}
