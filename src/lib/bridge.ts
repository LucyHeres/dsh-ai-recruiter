import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

export const READ_TOOLS = [
  'base_searchEmployee', 'recruitment_getMyJobList', 'recruitment_getJobDetail',
  'recruitment_getResumeList', 'recruitment_getResumeDetail', 'recruitment_getResumeFilterFields',
  'recruitment_getProcessSettingList', 'recruitment_getProcessSettingDetail',
  'recruitment_getOpenRoundsSetting', 'recruitment_getInterviewFeedbackTemplateList',
  'recruitment_getInterviewAddressList', 'recruitment_getResumeApplyJob',
  'recruitment_getResumeDetailOperations', 'recruitment_getResumeInterviewList',
  'recruitment_getInterviewerScheduleCalendar', 'recruitment_verifyInterviewerSchedule',
] as const
export type ReadTool = typeof READ_TOOLS[number]
export const MUTATION = 'recruitment_addInterview'
export const PREVIEW = 'recruitment_addInterviewPreview'
export function publicName(server: string, raw: string): string {
  const full = `mcp__${server}__${raw}`, normalized = full.replace(/[^A-Za-z0-9_-]/g, '_')
  if (full === normalized && full.length <= 64) return full
  return normalized.slice(0, 51) + '_' + createHash('sha256').update(`${server}\0${raw}`).digest('hex').slice(0, 12)
}
export const record = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x)
export function unwrap(value: any): any {
  let v = value
  // The XRXS bridge exposes MCP's canonical content, not the business object directly.
  if (record(v) && Array.isArray(v.content)) {
    if (v.isError === true) throw new Error('MCP 返回错误')
    if (v.structuredContent !== undefined) v = v.structuredContent
    else {
      const texts = v.content.filter((b: any) => b.type === 'text').map((b: any) => b.text)
      if (texts.length !== 1) throw new Error('无法识别 MCP 响应：需要单个 JSON 文本或 structuredContent')
      try { v = JSON.parse(texts[0]) } catch { throw new Error('MCP 返回非 JSON 内容，停止自动处理') }
    }
  }
  for (let i = 0; i < 6 && record(v); i++) {
    if (v.status === false || v.success === false || (typeof v.code === 'number' && ![0, 200].includes(v.code)))
      throw new Error(`业务失败：${String(v.message ?? v.msg ?? v.code).slice(0, 300)}`)
    if ('toolResult' in v) { v = v.toolResult; continue }
    if ('data' in v && ['code', 'status', 'success', 'message', 'msg'].some(k => k in v)) { v = v.data; continue }
    break
  }
  return v
}
export class Bridge {
  private sequence = 0
  constructor(readonly ctx: Context, readonly server: string, readonly exec: ToolRunContext, readonly signal: AbortSignal) {}
  capabilities(rawNames: readonly string[]) {
    return rawNames.map(raw => ({ raw, name: publicName(this.server, raw), available: !!this.ctx.tools.get(publicName(this.server, raw), this.exec.agent) }))
  }
  async call(raw: string, args: Record<string, unknown>): Promise<any> {
    if (![...READ_TOOLS, PREVIEW, MUTATION].includes(raw as any)) throw new Error('工具不在招聘插件白名单中')
    this.signal.throwIfAborted()
    const name = publicName(this.server, raw)
    if (!this.ctx.tools.get(name, this.exec.agent)) throw new Error(`薪灵当前会话未开放 ${name}`)
    const result = await this.ctx.tools.execute({ name, arguments: args, signal: this.signal,
      callId: `${this.exec.callId}:${++this.sequence}:${raw}` as ToolRunContext['callId'], rootCallId: this.exec.rootCallId,
      parent: this.exec.token, agent: this.exec.agent })
    for (const context of result.additionalContexts ?? []) this.exec.deferContext(context)
    if (result.isError) throw new Error(`${raw} 调用失败：${result.error.message}`)
    if (result.concludesTurn) { this.exec.concludeTurn(); throw new Error('宿主要求结束本次操作，请检查授权状态后继续') }
    return unwrap(result.value)
  }
  read(raw: string, args: Record<string, unknown>) {
    if (!READ_TOOLS.includes(raw as ReadTool)) throw new Error('context 只允许读取招聘与人员数据')
    return this.call(raw, args)
  }
}
