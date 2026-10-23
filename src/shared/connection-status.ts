import type { WorkbenchState } from './workbench.js'

/** A connection reservation is not evidence that a recruitment task is running. */
export function browserConnectionStatus(state: WorkbenchState | undefined, busy: string, error: string): string {
  if (error) return '读取失败'
  if (busy === '连接中') return '连接中'
  if (!state) return '读取中'
  const connection = state.connection
  const task = state.jobs.find(job => job.id === state.activeJobId)
  if (connection.activeWorkflow || task && ['running', 'stopping'].includes(task.status)) return '工作中'
  if (connection.connecting) return '连接中'
  return connection.ready && (connection.available || connection.requiresBegin) ? '已连接' : '未连接'
}
