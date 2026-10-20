import type { RecruitmentPlatform } from '../types.js'
import { LiepinSearchEvidence } from './search-evidence.js'
import { LIEPIN_POSITION_ROUTE, LIEPIN_RECOMMENDATION_ROUTE, LiepinPositionRoute } from './position-route.js'
import { LiepinSourcingDriver } from './sourcing-driver.js'
import { liepinDefinition } from './definition.js'
import { liepinCandidateIdentity } from './candidate-identity.js'

export const liepinPlatform: RecruitmentPlatform = {
  candidateIdentity: liepinCandidateIdentity,
  sourcingEntry: liepinDefinition.sourcingEntry,
  sourcingSearchEntry: liepinDefinition.sourcingSearchEntry,
  sourcingHints: LIEPIN_RECOMMENDATION_ROUTE,
  sourcingSearchHints: LIEPIN_POSITION_ROUTE,
  observationFormat: 'semantic',
  createSearchEvidence: broker => new LiepinSearchEvidence(broker),
  createPositionRoute: (names, mode) => new LiepinPositionRoute(names, mode === 'recommend' ? LIEPIN_RECOMMENDATION_ROUTE : LIEPIN_POSITION_ROUTE),
  createSourcingDriver: context => new LiepinSourcingDriver(context),
}
