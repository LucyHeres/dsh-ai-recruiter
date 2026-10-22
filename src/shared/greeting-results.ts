import type { TaskResult, WorkbenchJob } from './workbench.js'
import { hasGreeted } from './communication.js'

const personName = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase()
const rank = (row: TaskResult) => row.stage === 'succeeded' && row.confirmedAt ? 5
  : hasGreeted(row) ? 4 : row.stage === 'unknown' ? 3 : row.stage === 'sending' ? 2 : 1

/** One final outcome per candidate, preserving first-seen order. Raw attempts
 * remain untouched for diagnostics. Distinct verified profile identities stay
 * separate even when their display names match. */
export function greetingResultRows(results: readonly TaskResult[]): TaskResult[] {
  const identities = new Map<string, { rows: TaskResult[]; name: string; strong: boolean }>()
  results.forEach((row, index) => {
    const key = row.key || `row:${index}`
    const identity = identities.get(key) ?? { rows: [], name: personName(row.name) || key, strong: false }
    identity.rows.push(row); identity.strong ||= row.identityKind === 'url' || row.identityKind === 'platform_id'; identities.set(key, identity)
  })
  const distinctIdentity = (identity: { rows: TaskResult[]; strong: boolean }) => identity.strong
    || identity.rows.some(row => !!row.confirmedAt || row.stage === 'unknown' || row.stage === 'sending')
  const strongCounts = new Map<string, number>()
  for (const identity of identities.values()) if (distinctIdentity(identity)) strongCounts.set(identity.name, (strongCounts.get(identity.name) ?? 0) + 1)
  const people = new Map<string, TaskResult[]>()
  for (const [key, identity] of identities) {
    const group = (strongCounts.get(identity.name) ?? 0) > 1
      ? distinctIdentity(identity) ? `identity:${key}` : `unresolved:${identity.name}` : `person:${identity.name}`
    people.set(group, [...(people.get(group) ?? []), ...identity.rows])
  }
  return [...people.values()].map(rows => rows.reduce((best, row) => rank(row) > rank(best)
    || (rank(row) === rank(best) && row.updatedAt >= best.updatedAt) ? row : best))
}

export const taskResultRows = (job: Pick<WorkbenchJob, 'kind' | 'results'>) => job.kind === 'greeting' ? greetingResultRows(job.results) : job.results
