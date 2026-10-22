import { recruitmentMatchingSkill } from '../browser-skill.js'

// Both isolated calls consume the packaged source; loading the main chat skill
// alone cannot make these instructions visible to the assessment model.
export const matchingInstructions = () => recruitmentMatchingSkill().content
export const supplementParts = (supplement: string) => supplement.split(/[\n；;。]+/).map(part => part.trim()).filter(Boolean)
export const requirementsGoal = (position: unknown, supplement: string, existingRequirements?: unknown) => ({
  position, supplement, supplementParts: supplementParts(supplement), existingRequirements,
})
