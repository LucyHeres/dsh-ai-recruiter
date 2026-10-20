import { StandardPositionRoute, StandardSearchEvidence, type RecruitmentPlatform } from '../types.js'
import { bossDefinition } from './definition.js'

/** Until a BOSS sourcing driver is verified, the same session is driven by AI.
 * Generic workflow code does not guess BOSS paths from Liepin conventions. */
export const bossPlatform: RecruitmentPlatform = {
  sourcingEntry: bossDefinition.sourcingEntry,
  sourcingHints: '',
  createSearchEvidence: () => new StandardSearchEvidence(),
  createPositionRoute: () => new StandardPositionRoute(),
}
