import { z } from 'zod'
import { Store, hash } from './store.js'
import { PLATFORM_KEYS } from '../shared/workbench.js'
import type { SourcingJob } from '../shared/sourcing.js'
import { defaultSourcingSettings, type SourcingSettings } from '../shared/sourcing-settings.js'

export const sourcingSettingsPatchSpec = z.object({
  supplement: z.string().max(4000).optional(),
  platforms: z.array(z.enum(PLATFORM_KEYS)).max(PLATFORM_KEYS.length).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  minimumScore: z.number().int().min(0).max(100).optional(),
  autoGreet: z.boolean().optional(),
}).strict()
type SettingsRecord = { jobId: string; settings: SourcingSettings; updatedAt: string }
// This prefix must not overlap task records listed with `sourcing-`.
const recordKey = (jobId: string) => `position-settings-${hash(jobId)}`
const writes = new Map<string, Promise<SourcingSettings>>()
const queueKey = (store: Store, jobId: string) => `${store.root}:${recordKey(jobId)}`

async function readSavedSettings(store: Store, jobId: string): Promise<SourcingSettings> {
  const record = await store.find<SettingsRecord>(recordKey(jobId))
  if (record) {
    if (record.jobId !== jobId) throw new Error('寻聘设置与当前职位不一致')
    return { ...defaultSourcingSettings(), ...sourcingSettingsPatchSpec.parse(record.settings) }
  }
  const latest = (await store.list<SourcingJob>('sourcing-'))
    .filter(job => job.kind === 'talent_sourcing' && job.jobId === jobId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]
  const settings = defaultSourcingSettings()
  if (latest) for (const field of Object.keys(sourcingSettingsPatchSpec.shape) as (keyof SourcingSettings)[]) {
    const parsed = sourcingSettingsPatchSpec.shape[field].safeParse(latest[field])
    if (parsed.success && parsed.data !== undefined) Object.assign(settings, { [field]: parsed.data })
  }
  return settings
}

export async function readSourcingSettings(store: Store, jobId: string) {
  await writes.get(queueKey(store, jobId))
  return readSavedSettings(store, jobId)
}

/** Serialize per-position patches, including reads, so typing and quick toggles
 * cannot restore older values or overwrite an unrelated setting. */
export async function saveSourcingSettings(store: Store, jobId: string, input: unknown) {
  const parsed = sourcingSettingsPatchSpec.parse(input)
  const patch = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined))
  const key = queueKey(store, jobId)
  const pending = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const settings = { ...await readSavedSettings(store, jobId), ...patch }
    await store.put(recordKey(jobId), { jobId, settings, updatedAt: new Date().toISOString() } satisfies SettingsRecord)
    return settings
  })
  writes.set(key, pending)
  try { return await pending } finally { if (writes.get(key) === pending) writes.delete(key) }
}
