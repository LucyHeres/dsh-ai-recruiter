/**
 * 按会话的插件调用记录（只读工作台用）。
 *
 * 目的：`ai_recruit_context` 这类**查询**不建任务记录，因此右侧「招聘进度」面板
 * 里看不到它。这里为每个会话保留一小段最近调用，供面板展示"这次调了什么、
 * 成功没有、花了多久"。
 *
 * 只保留可读摘要与执行结果，不保存页面正文、简历内容、凭据或完整返回体。
 */
export type CallJournalEntry = {
  at: string
  tool: string
  summary: string
  ok: boolean
  jobId?: string
  code?: string
  durationMs: number
}

const PER_SESSION = 40
const MAX_SESSIONS = 120
const store = new Map<string, CallJournalEntry[]>()

const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''

/** 一句话说明这次调用在做什么；只用工具参数里的业务字段，不含页面内容。 */
export function summarizeCall(tool: string, args: any): string {
  const outer = objectValue(args)
  const value = tool === 'ai_recruit_task_start' && outer.request !== undefined ? objectValue(outer.request) : outer
  if (tool === 'ai_recruit_context') {
    const inner = value.args && typeof value.args === 'object' ? value.args : {}
    const list = value.tool === 'recruitment_getJobDetail' ? '职位详情' : '职位列表'
    const keyword = text(inner.keyword)
    return keyword ? `${list} · 关键词「${keyword}」` : list
  }
  if (tool === 'ai_recruit_task_start') {
    const kind = value.kind === 'resume_import' ? '简历入库' : value.kind === 'talent_sourcing' ? '人才寻聘' : '打招呼'
    return [kind, text(value.platform), Number.isFinite(value.limit) ? `${value.limit} 人` : ''].filter(Boolean).join(' · ')
  }
  if (tool === 'ai_recruit_task_status' || tool === 'ai_recruit_task_stop') {
    const id = text(value.taskId ?? value.id)
    return id ? `任务 ${id.slice(0, 8)}` : '当前会话任务'
  }
  if (tool === 'ai_recruit_task_options') return value.kind === 'resume_import' ? '入库表单选项' : value.kind === 'talent_sourcing' ? '寻聘职位选项' : '打招呼表单选项'
  if (tool === 'ai_recruit_auth_check') return '业务登录与入库接口'
  if (tool === 'ai_recruit_destinations') return '渠道与入库位置'
  if (tool === 'ai_recruit_help') return '能力与连接状态'
  if (tool === 'ai_recruit_scan') return '读取当前页面'
  if (tool === 'ai_recruit_capture') return '采集简历附件'
  if (tool === 'ai_recruit_ingest') return '上传并入库'
  if (tool === 'ai_recruit_result') return '核对入库结果'
  if (tool === 'ai_recruit_browser_tools') return '浏览器工具清单'
  if (tool === 'ai_recruit_browser_snapshot') return '读取页面快照'
  if (tool === 'ai_recruit_browser_click') return '点击页面元素'
  if (tool === 'ai_recruit_browser_type') return '输入文本'
  if (tool === 'ai_recruit_browser_call') return text(value.tool) || '浏览器操作'
  return tool
}

const codeOf = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code) return code
  return /\b[A-Z][A-Z0-9_]{3,}\b/.exec(error instanceof Error ? error.message : String(error))?.[0]
}

export function recordCall(sessionId: string | undefined, tool: string, args: unknown, outcome: { ok: boolean; code?: string; durationMs: number }) {
  if (!sessionId) return
  const outer = objectValue(args)
  const fields = tool === 'ai_recruit_task_start' ? objectValue(outer.request ?? outer)
    : tool === 'ai_recruit_context' && outer.tool === 'recruitment_getJobDetail' ? objectValue(outer.args) : {}
  const jobId = typeof fields.jobId === 'string' && /^[a-z0-9_-]{1,64}$/i.test(fields.jobId) ? fields.jobId : undefined
  const entry: CallJournalEntry = { at: new Date().toISOString(), tool, summary: summarizeCall(tool, args),
    ok: outcome.ok, durationMs: Math.max(0, Math.round(outcome.durationMs)),
    ...(outcome.ok && jobId ? { jobId } : {}),
    ...(outcome.code ? { code: outcome.code } : {}) }
  const list = store.get(sessionId) ?? []
  list.push(entry)
  store.set(sessionId, list.slice(-PER_SESSION))
  while (store.size > MAX_SESSIONS) store.delete(store.keys().next().value!)
}

export function listCalls(sessionId: string): CallJournalEntry[] {
  return [...(store.get(sessionId) ?? [])].reverse()
}

function objectValue(value: unknown): Record<string, any> {
  if (typeof value === 'string' && value.length <= 30000) try { value = JSON.parse(value) } catch { return {} }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

/** 工具执行包装：记录成功/失败与耗时，异常原样抛出。 */
export function journaledTool(definition: any) {
  const execute = definition?.execute
  if (typeof execute !== 'function') return definition
  return { ...definition, execute: async (args: any, execution: any) => {
    const started = Date.now()
    const sessionId = execution?.agent?.id as string | undefined
    try {
      const value = await execute(args, execution)
      try { recordCall(sessionId, String(definition.name), args, { ok: true, durationMs: Date.now() - started }) } catch { /* 观察者 */ }
      return value
    } catch (error) {
      try { recordCall(sessionId, String(definition.name), args, { ok: false, code: codeOf(error), durationMs: Date.now() - started }) } catch { /* 观察者 */ }
      throw error
    }
  } }
}
