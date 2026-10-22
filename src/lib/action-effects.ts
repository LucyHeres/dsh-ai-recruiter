import { normalized, statesOf } from './page-actions.js'

const controlRoles = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox',
  'checkbox', 'radio', 'combobox', 'textbox', 'searchbox', 'option', 'switch'])
const identity = (item: any) => JSON.stringify([item.role, normalized(item.name), item.elementId ?? '', item.href ?? ''])
const summarize = (item: any) => ({ ref: item.ref, role: item.role, name: String(item.name ?? '').slice(0, 200),
  ...(item.value === undefined ? {} : { value: String(item.value).slice(0, 200) }),
  states: statesOf(item) })

/** Changes describe observed UI only. They never certify message delivery or
 * business completion. All returned refs belong to the new snapshot. */
export function actionEffects(before: any, after: any, ref: unknown, receipt: any) {
  if (!before || !after || before.tabId !== after.tabId || before.snapshotId === after.snapshotId) return undefined
  const sameDocument = before.url === after.url && (!before.documentId || !after.documentId || before.documentId === after.documentId)
  const old = before.items?.find((item: any) => item.ref === ref)
  const matches = old && sameDocument ? (after.items ?? []).filter((item: any) => identity(item) === identity(old)) : []
  const counts = new Map<string, number>()
  for (const item of sameDocument ? before.items ?? [] : []) {
    if (controlRoles.has(item.role) && !statesOf(item).some(state => ['hidden', 'invisible', 'blocked_by_dialog'].includes(state))) counts.set(identity(item), (counts.get(identity(item)) ?? 0) + 1)
  }
  const added: any[] = []
  for (const item of after.items ?? []) {
    if (!item.ref || !controlRoles.has(item.role) || statesOf(item).some(state => ['hidden', 'invisible', 'blocked_by_dialog'].includes(state))) continue
    const key = identity(item), count = counts.get(key) ?? 0
    if (count) counts.set(key, count - 1)
    else added.push(summarize(item))
  }
  const verification = receipt?.verification ?? receipt?.output?.verification ?? {}
  const changed = receipt?.output?.changed ?? receipt?.changed
  return { tabId: after.tabId, snapshotId: after.snapshotId,
    ...(typeof changed === 'boolean' ? { changed } : {}),
    urlChanged: verification.urlChanged ?? before.url !== after.url,
    ...(matches.length === 1 ? { target: summarize(matches[0]) } : {}),
    addedControls: added.slice(0, 12), omittedAddedControls: Math.max(0, added.length - 12),
    dialogs: (after.dialogs ?? []).slice(0, 4).map((dialog: any) => ({ ref: dialog.ref,
      name: String(dialog.name ?? '').slice(0, 200), closeRef: dialog.closeRef })),
  }
}
