import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store, hash } from '../dist/lib/store.js'
import { Workbench } from '../dist/lib/workbench.js'
import { SourcingAgent } from '../dist/lib/sourcing-agent.js'
import { sourcingVersion } from '../dist/lib/sourcing-policy.js'
import { readSourcingSettings, saveSourcingSettings } from '../dist/lib/sourcing-settings.js'
import { defaultSourcingSettings } from '../dist/shared/sourcing-settings.js'
import { sourcingMinimumScore } from '../dist/shared/sourcing-score.js'

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'position-sourcing-settings-'))
  const store = new Store(directory, 'company'); await store.init()
  try { await run(store, directory) } finally { await rm(directory, { recursive: true, force: true }) }
}
const settings = { supplement: '有软件销售经验优先', jobDescription: '负责软件产品销售', platforms: ['boss'], limit: 2, minimumScore: 6, autoGreet: true }
const round = (id, jobId, createdAt, extra = {}) => ({ id, jobId, createdAt, kind: 'talent_sourcing',
  ...settings, autoGreet: false, candidates: [], results: [], status: 'completed', ...extra })

test('new settings default to 80 points while historical executions retain their original threshold', () => {
  assert.equal(defaultSourcingSettings().minimumScore, 80)
  assert.equal(defaultSourcingSettings().autoGreet, true)
  assert.equal(sourcingMinimumScore({}), 60)
  assert.equal(sourcingMinimumScore({ minimumScore: 60 }), 60)
})

test('stored opt-outs are ignored for new settings and older clients cannot disable greetings', async () => fixture(async store => {
  const key = `position-settings-${hash('legacy')}`
  await store.put(key, { jobId: 'legacy', settings: { ...settings, autoGreet: false }, updatedAt: '' })
  assert.deepEqual(await readSourcingSettings(store, 'legacy'), settings)
  assert.equal((await store.get(key)).settings.autoGreet, false, 'reading does not rewrite the stored record')
  const saved = await saveSourcingSettings(store, 'legacy', { autoGreet: false, minimumScore: 75 })
  assert.equal(saved.autoGreet, true)
  assert.equal(saved.minimumScore, 75, 'a custom threshold is still respected')
  assert.equal((await store.get(key)).settings.autoGreet, true)
}))

test('positions use the latest round with greetings enabled, preserving zero and empty values', async () => fixture(async store => {
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
  assert.deepEqual(await read, { ...defaultSourcingSettings(), limit: 3, minimumScore: 0, supplement: '最后一版', autoGreet: true })
}))

test('per-platform targets save up to 100 and invalid edits preserve the last saved settings', async () => fixture(async store => {
  for (const limit of [1, 51, 100]) {
    await saveSourcingSettings(store, 'sales', { limit })
    assert.equal((await readSourcingSettings(store, 'sales')).limit, limit)
  }
  await saveSourcingSettings(store, 'sales', settings)
  for (const invalid of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { minimumScore: -1 }, { minimumScore: 101 },
    { minimumScore: NaN }, { minimumScore: 6.5 }, { autoGreet: 'false' }, { platforms: ['unknown'] },
    { supplement: 'a'.repeat(4001) }, { jobDescription: 'a'.repeat(20001) }, { jobDescription: null }, { candidates: [] }]) {
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

test('edited JDs reach task requirements and invalidate cached standards while preserving fixed conditions', async () => fixture(async store => {
  const position = { id: 'sales', name: '销售', city: '上海', platforms: ['boss'],
    description: '原始职位职责\n学历要求：大专', descriptionHtml: '<p>原始职位职责</p>',
    jobDescription: { text: '原始职位职责', html: '<p>原始职位职责</p>' },
    basicRequirements: { education: '大专', experience: '1–3年', city: '上海', salary: '10–20K' },
    searchFields: { education: '大专', experience: '1–3年', city: '上海' } }
  const agent = new SourcingAgent(store, async () => { throw new Error('unexpected browser action') },
    async () => {}, async () => [], () => async () => {}, async () => position)
  const prepare = async jobDescription => {
    const job = agent.create({ id: randomUUID(), jobId: 'sales', platforms: ['boss'], limit: 1, confirmed: true,
      ...(jobDescription === undefined ? {} : { jobDescription }) })
    await agent.prepare(job, new AbortController().signal)
    return job
  }
  const edited = '负责软件产品销售\n熟悉 SQL <基础> & 客户管理'
  await saveSourcingSettings(store, 'sales', { jobDescription: edited })
  const job = await prepare((await readSourcingSettings(store, 'sales')).jobDescription)
  assert.equal(job.position.jobDescription.text, edited)
  assert.match(job.position.description, /SQL <基础> & 客户管理/)
  assert.doesNotMatch(job.position.description, /原始职位职责/)
  assert.equal(job.position.descriptionHtml, '')
  for (const value of Object.values(position.basicRequirements)) assert.ok(job.position.description.includes(value))
  assert.deepEqual(job.position.basicRequirements, position.basicRequirements)
  assert.notEqual(job.requirementVersion, sourcingVersion(position, ''))
  await saveSourcingSettings(store, 'sales', { jobDescription: '' })
  const cleared = await prepare((await readSourcingSettings(store, 'sales')).jobDescription)
  assert.equal(cleared.position.jobDescription.text, '')
  assert.doesNotMatch(cleared.position.description, /原始职位职责|负责软件产品销售/)
  assert.match(cleared.position.description, /学历要求：大专/)
  assert.deepEqual((await prepare()).position, position, 'omitting the edit preserves the freshly loaded source')
}))
