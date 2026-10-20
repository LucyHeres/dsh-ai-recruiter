import type { ComponentType } from 'react'
import type { TaskKind, WorkbenchState, ResumeOptions, JobOption } from '../shared/workbench.js'
import { ResumeForm } from './features/resume-form.js'
import { GreetingForm } from './features/greeting-form.js'

export interface TaskFormProps {
  positionId?: string
  state?: WorkbenchState
  locked: boolean
  busy: string
  pending: boolean
  blockingReason: string
  loadResumeOptions: () => Promise<ResumeOptions>
  loadJobOptions: () => Promise<JobOption[]>
  checkLogin: (platform: string, open: boolean) => Promise<{ status: string; detail: string }>
  onStart: (settings: Record<string, unknown>) => void
}
/** Feature forms are registered independently of the common task activity view. */
export const TASK_FORMS: Partial<Record<TaskKind, ComponentType<TaskFormProps>>> = {
  greeting: GreetingForm,
  resume_import: ResumeForm,
}
