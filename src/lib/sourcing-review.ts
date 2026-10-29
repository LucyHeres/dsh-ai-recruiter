import { sourcingMinimumScore, sourcingTotalTarget, sourcingCandidateQualified, sourcingQualifiedCount } from '../shared/sourcing-score.js'
import { greetingRows } from './greeting-history.js'
import { hash } from './store.js'
import { taskResultRows } from '../shared/greeting-results.js'
import { platformIdentityKey } from './candidate-identity.js'
import { hasGreeted } from '../shared/communication.js'
import { candidateListProfile } from './candidate-list-profile.js'
import { candidateResumeReceipt, type CandidateContact } from './candidate-contact.js'
import { candidateAttachments, type ReceivedResumeRecord } from './received-resume-store.js'
import type { WorkbenchJob, TaskKind } from '../shared/workbench.js'
import type { SourcingCandidate, SourcingJob } from '../shared/sourcing.js'
import type { TaskHistoryPage } from '../shared/task-history.js'

/** Join only observed completed greetings using exact platform identities. */
export function communicationIndex(jobs: WorkbenchJob[], contacts: CandidateContact[] = []) {
  const index = new Map<string, 'recorded'>()
  for (const contact of contacts) if (contact.greetedAt) for (const key of contact.identityKeys) index.set(key, 'recorded')
  for (const job of jobs) for (const row of greetingRows([job])) {
    if (!hasGreeted(row)) continue
    const platform = (row as any).platform ?? job.platform
    const keys = [
      ...((row as any).candidateKey ? [`${platform}:candidate:${(row as any).candidateKey}`] : []),
      ...(row.platformIdentity ? [platformIdentityKey(platform, row.platformIdentity)] : []),
      ...(row.identityKind === 'url' ? [row.key] : []),
    ]
    for (const key of keys) index.set(key, 'recorded')
  }
  return index
}
export function candidateCommunication(candidate: SourcingCandidate, index: ReturnType<typeof communicationIndex>): NonNullable<SourcingCandidate['communication']> {
  const direct = [candidate.key, ...(candidate.identityAliases ?? [])].map(key => index.get(`${candidate.platform}:candidate:${key}`)).find(Boolean)
  if (direct) return direct
  if (candidate.platformIdentity) return index.get(platformIdentityKey(candidate.platform, candidate.platformIdentity)) ?? 'none'
  if (!candidate.profileUrl) return 'none'
  return index.get(hash([candidate.platform, candidate.profileUrl])) ?? 'none'
}
function displayListProfile(candidate: SourcingCandidate) {
  const parsed = candidateListProfile(candidate.resumeText, '', candidate.platform), saved = candidate.listProfile
  return { ...parsed, ...saved, ...(saved?.expectation || parsed.expectation ? { expectation: saved?.expectation ?? parsed.expectation } : {}),
    work: saved?.work.length ? saved.work : parsed.work, education: saved?.education.length ? saved.education : parsed.education }
}
export function taskHistoryPage(jobs: WorkbenchJob[], page: number, kind?: TaskKind): TaskHistoryPage {
  const ordered = jobs.filter(job => !job.historyCleared && (!kind || job.kind === kind)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const pageSize = 20, lastPage = Math.max(1, Math.ceil(ordered.length / pageSize)), current = Math.min(page, lastPage)
  return { total: ordered.length, page: current, pageSize, records: ordered.slice((current - 1) * pageSize, current * pageSize).map(job => {
    const source = job.kind === 'talent_sourcing' ? job as SourcingJob : undefined
    return { id: job.id, kind: job.kind, platform: job.platform, jobId: source?.jobId, jobName: source?.position?.name || job.jobName || job.platformJobName || job.destinationLabel || '',
      status: job.status, createdAt: job.createdAt, completed: source ? source.talentCleared ? source.clearedCandidateCount ?? 0 : sourcingQualifiedCount(source) : taskResultRows(job).filter(row => job.kind === 'greeting' ? hasGreeted(row) : row.stage === 'succeeded').length, limit: source ? sourcingTotalTarget(source) : job.limit }
  }) }
}

export function sourcingResults(jobs: SourcingJob[], jobId: string, roundId: string, communications: ReturnType<typeof communicationIndex>, contacts: CandidateContact[] = [], attachments: ReceivedResumeRecord[] = []): import('../shared/sourcing.js').SourcingResults {
  const ordered = jobs.filter(job => job.kind === 'talent_sourcing' && job.jobId === jobId && !job.talentCleared)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const selected = roundId === 'all' ? undefined : ordered.find(job => job.id === roundId)
  if (roundId !== 'all' && !selected) throw new Error('该职位下没有这轮寻聘记录')
  const rounds = ordered.map((job, index) => ({ id: job.id, jobId, number: ordered.length - index, createdAt: job.createdAt, updatedAt: job.updatedAt, status: job.status, limit: sourcingTotalTarget(job), candidateCount: sourcingQualifiedCount(job) }))
  const roundNumbers = new Map(rounds.map(round => [round.id, round.number]))
  const run = selected ?? ordered.find(job => ['running', 'queued', 'stopping'].includes(job.status)) ?? ordered[0]
  const seen = new Set<string>()
  const visibleCandidates = (selected ? [selected] : ordered).flatMap(job => job.candidates.filter(candidate => {
    if (!sourcingCandidateQualified(candidate, sourcingMinimumScore(job)) || !selected && seen.has(candidate.key)) return false
    seen.add(candidate.key); return true
  }).map(candidate => ({
    minimumScore: sourcingMinimumScore(job), key: candidate.key, resultKey: `${job.id}:${candidate.key}`, roundId: job.id, roundNumber: roundNumbers.get(job.id)!, roundCreatedAt: job.createdAt,
    name: candidate.name, platform: candidate.platform, fields: candidate.fields,
    listProfile: displayListProfile(candidate),
    score: candidate.score, coverage: candidate.coverage, ...(candidate.scoring ? { scoring: candidate.scoring } : {}),
    collectedAt: candidate.collectedAt, communication: candidateCommunication(candidate, communications), ...candidateResumeReceipt(candidate, contacts), resumeAttachments: candidateAttachments(candidate, jobId, attachments),
  })))
  return { jobId, roundId, rounds, current: run ? {
    id: run.id, jobId, status: run.status, phase: run.phase, createdAt: run.createdAt, updatedAt: run.updatedAt, limit: run.limit, limitScope: run.limitScope, platforms: run.platforms, sourceMode: run.sourceMode, searchFilters: run.searchFilters,
    minimumScore: sourcingMinimumScore(run), detail: run.detail, channels: run.channels, position: run.position, requirements: run.requirements, supplement: run.supplement, candidateCount: sourcingQualifiedCount(run), autoGreet: run.autoGreet, greetings: run.greetings, scanned: run.scanned, skippedLowScore: run.skippedLowScore, skippedByFilters: run.skippedByFilters, skippedUnverified: run.skippedUnverified, events: run.events,
  } : undefined,
  candidates: visibleCandidates }
}
