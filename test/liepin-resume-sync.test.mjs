import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store, hash } from '../dist/lib/store.js'
import { syncLiepinResumes, refreshLiepinAttachment, assertLiepinResumeRead } from '../dist/lib/platforms/liepin/resume-sync.js'
import { liepinResumeResponses } from '../dist/lib/platforms/liepin/received-resumes.js'
import { resumeFileFingerprint } from '../dist/lib/received-resume-file.js'
import { receivedResumes, saveReceivedResume, updateReceivedResume } from '../dist/lib/received-resume-store.js'

const person = index => ({ key: hash(`resume_${index}`), platform: 'liepin', name: `候选人${index}`,
  platformIdentity: { kind: 'resume', id: `resume_${index}`, source: 'card_class' }, fields: [], score: 90 })
const payload = (index, attachment = false) => JSON.stringify({ ext: { extType: 203, extBody: { bizType: '7', bizData: {
  onlineResume: { param: JSON.stringify({ encodeResId: `resume_${index}`, userId: `user_${index}` }) },
  ...(attachment ? { attachmentResume: { param: JSON.stringify({ encodeAttachmentId: `attachment_${index}`, userId: `user_${index}` }) } } : {}),
} } } })
const response = list => ({ flag: 1, data: { list, hasMore: false } })
const contact = index => ({ oppositeUserId: `user_${index}`, oppositeImId: `chat_${index}`, imId: 'recruiter_1234',
  oppositeImUserType: '0', name: person(index).name, lastPayload: payload(index), latestMsgSendImId: `chat_${index}` })
const messages = (index, attachment) => response([{ ...contact(index), msgSendImId: `chat_${index}`, msgId: `message_${index}`,
  payload: payload(index, attachment), msgTime: 1792500000000, revokeFlag: false }])
const bytes = Buffer.from('%PDF-1.7\nreceived attachment')

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), 'liepin-sync-'))
  try { const store = new Store(root, 'company'); await store.init(); return await run(store) }
  finally { await rm(root, { recursive: true, force: true }) }
}

