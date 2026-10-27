import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile, writeFile, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store, hash } from '../dist/lib/store.js'
import { liepinContacts, liepinConversation, liepinAttachmentAddress } from '../dist/lib/platforms/liepin/received-resumes.js'
import { assertLiepinResumeRead, syncLiepinResumes, LIEPIN_RESUME_ORIGINS } from '../dist/lib/platforms/liepin/resume-sync.js'
import { saveReceivedResume, receivedResumes, candidateAttachments, updateReceivedResume, selectReceivedResumes, receivedResumeStorage, clearReceivedResumeCache } from '../dist/lib/received-resume-store.js'
import { receivedIngestId, uploadReceivedFiles } from '../dist/lib/received-resume-upload.js'
import { resumeFileFingerprint, fetchReceivedResumeFile } from '../dist/lib/received-resume-file.js'
import { ReceivedResumeDownloads } from '../dist/lib/received-resume-download.js'
import { RecruitEngine } from '../dist/lib/recruit-engine.js'
import { Workbench } from '../dist/lib/workbench.js'
import { recruitmentPlatform } from '../dist/lib/platforms/registry.js'
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
  const fingerprint = await resumeFileFingerprint(file())
  const { record } = await saveReceivedResume(store, person, { ...evidence(), ...extra })
  await updateReceivedResume(store, record.id, row => { row.content = fingerprint })
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
test('Liepin synchronization opens chat and selects 有简历 even for historical candidates without IDs', async () => withStore(async store => {
  let selected = false, guard, current
  const calls = []
  const broker = { tools: [], setBeforeCall: callback => { guard = callback }, currentPage: () => current,
    inspectRefs: async () => {}, getInspection: () => ({ element: { attributes: { class: selected ? 'ant-im-segmented-item-selected' : '' } } }) }
  const names = ['browser_list_tabs', 'browser_network_requests', 'browser_network_response', 'browser_navigate', 'browser_snapshot', 'browser_inspect_element', 'browser_click', 'browser_acquire_file', 'artifact_read']
  broker.tools = names.map(name => ({ name, execute: async (args = {}) => {
    guard?.({ name, args, readOnly: ['browser_list_tabs', 'browser_network_requests', 'browser_network_response', 'browser_snapshot', 'browser_inspect_element', 'artifact_read'].includes(name) })
    calls.push({ name, args })
    if (name === 'browser_list_tabs') return { tabs: [{ tabId: 7, url: 'https://lpt.liepin.com/recommend', active: true }] }
    if (name === 'browser_navigate') return {}
    if (name === 'browser_snapshot') return current = { tabId: 7, url: 'https://lpt.liepin.com/chat/im', snapshotId: randomUUID(), dialogs: [],
      items: [{ ref: 'received-tab', role: 'label', name: '有简历', states: selected ? ['selected'] : [] }] }
    if (name === 'browser_click') { assert.equal(args.ref, 'received-tab'); selected = true; return {} }
    if (name === 'browser_network_requests') return { requests: selected ? [{ responseRef: 'observed-contacts', url: 'https://api-lpt.liepin.com/api/com.liepin.im.b.contact.filter-contacts-v1', method: 'POST', status: 200, finished: true, mimeType: 'application/json' }] : [] }
    if (name === 'browser_network_response') { assert.equal(args.responseRef, 'observed-contacts'); return { data: response() } }
    throw new Error(`Unexpected call: ${name}`)
  } }))
  const result = await syncLiepinResumes(broker, [{ ...candidate(), platformIdentity: undefined }], store, signal())
  assert.equal(calls.find(call => call.name === 'browser_navigate').args.url, 'https://lpt.liepin.com/chat/im')
  assert.ok(calls.some(call => call.name === 'browser_click' && call.args.ref === 'received-tab'))
  assert.ok(calls.some(call => call.name === 'browser_network_response'))
  assert.ok(calls.every(call => call.args.url !== 'https://lpt.liepin.com/resume/apply'))
  assert.equal(result.status, 'completed'); assert.equal(result.unidentified, 1)
  assert.match(result.detail, /已跳过 1 条缺少平台 ID 的历史记录/)
  assert.equal(calls.filter(call => call.name === 'browser_navigate').length, 1, 'keep the final received-resume view instead of restoring the old URL')
}))
test('Liepin login redirects retain both new and existing tabs and never restore over the login page', async () => withStore(async store => {
  assert.ok(LIEPIN_RESUME_ORIGINS.includes('https://passport.liepin.com'), 'login redirects must not trigger extension-side tab removal')
  for (const created of [true, false]) {
    const calls = []; let current
    const broker = { tools: [], setBeforeCall() {}, currentPage: () => current }
    broker.tools = ['browser_list_tabs', 'browser_open_tab', 'browser_close_tab', 'browser_navigate', 'browser_snapshot', 'browser_network_requests', 'browser_network_response', 'browser_acquire_file', 'artifact_read'].map(name => ({ name, execute: async (args = {}) => {
      calls.push({ name, args })
      if (name === 'browser_list_tabs') return { tabs: created ? [] : [{ tabId: 7, url: 'https://lpt.liepin.com/recommend', active: true }] }
      if (name === 'browser_open_tab') return { tabId: 7 }
      if (name === 'browser_navigate') return {}
      if (name === 'browser_network_requests') return { requests: [] }
      if (name === 'browser_snapshot') return current = { tabId: 7, url: 'https://passport.liepin.com/login', isLoginPage: true, items: [] }
      throw new Error(`Unexpected operation: ${name}`)
    } }))
    await assert.rejects(syncLiepinResumes(broker, [candidate()], store, signal()), error => error.code === 'PLATFORM_LOGIN_REQUIRED')
    assert.equal(calls.some(c => c.name === 'browser_close_tab'), false)
    assert.equal(calls.filter(c => c.name === 'browser_navigate').length, 1)
    assert.equal(calls.at(-1).name, 'browser_snapshot')
  }
}))
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
  await assert.rejects(resumeFileFingerprint({ blob: new Blob(['<html>login</html>']), fileName: 'resume.pdf' }), /FORMAT_INVALID/)
}))
test('downloads validate position, round, candidate and attachment before returning bounded original file bytes', async () => withStore(async store => {
  const r = await record(store), id = randomUUID(), person = candidate(), data = '%PDF-1.7\n' + 'a'.repeat(180000)
  await store.put(`sourcing-${id}`, { id, kind: 'talent_sourcing', jobId: 'java', candidates: [person] })
  let fetched = 0
  const service = Object.create(Workbench.prototype); Object.assign(service, { store, resume: { receivedFile: async () => { fetched++; return file(data) } } })
  const request = { jobId: 'java', roundId: id, key: person.key, attachmentId: r.id }
  const parts = []; let offset = 0, downloadId
  while (true) {
    const chunk = await service.downloadReceivedResume({ ...request, offset, ...(downloadId ? { downloadId } : {}) }); downloadId = chunk.downloadId; const bytes = Buffer.from(chunk.base64, 'base64')
    assert.ok(bytes.length <= 98304); assert.equal(chunk.offset, offset); parts.push(bytes); offset += bytes.length
    if (chunk.eof) break
  }
  assert.equal(Buffer.concat(parts).toString(), data); assert.equal(fetched, 1)
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
  const run = records => uploadReceivedFiles({ store, engine: actual.engine, jobId: 'java', records, options, signal: signal(), readFile: async () => file(), onResult: async r => { if (r.stage !== 'sending') results.push(r) } })
  await run([first, second]);assert.deepEqual(actual.writes, ['file', 'preuploadResume', 'submitUploadResume'])
  assert.deepEqual(results.map(r => r.stage), ['succeeded', 'skipped'])
  await run(await receivedResumes(store));assert.equal(actual.writes.length, 3)
  assert.ok(candidateAttachments(candidate(), 'java', await receivedResumes(store)).every(r => r.uploadedAt))
  assert.ok(candidateAttachments(candidate(), 'other', await receivedResumes(store)).every(r => !r.uploadedAt))
}))
test('lost final receipt durably stops the batch, prevents replay after restart and never marks it uploaded', async () => withStore(async store => {
  const first = await record(store), second = await record(store, { messageId: 'different_message' }, candidate())
  const actual = engine(store, 'unknown'), results = []
  const result = await uploadReceivedFiles({ store, engine: actual.engine, jobId: 'java', records: [first, second], options, signal: signal(), readFile: async () => file(), onResult: async r => results.push({ ...r }) })
  assert.equal(result.stopped, true);assert.equal(results.at(-1).stage, 'unknown')
  const restarted = engine(store)
  await uploadReceivedFiles({ store, engine: restarted.engine, jobId: 'java', records: await receivedResumes(store), options, signal: signal(), readFile: async () => file(), onResult: async () => {} })
  assert.deepEqual(restarted.writes, [])
  const list = candidateAttachments(candidate(), 'java', await receivedResumes(store));assert.ok(list.some(r => r.uploadStopped));assert.ok(list.every(r => !r.uploadedAt))
}))
test('received batch tasks validate ownership/options and read files on demand without a model', async () => withStore(async store => {
  const r = await record(store), id = randomUUID(), actual = engine(store)
  await store.put(`sourcing-${id}`, { id, kind: 'talent_sourcing', jobId: 'java', candidates: [candidate()] })
  const importer = new ResumeImport({ call: () => { throw Error('Browser called') } }, store, () => null, () => actual.engine, () => { throw Error('Model called') })
  importer.options = async () => options
  importer.receivedFile = async () => file()
  const job = importer.create({ id: randomUUID(), jobId: 'java', roundId: id, attachmentIds: [r.id], resumeSource: 'platform_received', confirmed: true })
  await importer.run(job, signal());assert.equal(job.status, 'completed');assert.equal(job.results[0].stage, 'succeeded')
  const wrong = importer.create({ id: randomUUID(), jobId: 'other', roundId: id, attachmentIds: [r.id], resumeSource: 'platform_received', confirmed: true })
  await importer.run(wrong, signal());assert.equal(wrong.status, 'failed');assert.equal(actual.writes.length, 3)
}))


