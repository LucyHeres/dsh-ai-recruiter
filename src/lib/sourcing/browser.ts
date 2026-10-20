import type { AgentBrowserTools } from '../agent-browser-tools.js'

/** A known route may hand off only before an ambiguous write. This error carries
 * a stable reason, never a replay instruction or private page text. */
export class SourcingHandoff extends Error {
  constructor(readonly reason: string) { super(`SOURCING_HANDOFF: ${reason}`) }
}
export const requireSingle = <T>(items: T[], reason: string): T => {
  if (items.length !== 1) throw new SourcingHandoff(reason)
  return items[0]!
}
/** The fast executor uses exactly the same broker/policies as the AI fallback. */
export class SourcingBrowser {
  constructor(readonly broker: AgentBrowserTools, readonly signal: AbortSignal) {}
  page() {
    this.signal.throwIfAborted()
    const page = this.broker.currentPage()
    if (!page?.snapshotId) throw new SourcingHandoff('page_missing')
    return page
  }
  async execute(name: string, args: Record<string, unknown>) {
    this.signal.throwIfAborted()
    const tool = this.broker.tools.find(tool => tool.name === name)
    if (!tool) throw new SourcingHandoff('browser_capability_missing')
    return tool.execute(args, this.signal)
  }
  locator(ref: string) { const page = this.page(); return { tabId: page.tabId, snapshotId: page.snapshotId, ref } }
  async snapshot(format?: 'dom' | 'semantic', viewportOnly?: boolean) {
    await this.execute('browser_snapshot', { tabId: this.page().tabId, ...(format ? { format } : {}), ...(viewportOnly === undefined ? {} : { viewportOnly }) })
    return this.page()
  }
  async click(ref: string) {
    await this.execute('browser_click', { ...this.locator(ref), purpose: 'navigation' })
    return this.page()
  }
}
