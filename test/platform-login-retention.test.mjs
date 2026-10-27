import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { detectPlatformLogin, assertPlatformTaskLogin, isPlatformLoginRequired, platformPageNeedsLogin } from '../dist/lib/platform-login.js'
import { SourcingAgent } from '../dist/lib/sourcing-agent.js'
import { Store } from '../dist/lib/store.js'

function fixture(options = {}) {
  const state = { loggedIn: false, tabs: [], ...options }, calls = []
  const call = async (tool, args = {}) => {
    calls.push({ tool, args })
    if (tool === 'browser_channel_login') {
      if (state.oldGateway) throw new Error('CAPABILITY_NOT_SUPPORTED')
      return { loggedIn: state.loggedIn }
    }
    if (tool === 'browser_list_tabs') return { tabs: state.tabs }
    if (tool === 'browser_open_tab') { state.onOpen?.(); return { tabId: 17 } }
    if (tool === 'browser_snapshot') return state.page ?? { url: 'https://lpt.liepin.com/login', isLoginPage: true, text: '扫码登录' }
    if (tool === 'browser_close_tab' || tool === 'browser_finish') return {}
    throw new Error(`Unexpected browser operation: ${tool}`)
  }
  return { state, calls, call }
}

test('automatic login fallback retains a new login page instead of closing it', async () => {
  const f = fixture({ oldGateway: true })
  const result = await detectPlatformLogin(f.call, 'liepin', false)
  assert.equal(result.status, 'logged_out')
  assert.equal(f.calls.filter(c => c.tool === 'browser_open_tab').length, 1)
  assert.equal(f.calls.some(c => c.tool === 'browser_close_tab'), false)
})

test('classifier login/unknown failures retain the user-facing page; a confirmed logged-in probe is reclaimable', async () => {
  for (const status of ['logged_out', 'unknown', 'logged_in', 'error']) {
    const f = fixture({ oldGateway: true, page: { url: 'https://lpt.liepin.com/recommend', text: '平台页面' } })
    const classify = async () => { if (status === 'error') throw new Error('classifier unavailable'); return { status, detail: 'classification' } }
    if (status === 'error') await assert.rejects(detectPlatformLogin(f.call, 'liepin', false, undefined, classify), /unavailable/)
    else assert.equal((await detectPlatformLogin(f.call, 'liepin', false, undefined, classify)).status, status)
    assert.equal(f.calls.some(c => c.tool === 'browser_close_tab'), status === 'logged_in')
  }
})

test('a logged-out task terminates even if the user logs in while its new tab finishes opening', async () => {
  const f = fixture()
  f.state.onOpen = () => { f.state.loggedIn = true }
  await assert.rejects(assertPlatformTaskLogin(f.call, 'boss', '开始寻聘'), error => isPlatformLoginRequired(error) && /手动再次点击“开始寻聘”/.test(error.message))
  const callsAfterFailure = f.calls.length
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.length, callsAfterFailure, 'login never schedules automatic continuation')
  assert.equal(f.calls.some(c => c.tool === 'browser_close_tab'), false)
  await assertPlatformTaskLogin(f.call, 'boss', '开始寻聘')
  assert.equal(f.calls.length, callsAfterFailure + 1, 'a fresh manual attempt checks the session again')
})

test('an existing login-domain tab is reused and left in place for manual sign-in', async () => {
  for (const [platform, url] of [['boss', 'https://login.zhipin.com/'], ['liepin', 'https://passport.liepin.com/login']]) {
    const f = fixture({ tabs: [{ tabId: 23, url, active: true }] })
    await assert.rejects(assertPlatformTaskLogin(f.call, platform, '同步平台简历'), isPlatformLoginRequired)
    assert.deepEqual(f.calls.map(c => c.tool), ['browser_channel_login', 'browser_list_tabs'])
  }
})

test('login and verification redirects are recognized without treating ordinary work pages as login', () => {
  for (const url of ['https://login.zhipin.com/', 'https://passport.liepin.com/', 'https://www.zhipin.com/web/user/safe/verify']) assert.equal(platformPageNeedsLogin({ url }), true)
  assert.equal(platformPageNeedsLogin({ url: 'https://www.zhipin.com/web/chat/index' }), false)
  assert.equal(platformPageNeedsLogin({ url: 'https://www.zhipin.com/web/chat/index', frameUrl: 'https://login.zhipin.com/' }), true)
})

test('sourcing reports a terminal failure, releases ownership and cannot resume itself after login', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sourcing-login-retention-')), store = new Store(root, 'test')
  const f = fixture(); let modelCalls = 0, released = 0
  try {
    const agent = new SourcingAgent(store, async (tool, args) => {
      if (tool === 'browser_finish') released++
      return f.call(tool, args)
    }, async () => {}, async () => { throw new Error('must stop before listing execution tools') },
    () => async () => { modelCalls++; throw new Error('must not execute a task after login is required') }, async () => ({}))
    const job = agent.create({ id: randomUUID(), jobId: 'job', platforms: ['boss'], limit: 1, confirmed: true })
    await agent.run(job, new AbortController().signal)
    assert.equal(job.status, 'failed'); assert.equal(job.phase, 'finished')
    assert.match(job.detail, /手动再次点击“开始寻聘”/)
    assert.equal(released, 1); assert.equal(modelCalls, 0)
    assert.equal(f.calls.some(c => c.tool === 'browser_close_tab'), false)
    f.state.loggedIn = true
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(job.status, 'failed'); assert.equal(modelCalls, 0)
    assert.equal((await store.get(`sourcing-${job.id}`)).status, 'failed')
  } finally { await rm(root, { recursive: true, force: true }) }
})