function fixture({ count = 1, cached = [], attachment = false, fail = [], foreignResponse = false, pendingRefresh = false, unavailable = [], wrongNoticeName = false, login = false, unknown = false,
  initialFilterSelected = true, resetFilterClicks = 0, filterDelay = 0, withWait = false, nameInChat = false, newTab = false, sharedName = false, cachedList = false } = {}) {
  let current, guard, active = 0, preview = false, unavailableDialog = false, navigated = false, pendingReads = 0
  let filterSelected = initialFilterSelected, filterClicks = 0, pendingFilterFrames = 0
  const calls = [], bodies = new Map(), network = []
  const observe = (ref, path, data) => {
    bodies.set(ref, data)
    network.push({ responseRef: ref, url: `https://api-lpt.liepin.com${path}`, method: 'POST', status: 200, finished: true, mimeType: 'application/json' })
  }
  const broker = { tools: [], currentPage: () => current, setBeforeCall: callback => { guard = callback }, inspectRefs: async () => {},
    getInspection: (_page, ref) => ['received', 'all'].includes(ref) ? { element: { attributes: { class: ref === 'received' && filterSelected || ref === 'all' && !filterSelected ? 'ant-im-segmented-item-selected' : 'ant-im-segmented-item' } }, ancestors: [{ ref: 'filters', attributes: { class: 'ant-im-segmented-group' } }] }
      : ref.startsWith('toolbar-') ? { element: { attributes: { class: 'im-ui-new-window-open' } } }
      : ref === 'chat-name' ? { element: { attributes: { class: 'im-ui-chat-header-name' } } }
      : { element: { attributes: { class: 'im-ui-contact-list-item' } } } }
  const names = ['browser_list_tabs', 'browser_network_requests', 'browser_network_response', 'browser_navigate', 'browser_snapshot',
    'browser_inspect_element', 'browser_click', 'browser_acquire_file', 'artifact_read', 'browser_scroll', 'browser_open_tab', 'browser_close_tab', ...(withWait ? ['browser_wait'] : [])]
  broker.tools = names.map(name => ({ name, execute: async (args = {}) => {
    guard?.({ name, args, readOnly: ['browser_list_tabs', 'browser_network_requests', 'browser_network_response', 'browser_snapshot', 'browser_inspect_element', 'artifact_read', 'browser_wait'].includes(name) })
    calls.push({ name, args })
    if (name === 'browser_wait') return { conditionMet: true }
    if (name === 'browser_scroll') return {}
    if (name === 'browser_list_tabs') return { tabs: newTab ? [] : [{ tabId: 7, url: 'https://lpt.liepin.com/recommend', active: true }] }
    if (name === 'browser_open_tab') return { tabId: 7 }
    if (name === 'browser_navigate') {
      if (!navigated) {
        navigated = true
        if (!cachedList) observe('contacts', liepinResumeResponses.contacts, response(Array.from({ length: count }, (_, i) => ({ ...contact(i), name: person(sharedName ? 0 : i).name }))))
        for (const i of cached) observe(`cached-${i}`, liepinResumeResponses.messages, messages(i, attachment))
      }
      return {}
    }
    if (name === 'browser_snapshot') {
      if (pendingFilterFrames > 0 && --pendingFilterFrames === 0) filterSelected = true
      return current = { tabId: 7, url: 'https://lpt.liepin.com/chat/im', snapshotId: randomUUID(), viewport: { height: 700 },
      dialogs: unavailableDialog ? [{ ref: 'notice', text: `用户“${wrongNoticeName ? '其他候选人' : person(active).name}”的账号已经停用， 该对话将被删除\n知道了` }] : preview ? [{ ref: 'preview', text: '附件预览' }] : [],
      items: unavailableDialog ? [{ ref: 'acknowledge', role: 'button', name: '知道了', dialogRef: 'notice' }] : preview ? [
        { ref: 'download', role: 'link', name: '', dialogRef: 'preview' },
        ...[0, 1, 2].map(i => ({ ref: `toolbar-${i}`, role: 'div', name: '', dialogRef: 'preview', bounds: { x: i * 30, y: 0, width: 20, height: 20 } })),
      ] : [...(pendingFilterFrames ? [] : [{ ref: 'received', role: 'label', name: '有简历', states: filterSelected ? ['checked'] : [] }]),
        ...(cachedList ? [{ ref: 'all', role: 'label', name: '全部', states: filterSelected ? [] : ['checked'] }] : []),
        ...Array.from({ length: count }, (_, i) => ({ ref: `person-${i}`, role: 'span', name: person(sharedName ? 0 : i).name, bounds: { x: 0, y: i * 50, width: 100, height: 20 } })),
        ...(nameInChat ? [{ ref: 'chat-name', role: 'span', name: person(active).name }] : []),
        ...(attachment ? [{ ref: 'attachment', role: 'div', name: '附件简历' }] : [])] }
    }
    if (name === 'browser_network_requests') {
      const pending = network.find(row => row.finished === false)
      if (pending && pendingReads++ > 0) { pending.finished = true; pending.status = 200 }
      return { requests: network.filter(row => !args.urlPattern || row.url.includes(args.urlPattern)) }
    }
    if (name === 'browser_network_response') {
      if (args.responseRef.startsWith('failed-')) throw new Error('NETWORK_RESPONSE_UNAVAILABLE')
      return { data: bodies.get(args.responseRef) }
    }
    if (name === 'browser_click') {
      if (args.ref === 'all') {
        filterSelected = false
        observe('contacts-all', liepinResumeResponses.contacts, response([]))
      } else if (args.ref === 'received') {
        filterClicks++
        filterSelected = filterClicks > resetFilterClicks && !filterDelay
        pendingFilterFrames = filterClicks > resetFilterClicks ? filterDelay : 0
        observe(`contacts-filter-${filterClicks}`, liepinResumeResponses.contacts, response(Array.from({ length: count }, (_, i) => contact(i))))
      } else if (args.ref.startsWith('person-')) {
        active = Number(args.ref.slice(7))
        if (login && active === 0) throw Object.assign(new Error('PLATFORM_LOGIN_REQUIRED'), { code: 'PLATFORM_LOGIN_REQUIRED' })
        if (unknown && active === 0) throw new Error('BROWSER_WRITE_OUTCOME_UNKNOWN')
        if (unavailable.includes(active)) { unavailableDialog = true; return {} }
        if (fail.includes(active)) observe(`failed-${active}`, liepinResumeResponses.messages, undefined)
        else if (!cached.includes(active) || pendingRefresh) {
          observe(`messages-${active}`, liepinResumeResponses.messages, messages(active, attachment && !pendingRefresh))
          if (pendingRefresh) { network.at(-1).finished = false; network.at(-1).status = null }
          if (foreignResponse) observe(`foreign-${active}`, liepinResumeResponses.messages, messages(99, attachment))
        }
      } else if (args.ref === 'attachment') {
        preview = true
        observe(`attachment-${active}`, liepinResumeResponses.attachment, { flag: 1,
          data: { fileName: `candidate-${active}.pdf`, fileExtension: 'pdf', accessPath: 'https://tdoss.liepin.com/o/recruit-auth/resume/attachment-res/file.pdf?tk=private' } })
      } else if (args.ref === 'toolbar-2') preview = false
      else if (args.ref === 'acknowledge') unavailableDialog = false
      else throw new Error(`Unexpected click: ${args.ref}`)
      return {}
    }
    if (name === 'browser_acquire_file') return { complete: true, captureId: `capture-${active}` }
    if (name === 'artifact_read') return { captureId: args.captureId, offset: 0, totalSize: bytes.length, size: bytes.length,
      base64: bytes.toString('base64'), eof: true, fileName: 'captured.pdf', mimeType: 'application/pdf' }
    throw new Error(`Unexpected operation: ${name}`)
  } }))
  return { broker, calls, people: Array.from({ length: count }, (_, i) => person(i)) }
}

