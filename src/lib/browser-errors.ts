/** Preserve the gateway code without copying remote error bodies into logs. */
export function browserFailureCode(error: unknown): string | undefined {
  const value = error as { code?: unknown; message?: unknown } | null
  const explicit = String(value?.code ?? '')
  if (/^[A-Z][A-Z0-9_]{2,63}$/.test(explicit) && explicit !== 'TOOL_ERROR') return explicit
  const message = typeof value?.message === 'string' ? value.message : typeof error === 'string' ? error : ''
  return /^(?:工具执行失败[：:]\s*)?([A-Z][A-Z0-9_]{2,63})(?=[\s:：]|$)/.exec(message)?.[1]
}

export function browserFailureReason(error: unknown): string | undefined {
  const message = typeof error === 'string' ? error : String((error as { message?: unknown } | null)?.message ?? '')
  const match = /\b(?:SNAPSHOT_EXPIRED:\s*(RECORD_MISSING|TASK_SCOPE_MISMATCH|TAB_MISMATCH|TTL_EXCEEDED|AX_BASELINE_MISSING|AX_NODE_UNAVAILABLE)|PAGE_OPERATION_RESULT_REQUIRED:\s*(SAME_SNAPSHOT|EVIDENCE_REF_MISSING|EVIDENCE_UNCHANGED)|CANDIDATE_EVIDENCE_INVALID:\s*(IDENTITY_NAME_MISMATCH|RESUME_FRAGMENT_UNRELATED|RESUME_SCOPE_MISMATCH|GREETING_RESUME_ID_MISMATCH|GREETING_DETAIL_UNVERIFIED))\b/.exec(message)
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

const pageFailures: Record<string, string> = {
  PAGE_CHANGED: '页面内容或候选人上下文发生变化，点击未派发',
  SNAPSHOT_EXPIRED: '页面引用已过期，点击未派发',
  ELEMENT_NOT_FOUND: '原控件已不存在，点击未派发',
  ELEMENT_NOT_IN_VIEWPORT: '目标控件在当前视口之外，点击未派发',
  ELEMENT_HIDDEN: '目标控件当前不可见，点击未派发',
  ELEMENT_DISABLED: '目标控件当前不可用，点击未派发',
  PAGE_DIALOG_BLOCKED: '页面弹窗挡住了目标控件，点击未派发',
  ELEMENT_OCCLUDED: '目标控件被页面其他元素遮挡，点击未派发',
}
export function pageFailureDetail(error: unknown): string {
  const code = browserFailureCode(error)
  return code && pageFailures[code] ? `${pageFailures[code]}（${code}）` : '页面校验未通过，点击未派发'
}
