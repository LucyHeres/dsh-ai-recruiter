import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/lib/store.js'
import { RecruitEngine } from '../dist/lib/recruit-engine.js'
import { XinClient, XIN_OPERATIONS } from '../dist/lib/xin-client.js'
import { DeveloperLog } from '../dist/lib/developer-log.js'

const systemURL = 'https://system.example.test'
const auth = {
  credentials: async () => ({ accessToken: 'existing-host-token', companyId: 'test-company', apiURL: 'https://api.example.test', systemURL }),
  session: async () => ({ sessionId: 'existing-host-session', csrf: 'existing-host-csrf', ua: 'existing-host-agent', apiURL: 'https://api.example.test', systemURL }),
}
const fileKey = 'uploaded +file/key='
const preuploadId = 'temporary-preupload-cache-id'
const input = { taskId: 'upload-test', items: [{ captureId: 'capture-test', candidateKey: 'candidate-test', jobId: 'job-test',
  channelType: 39, deliveryType: 0, resumeLibrary: 1, resumeLibraryStatus: 11 }] }
const recordId = 'ingest-upload-test-candidate-test'
const ok = data => Response.json({ status: true, code: 0, message: '操作成功', data })

async function fixture(run, handle) {
  const root = await mkdtemp(join(tmpdir(), 'recruit-upload-'))
  try {
    const store = new Store(root, 'test'); await store.init()
    const logger = new DeveloperLog(store.root)
    const calls = [], stages = []
    let artifactReads = 0
    const xin = new XinClient(auth, '', async (url, init) => {
      const path = new URL(url).pathname
      const form = init.body && typeof init.body === 'string' ? new URLSearchParams(init.body) : null
      const call = { url, path, init, form }
      calls.push(call)
      if (path === '/recruitment/service/ajax-get-extension-login-token') return ok({ token: 'extension-token', companyList: [{ selected: 1 }] })
      if (path === '/recruitment/service/ajax-extension-get-init') return ok({ positionNames: [] })
      if (path === '/recruitment/service/ajax-register-get-upload-url') return ok('https://files.xinrenxinshi.com/site/upload?token=upload-token')
      if (path === '/site/upload') return ok({ key: fileKey })
      assert.equal(new URL(url).origin, systemURL)
      assert.equal(init.method, 'POST')
      assert.equal(init.headers.authorization, 'Bearer existing-host-token')
      assert.equal(init.headers.cookie, 'QJYDSID=existing-host-session; WAVESSID=existing-host-session')
      assert.equal(init.headers['user-agent'], 'existing-host-agent')
      assert.equal(init.headers['x-csrf-token'], 'existing-host-csrf')
      assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded;charset=UTF-8')
      const state = await store.get(recordId)
      assert.equal(state.stage, 'unknown', 'write checkpoint must be durable before request')
      if (handle) return handle({ ...call, state, calls, store })
      if (path.endsWith('ajax-add-preupload-resume')) return ok({ resumeId: preuploadId, isRepeat: false, repeatResumeId: '' })
      if (path.endsWith('ajax-submit-upload-resume')) return ok(null)
      throw new Error(`Unexpected request: ${path}`)
    }, { logger })
    const engine = new RecruitEngine({ xin, store, logger, browser: { call: async (name, args) => {
      assert.equal(name, 'artifact_read'); artifactReads++
      const bytes = Buffer.from('test-pdf-bytes')
      return { structuredContent: { captureId: args.captureId, offset: 0, totalSize: bytes.length, size: bytes.length,
        base64: bytes.toString('base64'), eof: true, fileName: 'test.pdf', mimeType: 'application/pdf' } }
    } } })
    const ingest = value => engine.ingest({ ...value, onProgress: async state => stages.push(structuredClone(state)) })
    await run({ engine, ingest, xin, store, calls, stages, logger, artifactReads: () => artifactReads })
    await logger.flush()
  } finally { await rm(root, { recursive: true, force: true }) }
}
const preCalls = calls => calls.filter(call => call.path.endsWith('ajax-add-preupload-resume'))
const submitCalls = calls => calls.filter(call => call.path.endsWith('ajax-submit-upload-resume'))

