import type { Platform, WorkbenchJob, TaskResult, JobOption, PublishedChannel, PlatformCandidateIdentity } from './workbench.js'

export interface SourcingPosition {
  id: string; name: string; department: string; city: string; description: string; descriptionHtml?: string; fetchedAt: string
  searchFields?: SourcingSearchFilters
  /** Current main-system job channel associations, never inferred from past tasks. */
  platforms?: Platform[]
  publishedChannels?: PublishedChannel[]
}
export interface SourcingSearchFilters { city?: string; experience?: string; education?: string }
export interface SourcingCriterion { id: string; label: string; quote: string; must: boolean; weight: number }
export interface SourcingRequirements { keyword: string; criteria: SourcingCriterion[] }
export interface SourcingAssessment {
  criterionId: string; state: 'match' | 'partial' | 'mismatch' | 'unknown'; quote: string; reason: string
}
export interface SourcingCandidate {
  key: string; name: string; platform: Platform; profileUrl: string; sourceUrl: string; collectedAt: string
  platformIdentity?: PlatformCandidateIdentity
  communication?: 'recorded' | 'uncertain' | 'none' | 'unknown'
  scope: 'summary' | 'online'; fields: { label: string; value: string }[]; resumeText: string
  resumeTruncated?: boolean
  assessments: SourcingAssessment[]; filterAssessments?: { field: 'city' | 'education' | 'experience'; state: 'match' | 'mismatch' | 'unknown'; quote: string; reason: string }[]; score: number; coverage: number
  verdict: 'recommended' | 'review' | 'unqualified'; analysis: string
}
export interface SourcingJob extends WorkbenchJob {
  kind: 'talent_sourcing'; jobId: string; position?: SourcingPosition; supplement: string
  platforms: Platform[]; sourceMode?: 'recommend' | 'search'; requirements?: SourcingRequirements; requirementVersion?: string
  limitScope?: 'per_platform'; searchFilters?: SourcingSearchFilters
  minimumScore?: number; autoGreet?: boolean; greetings?: SourcingGreeting[]; scanned?: number; skippedLowScore?: number; skippedByFilters?: number; skippedUnverified?: number
  platformJobs?: Partial<Record<Platform, { id: string; name: string }[]>>
  candidates: SourcingCandidate[]
  channels: { platform: Platform; status: 'queued' | 'running' | 'completed' | 'stopped' | 'failed'; detail: string; candidateCount?: number; limit?: number }[]
}

export interface SourcingRound {
  id: string; jobId: string; number: number; createdAt: string; updatedAt: string
  status: SourcingJob['status']; limit: number; candidateCount: number
}
export type SourcingRun = Pick<SourcingJob, 'id' | 'jobId' | 'status' | 'phase' | 'createdAt' | 'updatedAt' | 'limit' | 'limitScope' | 'platforms' | 'sourceMode' | 'searchFilters' | 'detail' | 'channels' | 'position' | 'requirements' | 'supplement' | 'minimumScore' | 'autoGreet' | 'greetings' | 'scanned' | 'skippedLowScore' | 'skippedByFilters' | 'skippedUnverified' | 'events'> & { candidateCount: number }
/** Lists carry identity/score metadata only; a selected evaluation loads its own evidence. */
export type SourcingResultCandidate = Pick<SourcingCandidate, 'key' | 'name' | 'platform' | 'fields' | 'score' | 'coverage' | 'collectedAt' | 'communication'> & {
  minimumScore?: number; resultKey: string; roundId: string; roundNumber: number; roundCreatedAt: string
}
export interface SourcingResults {
  jobId: string; roundId: string; rounds: SourcingRound[]; candidates: SourcingResultCandidate[]; current?: SourcingRun
}
export interface SourcingCandidateDetail {
  jobId: string; roundId: string; candidate: SourcingCandidate; position?: SourcingPosition; requirements?: SourcingRequirements; supplement: string
}

export interface SourcingGreeting extends TaskResult { candidateKey: string; platform: Platform; knownContacted?: boolean }
export interface PositionOverview extends JobOption { candidateCount: number; greetedCount: number; resumeCount: number; importedCount: number; activeKind?: WorkbenchJob['kind'] }
