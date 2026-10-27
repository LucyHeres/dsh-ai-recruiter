import type { Platform } from './workbench.js'
import type { SourcingPosition } from './sourcing.js'
import { DEFAULT_MINIMUM_SCORE } from './sourcing-score.js'

export const SOURCING_MAX_LIMIT = 100

/** An omitted platform selection means the job's connected platforms on first use.
 * An explicit empty selection is a saved user choice. */
export interface SourcingSettings {
  supplement: string
  /** Undefined uses the current source JD; an empty string is a deliberate edit. */
  jobDescription?: string
  platforms?: Platform[]
  limit: number
  minimumScore: number
  autoGreet: boolean
}

export const defaultSourcingSettings = (): SourcingSettings => ({
  supplement: '', limit: 20, minimumScore: DEFAULT_MINIMUM_SCORE, autoGreet: true,
})

/** Replace only the editable JD, retaining the source position's fixed fields. */
export function withSourcingJobDescription(position: SourcingPosition, text?: string): SourcingPosition {
  if (text === undefined) return position
  const basic = position.basicRequirements
  const requirements = [
    ['工作经验', basic?.experience ?? position.searchFields?.experience],
    ['学历要求', basic?.education ?? position.searchFields?.education],
    ['工作地点', basic?.city ?? position.searchFields?.city ?? position.city],
    ['薪酬范围', basic?.salary],
  ].filter(([, value]) => value).map(([label, value]) => `${label}：${value}`)
  return { ...position, jobDescription: { text, html: '' },
    description: [text, ...requirements].filter(Boolean).join('\n'), descriptionHtml: '' }
}
