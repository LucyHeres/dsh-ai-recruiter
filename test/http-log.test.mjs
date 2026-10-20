import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeveloperLog } from '../dist/lib/developer-log.js'
import { XinClient } from '../dist/lib/xin-client.js'

const token = 'test-access-sensitive', session = 'test-session-sensitive', csrf = 'test-csrf-sensitive'
const auth = {
  credentials: async () => ({ accessToken: token, companyId: 'company-test', apiURL: 'https://api.example.test', systemURL: 'https://system.example.test' }),
  session: async () => ({ sessionId: session, csrf, ua: 'test-agent', apiURL: 'https://api.example.test', systemURL: 'https://system.example.test' }),
}
const fileKey = 'test-file-sensitive'
const submission = { jobId: 'job-test', channelType: 0, deliveryType: 1, resumeLibrary: 1, resumeLibraryStatus: 10,
  resumeFileKeys: [{ fileKey, resumeId: 'temporary-resume-test' }] }
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'recruit-http-log-'))
  try {
    const logger = new DeveloperLog(root, 'info', 'test')
    await logger.withContext({ taskId: 'task-test' }, () => run(logger))
  } finally { await rm(root, { recursive: true, force: true }) }
}
async function records(logger) {
  const exported = await logger.read('task-test', 1000)
  assert.equal(exported.dropped, 0)
  assert.equal(exported.writeFailed, false)
  return exported.lines.map(line => JSON.parse(line))
}

test('HTTP 200 + business 401 retains original message, URL, parameters, headers and correlation at info', () => fixture(async logger => {
  let calls = 0
  const client = new XinClient(auth, '', async (url, init) => {
    calls++
    assert.equal(url, 'https://system.example.test/recruitment/service/ajax-submit-upload-resume')
    assert.equal(init.headers.authorization, `Bearer ${token}`)
    const form = new URLSearchParams(init.body)
    assert.equal(form.get('jobId'), 'job-test')
    assert.deepEqual(JSON.parse(form.get('resumeFileKeys')), submission.resumeFileKeys)
    return Response.json({ status: false, code: 401, message: '网关原始拒绝原因', data: { reason: 'INVALID_AUDIENCE', token, candidateName: '隐私姓名', fileKey: fileKey } },
      { headers: { 'x-request-id': 'server-request-test', 'set-cookie': 'sensitive-response-cookie' } })
  }, { logger })
  const result = await client.call('submitUploadResume', submission)
  assert.equal(calls, 1)
  assert.equal(result.failure.code, 'UNAUTHENTICATED')
  const rows = await records(logger)
  const request = rows.find(row => row.event === 'xrxs.http.request')
  const response = rows.find(row => row.event === 'xrxs.http.response')
  assert.equal(request.http.body.jobId, 'job-test')
  assert.equal(request.http.headers.authorization, '[REDACTED]')
  assert.equal(response.http.httpStatus, 200)
  assert.equal(response.http.body.message, '网关原始拒绝原因')
  assert.equal(response.http.body.data.reason, 'INVALID_AUDIENCE')
  assert.equal(response.http.headers['x-request-id'], 'server-request-test')
  assert.equal(request.http.httpCallId, response.http.httpCallId)
  assert.equal(request.callId, response.callId)
  assert.equal(response.http.bodyComplete, true)
  assert.equal(response.http.bodyTruncated, false)
  const encoded = JSON.stringify(rows)
  for (const secret of [token, session, csrf, fileKey, '隐私姓名', 'sensitive-response-cookie']) assert.ok(!encoded.includes(secret), secret)
}))

test('non-JSON HTTP errors and redirects retain actual response and strip signed URL queries', () => fixture(async logger => {
  for (const [status, body, headers] of [[503, '<html>upstream unavailable</html>', {}],
    [302, '', { location: 'https://login.example.test/login?token=redirect-sensitive' }],
    [200, '{broken JSON', {}]]) {
    const client = new XinClient(auth, '', async () => new Response(body, { status, headers }), { logger })
    const result = await client.call('submitUploadResume', submission)
    assert.equal(result.ok, false)
  }
  const rows = await records(logger)
  const responses = rows.filter(row => row.event === 'xrxs.http.response')
  assert.deepEqual(responses.map(row => row.http.httpStatus), [503, 302, 200])
  assert.equal(responses[0].http.body, '<html>upstream unavailable</html>')
  assert.equal(responses[2].http.body, '{broken JSON')
  assert.ok(!JSON.stringify(rows).includes('redirect-sensitive'))
}))

