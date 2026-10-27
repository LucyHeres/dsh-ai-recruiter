import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store, hash } from '../dist/lib/store.js'
import { AgentBrowserTools } from '../dist/lib/agent-browser-tools.js'
import { Workbench } from '../dist/lib/workbench.js'
import { candidateResumeReceipt, readCandidateContacts, saveCandidateContact } from '../dist/lib/candidate-contact.js'
import { communicationIndex, candidateCommunication } from '../dist/lib/sourcing-review.js'
import { communicationIdentityTokens, communicationScope, readCommunicationObservations, assertCommunicationRead, syncPlatformCommunication } from '../dist/lib/communication-sync.js'

const signal = () => AbortSignal.timeout(10000)
const origin = platform => platform === 'boss' ? 'https://www.zhipin.com' : 'https://lpt.liepin.com'
const person = (id = 'resume1234', platform = 'liepin') => ({ key: hash([platform, id]), platform, name: '同名候选人',
  profileUrl: `${origin(platform)}/resume/detail?resumeId=${id}`, platformIdentity: { kind: 'resume', id, source: 'card_class' },
  collectedAt: '2026-10-20', scope: 'online', resumeText: '在线履历', fields: [], assessments: [], score: 90, coverage: 90 })
const item = (ref, role, name, extra = {}) => ({ ref, role, name, states: [], ...extra })
const card = (id, platform = 'liepin', status = []) => [item(`row-${id}`, 'listitem', `同名候选人 30岁`, { parentRef: 'list' }),
  item(`name-${id}`, 'link', '同名候选人', { parentRef: `row-${id}`, href: person(id, platform).profileUrl }),
  ...status.map((label, i) => item(`${id}-status-${i}`, 'text', label, { parentRef: `row-${id}` }))]
const page = (platform = 'liepin', items = [], path = platform === 'boss' ? '/web/chat/index' : '/chat/im', extra = {}) => ({
  tabId: 7, snapshotId: randomUUID(), documentId: 'document', format: 'dom', url: `${origin(platform)}${path}`, title: path === '/resume/apply' ? '收到简历|人才管理' : '沟通',
  items: [item('list', 'main', ''), ...items], text: items.map(row => row.name).join(' '), viewport: { height: 900 }, dialogs: [], ...extra })
const inspector = (details = {}) => ({ inspectRefs: async () => {}, getInspection: (_page, ref) => details[ref] })
async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'contact-sync-'))
  try { const store = new Store(dir, 'company'); await store.init(); return await run(store) }
  finally { await rm(dir, { recursive: true, force: true }) }
}

test('receipt and greeting facts persist independently across rounds, scoped by platform identity', async () => withStore(async store => {
  const target = person(), first = '2026-10-20T01:00:00Z'
  assert.deepEqual(candidateResumeReceipt(target, []), { resumeReceived: false }, 'online résumé collection is not receipt')
  assert.equal(await saveCandidateContact(store, target, { greeted: true, resumeReceived: false, source: 'chat' }, first), true)
  assert.equal(candidateResumeReceipt(target, await readCandidateContacts(store)).resumeReceived, false)
  assert.equal(await saveCandidateContact(store, target, { greeted: false, resumeReceived: true, source: 'received_list' }, first), true)
  const anotherRound = { ...target, key: hash('another-round') }
  assert.equal(await saveCandidateContact(store, anotherRound, { greeted: false, resumeReceived: false, source: 'chat' }), false)
  assert.equal(await saveCandidateContact(store, anotherRound, { greeted: true, resumeReceived: true, source: 'chat' }, 'later'), false)
  const contacts = await readCandidateContacts(store)
  assert.equal(contacts.length, 1); assert.equal(contacts[0].resumeReceivedAt, first); assert.equal(contacts[0].greetedAt, first)
  assert.deepEqual(candidateResumeReceipt(anotherRound, contacts), { resumeReceived: true, resumeReceivedAt: first })
  assert.equal(candidateCommunication(anotherRound, communicationIndex([], contacts)), 'recorded')
  for (const other of [person('different123'), person('resume1234', 'boss')]) {
    assert.equal(candidateResumeReceipt(other, contacts).resumeReceived, false)
    assert.equal(candidateCommunication(other, communicationIndex([], contacts)), 'none')
  }
  const reusedLink = { ...person('conflicting456'), profileUrl: target.profileUrl }
  assert.equal(candidateResumeReceipt(reusedLink, contacts).resumeReceived, false, 'conflicting platform IDs override reused profile URLs')
  await saveCandidateContact(store, reusedLink, { greeted: true, resumeReceived: false, source: 'chat' })
  assert.equal((await readCandidateContacts(store)).length, 2)
  assert.equal(candidateResumeReceipt(reusedLink, await readCandidateContacts(store)).resumeReceived, false)
}))