test('link-only attachment records are visible before any bytes are fetched', async () => withStore(async store => {
  const { record: row } = await saveReceivedResume(store, candidate(), evidence())
  assert.equal(candidateAttachments(candidate(), 'java', [row]).length, 1)
  assert.equal(row.content, undefined)
  assert.ok((await readdir(store.root)).every(name => !name.endsWith('.bin')))
}))

test('on-demand files validate content and persist only a fingerprint, never original bytes or credentials', async () => withStore(async store => {
  const { record: row } = await saveReceivedResume(store, candidate(), evidence())
  const requests = []
  const actual = await fetchReceivedResumeFile({ store, row, signal: signal(), refresh: async () => { throw Error('Refresh must not run') },
    fetch: async (url, init) => { requests.push({ url, init }); return new Response(await file().blob.arrayBuffer()) } })
  assert.equal(await actual.blob.text(), await file().blob.text())
  assert.equal(actual.blob.type, 'application/pdf')
  assert.equal(requests.length, 1); assert.equal(requests[0].init.credentials, 'omit'); assert.equal(requests[0].init.redirect, 'error')
  assert.equal(requests[0].init.headers, undefined)
  const saved = (await receivedResumes(store))[0]
  assert.equal(saved.content.sha256, (await resumeFileFingerprint(file())).sha256)
  assert.equal(saved.cached, undefined)
  assert.ok((await readdir(store.root)).every(name => !name.endsWith('.bin')))
  assert.doesNotMatch(await readFile(store.path('received-resumes'), 'utf8'), /received attachment|base64/)
}))

