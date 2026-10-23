import { safePageUrl, statesOf, itemText, normalized } from './page-actions.js'
import { pageTextEvidenceRef, dialogEvidenceRef } from './page-evidence.js'

export interface ObservationSlice { offset?: number; limit?: number; query?: string; compact?: boolean }
/** Bounded, resumable observation. The full task-bound snapshot remains in
 * the host. Browser tools resolve actionability when dispatching an input. */
export function modelPageObservation(page: any, slice: ObservationSlice = {}) {
  if (page?.representation === 'semantic-v1') return page
  const all = Array.isArray(page?.items) ? page.items : []
  const compact = slice.compact === true
  const treeBudget = compact ? 18000 : 28000, resultBudget = compact ? 26000 : 48000
  const dialogs = Array.isArray(page?.dialogs) ? page.dialogs : []
  const foreground = new Set(dialogs.map((item: any) => item.ref))
  const dismissal = (item: any) => !statesOf(item).some(state => ['blocked_by_dialog', 'occluded', 'disabled'].includes(state))
    && /^(?:关闭|close(?:[-_ ](?:circle|outline))?|×|✕)$/i.test(normalized(item.name))
  const rank = (item: any) => foreground.has(item.ref) || foreground.has(item.dialogRef) ? 0
    : statesOf(item).includes('focused') || dismissal(item) ? 1 : statesOf(item).some(state => ['blocked_by_dialog', 'occluded'].includes(state)) ? 4 : 2
  const query = String(slice.query ?? '').normalize('NFKC').toLocaleLowerCase().trim()
  const items = all.filter((item: any) => !statesOf(item).some(state => ['hidden', 'invisible'].includes(state)))
    .filter((item: any) => !query || `${itemText(item)} ${item.description ?? ''}`.normalize('NFKC').toLocaleLowerCase().includes(query))
    .slice().sort((a: any, b: any) => rank(a) - rank(b))
  const offset = Math.min(slice.offset ?? 0, items.length), limit = slice.limit ?? items.length
  const byRef = new Map(all.filter((item: any) => item.ref).map((item: any) => [item.ref, item]))
  const contexts: Record<string, string> = {}, contextIds = new Map<string, string>(), lines: string[] = []
  let chars = 0, contextChars = 0, returned = 0
  for (const item of items.slice(offset, offset + limit)) {
    let depth = 0, parent = item.parentRef
    const seen = new Set()
    while (parent && !seen.has(parent) && depth < 12) { seen.add(parent); depth++; parent = (byRef.get(parent) as any)?.parentRef }
    const text = String(item.context?.text ?? '').slice(0, compact ? 1200 : 2400)
    let contextRef = contextIds.get(text)
    if (text && !contextRef && contextChars + text.length <= (compact ? 6000 : 10000)) contextRef = `c${contextIds.size + 1}`
    const info = [item.ref ? `[ref=${item.ref}]` : '', statesOf(item).join(','),
      item.parentRef ? `parent=${item.parentRef}` : '', item.dialogRef ? `dialog=${item.dialogRef}` : '',
      !compact && item.bounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(item.bounds[key]))
        ? `bounds=${item.bounds.x},${item.bounds.y},${item.bounds.width},${item.bounds.height}` : '',
      !compact && item.elementId ? `id=${JSON.stringify(item.elementId)}` : '', item.controls ? `controls=${item.controls}` : '',
      item.hasPopup ? `popup=${item.hasPopup}` : '', contextRef ? `context=${contextRef}` : '',
      item.description ? `description=${JSON.stringify(String(item.description).slice(0, compact ? 200 : 800))}` : '',
      item.href ? `href=${JSON.stringify(safePageUrl(item.href))}` : '',
      item.value !== undefined ? `value=${JSON.stringify(String(item.value).slice(0, 800))}` : ''].filter(Boolean).join(' ')
    const line = `${'  '.repeat(Math.min(depth, compact ? 4 : 12))}${item.role} ${JSON.stringify(String(item.name ?? '').slice(0, compact ? 500 : 1200))} ${info}`
    if (chars + line.length > treeBudget) break
    if (text && contextRef && !contextIds.has(text)) { contextIds.set(text, contextRef); contexts[contextRef] = text; contextChars += text.length }
    lines.push(line); chars += line.length; returned++
  }
  const next = offset + returned, omitted = items.length - returned
  const result = { representation: 'semantic-v1', url: safePageUrl(page?.url), snapshotId: page?.snapshotId, format: page?.format ?? 'dom', viewport: page?.viewport,
    ...(Number.isInteger(page?.frameId) ? { frameId: page.frameId } : {}),
    ...(page?.tabUrl ? { tabUrl: safePageUrl(page.tabUrl) } : {}),
    ...(['same-origin', 'unsupported'].includes(page?.frameInteraction) ? { frameInteraction: page.frameInteraction } : {}),
    tree: lines.join('\n'), ...(Object.keys(contexts).length ? { contexts } : {}),
    ...(page?.format !== 'semantic' && page?.text && offset === 0 ? { text: String(page.text).slice(0, compact ? 2000 : 4000), textEvidenceRef: pageTextEvidenceRef } : {}),
    truncated: !!page?.truncated || omitted > 0, omittedElementCount: (page?.omittedElementCount ?? 0) + omitted,
    coverage: { detail: compact ? 'compact' : 'full', totalElements: all.length, matchingElements: items.length, offset, returnedElements: returned,
      nextOffset: next < items.length ? next : null, query: query || undefined, sourceTruncated: !!page?.truncated, source: page?.coverage },
    ...(dialogs.length ? { dialogs: dialogs.slice(0, 8).map((item: any, index: number) => ({ ref: item.ref, evidenceRef: dialogEvidenceRef(index), role: item.role,
      name: String(item.name ?? '').slice(0, 500), text: String(item.text ?? '').slice(0, 2400), closeRef: item.closeRef })),
      omittedDialogCount: Math.max(0, dialogs.length - 8) } : {}) }
  // Bound the complete encoded tool result, including metadata and escaping.
  // Remove only whole lines so the next slice can recover every omitted ref.
  if (JSON.stringify(result).length > resultBudget) {
    if ('text' in result) result.text = ''
    if (result.dialogs) result.dialogs = result.dialogs.map((dialog: any) => ({ ...dialog, text: dialog.text.slice(0, 600), name: dialog.name.slice(0, 200) }))
    while (lines.length && JSON.stringify(result).length > resultBudget) {
      lines.pop(); returned--
      result.tree = lines.join('\n'); result.truncated = true
      result.omittedElementCount = (page?.omittedElementCount ?? 0) + items.length - returned
      result.coverage.returnedElements = returned
      result.coverage.nextOffset = offset + returned < items.length ? offset + returned : null
    }
  }
  return result
}

export function modelObservation(observation: Record<string, unknown>) {
  const { page, recentActions, ...rest } = observation
  return { ...rest, ...(page ? { page: modelPageObservation(page, { compact: true }) } : {}),
    ...(Array.isArray(recentActions) ? { recentActions: recentActions.slice(-8).map(({ action, ref, target, outcome, receipt }) => ({ action, ref, target, outcome, receipt })) } : {}) }
}
