import type { Platform, PlatformCandidateIdentity, TaskResult } from '../shared/workbench.js'
import { hash } from './store.js'
import { normalized } from './page-actions.js'

export const platformIdentityKey = (platform: Platform, identity: PlatformCandidateIdentity) => hash([platform, identity.kind, identity.id])
export const greetingIdentityAliases = (platform: Platform, profile: string, quote: string) =>
  [...new Set([hash([platform, normalized(quote)]), ...(profile ? [hash([platform, profile])] : [])])]

/** Masked display names never join histories. Conflicting platform IDs take
 * precedence over old text hashes, which may represent identical summaries. */
export function sameGreetingIdentity(a: TaskResult, b: TaskResult) {
  if (a.platformIdentity && b.platformIdentity) return a.platformIdentity.kind === b.platformIdentity.kind && a.platformIdentity.id === b.platformIdentity.id
  const keys = new Set([a.key, ...(a.identityAliases ?? [])])
  return [b.key, ...(b.identityAliases ?? [])].some(key => keys.has(key))
}

/** Legacy succeeded rows predate clickedAt. Explicit unknown remains protected. */
export function greetingOutcome(row: TaskResult): 'recorded' | 'uncertain' | undefined {
  if (row.stage === 'unknown') return 'uncertain'
  if (row.stage === 'succeeded' || row.clickedAt || row.confirmedAt || (row as any).knownContacted) return 'recorded'
  if (row.attemptedAt || row.stage === 'sending' && !('candidateKey' in row)) return 'uncertain'
}