test('an expired or HTML login link refreshes the exact attachment once, then fetches fresh bytes', async () => withStore(async store => {
  for (const mode of ['expired', 'login']) {
    const { record: row } = await saveReceivedResume(store, candidate(), evidence())
    let refreshed = 0, fetched = 0
    const actual = await fetchReceivedResumeFile({ store, row, signal: signal(), refresh: async old => {
      refreshed++; assert.equal(old.id, row.id)
      return { ...old, downloadUrl: old.downloadUrl + '&new=1' }
    }, fetch: async url => {
      fetched++
      if (!url.includes('&new=1')) return mode === 'expired' ? new Response('', { status: 403 }) : new Response('<html>login</html>')
      return new Response(await file().blob.arrayBuffer())
    } })
    assert.equal(await actual.blob.text(), await file().blob.text()); assert.equal(fetched, 2); assert.equal(refreshed, 1)
  }
}))

test('untrusted file URLs are never fetched and a refreshed identity cannot substitute a different file', async () => withStore(async store => {
  const { record: row } = await saveReceivedResume(store, candidate(), evidence())
  for (const downloadUrl of ['https://127.0.0.1/private', 'https://tdoss.liepin.com.evil.test/file.pdf', 'https://tdoss.liepin.com/api/private', 'http://tdoss.liepin.com/o/recruit-auth/resume/attachment-res/file.pdf']) {
    let calls = 0
    const actual = await fetchReceivedResumeFile({ store, row: { ...row, downloadUrl }, signal: signal(),
      refresh: async () => row, fetch: async url => { calls++; assert.equal(url, row.downloadUrl); return new Response(await file().blob.arrayBuffer()) } })
    assert.equal(calls, 1); assert.ok(actual.blob.size)
  }
  for (const changed of [{ id: hash('another') }, { messageId: 'another_message' }, { attachmentId: 'another_attachment' }, { conversationId: 'another_chat' }, { resumeId: 'another_resume' }]) {
    let calls = 0
    await assert.rejects(fetchReceivedResumeFile({ store, row, signal: signal(), refresh: async () => ({ ...row, ...changed }),
      fetch: async () => { calls++; return new Response('', { status: 403 }) } }), /IDENTITY_MISMATCH/)
    assert.equal(calls, 1)
  }
}))