test('main-system upload uses form JSON, real preupload ID and existing session; saved only after submit', () => fixture(async ({ ingest, calls, stages, logger, artifactReads }) => {
  const result = await ingest(input)
  assert.equal(result.saved, 1)
  assert.equal(result.results[0].preuploadResumeId, preuploadId)
  assert.equal(result.results[0].resumeId, undefined, 'temporary ID must not become a final resume ID')
  assert.equal(result.results[0].response, null)
  assert.equal(preCalls(calls)[0].form.get('fileKey'), fileKey)
  const form = submitCalls(calls)[0].form
  assert.deepEqual(Object.fromEntries(form), { jobId: 'job-test', channelType: '39', deliveryType: '0', resumeLibrary: '1', resumeLibraryStatus: '11',
    resumeFileKeys: JSON.stringify([{ fileKey, resumeId: preuploadId }]) })
  assert.deepEqual(stages.map(row => row.stage), ['unknown', 'uploaded', 'unknown', 'preuploaded', 'unknown', 'saved'])
  assert.ok(stages.slice(0, -1).every(row => row.stage !== 'saved'))
  assert.equal(artifactReads(), 1)
  await ingest(input)
  assert.equal(preCalls(calls).length, 1)
  assert.equal(submitCalls(calls).length, 1, 'saved records are never submitted again')
  assert.ok(!calls.some(call => call.url.includes('grey-api') || call.path.includes('/cli/')))
  assert.ok(!Object.hasOwn(XIN_OPERATIONS, 'uploadResumes'))
  const rows = (await logger.read(input.taskId, 1000)).lines.map(JSON.parse)
  const request = rows.find(row => row.event === 'xrxs.http.request' && row.http?.operation === 'submitUploadResume')
  assert.equal(request.http.body.resumeFileKeys[0].fileKey, '[REDACTED]')
  assert.equal(request.http.body.resumeFileKeys[0].resumeId, preuploadId)
}))

test('preupload rejects or omits its ID: never submit or invent an ID', async () => {
  for (const rejected of [true, false]) await fixture(async ({ ingest, calls, store }) => {
    const result = await ingest(input)
    assert.equal(result.saved, 0)
    assert.equal(result.results[0].stage, rejected ? 'failed' : 'unknown')
    assert.equal(submitCalls(calls).length, 0)
    if (rejected) assert.match(result.results[0].error, /预上传失败.*解析失败/)
    else {
      assert.match(result.results[0].error, /PREUPLOAD_RESPONSE_INVALID/)
      await ingest(input)
      assert.equal(preCalls(calls).length, 1, 'unknown preupload must not replay')
      assert.equal((await store.get(recordId)).stage, 'unknown')
    }
  }, () => rejected ? Response.json({ status: false, code: 0, message: '解析失败' }) : ok({ isRepeat: false }))
})

test('preupload network failure stops the batch and remains unknown on the next invocation', () => fixture(async ({ ingest, calls }) => {
  const batch = { ...input, items: [...input.items, { ...input.items[0], candidateKey: 'second-candidate' }] }
  const result = await ingest(batch)
  assert.equal(result.unknown, 1)
  assert.equal(result.results.length, 1)
  assert.equal(submitCalls(calls).length, 0)
  await ingest(batch)
  assert.equal(preCalls(calls).length, 1)
}, () => { throw new TypeError('connection closed') }))

test('submit result unknown retains file and parse checkpoint and never replays', () => fixture(async ({ ingest, calls, store }) => {
  const result = await ingest(input)
  assert.equal(result.unknown, 1)
  const saved = await store.get(recordId)
  assert.equal(saved.fileKey, fileKey)
  assert.equal(saved.preuploadResumeId, preuploadId)
  assert.equal(saved.stage, 'unknown')
  await ingest(input)
  assert.equal(preCalls(calls).length, 1)
  assert.equal(submitCalls(calls).length, 1)
}, ({ path }) => {
  if (path.endsWith('ajax-add-preupload-resume')) return ok({ resumeId: preuploadId })
  throw new TypeError('response lost after submit')
}))