test('contact projections cover results, batch and detail without rewriting raw task receipts', async () => withStore(async store => {
  const candidate = person(), id = randomUUID()
  const job = { id, kind: 'talent_sourcing', platform: 'liepin', jobId: 'java', createdAt: '2026-10-20', status: 'completed', updatedAt: 'now',
    detail: '', limit: 2, channels: [], candidates: [candidate], results: [], greetings: [{ key: 'attempt', candidateKey: candidate.key, platform: 'liepin', stage: 'unknown', attemptedAt: 'past' }] }
  await store.put(`sourcing-${id}`, job)
  await saveCandidateContact(store, candidate, { greeted: true, resumeReceived: true, source: 'chat' })
  const service = Object.create(Workbench.prototype); Object.assign(service, { store, initialized: Promise.resolve() })
  const rows = [(await service.sourcingResults({ jobId: 'java' })).candidates[0], (await service.sourcingBatch({ jobId: 'java', id })).candidates[0],
    (await service.sourcingCandidate({ jobId: 'java', id, key: candidate.key })).candidate]
  for (const row of rows) { assert.equal(row.communication, 'recorded'); assert.equal(row.resumeReceived, true) }
  assert.deepEqual(await store.get(`sourcing-${id}`), job)
  await assert.rejects(service.syncCommunication({ jobId: 'java', platform: 'liepin' }))
}))

test('identity parsing accepts observed business identity and profile links, never names or widget IDs', () => {
  const target = person()
  assert.ok(communicationIdentityTokens('liepin', { href: target.profileUrl }, origin('liepin')).includes('resume:resume1234'))
  assert.ok(communicationIdentityTokens('boss', { href: '/web/geek/info?encryptGeekId=geek_1234' }, origin('boss')).includes('geek:geek_1234'))
  for (const href of ['/resume/apply', '/chat/im?resumeId=resume1234', 'https://evil.test/resume/detail?resumeId=resume1234']) {
    assert.deepEqual(communicationIdentityTokens('liepin', { href }, origin('liepin')), [])
  }
  assert.equal(communicationScope(page('liepin', [], '/recommend'), 'liepin'), undefined)
  assert.equal(communicationScope(page('liepin', [], '/resume/apply'), 'liepin'), 'received_list')
  assert.equal(communicationScope(page('liepin', [], '/resume/apply', { title: '其他页面', selectedTabs: [] }), 'liepin'), undefined)
  assert.equal(communicationScope(page('liepin', [], '/resume/apply', { isLoginPage: true }), 'liepin'), undefined)
})

test('receipt parser rejects negative/request/online labels and binds positive evidence to its own card', async () => {
  for (const platform of ['liepin', 'boss']) {
    const target = person('resume1234', platform)
    const p = page(platform, [...card('resume1234', platform, ['未收到简历', '请求简历', '索要简历', '在线履历', '查看附件', '发送简历']),
      ...card('another5678', platform, ['已收到简历', '已沟通'])])
    const rows = await readCommunicationObservations(platform, p, inspector(), [target], signal())
    const row = rows.find(row => row.identityTokens.includes('resume:resume1234'))
    assert.equal(row.greeted, false); assert.equal(row.resumeReceived, false)
    const other = rows.find(row => row.identityTokens.includes('resume:another5678'))
    assert.equal(other.resumeReceived, true); assert.equal(other.greeted, true)
    const received = await readCommunicationObservations(platform, page(platform, card('resume1234', platform, ['已接收简历'])), inspector(), [target], signal())
    assert.equal(received[0].resumeReceived, true)
  }
})

