import type { JobOption } from '../shared/workbench.js'

/** Scoped to one plugin instance; supports mounted and newly mounted main panels. */
export function createWorkbenchNavigation() {
  let position: JobOption | undefined
  const listeners = new Set<(position: JobOption) => void>()
  return {
    current: () => position,
    clear() { position = undefined },
    visit(next: JobOption) { position = next; for (const listener of listeners) listener(next) },
    subscribe(listener: (position: JobOption) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
export type WorkbenchNavigation = ReturnType<typeof createWorkbenchNavigation>
