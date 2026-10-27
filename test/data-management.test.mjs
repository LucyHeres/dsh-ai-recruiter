import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store, hash } from '../dist/lib/store.js'
import { dataStorage, clearData } from '../dist/lib/data-management.js'
import { greetingHistory } from '../dist/lib/greeting-history.js'
import { dailyUsage } from '../dist/lib/greeting-policy.js'
import { taskHistoryPage, sourcingResults, communicationIndex } from '../dist/lib/sourcing-review.js'
import { saveReceivedResume, receivedResumes, updateReceivedResume } from '../dist/lib/received-resume-store.js'
import { DeveloperLog } from '../dist/lib/developer-log.js'
import { Workbench } from '../dist/lib/workbench.js'
import { positionOverview } from '../dist/lib/position-overview.js'

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'recruiter-data-')), store = new Store(root, 'test-company')
  try {
    await store.init()
    const now = new Date().toISOString(), sourceId = randomUUID(), greetingId = randomUUID()
    const person = { key: hash('candidate'), name: '候选人姓名', platform: 'liepin', platformIdentity: { kind: 'resume', id: 'resume_1234' },
      resumeText: '简历正文'.repeat(3000), fields: [], assessments: [], score: 90, collectedAt: now, scope: 'online' }
    const result = { key: hash('greet'), name: person.name, detail: '操作详情'.repeat(500), stage: 'unknown', attemptedAt: now, updatedAt: now }
    const source = { id: sourceId, kind: 'talent_sourcing', platform: 'liepin', platforms: ['liepin'], jobId: 'java',
      position: { id: 'java', name: 'Java', department: '研发', city: '北京', description: '职位要求'.repeat(300), fetchedAt: now },
      candidates: [person], viewedCandidates: [{key:person.key,platform:'liepin'},{key:'list-reject',platform:'liepin'}], scanned: 2, requirements: { keyword: 'Java', criteria: [] }, requirementVersion: 'version', supplement: '补充要求',
      limit: 20, channels: [], status: 'completed', createdAt: now, updatedAt: now, detail: '本轮已完成',
      events: [{ at: now, message: '任务日志'.repeat(1000) }], results: [], greetings: [{ ...result, platform: 'liepin', candidateKey: person.key }] }
    const greeting = { id: greetingId, kind: 'greeting', platform: 'liepin', jobId: 'java', limit: 1, status: 'unknown',
      createdAt: now, updatedAt: now, detail: '招呼结果未知', results: [result], events: [{ at: now, message: '操作动态'.repeat(1000) }] }
    await store.put(`sourcing-${sourceId}`, source); await store.put(`greeting-${greetingId}`, greeting)
    await store.put('position-settings-keep', { supplement: '保留设置' }); await store.put('ingest-protected', { stage: 'unknown' })
    await store.put('criteria-version', source.requirements)
    const log = new DeveloperLog(store.root); log.write('info', 'test.record'); await log.flush()
    const evidence = { resumeId: 'resume_1234', conversationId: 'chat_1234', messageId: 'message_1234', attachmentId: 'attachment_1234',
      fileName: '附件.pdf', downloadUrl: 'https://tdoss.liepin.com/o/recruit-auth/resume/attachment-res/file.pdf?secret=value' }
    const { record } = await saveReceivedResume(store, person, evidence)
    await updateReceivedResume(store, record.id, row => { row.cached = { mimeType: 'application/pdf', size: 9, sha256: hash('bytes') }; row.uploads = { java: { taskId: 'protected_task', stage: 'unknown', at: now } } })
    await writeFile(store.path(`received-file-${record.id}`, 'bin'), '%PDF-data')
    await run({ store, source, greeting, person, evidence, record, log })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('the two size groups contain task logs and talent payloads without changing data', async () => fixture(async ({ store, source }) => {
  const before = await store.get(`sourcing-${source.id}`), usage = await dataStorage(store)
  assert.ok(usage.tasks.bytes > 10000); assert.ok(usage.talents.bytes > 30000)
  assert.deepEqual(await store.get(`sourcing-${source.id}`), before)
}))

test('clearing task records preserves talent details, communication receipts and daily quotas', async () => fixture(async ({ store, source, person, log }) => {
  const quota = dailyUsage(await greetingHistory(store)), before = await dataStorage(store)
  const result = await clearData(store, 'tasks', () => log.clear())
  assert.equal(result.usage.tasks.bytes, 0); assert.ok(result.usage.talents.bytes > 0); assert.ok(result.bytes > 0)
  const jobs = await greetingHistory(store)
  assert.equal(taskHistoryPage(jobs, 1).total, 0); assert.deepEqual(dailyUsage(jobs), quota)
  const saved = await store.get(`sourcing-${source.id}`)
  assert.deepEqual(saved.candidates, source.candidates); assert.deepEqual(saved.position, source.position)
  assert.equal(positionOverview([{id:'java'}],jobs)[0].viewedCount,2,'clearing task history retains the live browsing data')
  assert.equal(saved.greetings[0].stage, 'unknown'); assert.equal(saved.greetings[0].name, '')
  assert.equal(saved.events, undefined); assert.equal(saved.detail, '')
  assert.equal(sourcingResults([saved], 'java', 'all', communicationIndex(jobs)).candidates[0].name, person.name)
  assert.equal((await receivedResumes(store)).length, 1)
  assert.equal((await clearData(store, 'tasks', () => log.clear())).bytes, 0)
  assert.ok(before.tasks.bytes > (await dataStorage(store)).tasks.bytes)
}))

test('clearing talents keeps task history and restores unknown attachment receipts on later synchronization', async () => fixture(async ({ store, source, person, evidence, log }) => {
  const before = await store.get(`greeting-${(await greetingHistory(store)).find(j => j.kind === 'greeting').id}`)
  const result = await clearData(store, 'talents', () => log.clear())
  assert.equal(result.usage.talents.bytes, 0); assert.ok(result.usage.tasks.bytes > 0)
  const saved = await store.get(`sourcing-${source.id}`)
  assert.deepEqual(saved.candidates, []); assert.equal(saved.requirements, undefined); assert.equal(saved.position.description, '')
  assert.deepEqual(sourcingResults([saved], 'java', 'all', new Map()).candidates, [])
  assert.deepEqual(sourcingResults([saved], 'java', 'all', new Map()).rounds, [])
  assert.equal(taskHistoryPage([saved], 1).records[0].completed, 1)
  assert.deepEqual(await store.get(`greeting-${before.id}`), {...before,talentCleared:true})
  assert.equal(saved.viewedCandidates,undefined)
  const overview=positionOverview([{id:'java'}],await greetingHistory(store))[0]
  assert.deepEqual([overview.viewedCount,overview.greetedCount,overview.resumeCount],[0,0,0])
  assert.deepEqual(await receivedResumes(store), [])
  await assert.rejects(readFile(store.path(`received-file-${(await store.get('attachment-receipts'))[0].id}`, 'bin')), { code: 'ENOENT' })
  const receipts = await store.get('attachment-receipts')
  assert.doesNotMatch(JSON.stringify(receipts), /候选人姓名|附件.pdf|https:|message_1234|chat_1234/)
  const restored = (await saveReceivedResume(store, person, evidence)).record
  assert.equal(restored.uploads.java.stage, 'unknown'); assert.equal(restored.content.sha256, hash('bytes'))
  assert.deepEqual(await store.get('ingest-protected'), { stage: 'unknown' })
  assert.deepEqual(await store.get('position-settings-keep'), { supplement: '保留设置' })
}))

test('either cleanup order empties both user data groups and retains irreversible-write safeguards', async () => {
  for (const order of [['tasks', 'talents'], ['talents', 'tasks']]) await fixture(async ({ store, log }) => {
    const quota = dailyUsage(await greetingHistory(store))
    for (const group of order) await clearData(store, group, () => log.clear())
    assert.deepEqual(await dataStorage(store), { tasks: { bytes: 0 }, talents: { bytes: 0 } })
    assert.deepEqual(dailyUsage(await greetingHistory(store)), quota)
    assert.equal(taskHistoryPage(await greetingHistory(store), 1).total, 0)
  })
})

test('active tasks and invalid confirmation block cleanup before any mutation', async () => fixture(async ({ store, source, log }) => {
  await store.put(`sourcing-${source.id}`, { ...source, status: 'running' })
  for (const group of ['tasks', 'talents']) await assert.rejects(clearData(store, group, () => log.clear()), /当前任务结束/)
  assert.deepEqual((await store.get(`sourcing-${source.id}`)).candidates, source.candidates)
  const service = Object.create(Workbench.prototype)
  Object.assign(service, { store, logger: log, initialize: async () => {}, active: null })
  for (const request of [{ group: 'tasks', confirmed: false }, { group: 'wrong', confirmed: true }, { confirmed: true }]) await assert.rejects(service.clearData(request))
  service.active = { id: source.id }
  await assert.rejects(service.clearData({ group: 'tasks', confirmed: true }), /BUSY/)
}))
