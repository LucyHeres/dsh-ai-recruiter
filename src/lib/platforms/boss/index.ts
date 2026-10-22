import { StandardPositionRoute, StandardSearchEvidence, type RecruitmentPlatform } from '../types.js'
import { bossDefinition } from './definition.js'
import { BossSourcingDriver } from './sourcing-driver.js'

/** BOSS owns its fixed route; changed components use the common AI recovery. */
export const bossPlatform: RecruitmentPlatform = {
  sourcingEntry: bossDefinition.sourcingEntry,
  sourcingHints: '',
  observationFormat: 'dom',
  createSearchEvidence: () => new StandardSearchEvidence(),
  createPositionRoute: () => new StandardPositionRoute(),
  createSourcingDriver: context => new BossSourcingDriver(context),
}