test('name-only and arbitrary DOM IDs do not match; explicit data IDs and proven Liepin wrapper can match', async () => {
  const items = [item('row', 'listitem', '同名候选人 30岁'), item('name', 'text', '同名候选人', { parentRef: 'row' })]
  for (const attrs of [{ id: 'rc-tabs-5-tab-resume1234' }, { 'data-user-id': 'resume1234' }]) {
    assert.deepEqual(await readCommunicationObservations('liepin', page('liepin', items), inspector({ row: { element: { attributes: attrs } } }), [person()], signal()), [])
  }
  for (const attrs of [{ 'data-resume-id': 'resume1234' }, { class: 'xpath-resume-item-wrap xpath-resume-item-wrap-resume1234' }]) {
    const rows = await readCommunicationObservations('liepin', page('liepin', items, '/resume/apply'), inspector({ row: { element: { attributes: attrs } } }), [person()], signal())
    assert.deepEqual(rows[0].identityTokens, ['resume:resume1234']); assert.equal(rows[0].resumeReceived, true)
  }
})

test('BOSS reads timestamp-anchored chat rows by the observed geek-item UID, never a widget ID or name', async () => {
  const target = { ...person('12345678', 'boss'), platformIdentity: undefined, profileUrl: `${origin('boss')}/web/geek/info?geekId=12345678` }
  const items = [item('time', 'span', '13:08'), item('name', 'span', target.name)]
  const observed = attrs => inspector({ time: { element: { tagName: 'span', attributes: { class: 'time' } },
    ancestors: [{ tagName: 'div', attributes: attrs }] } })
  const rows = await readCommunicationObservations('boss', page('boss', items), observed({ class: 'geek-item', id: '_12345678-0' }), [target], signal(), 'resume_received')
  assert.ok(rows.some(row => row.identityTokens.includes('geek:12345678') && row.resumeReceived))
  for (const attrs of [{ class: 'widget', id: '_12345678-0' }, { class: 'geek-item', id: '_12345678-1' }]) {
    assert.deepEqual(await readCommunicationObservations('boss', page('boss', items), observed(attrs), [target], signal(), 'resume_received'), [])
  }
  const p = page('boss', [item('filter', 'div', '已获取简历'), item('request', 'button', '索要简历')])
  assert.doesNotThrow(() => assertCommunicationRead({ name: 'browser_click', args: { ref: 'filter' }, purpose: 'navigation' }, p))
  assert.throws(() => assertCommunicationRead({ name: 'browser_click', args: { ref: 'request' }, purpose: 'navigation' }, p), /READ_ONLY/)
})

test('BOSS enters its actual received-resume filter even when every saved candidate lacks an ID', async () => withStore(async store => {
  const f = browserFixture('boss')
  const target = { ...person('legacy1234', 'boss'), profileUrl: '', platformIdentity: undefined }
  const result = await syncPlatformCommunication(f.broker, 'boss', [target], store, signal())
  assert.ok(f.calls.some(call => call.name === 'browser_snapshot'))
  assert.ok(f.calls.some(call => call.name === 'browser_click' && call.args.ref === 'filter-received'))
  assert.equal(result.status, 'partial'); assert.equal(result.unidentified, 1)
  assert.equal(result.matched, 0); assert.equal(result.updated, 0)
  assert.deepEqual(await readCandidateContacts(store), [])
}))
test('BOSS still opens 已获取简历 when the candidate already has a saved receipt', async () => withStore(async store => {
  const f = browserFixture('boss')
  await syncPlatformCommunication(f.broker, 'boss', [{ ...person('resume1234', 'boss'), resumeReceived: true, communication: 'recorded' }], store, signal())
  assert.deepEqual(f.calls.filter(call => call.name === 'browser_click').map(call => call.args.ref), ['filter-received'])
  assert.ok(f.calls.findIndex(call => call.name === 'browser_click') < f.calls.findIndex(call => call.name === 'browser_inspect_element' && call.args.ref.startsWith('row-')))
}))

