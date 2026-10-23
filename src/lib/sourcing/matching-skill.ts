import { recruitmentMatchingSkill } from '../browser-skill.js'
import type { SourcingPosition } from '../../shared/sourcing.js'
import { fixedSourcingFields } from './requirement-policy.js'
import { deriveSourcingSearchFilters } from '../sourcing-search.js'

// Both isolated calls consume the packaged source; loading the main chat skill
// alone cannot make these instructions visible to the assessment model.
export const matchingInstructions = () => recruitmentMatchingSkill().content
export const supplementParts = (supplement: string) => supplement.split(/[\n；;。]+/).map(part => part.trim()).filter(Boolean)
export const requirementsGoal = (position: unknown, supplement: string, existingRequirements?: unknown) => ({
  position, supplement, supplementParts: supplementParts(supplement), existingRequirements,
  requirementPriority: ['explicit_supplement', 'fixed_fields', 'jd'],
  ...(position && typeof position === 'object' ? { fixedFields: fixedSourcingFields(position as SourcingPosition),
    authoritativeBasicFilters: deriveSourcingSearchFilters(position as SourcingPosition, supplement) } : {}),
})
