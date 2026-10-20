import { identityObservation, safePageUrl } from './page-actions.js'

type Candidate = { ref: string; name: string; evidenceRefs: string[]; profileRef?: string }
/** A profile URL is an optional deduplication aid, after candidate/quote validation. */
export function candidateProfile(page: any, candidate: Candidate, origins: readonly string[]) {
  const text = (reason: 'not_provided' | 'missing_href' | 'non_navigation_href') => ({ url: '', mode: 'text' as const, reason })
  if (!candidate.profileRef) return text('not_provided')
  let item: any
  try {
    identityObservation(page, candidate.ref, candidate.name, [...candidate.evidenceRefs, candidate.profileRef])
    item = identityObservation(page, candidate.profileRef, candidate.name, [candidate.ref, ...candidate.evidenceRefs])
  } catch (error) {
    if (error instanceof Error && error.message === 'CANDIDATE_EVIDENCE_INVALID') {
      throw new Error('CANDIDATE_PROFILE_EVIDENCE_INVALID: profileRef 与当前候选人的身份关联无法确认；请检查同一卡片的资料元素，不能借用其他人或导航的引用')
    }
    throw error
  }
  const href = typeof item.href === 'string' ? item.href.trim() : ''
  if (!href) return text('missing_href')
  if (href.startsWith('#')) return text('non_navigation_href')
  let parsed: URL
  try { parsed = new URL(href, page.url) } catch {
    throw new Error('CANDIDATE_PROFILE_URL_INVALID: profileRef 的 href 无法解析；请检查资料元素，修正引用或在身份原文充分时省略 profileRef')
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) return text('non_navigation_href')
  if (!origins.includes(parsed.origin)) {
    throw new Error('CANDIDATE_PROFILE_ORIGIN_NOT_ALLOWED: profileRef 指向的平台域名不在当前任务范围；请检查资料引用，不得把站外链接作为候选人详情')
  }
  const url = safePageUrl(parsed.href)
  if (!url) throw new Error('CANDIDATE_PROFILE_URL_INVALID: profileRef 的 href 含无效或不允许的 URL 信息；请检查并修正引用')
  return { url, mode: 'url' as const, reason: 'valid_href' as const }
}