test('a cached received view with no observed list request refreshes its sibling filter once and only trusts the new received list', async () => withStore(async store => {
  const f = fixture({ cachedList: true })
  const result = await syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(20000))
  assert.equal(result.status, 'completed'); assert.equal(result.matched, 1)
  assert.equal(f.calls.filter(c => c.name === 'browser_click' && c.args.ref === 'all').length, 1)
  assert.equal(f.calls.filter(c => c.name === 'browser_click' && c.args.ref === 'received').length, 1)
  assert.equal(f.calls.some(c => c.name === 'browser_network_response' && c.args.responseRef === 'contacts-all'), false)
  assert.equal(f.broker.currentPage().items.find(i => i.ref === 'received').states.includes('checked'), true)
}))

test('a repeated name in the active chat header does not make a unique contact-list row ambiguous', async () => withStore(async store => {
  const f = fixture({ nameInChat: true, attachment: true })
  const result = await syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(15000))
  assert.equal(result.status, 'completed'); assert.equal((await receivedResumes(store)).length, 1)
  assert.equal(f.calls.some(c => c.name === 'browser_click' && c.args.ref === 'chat-name'), false)
}))

test('same-name contacts are navigated separately and linked only by each fresh response’s chat/user/resume IDs', async () => withStore(async store => {
  const f = fixture({ count: 2, attachment: true, sharedName: true })
  const result = await syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(15000))
  assert.equal(result.status, 'completed')
  const files = await receivedResumes(store)
  assert.equal(files.length, 2)
  for (const i of [0, 1]) assert.ok(files.some(row => row.resumeId === `resume_${i}` && row.conversationId === `chat_${i}` && row.messageId === `message_${i}`))
}))

test('same-name rows cannot reuse an old chat response when the current click provides no fresh identity proof', async () => withStore(async store => {
  const f = fixture({ count: 2, cached: [0], attachment: true, sharedName: true })
  const result = await syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(20000))
  assert.equal(result.status, 'partial'); assert.match(result.detail, /PLATFORM_RESUME_RESPONSE_MISSING/)
  assert.equal(f.calls.some(c => c.name === 'browser_network_response' && c.args.responseRef === 'cached-0'), false)
  const files = await receivedResumes(store)
  assert.equal(files.length, 1); assert.equal(files[0].resumeId, 'resume_1')
}))

test('legacy records without a platform ID are explicitly skipped without borrowing another person’s identity', async () => withStore(async store => {
  const f = fixture({ attachment: true })
  const result = await syncLiepinResumes(f.broker, f.people.map(p => ({ ...p, platformIdentity: undefined })), store, AbortSignal.timeout(15000))
  assert.equal(result.status, 'completed'); assert.equal(result.unidentified, 1); assert.equal(result.matched, 0)
  assert.match(result.detail, /已跳过 1 条缺少平台 ID 的历史记录/)
  assert.equal(await store.find('candidate-contacts'), null); assert.deepEqual(await receivedResumes(store), [])
}))

test('a verified chat without resume-ID evidence is an unlinked skip, never a missing-response error or a resume receipt', async () => withStore(async store => {
  const f = fixture()
  const tool = f.broker.tools.find(t => t.name === 'browser_network_response'), run = tool.execute
  tool.execute = async args => {
    const out = await run(args)
    for (const row of out.data?.data?.list ?? []) { row.lastPayload = '{}'; row.payload = '{}' }
    return out
  }
  const result = await syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(15000))
  assert.equal(result.status, 'completed'); assert.equal(result.matched, 0)
  assert.match(result.detail, /简历 ID 缺失或与当前人选不符/)
  assert.doesNotMatch(result.detail, /RESPONSE_MISSING/)
  assert.equal(await store.find('candidate-contacts'), null); assert.deepEqual(await receivedResumes(store), [])
}))

