import type { SourcingCandidate } from '../shared/sourcing.js'
import { normalized, readableIdentityRef, safePageUrl } from './page-actions.js'

type DetailIdentity = { candidateKey: string; tabId: number; documentId: string; url: string; resume: string }
const compact = (text: string) => normalized(text).replace(/\s/g, '')
// This standalone activity hint is UI state, not candidate resume content.
// Keep every other line exact; never use fuzzy similarity to join candidates.
export const resumeDetailContent = (text: string) => normalized(String(text ?? '').split(/\r?\n/)
  .filter(line => !/^ta在线[,，]?\s*回复更快[~～!！。]*$/i.test(normalized(line))).join('\n'))
const foreground = (page: any) => {
  if (page.dialogs?.length !== 1) return
  const dialog = page.dialogs[0]
  try { readableIdentityRef(page, dialog.ref) } catch { return }
  return { ref: dialog.ref, text: resumeDetailContent(dialog.text) }
}

export function belongsToResumeDialog(page: any, ref: string, dialogRef: string): boolean {
  let node: any
  try { node = readableIdentityRef(page, ref) } catch { return false }
  const seen = new Set<string>()
  while (node && !seen.has(node.ref)) {
    if (node.ref === dialogRef || node.dialogRef === dialogRef) return true
    seen.add(node.ref)
    try { node = node.parentRef ? readableIdentityRef(page, node.parentRef) : undefined } catch { return false }
  }
  return false
}

/** A task-local bridge from the already verified list identity to the exact
 * resume read before evaluation. Never reconstruct this grant from history. */
export function bindResumeDetail(page: any, candidate: SourcingCandidate, sourceText = candidate.resumeText): DetailIdentity | undefined {
  const dialog = foreground(page), saved = resumeDetailContent(candidate.resumeText), resume = resumeDetailContent(sourceText)
  if (!dialog || !page.documentId || !compact(dialog.text).includes(compact(candidate.name)) || safePageUrl(page.url) !== candidate.sourceUrl) return
  // The evaluated text can include independently read sections beyond the
  // dialog transport cap. Only the capture hook may supply that exact source;
  // it must occur in both the evaluated text and this foreground snapshot.
  if (resume.length < 120 || !compact(resume).includes(compact(candidate.name)) || !saved.includes(resume) || !dialog.text.includes(resume)) return
  return { candidateKey: candidate.key, tabId: page.tabId, documentId: page.documentId, url: safePageUrl(page.url), resume }
}

export function matchesResumeDetail(binding: DetailIdentity | undefined, page: any, candidateKey: string, refs: string[]): boolean {
  if (!binding || binding.candidateKey !== candidateKey || binding.tabId !== page.tabId || binding.documentId !== page.documentId
    || binding.url !== safePageUrl(page.url)) return false
  const dialog = foreground(page)
  if (!dialog?.text.includes(binding.resume)) return false
  return refs.every(ref => belongsToResumeDialog(page, ref, dialog.ref))
}
