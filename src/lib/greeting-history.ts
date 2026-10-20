import type { Store } from './store.js'
import type { WorkbenchJob, Platform, TaskResult } from '../shared/workbench.js'
import type { SourcingJob } from '../shared/sourcing.js'
export async function greetingHistory(store: Store): Promise<WorkbenchJob[]> {
  const [greetings, sources] = await Promise.all([store.list<WorkbenchJob>('greeting-'), store.list<SourcingJob>('sourcing-')])
  return [...greetings, ...sources]
}
export function greetingRows(jobs: WorkbenchJob[], platform?: Platform): TaskResult[] {
  return jobs.flatMap(job => job.kind === 'talent_sourcing'
    ? ((job as SourcingJob).greetings ?? []).filter(row => !platform || row.platform === platform)
    : (!job.kind || job.kind === 'greeting') && (!platform || job.platform === platform) ? job.results : [])
}
