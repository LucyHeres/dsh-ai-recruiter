import type { Platform, WorkbenchJob, TaskResult, JobOption, PublishedChannel, PlatformCandidateIdentity } from './workbench.js'

export interface SourcingPosition {
  id: string; name: string; department: string; city: string; description: string; descriptionHtml?: string; fetchedAt: string
  /** Separate display content; description retains the complete source used for scoring. */
  jobDescription?: { text: string; html: string }
  basicRequirements?: { education?: string; experience?: string; city?: string; salary?: string }
  searchFields?: SourcingSearchFilters
  /** Current main-system job channel associations, never inferred from past tasks. */
  platforms?: Platform[]
  publishedChannels?: PublishedChannel[]
  /** Last edited settings, scoped to this position in the local workbench. */
  settings?: import('./sourcing-settings.js').SourcingSettings
}
export interface SourcingSearchFilters { city?: string; experience?: string; education?: string }
export interface SourcingCriterion {
  id: string; label: string; quote: string; must: boolean; weight: number
  /** Absent on historical rubrics, which retain their original scoring. */
  tier?: 'must' | 'core' | 'bonus' | 'verify'
}
export interface SourcingSupplementCoverage { quote: string; criterionIds: string[]; listFields: SourcingListField[]; reason?: string }
export type SourcingListField = 'age' | 'education' | 'experience' | 'city' | 'company' | 'salary'
export interface SourcingListCriterion { field: SourcingListField; requirement: string; quote: string }
export interface SourcingListAssessment { field: SourcingListField; state: 'match' | 'mismatch' | 'unknown'; quote: string; reason: string }
export interface SourcingRequirements {
  keyword: string; criteria: SourcingCriterion[]
  rubricVersion?: 2
  supplementCoverage?: SourcingSupplementCoverage[]
  /** Host-resolved basic conditions, shared by extraction, preview and detail. */
  basicFilters?: SourcingSearchFilters
  /** Absent on historical runs; new runs must explicitly define their list conditions, including an empty set. */
  listCriteria?: SourcingListCriterion[]
}
export interface SourcingAssessment {
  criterionId: string; state: 'match' | 'partial' | 'mismatch' | 'unknown'; quote: string; reason: string
  evidenceKind?: 'direct' | 'inferred'; confidence?: 'high' | 'medium' | 'low'
  evidenceQuotes?: string[]; verificationQuestion?: string
}
export interface SourcingScoring { version: 2; baseScore: number; bonusScore: number; assessedWeight: number; needsReview: boolean }
export interface SourcingCandidate {
  key: string; name: string; platform: Platform; profileUrl: string; sourceUrl: string; collectedAt: string
  /** Verified previous text-key formats, excluding mutable UI contact state. */
  identityAliases?: string[]
  platformIdentity?: PlatformCandidateIdentity
  communication?: import('./communication.js').CommunicationState
  resumeReceived?: boolean
  /** First observed platform receipt time; not the candidate's send time. */
  resumeReceivedAt?: string
  resumeAttachments?: ReceivedResumeAttachment[]
  scope: 'summary' | 'online'; fields: { label: string; value: string }[]; resumeText: string
  resumeEvidence?: { kind: 'visual'; imageHashes: string[]; pages: number }
  resumeTruncated?: boolean
  assessments: SourcingAssessment[]; filterAssessments?: { field: 'city' | 'education' | 'experience'; state: 'match' | 'mismatch' | 'unknown'; quote: string; reason: string }[]; score: number; coverage: number
  verdict: 'recommended' | 'review' | 'unqualified'; analysis: string; scoring?: SourcingScoring
  listAssessments?: SourcingListAssessment[]
}
export interface SourcingJob extends WorkbenchJob {
  clearedCandidateCount?: number
  kind: 'talent_sourcing'; jobId: string; position?: SourcingPosition; supplement: string
  jobDescription?: string
  platforms: Platform[]; sourceMode?: 'recommend' | 'search'; requirements?: SourcingRequirements; requirementVersion?: string
  limitScope?: 'per_platform'; searchFilters?: SourcingSearchFilters
  minimumScore?: number; autoGreet?: boolean; greetings?: SourcingGreeting[]; scanned?: number; skippedLowScore?: number; skippedByFilters?: number; skippedUnverified?: number
  platformJobs?: Partial<Record<Platform, { id: string; name: string }[]>>
  candidates: SourcingCandidate[]
  /** Verified identities read during list screening, including rejected candidates. */
  viewedCandidates?: Pick<SourcingCandidate, 'key' | 'platform' | 'identityAliases' | 'platformIdentity'>[]
  channels: { platform: Platform; status: 'queued' | 'running' | 'completed' | 'stopped' | 'failed'; detail: string; candidateCount?: number; limit?: number }[]
}

export interface SourcingRound {
  id: string; jobId: string; number: number; createdAt: string; updatedAt: string
  status: SourcingJob['status']; limit: number; candidateCount: number
}
export type SourcingRun = Pick<SourcingJob, 'id' | 'jobId' | 'status' | 'phase' | 'createdAt' | 'updatedAt' | 'limit' | 'limitScope' | 'platforms' | 'sourceMode' | 'searchFilters' | 'detail' | 'channels' | 'position' | 'requirements' | 'supplement' | 'minimumScore' | 'autoGreet' | 'greetings' | 'scanned' | 'skippedLowScore' | 'skippedByFilters' | 'skippedUnverified' | 'events'> & { candidateCount: number }
/** Lists carry identity/score metadata only; a selected evaluation loads its own evidence. */
export type SourcingResultCandidate = Pick<SourcingCandidate, 'key' | 'name' | 'platform' | 'fields' | 'score' | 'coverage' | 'collectedAt' | 'communication' | 'resumeReceived' | 'resumeReceivedAt' | 'resumeAttachments' | 'scoring'> & {
  minimumScore?: number; resultKey: string; roundId: string; roundNumber: number; roundCreatedAt: string
}
export interface SourcingResults {
  jobId: string; roundId: string; rounds: SourcingRound[]; candidates: SourcingResultCandidate[]; current?: SourcingRun
}
export interface SourcingCandidateDetail {
  jobId: string; roundId: string; candidate: SourcingCandidate; position?: SourcingPosition; requirements?: SourcingRequirements; supplement: string
}

export interface CommunicationSyncResult {
  checked: number; matched: number; updated: number
  platforms: { platform: Platform; matched: number; detail: string; status?: 'completed' | 'partial' | 'failed'; scanned?: number; unidentified?: number }[]
}

export interface ReceivedResumeAttachment {
  id: string
  fileName: string
  receivedAt?: string
  uploadedAt?: string
  uploadError?: string
  uploadStopped?: boolean
}
export interface ResumeDownloadChunk {
  downloadId: string
  fileName: string; mimeType: string; totalSize: number; offset: number; base64: string; eof: boolean
}
export interface ResumeStorageUsage { fileCount: number; bytes: number }
export type DataGroup = 'tasks' | 'talents'
export interface DataStorageUsage { tasks: { bytes: number }; talents: { bytes: number } }

export interface SourcingGreeting extends TaskResult { candidateKey: string; platform: Platform; knownContacted?: boolean }
export interface PositionOverview extends JobOption { viewedCount: number; candidateCount: number; greetedCount: number; resumeCount: number; importedCount: number; activeKind?: WorkbenchJob['kind'] }
