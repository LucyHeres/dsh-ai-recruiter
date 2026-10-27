import { sourcingMinimumScore, sourcingCandidateQualified } from '../shared/sourcing-score.js'
import { hasGreeted } from '../shared/communication.js'
import { greetingRows } from './greeting-history.js'
import { candidateContactKeys, candidateResumeReceipt, type CandidateContact } from './candidate-contact.js'
import { matchesReceivedResume, type ReceivedResumeRecord } from './received-resume-store.js'
import { candidateCommunication, communicationIndex } from './sourcing-review.js'
import { platformIdentityKey } from './candidate-identity.js'
import type { JobOption, WorkbenchJob } from '../shared/workbench.js'
import type { SourcingJob, SourcingGreeting, PositionOverview } from '../shared/sourcing.js'

type Viewed = NonNullable<SourcingJob['viewedCandidates']>[number]
const candidateKeys = (person: Viewed & { profileUrl?: string }) => candidateContactKeys({ ...person, profileUrl: person.profileUrl ?? '' }).map(key => `${person.platform}:${key}`)

/** Merge verified aliases before counting a person across rounds and receipts. */
function identities() {
  const parents = new Map<string, string>()
  const root = (key: string): string => {
    const parent = parents.get(key)
    if (!parent || parent === key) return key
    const canonical = root(parent); parents.set(key, canonical); return canonical
  }
  const link = (keys: string[]) => {
    const canonical = root(keys[0])
    for (const key of keys) parents.set(root(key), canonical)
    return keys[0]
  }
  return { root, link }
}

export function positionOverview(options: JobOption[], tasks: WorkbenchJob[], activeId?: string,
  contacts: CandidateContact[] = [], resumes: ReceivedResumeRecord[] = []): PositionOverview[] {
  const cleared = tasks.some(task => task.talentCleared)
  return options.map(position => {
    const related = tasks.filter(task => task.jobId === position.id)
    const current = related.filter(task => !task.talentCleared)
    const sources = current.filter((task): task is SourcingJob => task.kind === 'talent_sourcing')
    const candidates = sources.flatMap(task => task.candidates ?? [])
    const identity = identities()
    const candidateId = (person: Viewed & { profileUrl?: string }) => identity.link(candidateKeys(person))
    const viewed = sources.flatMap(task => [...(task.viewedCandidates ?? []), ...(task.candidates ?? [])]).map(candidateId)
    const qualified = sources.flatMap(task => (task.candidates ?? []).filter(person => sourcingCandidateQualified(person, sourcingMinimumScore(task)))).map(candidateId)
    const talentIdentities = viewed.slice()
    const greeted: string[] = []
    for (const task of current) for (const row of greetingRows([task])) {
      const linked = row as Partial<SourcingGreeting>, platform = linked.platform ?? task.platform
      const keys = [row.key, ...(row.identityAliases ?? []),
        ...(linked.candidateKey ? [`${platform}:candidate:${linked.candidateKey}`] : []),
        ...(row.platformIdentity ? [platformIdentityKey(platform, row.platformIdentity)] : [])].map(key => `${platform}:${key}`)
      const key = identity.link(keys)
      // Older cleanup versions left standalone greeting receipts unmarked.
      // They describe current talent only when a retained identity still exists.
      if (task.kind === 'greeting' && cleared && !talentIdentities.some(person => identity.root(person) === identity.root(key))) continue
      if (task.kind === 'greeting') viewed.push(key)
      if (hasGreeted(row)) greeted.push(key)
    }
    const communications = communicationIndex(current, contacts)
    const received = candidates.filter(person => candidateResumeReceipt(person, contacts).resumeReceived
      || resumes.some(row => matchesReceivedResume(person, row))).map(candidateId)
    for (const person of candidates) if (person.communication === 'recorded' || candidateCommunication(person, communications) === 'recorded') greeted.push(candidateId(person))
    const count = (keys: string[]) => new Set(keys.map(identity.root)).size
    // Old executions retained only a total for rejected list cards. Keep that
    // observed total; new executions retain identities and deduplicate reads.
    const legacyReads = sources.reduce((total, task) => total + (task.viewedCandidates === undefined && Number.isInteger(task.scanned)
      ? Math.max(0, task.scanned! - count((task.candidates ?? []).map(candidateId))) : 0), 0)
    return { ...position, viewedCount: count(viewed) + legacyReads, candidateCount: count(qualified),
      greetedCount: count(greeted), resumeCount: count(received),
      importedCount: related.filter(task => task.kind === 'resume_import').flatMap(task => task.results).filter(row => row.stage === 'succeeded').length,
      activeKind: related.find(task => task.id === activeId)?.kind }
  })
}
