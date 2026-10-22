import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store, hash } from '../dist/lib/store.js'
import { liepinContacts, liepinConversation, liepinAttachmentAddress } from '../dist/lib/platforms/liepin/received-resumes.js'
import { assertLiepinResumeRead } from '../dist/lib/liepin-resume-sync.js'
import { saveReceivedResume, receivedResumes, candidateAttachments, cachedReceivedFile, cacheReceivedFile, selectReceivedResumes } from '../dist/lib/received-resume-store.js'
import { receivedIngestId, uploadReceivedFiles } from '../dist/lib/received-resume-upload.js'
import { RecruitEngine } from '../dist/lib/recruit-engine.js'
import { Workbench } from '../dist/lib/workbench.js'
import { ResumeImport } from '../dist/lib/resume-import.js'

const signal = () => AbortSignal.timeout(5000)
const resumeId = 'resume_1234', userId = 'user_1234', imId = 'chat_1234', ownImId = 'recruiter_1234'
const candidate = (id = resumeId) => ({ key: hash(id), platform: 'liepin', platformIdentity: { kind: 'resume', id, source: 'card_class' }, profileUrl: '', name: '同名候选人', fields: [], score: 90 })
const business = (bizType = '7', extra = {}) => JSON.stringify({ ext: { extType: 203, extBody: { bizType, bizData: { onlineResume: { param: JSON.stringify({ encodeResId: resumeId, userId }) }, ...extra } } } })
const attachment = () => business('7', { attachmentResume: { param: JSON.stringify({ encodeAttachmentId: 'attachment_1234', userId }) } })
const message = (extra = {}) => ({ oppositeImId: imId, imId: ownImId, oppositeUserId: userId, oppositeImUserType: '0', msgSendImId: imId, payload: attachment(), msgId: 'message_1234', msgTime: 1792500000000, revokeFlag: false, ...extra })
const response = (...rows) => ({ flag: 1, data: { list: rows, hasMore: false } })
const contact = () => liepinContacts(response({ oppositeUserId: userId, oppositeImId: imId, imId: ownImId, oppositeImUserType: '0', name: '同名候选人', lastPayload: attachment(), latestMsgId: 'message_1234', latestMsgSendImId: imId })).rows[0]
const evidence = () => ({ resumeId, conversationId: imId, messageId: 'message_1234', attachmentId: 'attachment_1234', fileName: '候选人.pdf', downloadUrl: 'https://tdoss.liepin.com/o/recruit-auth/resume/attachment-res/c/file.pdf?tk=private' })
const options = { jobs: [{ id: 'java', label: 'Java' }], destinations: [{ id: '1:10', resumeLibrary: 1, resumeLibraryStatus: 10 }], channels: [{ id: '0', channelType: 0 }], deliveries: [{ id: '1', deliveryType: 1 }], defaults: { channel: '0', delivery: '1' } }
const withStore = async fn => { const root = await mkdtemp(join(tmpdir(), 'received-resumes-')); const store = new Store(root, 'company'); await store.init(); try { return await fn(store) } finally { await rm(root, { recursive: true, force: true }) } }
const file = (text = '%PDF-1.7\nreceived attachment') => ({ blob: new Blob([text], { type: 'application/pdf' }), fileName: '候选人.pdf' })
async function record(store, extra = {}, person = candidate()) {
  const { record } = await saveReceivedResume(store, person, { ...evidence(), ...extra })
  await cacheReceivedFile(store, record, file())
  return (await receivedResumes(store)).find(r => r.id === record.id)
}

