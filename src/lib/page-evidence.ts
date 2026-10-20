import { itemText, normalized, statesOf } from './page-actions.js'

/** Observation evidence is not an action target. Text, accessible status and
 * foreground descriptions are valid sources even without backend DOM refs. */
export const pageTextEvidenceRef = 'evidence:page-text'
export const dialogEvidenceRef = (index: number) => `evidence:dialog:${index}`
export function readablePageEvidence(page: any): { ref: string; text: string; states: string[] }[] {
  const items = (page.items ?? []).filter((item: any) => item.ref && itemText(item)
    && !statesOf(item).some(state => ['hidden', 'invisible'].includes(state)))
    .map((item: any) => ({ ref: item.ref as string, text: itemText(item), states: statesOf(item) }))
  const dialogs = (page.dialogs ?? []).flatMap((dialog: any, index: number) => {
    const text = normalized([dialog.name, dialog.text].filter(Boolean).join(' '))
    return text ? [{ ref: dialogEvidenceRef(index), text, states: [] },
      ...(dialog.ref && !items.some((item: any) => item.ref === dialog.ref) ? [{ ref: dialog.ref, text, states: [] }] : [])] : []
  })
  const text = normalized(page.text)
  return [...items, ...dialogs, ...(text ? [{ ref: pageTextEvidenceRef, text, states: [] }] : [])]
}
