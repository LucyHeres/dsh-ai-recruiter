import type { SourcingAssessment } from './sourcing.js'

/** Contribution to the 100-point total; missing evidence contributes no points. */
export function sourcingCriterionScore(weight: number, state: SourcingAssessment['state']): number {
  return weight * (state === 'match' ? 1 : state === 'partial' ? .5 : 0)
}

export const DEFAULT_MINIMUM_SCORE = 60

/** Old executions used a shared total; new executions allocate this limit to each platform. */
export function sourcingTotalTarget(value: { limit: number; limitScope?: 'per_platform'; platforms?: string[] }): number {
  return value.limit * (value.limitScope === 'per_platform' ? Math.max(1, new Set(value.platforms ?? []).size) : 1)
}

/** Historical executions without a setting retain their original threshold. */
export function sourcingMinimumScore(value?: { minimumScore?: number }): number {
  const score = value?.minimumScore
  return typeof score === 'number' && Number.isInteger(score) && score >= 0 && score <= 100 ? score : DEFAULT_MINIMUM_SCORE
}