test('received attachment joins use chat/user/resume/message IDs; names and online-only cards cannot create files', () => {
  const c = contact(); assert.equal(c.resumeId, resumeId)
  assert.equal(liepinConversation(response(message()), c, resumeId).files.length, 1)
  assert.equal(liepinConversation(response(message({ payload: business() })), c, resumeId).files.length, 0)
  for (const wrong of [{ oppositeImId: 'wrong_chat' }, { oppositeUserId: 'wrong_user' }, { msgSendImId: ownImId }, { revokeFlag: true }]) {
    assert.equal(liepinConversation(response(message(wrong)), c, resumeId).files.length, 0)
  }
  assert.equal(liepinConversation(response(message()), c, 'same_name_different_id').resumeId, undefined)
  const foreign = business('7', { onlineResume: { param: JSON.stringify({ encodeResId: 'foreign_resume', userId: 'foreign_user' }) } })
  assert.equal(liepinContacts(response({ oppositeUserId: userId, oppositeImId: imId, imId: ownImId, oppositeImUserType: '0', name: '同名候选人', lastPayload: foreign })).rows[0].resumeId, undefined)
  const historical = business('2', { resumeInfo: { userId, resumeId: 'historical_encoded_resume' } })
  assert.equal(liepinConversation(response(message(), message({ payload: historical })), c, resumeId).files.length, 1, 'older encoded aliases belong only to their verified chat user')
  assert.equal(liepinConversation(response(message(), message({ payload: historical })), c, 'historical_encoded_resume').files.length, 1)
})
test('attachment URLs are accepted only from the observed Liepin file service and valid document types', () => {
  const r = { flag: 1, data: { fileExtension: 'pdf', fileName: '../简历', accessPath: evidence().downloadUrl } }
  assert.match(liepinAttachmentAddress(r).fileName, /简历\.pdf$/)
  for (const accessPath of ['http://tdoss.liepin.com/o/recruit-auth/resume/attachment-res/file.pdf', 'https://tdoss.liepin.com.evil.test/o/recruit-auth/resume/attachment-res/file.pdf', 'https://127.0.0.1/file.pdf', 'https://tdoss.liepin.com/api/login']) {
    assert.throws(() => liepinAttachmentAddress({ ...r, data: { ...r.data, accessPath } }))
  }
  assert.throws(() => liepinAttachmentAddress({ ...r, data: { ...r.data, fileExtension: 'html' } }))
})
test('resume synchronization grants navigation and one verified download, never arbitrary messaging or scripts', () => {
  const grant = { snapshotId: 'snapshot', ref: 'download', capture: true }
  assert.doesNotThrow(() => assertLiepinResumeRead({ name: 'browser_acquire_file', purpose: 'navigation', args: { snapshotId: 'snapshot', ref: 'download', mode: 'download' } }, grant))
  for (const name of ['browser_type', 'browser_press_key', 'browser_execute_js', 'browser_execute_actions']) assert.throws(() => assertLiepinResumeRead({ name, purpose: 'navigation', args: {} }, grant), /READ_ONLY/)
  assert.throws(() => assertLiepinResumeRead({ name: 'browser_click', purpose: 'navigation', args: { snapshotId: 'snapshot', ref: 'send' } }, grant), /READ_ONLY/)
  assert.throws(() => assertLiepinResumeRead({ name: 'browser_acquire_file', purpose: 'business_write', args: { snapshotId: 'snapshot', ref: 'download', mode: 'download' } }, grant), /READ_ONLY/)
})
test('attachment facts are shared across rounds and retain receipts on resync without leaking signed links', async () => withStore(async store => {
  const r = await record(store), person = candidate()
  await saveReceivedResume(store, person, { ...evidence(), downloadUrl: evidence().downloadUrl + 'new' })
  assert.equal((await receivedResumes(store)).length, 1)
  const projected = candidateAttachments({ ...person, key: hash('new-round') }, 'java', await receivedResumes(store))
  assert.equal(projected.length, 1); assert.equal(projected[0].id, r.id)
  assert.doesNotMatch(JSON.stringify(projected), /https|tk=|conversationId|messageId|downloadUrl/)
  assert.equal(candidateAttachments(candidate('different_resume'), 'java', await receivedResumes(store)).length, 0)
  await assert.rejects(saveReceivedResume(store, candidate('different_resume'), evidence()), /MISMATCH/)
  const before = await receivedResumes(store)
  await assert.rejects(cacheReceivedFile(store, r, { blob: new Blob(['<html>login</html>']), fileName: 'resume.pdf' }), /FORMAT_INVALID/)
  assert.equal((await cachedReceivedFile(store, before[0])).blob.size, file().blob.size)
  await writeFile(store.path(`received-file-${r.id}`, 'bin'), 'tampered')
  await assert.rejects(cachedReceivedFile(store, before[0]), /CACHE_INVALID/)
}))
test('downloads validate position, round, candidate and attachment before returning bounded original file bytes', async () => withStore(async store => {
  const r = await record(store), id = randomUUID(), person = candidate(), data = '%PDF-1.7\n' + 'a'.repeat(180000)
  await cacheReceivedFile(store, r, file(data))
  await store.put(`sourcing-${id}`, { id, kind: 'talent_sourcing', jobId: 'java', candidates: [person] })
  const service = Object.create(Workbench.prototype); Object.assign(service, { store })
  const request = { jobId: 'java', roundId: id, key: person.key, attachmentId: r.id }
  const parts = []; let offset = 0
  while (true) {
    const chunk = await service.downloadReceivedResume({ ...request, offset });const bytes = Buffer.from(chunk.base64, 'base64')
    assert.ok(bytes.length <= 98304); assert.equal(chunk.offset, offset); parts.push(bytes); offset += bytes.length
    if (chunk.eof) break
  }
  assert.equal(Buffer.concat(parts).toString(), data)
  for (const wrong of [{ jobId: 'other' }, { roundId: randomUUID() }, { key: hash('other') }, { attachmentId: hash('other') }, { offset }]) await assert.rejects(service.downloadReceivedResume({ ...request, ...wrong }))
  await assert.rejects(selectReceivedResumes(store, 'other', 'all', [r.id]))
}))

