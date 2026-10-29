import { type RecruitmentPlatform } from '../types.js'
import { BossPositionRoute } from './position-route.js'
import { bossDefinition } from './definition.js'
import { BossSearchEvidence } from './search-evidence.js'
import { BossSourcingDriver } from './sourcing-driver.js'
import { BOSS_SOURCING_ROUTE } from './ai-route.js'
import { bossReadOnlyControl, readBossResume } from './resume-driver.js'
import { bossCandidateTextIdentity } from './candidate-identity.js'
import { bossListProfile } from './list-profile.js'

/** BOSS owns list preflight, actual resume opening and Canvas-body evidence. */
export const bossPlatform: RecruitmentPlatform = {
  listProfile: bossListProfile,
  candidateTextIdentity: bossCandidateTextIdentity,
  sourcingEntry: bossDefinition.sourcingEntry,
  sourcingEntryAliases: bossDefinition.sourcingEntryAliases,
  sourcingHints: BOSS_SOURCING_ROUTE,
  readResume: readBossResume,
  allowsNavigation: bossReadOnlyControl,
  observationFormat: 'dom',
  createSearchEvidence: () => new BossSearchEvidence(),
  createPositionRoute: () => new BossPositionRoute(),
  createSourcingDriver: context => new BossSourcingDriver(context),
}
