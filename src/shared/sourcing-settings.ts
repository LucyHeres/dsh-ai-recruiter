import type { Platform } from './workbench.js'
import { DEFAULT_MINIMUM_SCORE } from './sourcing-score.js'

/** An omitted platform selection means the job's connected platforms on first use.
 * An explicit empty selection is a saved user choice. */
export interface SourcingSettings {
  supplement: string
  platforms?: Platform[]
  limit: number
  minimumScore: number
  autoGreet: boolean
}

export const defaultSourcingSettings = (): SourcingSettings => ({
  supplement: '', limit: 20, minimumScore: DEFAULT_MINIMUM_SCORE, autoGreet: true,
})
