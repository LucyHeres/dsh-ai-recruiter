import type { AgentBrowserTools } from '../agent-browser-tools.js'
import type { BrowserAgentRunner } from '../host-browser-agent.js'
import type { BrowserAgentTool } from '../browser-agent.js'
import type { SourcingJob } from '../../shared/sourcing.js'
import type { PlatformCandidateIdentity } from '../../shared/workbench.js'
import type { z } from 'zod'
import type { sourcingSearchConfirmationSpec } from '../sourcing-search.js'
import type { sourcingGreetingSpec } from '../sourcing-greeting.js'

export type SearchConfirmation = z.infer<typeof sourcingSearchConfirmationSpec>
export type ResumeLocator = { tabId: number; snapshotId: string; identityRef: string; resumeRefs: string[] }
/** A source is immutable during assessment. Its key binds the model result to
 * one captured candidate, independently of changing browser refs. */
export type SourcingCard = { sourceId: string; name: string; text: string; ref: string; openRef: string; evidenceRefs: string[]; profileRef?: string }
export type SourcingDriverContext = { broker: AgentBrowserTools; job: SourcingJob; signal: AbortSignal; progress?: (message: string) => Promise<void> }
export interface SourcingDriver {
  recognizes(): Promise<boolean>
  prepareSearch(): Promise<SearchConfirmation>
  cards(options?: { refresh?: boolean }): Promise<SourcingCard[]>
  open(card: SourcingCard): Promise<ResumeLocator>
  resume(name: string): Promise<ResumeLocator>
  /** Task-owned detail, including Canvas frames without dialog metadata. */
  hasOpenResume?(name?: string): boolean
  returnToList(): Promise<SearchConfirmation | void>
  advance(): Promise<{ exhaustion?: { tabId: number; snapshotId: string; ref: string; quote: string } }>
  greeting(name: string, candidateKey: string): Promise<z.infer<typeof sourcingGreetingSpec>>
}
export type SourcingOperations = {
  tools: BrowserAgentTool[]
  recoveryTools(agent: BrowserAgentRunner): BrowserAgentTool[]
  preview(card: SourcingCard, signal: AbortSignal): Promise<{ text: string; duplicate: boolean; candidateKey?: string }>
  complete(): boolean
  remaining(): number
  progress?(message: string): Promise<void>
  state(): { searchReady: boolean; pending?: string; needsGreeting: boolean; candidateKey?: string;
    selectedCandidate?: { candidateKey: string; name: string; platformIdentity?: PlatformCandidateIdentity; verifiedListText?: string; listEvidenceHash?: string; resumeCharacters: number; stage: 'selected' | 'reading' | 'greeting' } }
  captured(): { name: string; text: string; scope: 'summary' | 'online' } | undefined
}