function engine(store, mode = 'saved') {
  const writes = [], browser = { call() { throw Error('Browser must not run while uploading a cached file') } }
  return { writes, engine: new RecruitEngine({ store, browser, signal: signal(), xin: {
    uploadUrl: async () => ({ ok: true, data: 'https://files.xinrenxinshi.com/site/upload?token=fixture' }),
    uploadFile: async (_url, file) => { writes.push('file'); assert.match(await file.blob.text(), /^%PDF-/); return { fileKey: 'file-key' } },
    call: async (name, args) => {
      if (name === 'extensionInit') return { ok: true, data: {} }
      writes.push(name)
      if (name === 'preuploadResume') return { ok: true, data: { resumeId: 'parsed-resume' } }
      assert.equal(name, 'submitUploadResume');assert.equal(args.jobId, 'java');assert.equal(args.resumeLibrary, 1);assert.equal(args.resumeLibraryStatus, 10)
      return mode === 'unknown' ? { ok: false, failure: { code: 'TIMEOUT', message: 'reply lost', outcome: 'unknown' } } : { ok: true, data: {} }
    },
  } }) }
}
test('received files reuse upload/parse/final-submit and deduplicate by position, person and bytes across messages/tasks', async () => withStore(async store => {
  const first = await record(store), second = await record(store, { messageId: 'message_again' })
  assert.equal(receivedIngestId('java', first), receivedIngestId('java', second))
  assert.notEqual(receivedIngestId('other', first), receivedIngestId('java', first))
  const actual = engine(store), results = []
  const run = records => uploadReceivedFiles({ store, engine: actual.engine, jobId: 'java', records, options, signal: signal(), onResult: async r => { if (r.stage !== 'sending') results.push(r) } })
  await run([first, second]);assert.deepEqual(actual.writes, ['file', 'preuploadResume', 'submitUploadResume'])
  assert.deepEqual(results.map(r => r.stage), ['succeeded', 'skipped'])
  await run(await receivedResumes(store));assert.equal(actual.writes.length, 3)
  assert.ok(candidateAttachments(candidate(), 'java', await receivedResumes(store)).every(r => r.uploadedAt))
  assert.ok(candidateAttachments(candidate(), 'other', await receivedResumes(store)).every(r => !r.uploadedAt))
}))
test('lost final receipt durably stops the batch, prevents replay after restart and never marks it uploaded', async () => withStore(async store => {
  const first = await record(store), second = await record(store, { messageId: 'different_message' }, candidate())
  const actual = engine(store, 'unknown'), results = []
  const result = await uploadReceivedFiles({ store, engine: actual.engine, jobId: 'java', records: [first, second], options, signal: signal(), onResult: async r => results.push({ ...r }) })
  assert.equal(result.stopped, true);assert.equal(results.at(-1).stage, 'unknown')
  const restarted = engine(store)
  await uploadReceivedFiles({ store, engine: restarted.engine, jobId: 'java', records: await receivedResumes(store), options, signal: signal(), onResult: async () => {} })
  assert.deepEqual(restarted.writes, [])
  const list = candidateAttachments(candidate(), 'java', await receivedResumes(store));assert.ok(list.some(r => r.uploadStopped));assert.ok(list.every(r => !r.uploadedAt))
}))
test('received batch tasks validate ownership/options and run without a browser or model', async () => withStore(async store => {
  const r = await record(store), id = randomUUID(), actual = engine(store)
  await store.put(`sourcing-${id}`, { id, kind: 'talent_sourcing', jobId: 'java', candidates: [candidate()] })
  const importer = new ResumeImport({ call: () => { throw Error('Browser called') } }, store, () => null, () => actual.engine, () => { throw Error('Model called') })
  importer.options = async () => options
  const job = importer.create({ id: randomUUID(), jobId: 'java', roundId: id, attachmentIds: [r.id], resumeSource: 'platform_received', confirmed: true })
  await importer.run(job, signal());assert.equal(job.status, 'completed');assert.equal(job.results[0].stage, 'succeeded')
  const wrong = importer.create({ id: randomUUID(), jobId: 'other', roundId: id, attachmentIds: [r.id], resumeSource: 'platform_received', confirmed: true })
  await importer.run(wrong, signal());assert.equal(wrong.status, 'failed');assert.equal(actual.writes.length, 3)
}))