test('received-list wrapper strips only its observed row index and chat filters cannot annotate the adjacent receipt panel', async () => {
  const attrs = { class: 'manager-resume-card-item-new resume-item-wrap-resume_key_1234_7' }
  const items = [item('row', 'listitem', '同名候选人 30岁', { context: { text: '同名候选人 30岁' } }), item('age', 'span', '30岁', { parentRef: 'row' })]
  const p = page('liepin', items, '/resume/apply')
  let inspections = 0
  const broker = { inspectRefs: async () => { inspections++ }, getInspection: () => ({ element: { tagName: 'li', attributes: attrs } }) }
  const rows = await readCommunicationObservations('liepin', p, broker, [], signal())
  assert.equal(inspections, 1, 'one inspection per card, even when child contexts repeat its age')
  assert.deepEqual(rows[0].identityTokens, ['resume:resume_key_1234']); assert.equal(rows[0].resumeReceived, true)
  const rightPanel = inspector({ row: { element: { tagName: 'li', attributes: { ...attrs, 'data-resume-id': 'resume1234' } } } })
  for (const view of ['greeted', 'resume_received']) {
    const rows = await readCommunicationObservations('liepin', page('liepin', items), rightPanel, [], signal(), view)
    assert.equal(rows[0].greeted, false); assert.equal(rows[0].resumeReceived, false)
  }
})

test('shared multi-person containers, hidden cards and modal background cannot lend receipt evidence', async () => {
  const shared = [item('shared', 'listitem', '同名候选人 30岁 另一人 35岁'), ...card('resume1234').slice(1).map(row => ({ ...row, parentRef: 'shared' })),
    item('received', 'text', '已收到简历', { parentRef: 'shared' })]
  assert.deepEqual(await readCommunicationObservations('liepin', page('liepin', shared), inspector(), [person()], signal()), [])
  const conflict = [item('shared', 'listitem', '两位同名候选人'), ...card('resume1234').slice(1).map(row => ({ ...row, parentRef: 'shared' })),
    ...card('another5678', 'liepin', ['已收到简历']).slice(1).map(row => ({ ...row, parentRef: 'shared' }))]
  assert.deepEqual(await readCommunicationObservations('liepin', page('liepin', conflict), inspector(), [person()], signal()), [])
  assert.deepEqual(await readCommunicationObservations('liepin', page('liepin', card('resume1234').map(row => ({ ...row, states: ['hidden'] }))), inspector(), [person()], signal()), [])
  assert.deepEqual(await readCommunicationObservations('liepin', page('liepin', card('resume1234'), '/chat/im', { dialogs: [{ ref: 'dialog' }] }), inspector(), [person()], signal()), [])
})

test('status sync allowlist forbids greetings, requests, downloads, typing and script execution', () => {
  const p = page('liepin', ['全部', '我发起的', '有简历', '下一页', '立即沟通', '索要简历', '下载简历'].map((name, i) => item(String(i), 'button', name)))
  const call = { name: 'browser_click', purpose: 'navigation', readOnly: false, signal: signal(), args: { ref: '0' } }
  for (const ref of ['0', '1', '2', '3']) assert.doesNotThrow(() => assertCommunicationRead({ ...call, args: { ref } }, p))
  for (const ref of ['4', '5', '6']) assert.throws(() => assertCommunicationRead({ ...call, args: { ref } }, p), /READ_ONLY/)
  for (const name of ['browser_type', 'browser_execute_js', 'browser_download']) assert.throws(() => assertCommunicationRead({ ...call, name, readOnly: name === 'browser_execute_js' }, p), /READ_ONLY/)
  assert.throws(() => assertCommunicationRead({ ...call, purpose: 'business_write' }, p), /READ_ONLY/)
})