test('file requests stop on size limits or cancellation and do not trigger refresh or write binary files', async () => withStore(async store => {
  const { record: row } = await saveReceivedResume(store, candidate(), evidence())
  let refreshed = 0, calls = 0
  await assert.rejects(fetchReceivedResumeFile({ store, row, signal: signal(), refresh: async () => { refreshed++; return row },
    fetch: async () => new Response('large', { headers: { 'content-length': String(21 * 1024 * 1024) } }) }), /SIZE_INVALID/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(fetchReceivedResumeFile({ store, row, signal: controller.signal, refresh: async () => { refreshed++; return row },
    fetch: async () => { calls++; return new Response('unused') } }))
  assert.equal(refreshed, 0); assert.equal(calls, 0)
  assert.ok((await readdir(store.root)).every(name => !name.endsWith('.bin')))
}))

test('an unavailable refreshed link fails without exposing a signed URL or looping', async () => withStore(async store => {
  const { record: row } = await saveReceivedResume(store, candidate(), evidence())
  let fetched = 0, refreshed = 0
  await assert.rejects(fetchReceivedResumeFile({ store, row, signal: signal(), refresh: async () => { refreshed++; return row },
    fetch: async () => { fetched++; throw new Error(row.downloadUrl) } }), error => {
    assert.doesNotMatch(error.message, /tk=private|https:/); return /附件链接不可用/.test(error.message)
  })
  assert.equal(fetched, 2); assert.equal(refreshed, 1)
}))

test('link-only uploads fetch in memory, deduplicate identical bytes across messages, and preserve unknown receipts after restart', async () => withStore(async store => {
  const { record: first } = await saveReceivedResume(store, candidate(), evidence())
  const { record: second } = await saveReceivedResume(store, candidate(), { ...evidence(), messageId: 'second_message' })
  const actual = engine(store), results = []; let reads = 0
  const run = records => uploadReceivedFiles({ store, engine: actual.engine, jobId: 'java', records, options, signal: signal(),
    readFile: async () => { reads++; return file() }, onResult: async row => { if (row.stage !== 'sending') results.push(row.stage) } })
  await run([first, second]); assert.equal(reads, 2); assert.deepEqual(results, ['succeeded', 'skipped'])
  assert.equal(actual.writes.length, 3)
  await run(await receivedResumes(store)); assert.equal(reads, 2); assert.equal(actual.writes.length, 3)
  assert.ok((await readdir(store.root)).every(name => !name.endsWith('.bin')))
  await updateReceivedResume(store, first.id, row => { row.uploads.java.stage = 'unknown' })
  await run(await receivedResumes(store)); assert.equal(reads, 2); assert.equal(results.at(-1), 'unknown')
}))

test('cleaning legacy binaries preserves upload identities, unknown receipts, source links and unrelated files', async () => withStore(async store => {
  const row = await record(store), digest = receivedIngestId('java', row)
  await updateReceivedResume(store, row.id, saved => { saved.cached = saved.content; delete saved.content; saved.uploads = { java: { taskId: digest, stage: 'unknown', at: 'now' } } })
  await writeFile(store.path(`received-file-${row.id}`, 'bin'), 'legacy binary')
  await writeFile(store.path(`received-file-${hash('orphan')}`, 'bin'), 'orphan binary')
  await writeFile(join(store.root, 'user-resume.pdf'), 'keep')
  await writeFile(store.path('sourcing-history'), '{"keep":true}')
  const target = join(store.root, 'user-resume.pdf')
  await symlink(target, store.path(`received-file-${hash('symlink')}`, 'bin'))
  assert.equal((await receivedResumeStorage(store)).fileCount, 2)
  const cleared = await clearReceivedResumeCache(store)
  assert.equal(cleared.fileCount, 2); assert.equal(cleared.bytes, 26)
  const saved = (await receivedResumes(store))[0]
  assert.equal(saved.cached, undefined); assert.equal(receivedIngestId('java', saved), digest)
  assert.equal(saved.uploads.java.stage, 'unknown'); assert.equal(saved.downloadUrl, row.downloadUrl)
  assert.equal(candidateAttachments(candidate(), 'java', [saved]).length, 1)
  assert.equal(await readFile(target, 'utf8'), 'keep'); assert.deepEqual(await store.get('sourcing-history'), { keep: true })
  assert.equal((await receivedResumeStorage(store)).fileCount, 0)
  assert.equal((await clearReceivedResumeCache(store)).fileCount, 0)
}))

test('download buffers are sequential, selection-bound, bounded and released on completion or disposal', async () => {
  const downloads = new ReceivedResumeDownloads(), large = file('%PDF-1.7\n' + 'a'.repeat(180000))
  let loads = 0
  const load = async () => { loads++; return large }
  const first = await downloads.read('owner', 0, undefined, load)
  assert.equal(first.eof, false)
  for (const [owner, offset] of [['other', 98304], ['owner', 0], ['owner', 98305]]) {
    await assert.rejects(downloads.read(owner, offset, first.downloadId, load))
  }
  const last = await downloads.read('owner', 98304, first.downloadId, load)
  assert.equal(last.eof, true); assert.equal(loads, 1)
  await assert.rejects(downloads.read('owner', 98304, first.downloadId, load))
  await downloads.read('owner', 0, undefined, load); const second = await downloads.read('owner', 0, undefined, load)
  await assert.rejects(downloads.read('third', 0, undefined, load), /正在下载/)
  downloads.dispose()
  await assert.rejects(downloads.read('owner', 98304, second.downloadId, load))
})


test('the real received-file importer uploads a link-only record without browser use or persistent bytes', async t => withStore(async store => {
  const { record: row } = await saveReceivedResume(store, candidate(), evidence()), id = randomUUID()
  await store.put(`sourcing-${id}`, { id, kind: 'talent_sourcing', jobId: 'java', candidates: [candidate()] })
  let fetched = 0
  t.mock.method(globalThis, 'fetch', async () => { fetched++; return new Response(await file().blob.arrayBuffer()) })
  const actual = engine(store)
  const importer = new ResumeImport({ call() { throw Error('Browser must not run for a valid file link') } }, store, () => null, () => actual.engine, () => { throw Error('Model must not run') })
  importer.options = async () => options
  const job = importer.create({ id: randomUUID(), jobId: 'java', roundId: id, attachmentIds: [row.id], resumeSource: 'platform_received', confirmed: true })
  await importer.run(job, signal())
  assert.equal(job.status, 'completed'); assert.equal(job.results[0].stage, 'succeeded'); assert.equal(fetched, 1)
  assert.deepEqual(actual.writes, ['file', 'preuploadResume', 'submitUploadResume'])
  assert.ok((await readdir(store.root)).every(name => !name.endsWith('.bin')))
}))

test('expired links acquire and release browser ownership for a verified platform refresh without invoking a model', async t => withStore(async store => {
  const { record: row } = await saveReceivedResume(store, candidate(), evidence()), id = randomUUID(), calls = []
  await store.put(`sourcing-${id}`, { id, kind: 'talent_sourcing', jobId: 'java', candidates: [candidate()] })
  let fetched = 0
  t.mock.method(globalThis, 'fetch', async url => {
    fetched++
    return url.endsWith('&fresh=1') ? new Response(await file().blob.arrayBuffer()) : new Response('', { status: 403 })
  })
  const source = recruitmentPlatform('liepin').receivedAttachment
  t.mock.method(source, 'refresh', async (_broker, person, selected, targetStore) => {
    assert.equal(person.platformIdentity.id, row.resumeId); assert.equal(selected.id, row.id); assert.equal(targetStore, store)
    return { ...selected, downloadUrl: selected.downloadUrl + '&fresh=1' }
  })
  const browser = { listTools: async () => [{ name: 'browser_snapshot', inputSchema: { type: 'object', properties: { tabId: { type: 'integer' } } },
    annotations: { readOnlyHint: true }, _meta: { browserAgent: { available: true } } }], call: async name => {
    calls.push(name)
    const values = { browser_ensure: {}, browser_status: { ready: true, available: true }, browser_begin: {}, browser_channel_login: { loggedIn: true }, browser_finish: {} }
    assert.ok(Object.hasOwn(values, name), name)
    return { structuredContent: values[name] }
  } }
  const importer = new ResumeImport(browser, store, () => null, () => { throw Error('Upload should not run') }, () => { throw Error('Model should not run') })
  const actual = await importer.receivedFile(row, signal())
  assert.match(await actual.blob.text(), /^%PDF-/); assert.equal(fetched, 2)
  assert.deepEqual(calls, ['browser_ensure', 'browser_status', 'browser_begin', 'browser_channel_login', 'browser_finish'])
}))

test('cache cleanup requires explicit confirmation and the shared execution lock', async () => withStore(async store => {
  const row = await record(store)
  await writeFile(store.path(`received-file-${row.id}`, 'bin'), 'old')
  const service = Object.create(Workbench.prototype); Object.assign(service, { store, active: { id: randomUUID() } })
  await assert.rejects(service.clearResumeCache({ confirmed: false }))
  await assert.rejects(service.clearResumeCache({ confirmed: true }), /BUSY/)
  service.active = null
  await store.locked('workbench-browser', () => assert.rejects(service.clearResumeCache({ confirmed: true }), /任务正在执行/))
  assert.equal((await service.resumeStorage()).fileCount, 1)
  assert.equal((await service.clearResumeCache({ confirmed: true })).fileCount, 1)
  assert.equal((await service.resumeStorage()).fileCount, 0)
}))

test('Liepin preview links are resolved through logged-in browser capture instead of a second host GET', async () => withStore(async store => {
  const { record: row } = await saveReceivedResume(store, candidate(), { ...evidence(), downloadUrl: evidence().downloadUrl + '&download=0&process=preview' })
  let fetched = 0, captured = 0
  const events = []
  const actual = await fetchReceivedResumeFile({ store, row, signal: signal(), logger: { write: (...args) => events.push(args) },
    fetch: async () => { fetched++; return new Response('', { status: 403 }) },
    refresh: async selected => { captured++; return { record: selected, file: file() } } })
  assert.equal(fetched, 0); assert.equal(captured, 1)
  assert.equal(await actual.blob.text(), await file().blob.text())
  assert.ok(events.some(row => row[1] === 'received_resume.file_ready' && row[2].acquiredVia === 'browser'))
  assert.doesNotMatch(JSON.stringify(events), /tk=private|候选人|received attachment/)
  const saved = (await receivedResumes(store))[0]
  assert.equal(saved.content.size, file().blob.size); assert.equal(saved.cached, undefined)
  assert.ok((await readdir(store.root)).every(name => !name.endsWith('.bin')))
}))

test('a rejected original-file URL falls back to captured bytes without fetching the refreshed preview URL', async () => withStore(async store => {
  const { record: row } = await saveReceivedResume(store, candidate(), evidence())
  let fetched = 0
  const events = []
  const actual = await fetchReceivedResumeFile({ store, row, signal: signal(), logger: { write: (...args) => events.push(args) },
    fetch: async () => { fetched++; return new Response('', { status: 403 }) },
    refresh: async selected => ({ record: { ...selected, downloadUrl: selected.downloadUrl + '&download=0' }, file: file() }) })
  assert.equal(fetched, 1); assert.match(await actual.blob.text(), /^%PDF-/)
  assert.ok(events.some(row => row[1] === 'received_resume.read_failed' && row[2].httpStatus === 403 && row[2].stage === 'stored_link'))
}))

test('a complete browser file remains downloadable even when browser ownership release fails', async t => withStore(async store => {
  const { record: row } = await saveReceivedResume(store, candidate(), { ...evidence(), downloadUrl: evidence().downloadUrl + '&download=0' }), id = randomUUID(), events = []
  await store.put(`sourcing-${id}`, { id, kind: 'talent_sourcing', jobId: 'java', candidates: [candidate()] })
  t.mock.method(recruitmentPlatform('liepin').receivedAttachment, 'refresh', async (_broker, _person, selected, _store, _signal, capture) => {
    assert.equal(capture, true); return { record: selected, file: file() }
  })
  const browser = { listTools: async () => [{ name: 'browser_snapshot', inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }, _meta: { browserAgent: { available: true } } }], call: async name => {
    if (name === 'browser_finish') throw Error('BROWSER_AGENT_RELEASE_PENDING')
    const values = { browser_ensure: {}, browser_status: { ready: true, available: true }, browser_begin: {}, browser_channel_login: { loggedIn: true } }
    assert.ok(Object.hasOwn(values, name)); return { structuredContent: values[name] }
  } }
  const importer = new ResumeImport(browser, store, () => null, () => { throw Error('Upload must not run') }, () => { throw Error('Model must not run') }, { write: (...args) => events.push(args) })
  const actual = await importer.receivedFile(row, signal())
  assert.match(await actual.blob.text(), /^%PDF-/)
  assert.ok(events.some(row => row[1] === 'browser.release_failed'))
  assert.ok(events.some(row => row[1] === 'received_resume.file_ready'))
}))