test('completed sync leaves existing and newly opened tabs on their last received-resume state', async () => withStore(async store => {
  for (const newTab of [false, true]) {
    const f = fixture({ newTab })
    const result = await syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(15000))
    assert.equal(result.status, 'completed')
    assert.equal(f.calls.filter(c => c.name === 'browser_navigate').length, 1)
    assert.equal(f.calls.some(c => c.name === 'browser_close_tab'), false)
    assert.equal(f.broker.currentPage().items.find(i => i.ref === 'received').states.includes('checked'), true)
  }
}))

test('Liepin waits for a rerendered received-resume filter before trusting a completed response', async () => withStore(async store => {
  const f = fixture({ initialFilterSelected: false, filterDelay: 3, attachment: true, withWait: true })
  const result = await syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(15000))
  assert.equal(result.status, 'completed')
  assert.equal(f.calls.filter(c => c.name === 'browser_click' && c.args.ref === 'received').length, 1)
  assert.ok(f.calls.some(c => c.name === 'browser_wait' && c.args.condition.type === 'dom_quiet'))
  assert.equal((await receivedResumes(store)).length, 1)
}))

test('Liepin retries a filter reset once with a fresh response baseline and discards the first response', async () => withStore(async store => {
  const f = fixture({ initialFilterSelected: false, resetFilterClicks: 1, attachment: true })
  const result = await syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(15000))
  assert.equal(result.status, 'completed')
  assert.equal(f.calls.filter(c => c.name === 'browser_click' && c.args.ref === 'received').length, 2)
  assert.equal(f.calls.some(c => c.name === 'browser_network_response' && c.args.responseRef === 'contacts-filter-1'), false)
  assert.ok(f.calls.some(c => c.name === 'browser_network_response' && c.args.responseRef === 'contacts-filter-2'))
  assert.equal((await receivedResumes(store)).length, 1)
}))

test('an unconfirmed received-resume filter stops after two clicks without changing local receipts or opening a contact', async () => withStore(async store => {
  const f = fixture({ initialFilterSelected: false, resetFilterClicks: 2, attachment: true })
  await assert.rejects(syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(15000)), /未能确认猎聘已切换/)
  assert.equal(f.calls.filter(c => c.name === 'browser_click' && c.args.ref === 'received').length, 2)
  assert.equal(f.calls.some(c => c.name === 'browser_click' && c.args.ref.startsWith('person-')), false)
  assert.equal(f.calls.some(c => c.name === 'browser_network_response'), false)
  assert.deepEqual(await receivedResumes(store), [])
  assert.equal(await store.find('candidate-contacts'), null)
}))

test('resume sync only permits read-only DOM settling waits', () => {
  assert.doesNotThrow(() => assertLiepinResumeRead({ name: 'browser_wait', readOnly: true, args: { condition: { type: 'dom_quiet' } } }))
  assert.throws(() => assertLiepinResumeRead({ name: 'browser_wait', readOnly: true, args: { condition: { type: 'time' } } }), /READ_ONLY/)
  assert.throws(() => assertLiepinResumeRead({ name: 'browser_wait', readOnly: false, args: { condition: { type: 'dom_quiet' } } }), /READ_ONLY/)
})

test('Liepin reuses this run’s identity-verified response when reopening the active conversation sends no request', async () => withStore(async store => {
  const f = fixture({ cached: [0, 99] })
  const result = await syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(15000))
  assert.equal(result.status, 'completed'); assert.equal(result.matched, 1)
  assert.ok(f.calls.some(call => call.name === 'browser_network_response' && call.args.responseRef === 'cached-0'))
  assert.deepEqual(await receivedResumes(store), [])
}))

test('Liepin matches fresh chat responses to their conversation instead of choosing the last response', async () => withStore(async store => {
  const f = fixture({ foreignResponse: true, attachment: true })
  const result = await syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(15000))
  assert.equal(result.status, 'completed')
  const rows = await receivedResumes(store)
  assert.equal(rows.length, 1); assert.equal(rows[0].resumeId, 'resume_0'); assert.equal(rows[0].conversationId, 'chat_0')
}))

