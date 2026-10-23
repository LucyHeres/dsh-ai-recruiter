import { readCandidate } from '../../candidate-entry.js'
import { normalized } from '../../page-actions.js'

const greetingLabels = ['打招呼', '立即打招呼', '立即沟通', '继续沟通', '聊一聊', '已沟通']
const trailingControl = /(?:^|\s)(?:立即打招呼|打招呼|立即沟通|继续沟通|聊一聊|已沟通)$/

/** These are full verified card-text identities, not platform IDs or names.
 * A contact button changes state without creating a different candidate. */
export function bossCandidateTextIdentity(text: string) {
  const raw = normalized(text)
  const stable = readCandidate(raw, 'button').candidate?.identity ?? raw
  const canonical = stable.replace(trailingControl, '').trim()
  const bodies = new Set([raw.replace(trailingControl, '').trim(), canonical])
  return { canonical, aliases: [...new Set([raw, stable, ...[...bodies].flatMap(body =>
    [body, ...greetingLabels.map(label => `${body} ${label}`)])])] }
}