const toolInfo = (name, readOnly, properties, required = []) => ({ name, annotations: { readOnlyHint: readOnly }, _meta: { browserAgent: { available: true } },
  inputSchema: { type: 'object', properties: Object.fromEntries(properties.map(key => [key, { type: key === 'tabId' || key === 'deltaY' ? 'integer' : key === 'viewportOnly' ? 'boolean' : 'string' }])), required, additionalProperties: false } })
const infos = [toolInfo('browser_list_tabs', true, []), toolInfo('browser_snapshot', true, ['tabId', 'format', 'viewportOnly'], ['tabId']),
  toolInfo('browser_inspect_element', true, ['tabId', 'snapshotId', 'ref']),
  toolInfo('browser_navigate', false, ['tabId', 'url'], ['tabId', 'url']), toolInfo('browser_click', false, ['tabId', 'snapshotId', 'ref']),
  toolInfo('browser_scroll', false, ['tabId', 'snapshotId', 'ref', 'deltaY']), toolInfo('browser_open_tab', false, ['url']), toolInfo('browser_close_tab', false, ['tabId'])]
function browserFixture(platform = 'liepin', options = {}) {
  const calls = [], entry = platform === 'liepin' ? '/resume/apply' : '/web/chat/index'
  let path = '/recommend', view = 'all', screen = 0, staleFilter = !!options.staleFilter, layoutSnapshots = 0
  const tabs = options.newTab ? [] : [{ tabId: 7, url: `${origin(platform)}/recommend`, active: true }]
  const snapshot = (format = 'dom') => {
    layoutSnapshots++
    const rows = options.rows?.({ path, view, screen }) ?? card('resume1234', platform)
    const radio = options.segmented && format === 'semantic'
    const role = options.segmented ? radio ? 'radio' : 'label' : 'tab'
    const filter = (key, name, selectedView) => item(`${radio ? 'radio' : 'filter'}-${key}`, role, name,
      { states: options.segmented && !radio ? layoutSnapshots < 6 ? ['occluded'] : [] : view === selectedView && !options.unverifiedFilter ? [radio ? 'checked' : 'selected'] : [] })
    return page(platform, [filter('all', '全部', 'all'), ...(platform === 'liepin' ? [filter('greeted', '我发起的', 'greeted')] : []), filter('received', platform === 'boss' ? '已获取简历' : '有简历', 'resume_received'), ...rows], path,
      { format, ...(options.login ? { isLoginPage: true } : {}) })
  }
  const transport = async (name, args, toolSignal) => {
    calls.push({ name, args, signal: toolSignal }); toolSignal?.throwIfAborted()
    if (name === 'browser_list_tabs') return { tabs }
    if (name === 'browser_open_tab') { path = entry; return { tabId: 7, snapshot: snapshot() } }
    if (name === 'browser_navigate') {
      if (options.unknownNavigation) throw new Error('TOOL_CALL_OUTCOME_UNKNOWN')
      path = new URL(args.url).pathname; screen = 0; view = 'all'; return { tabId: 7, snapshot: snapshot() }
    }
    if (name === 'browser_snapshot') return snapshot(args.format)
    if (name === 'browser_inspect_element') {
      const selected = args.ref.endsWith('all') ? view === 'all' : args.ref.endsWith('greeted') ? view === 'greeted' : args.ref.endsWith('received') && view === 'resume_received'
      return { element: { tagName: 'label', attributes: { class: options.segmented && selected ? 'ant-im-segmented-item-selected' : '' } } }
    }
    if (name === 'browser_click') {
      if (options.unknownFilter) throw new Error('TOOL_CALL_OUTCOME_UNKNOWN')
      if (staleFilter) { staleFilter = false; throw new Error('PAGE_CHANGED') }
      if (options.segmented && args.ref.startsWith('filter-') && layoutSnapshots < 6) throw Error('ELEMENT_OCCLUDED')
      const key = args.ref.replace(/^(?:filter|radio)-/, '')
      view = key === 'received' ? 'resume_received' : key; screen = 0; return { snapshot: snapshot() }
    }
    if (name === 'browser_scroll') { screen++; return { snapshot: snapshot() } }
    if (name === 'browser_close_tab') return { closed: true }
    throw new Error(`Unexpected ${name}`)
  }
  const broker = new AgentBrowserTools(infos, transport, { origins: [origin(platform)], confirmationId: 'read-only', observationFormat: 'dom', signal: signal() })
  broker.setBeforeCall(async call => assertCommunicationRead(call, broker.currentPage()))
  return { broker, calls, transport }
}

