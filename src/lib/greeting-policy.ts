import { z } from 'zod'
import { PLATFORMS, PLATFORM_KEYS, type Platform, type GreetingJob, type WorkbenchJob } from '../shared/workbench.js'

const platformSpec = z.enum(PLATFORM_KEYS)
export const searchSpec = z.object({ keyword: z.string().trim().min(1).max(200), city: z.string().trim().min(1).max(80).optional(), ageUnder: z.number().int().min(18).max(100).optional(), experienceMin: z.number().int().min(0).max(60).optional(), experienceMax: z.number().int().min(0).max(60).optional() }).strict().refine(value => value.experienceMin === undefined || value.experienceMax === undefined || value.experienceMin <= value.experienceMax)
export const greetingStartSpec = z.object({ id: z.string().uuid(), platform: platformSpec, mode: z.enum(['recommend', 'search']).default('recommend'), search: searchSpec.optional(), jobId: z.string().min(1).max(64).optional(), tabId: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100), intervalMinSeconds: z.number().int().min(5).max(600).optional(), intervalMaxSeconds: z.number().int().min(5).max(600).optional(), confirmed: z.literal(true) }).strict().refine(value => value.mode === 'search' ? !!PLATFORMS[value.platform].searchUrl && !!value.search : !value.search, '搜索人才目前只支持猎聘，搜索模式必须提供 search，推荐模式不能携带 search')
export const DAILY_LIMIT = 100
export const GREETING_CLICK_INTERVAL_MS = 5000
export const DEFAULT_GREETING_POLICY = { dailyLimit: DAILY_LIMIT, intervalMinSeconds: 5, intervalMaxSeconds: 5, batchMin: 5, batchMax: 8, batchPauseSeconds: 30 }
export type GreetingPolicy = typeof DEFAULT_GREETING_POLICY
const policySpec = z.object({ dailyLimit: z.number().int().min(1).max(10000), intervalMinSeconds: z.number().int().min(5).max(600), intervalMaxSeconds: z.number().int().min(5).max(600), batchMin: z.number().int().min(1).max(100), batchMax: z.number().int().min(1).max(100), batchPauseSeconds: z.number().int().min(1).max(3600) }).refine(value => value.intervalMaxSeconds >= value.intervalMinSeconds && value.batchMax >= value.batchMin)
export const greetingPolicy = (value: Partial<GreetingPolicy> = {}): GreetingPolicy => policySpec.parse({ ...DEFAULT_GREETING_POLICY, ...Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) })
const dayKey = (value: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
export function dailyUsage(jobs: WorkbenchJob[], now = new Date().toISOString()): Record<Platform, number> {
  const counts = Object.fromEntries(PLATFORM_KEYS.map(platform => [platform, 0])) as Record<Platform, number>
  for (const job of jobs) {
    const source = job as import('../shared/sourcing.js').SourcingJob
    const rows = job.kind === 'talent_sourcing' ? (source.greetings ?? []).filter(row => !!row.attemptedAt) : !job.kind || job.kind === 'greeting' ? job.results : []
    for (const result of rows) if (result.stage !== 'skipped' && dayKey(result.attemptedAt || result.updatedAt || job.createdAt) === dayKey(now)) counts['platform' in result ? (result as import('../shared/sourcing.js').SourcingGreeting).platform : job.platform]++
  }
  return counts
}
const date = () => new Date().toISOString()
export function createGreetingJob(request: unknown, configured: Partial<GreetingPolicy> = {}): GreetingJob {
  const input = greetingStartSpec.parse(request), defaults = greetingPolicy(configured)
  const intervalMinSeconds = input.intervalMinSeconds ?? defaults.intervalMinSeconds
  const intervalMaxSeconds = input.intervalMaxSeconds ?? defaults.intervalMaxSeconds
  if (intervalMaxSeconds < intervalMinSeconds) throw new Error('最大间隔不能小于最小间隔')
  return { kind: 'greeting', id: input.id, platform: input.platform, tabId: input.tabId, limit: input.limit,
    mode: input.mode, ...(input.search ? { search: input.search } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}), intervalMinSeconds, intervalMaxSeconds,
    phase: 'connecting', events: [], status: 'queued', results: [], createdAt: date(), updatedAt: date(), detail: '正在连接浏览器' }
}

