import type { RecruitmentPlatform } from '../types.js'
import { LiepinSearchEvidence } from './search-evidence.js'
import { LIEPIN_POSITION_ROUTE, LIEPIN_RECOMMENDATION_ROUTE, LiepinPositionRoute } from './position-route.js'
import { LiepinSourcingDriver } from './sourcing-driver.js'
import { liepinDefinition } from './definition.js'
import { liepinCandidateIdentity } from './candidate-identity.js'
import { syncLiepinResumes, refreshLiepinAttachment, LIEPIN_RESUME_ORIGINS } from './resume-sync.js'
import { isLiepinAttachmentUrl } from './received-resumes.js'
import { liepinPromotionClose, LIEPIN_PROMOTION_GUIDANCE } from './promotion-overlay.js'

export const liepinPlatform: RecruitmentPlatform = {
  receivedAttachment: { acceptsUrl: url => isLiepinAttachmentUrl(url) && url.searchParams.get('download') !== '0', refresh: refreshLiepinAttachment },
  allowsNavigation: (page, ref, broker) => !!liepinPromotionClose(page, ref, broker),
  candidateIdentity: liepinCandidateIdentity,
  sourcingEntry: liepinDefinition.sourcingEntry,
  sourcingSearchEntry: liepinDefinition.sourcingSearchEntry,
  sourcingHints: LIEPIN_RECOMMENDATION_ROUTE + LIEPIN_PROMOTION_GUIDANCE,
  sourcingSearchHints: LIEPIN_POSITION_ROUTE + LIEPIN_PROMOTION_GUIDANCE,
  observationFormat: 'dom',
  createSearchEvidence: broker => new LiepinSearchEvidence(broker),
  createPositionRoute: (names, mode) => new LiepinPositionRoute(names, mode === 'recommend' ? LIEPIN_RECOMMENDATION_ROUTE : LIEPIN_POSITION_ROUTE),
  createSourcingDriver: context => new LiepinSourcingDriver(context),
  // 猎聘的接收记录来自聊天接口响应，通用 DOM 读取覆盖不到。
  communicationSync: {
    origins: LIEPIN_RESUME_ORIGINS,
    hostTools: ['browser_network_response', 'artifact_read'],
    sync: (broker, candidates, store, signal) => syncLiepinResumes(broker, candidates, store, signal),
  },
}
