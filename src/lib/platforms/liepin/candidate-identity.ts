import type { AgentBrowserTools } from '../../agent-browser-tools.js'
import type { PlatformCandidateIdentity } from '../../../shared/workbench.js'

/** Liepin emits the opaque resume key on the exact list card wrapper. Do not
 * parse arbitrary HTML, React state, global page text, or another card. */
export function liepinCandidateIdentity(page: any, refs: string[], broker: AgentBrowserTools): PlatformCandidateIdentity | undefined {
  if (new URL(page.url).origin !== 'https://lpt.liepin.com') return
  const ids = new Set<string>()
  for (const ref of new Set(refs)) {
    const detail = broker.getInspection(page, ref)
    for (const node of [detail?.element, ...(detail?.ancestors ?? [])]) {
      const classes = String(node?.attributes?.class ?? '').split(/\s+/)
      if (!classes.includes('xpath-resume-item-wrap')) continue
      for (const token of classes) {
        const id = /^xpath-resume-item-wrap-([A-Za-z0-9_-]{8,160})$/.exec(token)?.[1]
        if (id) ids.add(id)
      }
      break
    }
  }
  if (ids.size > 1) throw new Error('CANDIDATE_EVIDENCE_INVALID: 引用来自不同简历ID的候选人卡片')
  const id = [...ids][0]
  return id ? { kind: 'resume', id, source: 'card_class' } : undefined
}
