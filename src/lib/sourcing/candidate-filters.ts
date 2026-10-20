import type { z } from 'zod'
import type { SourcingSearchFilters } from '../../shared/sourcing.js'
import type { filterAssessmentsSpec } from './contracts.js'
import { normalized } from '../page-actions.js'

/** Page filters reduce work. Candidate acceptance still needs per-person
 * evidence, even when a recommendation page has no equivalent filter UI. */
export function assessCandidateFilters(expected: SourcingSearchFilters, rows: z.infer<typeof filterAssessmentsSpec>, text: string) {
  const fields = Object.keys(expected)
  if (rows.length !== fields.length || new Set(rows.map(row => row.field)).size !== fields.length
    || rows.some(row => !fields.includes(row.field))) throw new Error('SOURCING_FILTER_ASSESSMENT_REQUIRED: 请逐项核验候选人的城市、经验和学历条件')
  for (const row of rows) if (row.state !== 'unknown' && (!normalized(row.quote) || !normalized(text).includes(normalized(row.quote)))) {
    throw new Error('SOURCING_FILTER_EVIDENCE_MISSING: 条件判断必须引用当前候选人的原文，缺少信息请标记unknown')
  }
  return { matched: rows.every(row => row.state === 'match'), mismatch: rows.some(row => row.state === 'mismatch'), unknown: rows.some(row => row.state === 'unknown') }
}
