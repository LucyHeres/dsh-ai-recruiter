import type { Platform, TaskKind, WorkbenchJob } from './workbench.js'
export interface TaskHistoryRecord {
  id: string; kind: TaskKind; platform: Platform; jobId?: string; jobName: string
  status: WorkbenchJob['status']; createdAt: string; completed: number; limit: number
}
export interface TaskHistoryPage { records: TaskHistoryRecord[]; total: number; page: number; pageSize: number }
