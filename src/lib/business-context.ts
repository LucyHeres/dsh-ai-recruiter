import { z } from 'zod'
import type { XinClient } from './xin-client.js'

// These are plugin API contracts, not the external MCP tools' argument schemas.
export const contextSchemas = {
  recruitment_getMyJobList: z.object({
    keyword: z.string().max(200).optional(),
    hireStatus: z.number().int().min(0).max(1).default(0),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  }).strict(),
  recruitment_getJobDetail: z.object({ jobId: z.string().min(1).max(64) }).strict(),
}
export function isDirectContext(tool: string): tool is keyof typeof contextSchemas {
  return Object.hasOwn(contextSchemas, tool)
}
export async function readBusinessContext(xin: XinClient, tool: keyof typeof contextSchemas,
  args: Record<string, unknown>, signal: AbortSignal) {
  const parsed = contextSchemas[tool].safeParse(args)
  if (!parsed.success) throw new Error('查询参数不符合插件契约，请查看 ai_recruit_help.contextSchemas；不要沿用外部 MCP 参数')
  if (tool === 'recruitment_getJobDetail') {
    const result = await xin.call('jobDetail', parsed.data as { jobId: string }, signal)
    if (!result.ok) throw new Error(`职位详情查询失败 ${result.failure.code}: ${result.failure.message}`)
    return { source: 'plugin-business-api', data: result.data }
  }
  const options = parsed.data as z.infer<typeof contextSchemas.recruitment_getMyJobList>
  const result = await xin.call('extensionInit', {}, signal)
  if (!result.ok) throw new Error(`职位列表查询失败 ${result.failure.code}: ${result.failure.message}`)
  const rows = result.data?.positionNames
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.jobId !== 'string' ||
      !row.jobId || typeof row.jobName !== 'string' || !Number.isInteger(row.hireStatus))) {
    throw new Error('JOB_LIST_RESPONSE_INVALID: 职位响应缺少真实 jobId、jobName 或 hireStatus，停止自动匹配')
  }
  const keyword = options.keyword?.trim().toLocaleLowerCase() || ''
  const matches = rows.filter(row => row.hireStatus === options.hireStatus &&
    (!keyword || row.jobName.toLocaleLowerCase().includes(keyword)))
  const items = matches.slice(options.offset, options.offset + options.limit).map(row => ({
    jobId: row.jobId, jobName: row.jobName, hireStatus: row.hireStatus,
    ...Object.fromEntries(['jobNo', 'department', 'workCity'].filter(key => typeof row[key] === 'string').map(key => [key, row[key]])),
  }))
  return { source: 'plugin-business-api', scope: '当前授权用户的薪招初始化职位选项，非全公司职位目录',
    items, total: matches.length, offset: options.offset, limit: options.limit,
    hasMore: options.offset + items.length < matches.length,
    note: '按名称筛选是本地包含匹配；同名职位必须结合部门、城市、职位编号消歧，不能自动取第一项。' }
}
