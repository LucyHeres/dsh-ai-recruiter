import type { SourcingListCriterion, SourcingPosition } from '../../shared/sourcing.js'
import { deriveSourcingSearchFilters } from '../sourcing-search.js'

/** Structured fields are authoritative when JD wording disagrees. Explicit
 * task supplements still override their own field through the shared resolver. */
export function fixedSourcingFields(position: Partial<SourcingPosition>) {
  return {
    city: position.basicRequirements?.city || position.searchFields?.city || position.city || '',
    experience: position.basicRequirements?.experience || position.searchFields?.experience || '',
    education: position.basicRequirements?.education || position.searchFields?.education || '',
  }
}

/** Do not let model extraction omit a known hard filter or replace it with a
 * conflicting JD range. An explicit unlimited field removes the lower source. */
export function withFixedListCriteria(position: SourcingPosition, supplement: string, criteria: SourcingListCriterion[]): SourcingListCriterion[] {
  const fixed = fixedSourcingFields(position), effective = deriveSourcingSearchFilters(position, supplement)
  const result = criteria.filter(row => !Object.hasOwn(fixed, row.field) || !fixed[row.field as keyof typeof fixed])
  for (const field of ['city', 'experience', 'education'] as const) {
    const value = effective[field]
    if (!fixed[field] || !value) continue
    const requirement = field === 'education' && /^(?:小学|初中|中专|中职|中技|高中|大专|本科|硕士|博士)$/.test(value) ? `${value}及以上` : value
    result.push({ field, requirement, quote: value })
  }
  return result
}