test('resume sync reads only each platform receipt tab without inferring initiated greetings', async () => withStore(async store => {
  for (const platform of ['liepin', 'boss']) {
    const f = browserFixture(platform)
    const result = await syncPlatformCommunication(f.broker, platform, [person('resume1234', platform)], store, signal())
    assert.equal(result.matched, 1); assert.equal(result.updated, 1)
    const records = await readCandidateContacts(store)
    assert.equal(candidateCommunication(person('resume1234', platform), communicationIndex([], records)), 'none', 'receipt membership does not prove an initiated greeting')
    assert.equal(candidateResumeReceipt(person('resume1234', platform), records).resumeReceived, true)
    assert.equal(f.calls.at(-1).name, 'browser_navigate'); assert.match(f.calls.at(-1).args.url, /\/recommend$/)
    assert.ok(f.calls.every(call => call.args.policy.riskLevel !== 'business_write'))
    assert.ok(f.calls.filter(call => call.name === 'browser_click').every(call => call.args.ref === 'filter-received'))
    assert.ok(f.calls.filter(call => call.name === 'browser_navigate').every(call => !new URL(call.args.url).pathname.includes('/resume/apply')))
  }
}))

test('reader advances past non-target rows and stops on stable identity lists', async () => withStore(async store => {
  const f = browserFixture('liepin', { rows: ({ screen, path }) => card(screen ? 'resume1234' : 'other5678', 'liepin', path === '/chat/im' ? ['已打招呼'] : []) })
  const result = await syncPlatformCommunication(f.broker, 'liepin', [person()], store, signal())
  assert.equal(result.matched, 1); assert.equal(candidateResumeReceipt(person(), await readCandidateContacts(store)).resumeReceived, true)
  assert.ok(f.calls.some(call => call.name === 'browser_scroll'))
  const stuck = browserFixture('boss', { rows: () => card('other5678', 'boss') })
  const nothing = await syncPlatformCommunication(stuck.broker, 'boss', [person('missing1234', 'boss')], store, signal())
  assert.equal(nothing.matched, 0); assert.match(nothing.detail, /尚未读取完整/)
  assert.ok(stuck.calls.filter(call => call.name === 'browser_scroll').length <= 3)
}))

test('selected Liepin filters are skipped; covered temporary layout waits for visible controls, without zero-size AX radios', async () => withStore(async store => {
  const f = browserFixture('liepin', { segmented: true })
  const result = await syncPlatformCommunication(f.broker, 'liepin', [person()], store, signal())
  assert.equal(result.matched, 1); assert.equal(result.updated, 1)
  const clicks = f.calls.filter(call => call.name === 'browser_click')
  assert.ok(clicks.length > 0); assert.ok(clicks.every(call => call.args.ref.startsWith('filter-')))
  assert.ok(!clicks.some(call => call.args.ref.endsWith('all')))
  assert.ok(!f.calls.some(call => call.name === 'browser_snapshot' && call.args.format === 'semantic'))
}))

