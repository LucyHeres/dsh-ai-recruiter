import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/lib/store.js'
import { Workbench } from '../dist/lib/workbench.js'
import { readSourcingSettings, saveSourcingSettings } from '../dist/lib/sourcing-settings.js'
import { defaultSourcingSettings } from '../dist/shared/sourcing-settings.js'

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'position-sourcing-settings-'))
  const store = new Store(directory, 'company'); await store.init()
  try { await run(store, directory) } finally { await rm(directory, { recursive: true, force: true }) }
}
const settings = { supplement: '有软件销售经验优先', platforms: ['boss'], limit: 2, minimumScore: 6, autoGreet: false }
const round = (id, jobId, createdAt, extra = {}) => ({ id, jobId, createdAt, kind: 'talent_sourcing',
  ...settings, candidates: [], results: [], status: 'completed', ...extra })

test('positions without settings use only their latest round, preserving false, zero and empty values', async () => fixture(async store => {
  assert.deepEqual(await readSourcingSettings(store, 'new-position'), defaultSourcingSettings())
  await store.put('sourcing-old', round('old', 'sales', '2026-10-20', { minimumScore: 90 }))
  await store.put('sourcing-new', round('new', 'sales', '2026-10-23', { minimumScore: 0, supplement: '', platforms: [] }))
  await store.put('sourcing-other', round('other', 'java', '2026-10-24', { minimumScore: 99 }))
  const before = await store.get('sourcing-new')
  assert.deepEqual(await readSourcingSettings(store, 'sales'), { ...settings, minimumScore: 0, supplement: '', platforms: [] })
  assert.equal((await readSourcingSettings(store, 'java')).minimumScore, 99)
  assert.deepEqual(await store.get('sourcing-new'), before, 'reading preferences cannot rewrite execution history')
}))

test('edits persist without starting a run and remain isolated by position and company across restarts', async () => fixture(async (store, directory) => {
  await saveSourcingSettings(store, 'sales', settings)
  await saveSourcingSettings(store, 'java', { limit: 5, minimumScore: 85, autoGreet: true })
  const restarted = new Store(directory, 'company')
  assert.deepEqual(await readSourcingSettings(restarted, 'sales'), settings)
  assert.deepEqual(await readSourcingSettings(restarted, 'java'), { ...defaultSourcingSettings(), limit: 5, minimumScore: 85 })
  assert.deepEqual(await readSourcingSettings(new Store(directory, 'another-company'), 'sales'), defaultSourcingSettings())
  assert.deepEqual(await store.list('sourcing-'), [], 'settings must not be mistaken for tasks')
  await saveSourcingSettings(restarted, 'sales', { supplement: '', minimumScore: 0, platforms: [] })
  assert.deepEqual(await readSourcingSettings(store, 'sales'), { ...settings, supplement: '', minimumScore: 0, platforms: [] })
}))

test('rapid patches serialize and a concurrent read waits for all earlier edits', async () => fixture(async store => {
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const firstWrite = new Promise(resolve => { entered = resolve })
  const put = store.put.bind(store); let writes = 0
  store.put = async (...args) => { if (++writes === 1) { entered(); await gate }; return put(...args) }
  const edits = [saveSourcingSettings(store, 'sales', { limit: 3 })]
  await firstWrite
  edits.push(saveSourcingSettings(store, 'sales', { minimumScore: 0 }),
    saveSourcingSettings(store, 'sales', { supplement: '第一版' }),
    saveSourcingSettings(store, 'sales', { supplement: '最后一版', autoGreet: false }))
  const read = readSourcingSettings(store, 'sales')
  release(); await Promise.all(edits)
  assert.deepEqual(await read, { ...defaultSourcingSettings(), limit: 3, minimumScore: 0, supplement: '最后一版', autoGreet: false })
}))

test('invalid edits are rejected without erasing the last saved settings', async () => fixture(async store => {
  await saveSourcingSettings(store, 'sales', settings)
  for (const invalid of [{ limit: 0 }, { limit: 51 }, { minimumScore: -1 }, { minimumScore: 101 },
    { minimumScore: NaN }, { minimumScore: 6.5 }, { autoGreet: 'false' }, { platforms: ['unknown'] },
    { supplement: 'a'.repeat(4001) }, { candidates: [] }]) {
    await assert.rejects(saveSourcingSettings(store, 'sales', invalid))
  }
  assert.deepEqual(await readSourcingSettings(store, 'sales'), settings)
}))

test('a failed save is reported and does not prevent a later edit from being persisted', async () => fixture(async store => {
  const put = store.put.bind(store)
  store.put = async () => { throw new Error('disk full') }
  await assert.rejects(saveSourcingSettings(store, 'sales', { limit: 3 }), /disk full/)
  store.put = put
  await saveSourcingSettings(store, 'sales', { limit: 4 })
  assert.equal((await readSourcingSettings(store, 'sales')).limit, 4)
}))

test('workbench restores settings alongside fresh position details and saves only local preferences', async () => fixture(async store => {
  const service = Object.create(Workbench.prototype)
  service.store = store
  const position = { id: 'sales', name: '销售', description: '最新职位要求', basicRequirements: { education: '大专' }, platforms: ['boss'] }
  service.sourcing = { loadPosition: async (id, signal) => { assert.equal(id, 'sales'); signal?.throwIfAborted(); return position } }
  await service.saveSourcingSettings({ jobId: 'sales', settings })
  assert.deepEqual(await service.sourcingPosition({ jobId: 'sales' }, new AbortController().signal), { ...position, settings })
  await assert.rejects(service.saveSourcingSettings({ jobId: '../outside', settings: { limit: 0 } }))
  await assert.rejects(service.saveSourcingSettings({ jobId: '', settings }))
  assert.deepEqual(await store.list('sourcing-'), [])
}))
