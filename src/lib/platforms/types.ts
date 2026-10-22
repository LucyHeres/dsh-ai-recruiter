import type { AgentBrowserCall, AgentBrowserTools } from '../agent-browser-tools.js'
import type { PositionEvidence, PositionOutcome } from '../position-evidence.js'
import type { GreetingJob, PlatformCandidateIdentity } from '../../shared/workbench.js'
import type { SourcingSearchFilters } from '../../shared/sourcing.js'
import type { SourcingDriver, SourcingDriverContext } from '../sourcing/types.js'

export type SearchControl = { kind: 'position' | 'position_confirm' | 'job_option' | 'filter' | 'filter_open' | 'confirm' | 'search'; field?: string; selected: boolean; active: boolean; expanded: boolean }
export type FilterProof = { field: string; ref: string; quote: string; state?: string }
export interface SearchEvidence {
  enabled(page: any): boolean
  inspect(page: any, refs: string[], signal: AbortSignal, reuse?: boolean): Promise<void>
  control(page: any, ref: string): SearchControl | undefined
  position(page: any, job: Pick<GreetingJob, 'jobId' | 'jobName' | 'platformJobs'>, proof: PositionEvidence): PositionOutcome | undefined
  scan(page: any, names: string[], expected: SourcingSearchFilters, signal: AbortSignal): Promise<void>
  completeFilterProofs<T extends FilterProof>(page: any, proofs: T[]): T[]
  filterPage(page: any, proofs: { ref: string; field: string }[]): any
  summary(page: any, expected?: SourcingSearchFilters): Record<string, unknown>
}
export interface PositionRoute {
  assertInput(call: AgentBrowserCall, page: any): void
  allowsChoice(call: AgentBrowserCall, page: any): boolean
  isSelectedTrigger(tabId: number, page: any, ref: string): boolean
  dispatch(call: AgentBrowserCall, page: any, dispatch: () => Promise<any>, verifiedTrigger?: boolean): Promise<any>
}
/** Website paths, prompts and custom controls have one owner. Workflow code
 * consumes this contract and never selects an implementation by hostname. */
export interface RecruitmentPlatform {
  candidateIdentity?(page: any, refs: string[], broker: AgentBrowserTools): PlatformCandidateIdentity | undefined
  sourcingEntry: string
  sourcingSearchEntry?: string
  sourcingHints: string
  sourcingSearchHints?: string
  observationFormat?: 'dom' | 'semantic'
  createSearchEvidence(broker: AgentBrowserTools): SearchEvidence
  createPositionRoute(names: string[], sourceMode?: 'recommend' | 'search'): PositionRoute
  createSourcingDriver?(context: SourcingDriverContext): SourcingDriver
}

/** Unsupported custom controls fall back to the common AX/DOM verifiers. */
export class StandardSearchEvidence implements SearchEvidence {
  enabled(_page: any) { return false }
  async inspect(_page: any, _refs: string[], _signal: AbortSignal) {}
  control(_page: any, _ref: string): SearchControl | undefined { return undefined }
  position(_page: any, _job: Pick<GreetingJob, 'jobId' | 'jobName' | 'platformJobs'>, _proof: PositionEvidence): PositionOutcome | undefined { return undefined }
  async scan(_page: any, _names: string[], _expected: SourcingSearchFilters, _signal: AbortSignal) {}
  completeFilterProofs<T extends FilterProof>(_page: any, proofs: T[]): T[] { return proofs }
  filterPage(page: any, _proofs: { ref: string; field: string }[]) { return page }
  summary(_page: any) { return {} }
}
export class StandardPositionRoute implements PositionRoute {
  assertInput(_call: AgentBrowserCall, _page: any) {}
  allowsChoice(_call: AgentBrowserCall, _page: any) { return false }
  isSelectedTrigger(_tabId: number, _page: any, _ref: string) { return false }
  dispatch(_call: AgentBrowserCall, _page: any, dispatch: () => Promise<any>) { return dispatch() }
}