test('a pre-dispatch stale filter can rebind once; an unknown filter input stops without replay or restoration', async () => withStore(async store => {
  const stale = browserFixture('boss', { staleFilter: true })
  const result = await syncPlatformCommunication(stale.broker, 'boss', [person('resume1234', 'boss')], store, signal())
  assert.equal(result.updated, 1)
  assert.equal(stale.calls.filter(call => call.name === 'browser_click' && call.args.ref === 'filter-received').length, 2)
  const unknown = browserFixture('boss', { unknownFilter: true })
  await assert.rejects(syncPlatformCommunication(unknown.broker, 'boss', [person('different5678', 'boss')], store, signal()), /OUTCOME_UNKNOWN/)
  assert.equal(unknown.calls.filter(call => call.name === 'browser_click').length, 1)
  assert.equal(unknown.calls.at(-1).name, 'browser_click')
}))

test('unverified selected filters, missing identity and same names cannot fabricate facts', async () => withStore(async store => {
  const f = browserFixture('boss', { unverifiedFilter: true })
  const result = await syncPlatformCommunication(f.broker, 'boss', [person('resume1234', 'boss')], store, signal())
  assert.equal(result.updated, 0); assert.deepEqual(await readCandidateContacts(store), [])
  const missing = browserFixture('liepin')
  const noId = await syncPlatformCommunication(missing.broker, 'liepin', [{ ...person(), platformIdentity: undefined, profileUrl: '' }], store, signal())
  assert.equal(noId.matched, 0); assert.ok(missing.calls.some(call => call.name === 'browser_snapshot'))
  assert.equal(noId.status, 'partial'); assert.equal(noId.unidentified, 1)
  assert.ok(noId.scanned > 0, 'missing identity cannot bypass reading the platform')
  const names = browserFixture('boss')
  const sameName = await syncPlatformCommunication(names.broker, 'boss', [person('different9876', 'boss')], store, signal())
  assert.equal(sameName.matched, 0); assert.deepEqual(await readCandidateContacts(store), [])
}))

test('created tab is closed, login failure preserves facts, and unknown navigation is never replayed', async () => withStore(async store => {
  const opened = browserFixture('boss', { newTab: true })
  await syncPlatformCommunication(opened.broker, 'boss', [person('resume1234', 'boss')], store, signal())
  assert.equal(opened.calls.at(-1).name, 'browser_close_tab')
  const before = await readCandidateContacts(store), login = browserFixture('boss', { login: true })
  await assert.rejects(syncPlatformCommunication(login.broker, 'boss', [person('different1234', 'boss')], store, signal()), error => error.code === 'PLATFORM_LOGIN_REQUIRED')
  assert.deepEqual(await readCandidateContacts(store), before); assert.equal(login.calls.at(-1).name, 'browser_snapshot')
  const newLogin = browserFixture('boss', { login: true, newTab: true })
  await assert.rejects(syncPlatformCommunication(newLogin.broker, 'boss', [person('different1234', 'boss')], store, signal()), error => error.code === 'PLATFORM_LOGIN_REQUIRED')
  assert.equal(newLogin.calls.some(call => call.name === 'browser_close_tab'), false)
  const unknown = browserFixture('liepin', { unknownNavigation: true })
  await assert.rejects(syncPlatformCommunication(unknown.broker, 'liepin', [person()], store, signal()), /OUTCOME_UNKNOWN/)
  assert.equal(unknown.calls.filter(call => call.name === 'browser_navigate').length, 1)
}))

test('logged-out resume sync ends with an error and releases its lock; a manual retry starts normally', async () => withStore(async store => {
  const id = randomUUID()
  await store.put(`sourcing-${id}`, { id, kind: 'talent_sourcing', jobId: 'java', createdAt: '2026-10-20', candidates: [person('resume1234', 'boss')], results: [], status: 'completed', channels: [] })
  const f = browserFixture('boss'), service = Object.create(Workbench.prototype), lease = []; let loggedIn = false
  Object.assign(service, { store, initialized: Promise.resolve(), begin: async () => lease.push('begin'), browser: { listTools: async () => infos },
    call: async (tool, args, s) => tool === 'browser_finish' ? lease.push('finish') : tool === 'browser_channel_login' ? { loggedIn } : f.transport(tool, args, s) })
  const result = await service.syncCommunication({ jobId: 'java' }, signal())
  assert.equal(result.platforms[0].status, 'failed'); assert.match(result.platforms[0].detail, /手动再次点击“同步平台简历”/)
  assert.equal(service.operation, false); assert.deepEqual(lease, ['begin', 'finish'])
  assert.ok(!f.calls.some(call => ['browser_navigate', 'browser_click', 'browser_close_tab'].includes(call.name)))
  loggedIn = true; await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(lease, ['begin', 'finish'])
  const retry = await service.syncCommunication({ jobId: 'java' }, signal())
  assert.equal(retry.updated, 1); assert.deepEqual(lease, ['begin', 'finish', 'begin', 'finish'])
}))

