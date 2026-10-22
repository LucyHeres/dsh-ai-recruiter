import type { TaskResult } from './workbench.js'

export type CommunicationState = 'recorded' | 'none'
export const communicationLabels: Record<CommunicationState, string> = { recorded: '已打招呼', none: '未打招呼' }

/** Business state is separate from the execution ledger used to block replay. */
export function hasGreeted(row: TaskResult): boolean {
  return !!(row.clickedAt || row.confirmedAt || (row as TaskResult & { knownContacted?: boolean }).knownContacted || row.stage === 'succeeded')
}

/** Historical projections can contain obsolete third states. */
export const communicationState = (value: unknown): CommunicationState => value === 'recorded' ? 'recorded' : 'none'
export const greetingLabel = (row: TaskResult) => communicationLabels[hasGreeted(row) ? 'recorded' : 'none']

export function greetingNotice(message: string): string {
  return /GREETING_OUTCOME_UNKNOWN|(?:招呼|发送)(?:执行)?结果(?:待确认|待核对|待核实|未知)|待核实招呼记录/.test(message)
    ? '打招呼操作中断，已停止自动执行。' : message
}

export function greetingDetail(row: TaskResult): string {
  if (hasGreeted(row)) return '已打招呼'
  if (row.stage === 'unknown' || row.attemptedAt && row.stage !== 'succeeded') return '操作中断，已停止自动执行'
  return greetingNotice(row.detail)
}
