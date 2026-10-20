import { z } from 'zod'
import { PLATFORMS, type JobOption, type Platform, type PublishedChannel } from '../shared/workbench.js'
import { sourcingPlatformsForChannels } from '../shared/published-channels.js'
import type { XinClient } from './xin-client.js'

const pageSpec = z.object({
  p: z.number().int().positive(),
  count: z.number().int().nonnegative(),
  data: z.array(z.object({
    jobId: z.string().min(1).max(64),
    name: z.string().trim().min(1),
    hireStatus: z.number().int(),
    department: z.string().nullish(),
    workCity: z.string().nullish(),
    jobNo: z.string().nullish(),
    channelType: z.unknown().optional(),
  })),
})

/** 只通过当前宿主授权查询系统职位，分页完成后才提供下拉选项。 */
export async function readJobOptions(xin: XinClient | null, signal?: AbortSignal): Promise<JobOption[]> {
  if (!xin) throw new Error('请先在薪灵完成薪人薪事授权')
  const jobs = new Map<string, JobOption>()
  const addJob = (row: { jobId: string; name: string; department?: string | null; workCity?: string | null; jobNo?: string | null; channelType?: unknown }) => {
    const publishedChannels = jobPublishedChannels(row.channelType)
    jobs.set(row.jobId, { id: row.jobId, name: row.name,
      publishedChannels, platforms: sourcingPlatformsForChannels(publishedChannels),
      ...(row.department ? { department: row.department } : {}), ...(row.workCity ? { city: row.workCity } : {}), ...(row.jobNo ? { code: row.jobNo } : {}),
      label: [row.name, row.department, row.workCity, row.jobNo].filter(Boolean).join(' · ') })
  }
  const pageSize = 100
  let received = 0
  for (let p = 1; p <= 100; p++) {
    signal?.throwIfAborted()
    const result = await xin.call('jobList', { p, pn: pageSize, hireStatus: 0 }, signal)
    if (!result.ok) throw new Error(`职位列表读取失败：${result.failure.message}`)
    const parsed = pageSpec.safeParse(result.data)
    if (!parsed.success) throw new Error('职位列表格式不可识别，请刷新重试')
    const page = parsed.data
    if (page.count === 0 && p === 1 && page.data.length === 0) return []
    const before = jobs.size
    const rows = page.data.filter(row => row.hireStatus === 0)
    // 服务端分页行为可能有边界差异（末页为空、p 字段回显不一致、排序不稳定导致跨页重复），
    // 这里不做强校验抛错，而是防御式合并：去重、按 count/空页判定结束，保证列表可用。
    if (!rows.length || received >= page.count) {
      if (rows.length) for (const row of rows) addJob(row)
      return [...jobs.values()]
    }
    for (const row of rows) addJob(row)
    received += jobs.size - before
    if (received >= page.count) return [...jobs.values()]
  }
  throw new Error('职位数量过多，未能完整读取，请稍后重试')
}

/** Same channelType map array used by the main system's job list; unrelated channels are not sourcing platforms. */
export function jobSourcingPlatforms(channels: unknown): Platform[] {
  return sourcingPlatformsForChannels(jobPublishedChannels(channels))
}

export function jobPublishedChannels(channels: unknown): PublishedChannel[] {
  const result = new Map<string, PublishedChannel>()
  for (const row of Array.isArray(channels) ? channels : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    for (const [id, name] of Object.entries(row)) {
      if (/^\d+$/.test(id) && typeof name === 'string' && name.trim()) result.set(id, { id, name: name.trim() })
    }
  }
  return [...result.values()]
}

/** Only retain position identities, never channel-account fields. */
export async function readPlatformJobs(xin: XinClient | null, jobId: string, platform: Platform, signal?: AbortSignal): Promise<{ id: string; name: string }[]> {
  if (!xin) throw new Error('请先在薪灵完成薪人薪事授权')
  const channelType = PLATFORMS[platform].channelType
  const result = await xin.call('jobAds', { jobId, channelType }, signal)
  if (!result.ok) throw new Error(`平台职位关联读取失败：${result.failure.message}`)
  const parsed = z.array(z.object({ jobId: z.string(), channelType: z.number(), thirdJobId: z.union([z.string(), z.number()]).transform(String), thirdJobName: z.string().trim(), state: z.number() })).safeParse(result.data)
  if (!parsed.success || parsed.data.some(row => row.jobId !== jobId || row.channelType !== channelType)) throw new Error('平台职位关联格式不可识别，请刷新后重试')
  return [...new Map(parsed.data.filter(row => row.state === 1 && row.thirdJobId && row.thirdJobName).map(row => [row.thirdJobId, { id: row.thirdJobId, name: row.thirdJobName }])).values()]
}
