import type { TaskKind, WorkbenchJob } from '../shared/workbench.js'

/** Per-feature adapter. The workbench owns dispatch, cancellation and history. */
export interface WorkbenchTaskExecutor {
  readonly kind: TaskKind
  /** Keep prefixes stable so existing task records remain readable. */
  readonly storagePrefix: string
  /** Validate all feature-specific input before claiming resources. */
  create(request: unknown): WorkbenchJob
  /** Persist progress and outcomes; respect cancellation and never replay unknown writes. */
  run(job: WorkbenchJob, signal: AbortSignal): Promise<void>
}
