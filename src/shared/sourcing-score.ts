import type { SourcingAssessment, SourcingCandidate, SourcingCriterion } from './sourcing.js'

export const SOURCING_RUBRIC_VERSION = 2
export const SOURCING_MIN_ASSESSED_WEIGHT = 70
export const SOURCING_MAX_BONUS = 10
export const SOURCING_MAX_CRITERIA = 24
export const sourcingTierLabels = { must: '硬性条件', core: '核心能力', bonus: '加分项', verify: '面试核实' }

/** New rubrics separate eligibility, scored ability, positive preferences and interview checks. */
export function sourcingRubricScore(criteria: SourcingCriterion[], assessments: SourcingAssessment[]) {
  let earned = 0, assessedWeight = 0, bonusScore = 0, unknownMust = false, conflict = false
  for (const criterion of criteria) {
    const row = assessments.find(item => item.criterionId === criterion.id)!
    const factor = row.state === 'match' && row.evidenceKind !== 'inferred' && row.confidence !== 'low' ? 1
      : row.state === 'match' || row.state === 'partial' ? .5 : 0
    if (criterion.tier === 'must') {
      if (row.state === 'mismatch') conflict = true
      else if (row.state !== 'match' || row.evidenceKind === 'inferred' || row.confidence === 'low') unknownMust = true
    } else if (criterion.tier === 'core' && row.state !== 'unknown') {
      assessedWeight += criterion.weight; earned += criterion.weight * factor
    } else if (criterion.tier === 'bonus') bonusScore += criterion.weight * factor
  }
  const baseScore = assessedWeight ? earned / assessedWeight * 100 : 0
  const needsReview = !conflict && (unknownMust || assessedWeight < SOURCING_MIN_ASSESSED_WEIGHT)
  return { score: Math.min(100, Math.round(baseScore + bonusScore)), coverage: assessedWeight,
    verdict: conflict ? 'unqualified' as const : needsReview || baseScore + bonusScore < 70 ? 'review' as const : 'recommended' as const,
    scoring: { version: 2 as const, baseScore: Math.round(baseScore * 10) / 10, bonusScore: Math.round(bonusScore * 10) / 10, assessedWeight, needsReview } }
}

export function sourcingCandidateQualified(candidate: Pick<SourcingCandidate, 'score' | 'scoring' | 'verdict'>, minimumScore: number) {
  return candidate.score >= minimumScore && (!candidate.scoring || !candidate.scoring.needsReview && candidate.verdict !== 'unqualified')
}
export function sourcingQualifiedCount(job: { candidates: SourcingCandidate[]; minimumScore?: number }) {
  return job.candidates.filter(candidate => sourcingCandidateQualified(candidate, sourcingMinimumScore(job))).length
}

/** Contribution to the 100-point total; missing evidence contributes no points. */
export function sourcingCriterionScore(weight: number, state: SourcingAssessment['state']): number {
  return weight * (state === 'match' ? 1 : state === 'partial' ? .5 : 0)
}

export const DEFAULT_MINIMUM_SCORE = 80
const LEGACY_MINIMUM_SCORE = 60

/** Old executions used a shared total; new executions allocate this limit to each platform. */
export function sourcingTotalTarget(value: { limit: number; limitScope?: 'per_platform'; platforms?: string[] }): number {
  return value.limit * (value.limitScope === 'per_platform' ? Math.max(1, new Set(value.platforms ?? []).size) : 1)
}

/** Historical executions without a setting retain their original threshold. */
export function sourcingMinimumScore(value?: { minimumScore?: number }): number {
  const score = value?.minimumScore
  return typeof score === 'number' && Number.isInteger(score) && score >= 0 && score <= 100 ? score : LEGACY_MINIMUM_SCORE
}
