import { hash, type Store } from './store.js'
import { platformIdentityKey } from './candidate-identity.js'
import type { SourcingCandidate } from '../shared/sourcing.js'
import type { Platform } from '../shared/workbench.js'

export interface CandidateContact {
  platform: Platform
  identityKeys: string[]
  platformIdentityKey?: string
  greetedAt?: string
  resumeReceivedAt?: string
  checkedAt: string
  source: 'chat' | 'received_list'
}
type Candidate = Pick<SourcingCandidate, 'key' | 'platform' | 'profileUrl' | 'platformIdentity' | 'identityAliases'>

export function candidateContactKeys(candidate: Candidate): string[] {
  return [...new Set([
    ...(candidate.platformIdentity ? [platformIdentityKey(candidate.platform, candidate.platformIdentity)] : []),
    ...(candidate.profileUrl ? [hash([candidate.platform, candidate.profileUrl])] : []),
    ...[candidate.key, ...(candidate.identityAliases ?? [])].map(key => `${candidate.platform}:candidate:${key}`),
  ])]
}

export const readCandidateContacts = async (store: Store): Promise<CandidateContact[]> => await store.find<CandidateContact[]>('candidate-contacts') ?? []

function matchingContacts(candidate: Candidate, records: CandidateContact[]) {
  const keys = candidateContactKeys(candidate), identityKey = candidate.platformIdentity ? platformIdentityKey(candidate.platform, candidate.platformIdentity) : undefined
  return records.filter(row => row.platform === candidate.platform && (!identityKey || !row.platformIdentityKey || identityKey === row.platformIdentityKey)
    && row.identityKeys.some(key => keys.includes(key)))
}

/** Only affirmative website evidence updates the ledger. Missing matches,
 * truncated lists, login failures and empty chats cannot clear prior facts. */
export async function saveCandidateContact(store: Store, candidate: Candidate,
  evidence: { greeted: boolean; resumeReceived: boolean; source: CandidateContact['source'] }, checkedAt = new Date().toISOString()) {
  if (!evidence.greeted && !evidence.resumeReceived) return false
  const records = await readCandidateContacts(store), keys = candidateContactKeys(candidate)
  const existing = matchingContacts(candidate, records)
  const row: CandidateContact = { platform: candidate.platform,
    identityKeys: [...new Set([...keys, ...existing.flatMap(row => row.identityKeys)])],
    platformIdentityKey: candidate.platformIdentity ? platformIdentityKey(candidate.platform, candidate.platformIdentity) : existing.find(row => row.platformIdentityKey)?.platformIdentityKey,
    greetedAt: existing.find(row => row.greetedAt)?.greetedAt ?? (evidence.greeted ? checkedAt : undefined),
    resumeReceivedAt: existing.find(row => row.resumeReceivedAt)?.resumeReceivedAt ?? (evidence.resumeReceived ? checkedAt : undefined),
    checkedAt, source: evidence.source }
  await store.put('candidate-contacts', [...records.filter(row => !existing.includes(row)), row])
  return !existing.length || evidence.greeted && !existing.some(row => row.greetedAt) || evidence.resumeReceived && !existing.some(row => row.resumeReceivedAt)
}

export function candidateResumeReceipt(candidate: SourcingCandidate, records: CandidateContact[]) {
  const matches = matchingContacts(candidate, records)
  const receivedAt = candidate.resumeReceivedAt ?? matches.find(row => row.resumeReceivedAt)?.resumeReceivedAt
  return { resumeReceived: !!(candidate.resumeReceived || receivedAt), ...(receivedAt ? { resumeReceivedAt: receivedAt } : {}) }
}