test('workbench sync scopes candidates to position, releases ownership, and projects saved facts', async () => withStore(async store => {
  const source = (candidate, jobId) => ({ id: randomUUID(), kind: 'talent_sourcing', platform: candidate.platform, jobId,
    createdAt: '2026-10-20', candidates: [candidate], results: [], status: 'completed', channels: [], limit: 2 })
  for (const row of [source(person('resume1234', 'boss'), 'java'), source(person('different1234'), 'other')]) await store.put(`sourcing-${row.id}`, row)
  const f = browserFixture('boss'), service = Object.create(Workbench.prototype), lease = []
  Object.assign(service, { store, initialized: Promise.resolve(), begin: async () => lease.push('begin'),
    browser: { listTools: async () => infos }, call: async (...args) => args[0] === 'browser_finish' ? lease.push('finish') : f.transport(...args) })
  const result = await service.syncCommunication({ jobId: 'java' }, signal())
  assert.equal(result.checked, 1); assert.equal(result.updated, 1); assert.deepEqual(result.platforms.map(row => row.platform), ['boss'])
  assert.deepEqual(lease, ['begin', 'finish']); assert.equal(service.operation, false)
  assert.equal((await service.sourcingResults({ jobId: 'java' })).candidates[0].resumeReceived, true)
  service.operation = true; await assert.rejects(service.syncCommunication({ jobId: 'java' }), /BUSY/); service.operation = false
  service.begin = async () => { throw new Error('LOGIN_REQUIRED') }
  await assert.rejects(service.syncCommunication({ jobId: 'java' }), /LOGIN_REQUIRED/)
  assert.equal(service.operation, false); assert.equal(lease.filter(row => row === 'finish').length, 1)
}))

test('workbench resume sync follows the selected round and excludes candidates absent from the qualified list', async () => withStore(async store => {
  const oldId = randomUUID(), currentId = randomUUID()
  const source = (id, candidates, createdAt) => ({ id, kind: 'talent_sourcing', jobId: 'java', createdAt, updatedAt: createdAt,
    candidates, results: [], status: 'completed', channels: [], limit: 2, minimumScore: 60 })
  await store.put(`sourcing-${oldId}`, source(oldId, [{ ...person('legacy1234', 'boss'), platformIdentity: undefined, profileUrl: '' }], '2026-10-20'))
  await store.put(`sourcing-${currentId}`, source(currentId, [person('resume1234', 'boss'), { ...person('rejected1234', 'boss'), score: 40 }], '2026-10-21'))
  const f = browserFixture('boss'), service = Object.create(Workbench.prototype)
  Object.assign(service, { store, initialized: Promise.resolve(), begin: async () => {}, browser: { listTools: async () => infos },
    call: async (...args) => args[0] === 'browser_finish' ? {} : f.transport(...args) })
  const result = await service.syncCommunication({ jobId: 'java', roundId: currentId }, signal())
  assert.equal(result.checked, 1); assert.equal(result.platforms[0].unidentified, 0); assert.equal(result.updated, 1)
  const all = await service.syncCommunication({ jobId: 'java', roundId: 'all' }, signal())
  assert.equal(all.checked, 2, 'all rounds still exclude rejected internal records')
  assert.equal(all.platforms[0].unidentified, 1)
  await assert.rejects(service.syncCommunication({ jobId: 'java', roundId: randomUUID() }, signal()), /没有这轮/)
  assert.equal(service.operation, false)
}))