test('business and HTTP failures accept message or msg, preserve precedence and redact credentials', async () => {
  const upstream = '不合法的access_token或者access_token已失效'
  const cases = [
    [{ msg: upstream }, upstream],
    [{ message: 'message 原文' }, 'message 原文'],
    [{ message: 'message 优先', msg: 'msg 原文' }, 'message 优先'],
    [{ message: '  ', msg: upstream }, upstream],
    [{ message: 42, msg: upstream }, upstream],
    [{ msg: `令牌被拒绝 ${token}` }, '令牌被拒绝 [REDACTED]'],
    [{ message: '', msg: null }, ''],
  ]
  for (const status of [200, 401, 503]) {
    for (const [body, expected] of cases) {
      let calls = 0
      const client = new XinClient(auth, '', async () => {
        calls++
        return Response.json({ code: 401, ...body }, { status })
      })
      const result = await client.call('submitUploadResume', submission)
      assert.equal(calls, 1)
      assert.equal(result.failure.message, status === 200 ? expected || '未登录或登录已过期'
        : `服务端返回 ${status}${expected ? `：${expected}` : ''}`)
      assert.equal(result.failure.outcome, status === 503 ? 'unknown' : 'rejected')
    }
  }
})

test('network and response stream failures remain unknown without replay', () => fixture(async logger => {
  let calls = 0
  for (const failBody of [false, true]) {
    const client = new XinClient(auth, '', async () => {
      calls++
      if (!failBody) throw new TypeError(`fetch failed ${token}`, { cause: { code: 'ECONNRESET' } })
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream closed')) } }))
    }, { logger })
    const result = await client.call('submitUploadResume', submission)
    assert.equal(result.failure.outcome, 'unknown')
  }
  const rows = await records(logger)
  assert.equal(calls, 2)
  assert.deepEqual(rows.filter(row => row.event === 'xrxs.http.failed').map(row => row.http.phase), ['request', 'response-body'])
  assert.equal(rows.find(row => row.event === 'xrxs.http.response').http.bodyComplete, false)
  assert.ok(!JSON.stringify(rows).includes(token))
}))

test('large response is chunked without generic 600-character clipping, with explicit body limit', () => fixture(async logger => {
  for (const size of [1500, 40000, 150000]) {
    const client = new XinClient(auth, '', async () => Response.json({ status: false, code: 401, message: '详'.repeat(size) }), { logger })
    await client.call('submitUploadResume', submission)
  }
  const rows = await records(logger)
  const responses = rows.filter(row => row.event === 'xrxs.http.response')
  assert.equal(responses[0].http.body.message.length, 1500)
  const groups = new Map()
  for (const row of responses.filter(row => row.httpPart)) {
    if (!groups.has(row.httpCallId)) groups.set(row.httpCallId, [])
    groups.get(row.httpCallId).push(row)
  }
  assert.equal(groups.size, 2)
  const assembled = [...groups.values()].map(parts => JSON.parse(parts.sort((a, b) => a.httpPart - b.httpPart).map(row => row.httpText).join('')))
  assert.equal(assembled[0].body.message.length, 40000)
  assert.equal(assembled[0].bodyTruncated, false)
  assert.equal(assembled[1].bodyTruncated, true)
}))

test('HTTP rejection stays rejected even when reading its response fails', () => fixture(async logger => {
  const client = new XinClient(auth, '', async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('stream closed')) },
  }), { status: 401 }), { logger })
  const result = await client.call('submitUploadResume', submission)
  assert.equal(result.failure.outcome, 'rejected')
  assert.equal(result.failure.code, 'UNAUTHENTICATED')
  const response = (await records(logger)).find(row => row.event === 'xrxs.http.response')
  assert.equal(response.http.httpStatus, 401)
  assert.equal(response.http.bodyComplete, false)
}))

test('extension exchange and file service upload are logged with returned credentials removed', () => fixture(async logger => {
  const client = new XinClient(auth, '', async url => {
    if (url.includes('ajax-get-extension-login-token')) return Response.json({ status: true, data: { token: 'extension-sensitive', companyList: [{ selected: 1 }] } })
    if (url.includes('ajax-extension-get-init')) return Response.json({ status: true, data: { jobList: [] } })
    return Response.json({ status: true, data: { key: 'uploaded-file-sensitive' } })
  }, { logger })
  assert.equal((await client.call('extensionInit')).ok, true)
  const uploaded = await client.uploadFile('https://files.xinrenxinshi.com/site/upload?token=upload-sensitive&is_permanent=true',
    { blob: new Blob(['file-bytes-sensitive'], { type: 'application/pdf' }), fileName: '姓名-sensitive.pdf' })
  assert.equal(uploaded.fileKey, 'uploaded-file-sensitive')
  const rows = await records(logger)
  assert.deepEqual(rows.filter(row => row.event === 'xrxs.http.request').map(row => row.http.operation), ['extensionTokenExchange', 'extensionInit', 'uploadFile'])
  const exchange = rows.find(row => row.event === 'xrxs.http.request')
  assert.equal(exchange.http.query.type, 'pc')
  const encoded = JSON.stringify(rows)
  for (const secret of ['extension-sensitive', 'upload-sensitive', 'uploaded-file-sensitive', 'file-bytes-sensitive', '姓名-sensitive.pdf']) assert.ok(!encoded.includes(secret), secret)
}))