test('a pending refresh waits for fresh chat data instead of collecting an attachment from an older response', async () => withStore(async store => {
  const f = fixture({ cached: [0], attachment: true, pendingRefresh: true })
  const result = await syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(15000))
  assert.equal(result.status, 'completed')
  assert.equal(f.calls.some(call => call.name === 'browser_acquire_file'), false)
  assert.equal(f.calls.some(call => call.name === 'browser_network_response' && call.args.responseRef === 'cached-0'), false)
  assert.deepEqual(await receivedResumes(store), [])
}))

test('Liepin sync saves verified attachment links without downloading or persisting file bytes', async () => withStore(async store => {
  const f = fixture({ attachment: true })
  const result = await syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(15000))
  assert.equal(result.status, 'completed'); assert.match(result.detail, /已更新 1 份附件链接/)
  const rows = await receivedResumes(store)
  assert.equal(rows.length, 1); assert.match(rows[0].downloadUrl, /^https:\/\/tdoss\.liepin\.com\//)
  assert.equal(rows[0].cached, undefined); assert.equal(rows[0].content, undefined)
  assert.equal(f.calls.filter(call => ['browser_acquire_file', 'artifact_read'].includes(call.name)).length, 0)
  assert.ok((await readdir(store.root)).every(name => !name.endsWith('.bin')))
}))

test('a candidate response read failure preserves partial results and continues with the next candidate', async () => withStore(async store => {
  const f = fixture({ count: 2, fail: [0], attachment: true })
  const result = await syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(15000))
  assert.equal(result.status, 'partial'); assert.equal(result.scanned, 2)
  assert.ok(f.calls.some(call => call.name === 'browser_click' && call.args.ref === 'person-1'))
  assert.match(result.detail, /1 位候选人读取失败/)
  const rows = await receivedResumes(store)
  assert.equal(rows.length, 1); assert.equal(rows[0].resumeId, 'resume_1')
}))

test('an exact deactivated-account notice is acknowledged, preserves cached files and permits the next contact', async () => withStore(async store => {
  const f = fixture({ count: 2, unavailable: [0], attachment: true })
  const { record } = await saveReceivedResume(store, f.people[0], { resumeId: 'resume_0', conversationId: 'chat_0',
    messageId: 'previous_message', attachmentId: 'previous_attachment', fileName: 'previous.pdf' })
  const fingerprint = await resumeFileFingerprint({ blob: new Blob([bytes]), fileName: 'previous.pdf' })
  await updateReceivedResume(store, record.id, row => { row.cached = fingerprint })
  await writeFile(store.path(`received-file-${record.id}`, 'bin'), bytes)
  const result = await syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(15000))
  assert.equal(result.status, 'completed'); assert.match(result.detail, /已跳过 1 位账号停用的候选人/)
  const clicks = f.calls.filter(call => call.name === 'browser_click').map(call => call.args.ref)
  assert.ok(clicks.indexOf('acknowledge') < clicks.indexOf('person-1'))
  const rows = await receivedResumes(store)
  assert.equal(rows.length, 2); assert.ok(rows.some(row => row.resumeId === 'resume_1' && row.downloadUrl && !row.cached))
  assert.equal((await readFile(store.path(`received-file-${record.id}`, 'bin'))).toString(), bytes.toString())
}))

test('a deactivation notice naming another person is never acknowledged or treated as the current contact', async () => withStore(async store => {
  const f = fixture({ count: 2, unavailable: [0], wrongNoticeName: true })
  const result = await syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(15000))
  assert.equal(result.status, 'partial'); assert.match(result.detail, /未处理提示/)
  assert.equal(f.calls.some(call => call.name === 'browser_click' && ['acknowledge', 'person-1'].includes(call.args.ref)), false)
}))

test('a cached response for another conversation cannot satisfy the current candidate’s missing response', async () => withStore(async store => {
  const f = fixture({ cached: [0], count: 2 })
  // Reopening candidate 1 produces no new response, while candidate 0’s cached response remains available.
  const click = f.broker.tools.find(tool => tool.name === 'browser_click'), execute = click.execute
  click.execute = args => args.ref === 'person-1' ? Promise.resolve({}) : execute(args)
  const result = await syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(15000))
  assert.equal(result.status, 'partial'); assert.match(result.detail, /PLATFORM_RESUME_RESPONSE_MISSING/)
  assert.deepEqual(await receivedResumes(store), [])
}))