test('explicit submit rejection can resume from the same file and parsed ID without repeating upload or parse', () => fixture(async ({ ingest, calls, artifactReads }) => {
  const first = await ingest(input)
  assert.equal(first.failed, 1)
  assert.match(first.results[0].error, /提交入库失败.*无权限/)
  const second = await ingest(input)
  assert.equal(second.saved, 1)
  assert.equal(artifactReads(), 1)
  assert.equal(preCalls(calls).length, 1)
  assert.equal(submitCalls(calls).length, 2)
}, ({ path, calls }) => path.endsWith('ajax-add-preupload-resume') ? ok({ resumeId: preuploadId })
  : submitCalls(calls).length === 1 ? Response.json({ status: false, code: 403, msg: '无权限' }) : ok(null)))

test('legacy uploaded records preupload first; parsed checkpoints resume; prior unknown records stay blocked', async () => {
  for (const stage of ['failed', 'preuploaded', 'unknown', 'saved']) await fixture(async ({ ingest, calls, store, artifactReads }) => {
    await store.put(recordId, { candidateKey: 'candidate-test', captureId: 'expired-capture', fileKey,
      stage, ...(stage === 'preuploaded' ? { preuploadResumeId: preuploadId } : {}), updatedAt: new Date().toISOString() })
    const result = await ingest(input)
    assert.equal(artifactReads(), 0)
    assert.equal(preCalls(calls).length, stage === 'failed' ? 1 : 0)
    assert.equal(submitCalls(calls).length, ['failed', 'preuploaded'].includes(stage) ? 1 : 0)
    assert.equal(result.results[0].stage, stage === 'unknown' ? 'unknown' : 'saved')
  })
})

test('repeat hints use the main-system submission behavior and retain repeat evidence', () => fixture(async ({ ingest, calls }) => {
  const result = await ingest(input)
  assert.equal(result.saved, 1)
  assert.equal(result.results[0].isRepeat, true)
  assert.equal(result.results[0].repeatResumeId, 'existing-resume-id')
  assert.equal(submitCalls(calls).length, 1)
}, ({ path }) => path.endsWith('ajax-add-preupload-resume')
  ? ok({ resumeId: preuploadId, isRepeat: true, repeatLevel: 1, repeatResumeId: 'existing-resume-id' }) : ok(null)))

test('invalid destinations and incomplete resumeFileKeys are rejected before any HTTP writes', () => fixture(async ({ ingest, xin, calls }) => {
  await assert.rejects(ingest({ ...input, items: [{ ...input.items[0], channelType: 20 }] }), /recommenderId/)
  assert.equal(calls.length, 0)
  for (const resumeFileKeys of [[], [{ fileKey }], [{ fileKey, resumeId: '' }], [{ fileKey, resumeId: preuploadId, extra: 'bad' }]]) {
    const result = await xin.call('submitUploadResume', { jobId: 'job-test', channelType: 39, deliveryType: 0, resumeLibrary: 1, resumeLibraryStatus: 11, resumeFileKeys })
    assert.equal(result.failure.outcome, 'not-sent')
  }
  assert.equal(calls.length, 0)
}))

test('a failed progress update after successful submit cannot turn it into a repeatable failure', () => fixture(async ({ engine, ingest, calls }) => {
  const result = await engine.ingest({ ...input, onProgress: async state => {
    if (state.stage === 'saved') throw new Error('progress storage failed')
  } })
  assert.equal(result.saved, 1)
  await ingest(input)
  assert.equal(submitCalls(calls).length, 1)
}))

test('failure to persist final acknowledgement remains unknown instead of allowing a retry', () => fixture(async ({ ingest, store, calls }) => {
  const originalPut = store.put.bind(store)
  store.put = async (key, value) => {
    if (value.stage === 'saved') throw new Error('final acknowledgement persistence failed')
    return originalPut(key, value)
  }
  const result = await ingest(input)
  assert.equal(result.unknown, 1)
  assert.equal((await store.get(recordId)).stage, 'unknown')
  await ingest(input)
  assert.equal(submitCalls(calls).length, 1)
}))