test('login and unknown click outcomes still stop the batch immediately', async () => withStore(async store => {
  for (const options of [{ login: true }, { unknown: true }]) {
    const f = fixture({ count: 2, ...options })
    await assert.rejects(syncLiepinResumes(f.broker, f.people, store, AbortSignal.timeout(15000)), /LOGIN_REQUIRED|OUTCOME_UNKNOWN/)
    assert.equal(f.calls.some(call => call.name === 'browser_click' && call.args.ref === 'person-1'), false)
  }
}))


test('expired-link refresh reopens only the identity-verified attachment and does not download files', async () => withStore(async store => {
  const f = fixture({ count: 2, attachment: true })
  const { record: row } = await saveReceivedResume(store, f.people[0], { resumeId: 'resume_0', conversationId: 'chat_0',
    messageId: 'message_0', attachmentId: 'attachment_0', fileName: 'previous.pdf', downloadUrl: 'https://tdoss.liepin.com/o/recruit-auth/resume/attachment-res/expired.pdf' })
  const actual = await refreshLiepinAttachment(f.broker, f.people[0], row, store, AbortSignal.timeout(15000))
  assert.equal(actual.id, row.id); assert.match(actual.downloadUrl, /file\.pdf/)
  assert.equal(f.calls.some(call => ['browser_acquire_file', 'artifact_read'].includes(call.name)), false)
  assert.equal(f.calls.some(call => call.name === 'browser_click' && call.args.ref === 'person-1'), false)
  assert.ok((await readdir(store.root)).every(name => !name.endsWith('.bin')))
}))

test('a newer or withdrawn message cannot replace the attachment selected for link refresh', async () => withStore(async store => {
  const f = fixture({ attachment: true })
  const { record: row } = await saveReceivedResume(store, f.people[0], { resumeId: 'resume_0', conversationId: 'chat_0',
    messageId: 'withdrawn_message', attachmentId: 'withdrawn_attachment', fileName: 'previous.pdf', downloadUrl: 'old-link' })
  await assert.rejects(refreshLiepinAttachment(f.broker, f.people[0], row, store, AbortSignal.timeout(15000)), /原附件未能重新定位/)
  assert.equal(f.calls.some(call => call.name === 'browser_click' && call.args.ref === 'attachment'), false)
  assert.equal((await receivedResumes(store))[0].downloadUrl, 'old-link')
}))

test('on-demand download captures the exact verified preview in browser memory and leaves sync link-only', async () => withStore(async store => {
  const f = fixture({ attachment: true })
  const { record: row } = await saveReceivedResume(store, f.people[0], { resumeId: 'resume_0', conversationId: 'chat_0',
    messageId: 'message_0', attachmentId: 'attachment_0', fileName: 'candidate-0.pdf', downloadUrl: 'expired' })
  const actual = await refreshLiepinAttachment(f.broker, f.people[0], row, store, AbortSignal.timeout(15000), true)
  assert.equal(actual.record.id, row.id); assert.equal(await actual.file.blob.text(), bytes.toString())
  const captures = f.calls.filter(call => call.name === 'browser_acquire_file')
  assert.equal(captures.length, 1); assert.equal(captures[0].args.mode, 'click'); assert.equal(captures[0].args.ref, 'download')
  assert.ok(f.calls.some(call => call.name === 'artifact_read'))
  assert.equal(f.calls.some(call => call.name === 'browser_click' && call.args.ref === 'download'), false)
  assert.equal(f.calls.some(call => call.name === 'browser_click' && call.args.ref === 'toolbar-2'), false, 'closing a cosmetic preview must not turn completed file capture into failure')
  assert.ok((await readdir(store.root)).every(name => !name.endsWith('.bin')))
  assert.equal((await receivedResumes(store))[0].cached, undefined)
}))

test('incomplete browser capture reports the actual failure and never retries the download action', async () => withStore(async store => {
  const f = fixture({ attachment: true }), tool = f.broker.tools.find(tool => tool.name === 'browser_acquire_file'), run = tool.execute
  tool.execute = async args => { await run(args); return { complete: false, captureId: 'partial' } }
  const { record: row } = await saveReceivedResume(store, f.people[0], { resumeId: 'resume_0', conversationId: 'chat_0',
    messageId: 'message_0', attachmentId: 'attachment_0', fileName: 'candidate-0.pdf' })
  await assert.rejects(refreshLiepinAttachment(f.broker, f.people[0], row, store, AbortSignal.timeout(15000), true), /附件文件未完整取得/)
  assert.equal(f.calls.filter(call => call.name === 'browser_acquire_file').length, 1)
  assert.equal(f.calls.some(call => call.name === 'artifact_read'), false)
}))
