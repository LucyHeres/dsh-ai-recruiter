import { setTimeout as delay } from 'node:timers/promises'
import type { AgentBrowserTools, AgentBrowserCall } from './agent-browser-tools.js'
import { normalized, statesOf } from './page-actions.js'
import { candidateContactKeys, saveCandidateContact } from './candidate-contact.js'
import { receivedResumes, matchesReceivedResume, cachedReceivedFile, cacheReceivedFile, saveReceivedResume } from './received-resume-store.js'
import { readCapturedFile } from './file-transfer.js'
import { safeError } from './task-error.js'
import { liepinContacts, liepinConversation, liepinAttachmentAddress, liepinResumeResponses } from './platforms/liepin/received-resumes.js'
import type { Store } from './store.js'
import type { SourcingCandidate } from '../shared/sourcing.js'

export const LIEPIN_RESUME_ORIGINS = ['https://lpt.liepin.com', 'https://api-lpt.liepin.com'] as const
const entry = 'https://lpt.liepin.com/chat/im'
const visible = (r: any) => r?.ref && !statesOf(r).some(s => ['hidden', 'invisible', 'blocked_by_dialog'].includes(s))

/** The host grants one exact control after checking its meaning. No model can
 * supply a send button, arbitrary key, capture target or endpoint. */
export function assertLiepinResumeRead(call: AgentBrowserCall, grant?: { snapshotId: string; ref: string; capture?: boolean }) {
  if (call.readOnly && ['browser_list_tabs', 'browser_snapshot', 'browser_inspect_element', 'browser_network_requests', 'browser_network_response', 'artifact_read'].includes(call.name)) return
  if (call.purpose !== 'business_write' && ['browser_navigate', 'browser_open_tab', 'browser_close_tab', 'browser_scroll'].includes(call.name)) return
  if (call.purpose !== 'business_write' && ['browser_click', 'browser_acquire_file'].includes(call.name)
    && grant?.snapshotId === call.args.snapshotId && grant?.ref === call.args.ref
    && (call.name !== 'browser_acquire_file' || grant?.capture && call.args.mode === 'download')) return
  throw new Error('PLATFORM_RESUME_READ_ONLY: 简历同步不能发送消息或索要简历')
}

export async function syncLiepinResumes(broker: AgentBrowserTools, candidates: SourcingCandidate[], store: Store, signal: AbortSignal) {
  const targets = candidates.filter(c => c.platform === 'liepin' && c.platformIdentity?.id)
  if (!targets.length) return { platform: 'liepin' as const, matched: 0, updated: 0, detail: '候选人缺少平台唯一标识，已有状态保留，未按姓名绑定' }
  for (const name of ['browser_network_requests', 'browser_network_response', 'browser_acquire_file', 'artifact_read']) {
    if (!broker.tools.some(t => t.name === name)) throw new Error('请更新薪招扩展至 3.2.43 或更新版本，再同步平台简历')
  }
  let grant: { snapshotId: string; ref: string; capture?: boolean } | undefined
  broker.setBeforeCall(async call => assertLiepinResumeRead(call, grant))
  const execute = async (name: string, args: Record<string, unknown>, requestSignal = signal): Promise<any> => {
    const tool = broker.tools.find(t => t.name === name)
    if (!tool) throw new Error(`PLATFORM_RESUME_TOOL_UNAVAILABLE: ${name}`)
    return tool.execute(args, requestSignal)
  }
  const tabs = (await execute('browser_list_tabs', {})).tabs ?? []
  const existing = tabs.filter((t: any) => { try { return new URL(t.url).origin === LIEPIN_RESUME_ORIGINS[0] } catch { return false } })
  if (existing.length > 1 && existing.filter((t: any) => t.active).length !== 1) throw new Error('请切到需要同步的猎聘页面，避免使用错误账号的标签页')
  let tab = existing.find((t: any) => t.active) ?? existing[0], created = false, unknown = false, restoreFailed = false
  const restoreUrl = tab?.url, matched = new Set<string>(), updated = new Set<string>(), visited = new Set<string>()
  let attachmentCount = 0, incomplete = false, failure = ''
  const snapshot = async () => { await execute('browser_snapshot', { tabId: tab.tabId, format: 'dom', viewportOnly: true }); const p = broker.currentPage(); if (p.isLoginPage) throw new Error('请先在猎聘完成登录或验证'); return p }
  const click = async (page: any, ref: string, capture = false) => {
    grant = { snapshotId: page.snapshotId, ref, capture }
    try { return await execute(capture ? 'browser_acquire_file' : 'browser_click', { tabId: tab.tabId, snapshotId: page.snapshotId, ref,
      ...(capture ? { mode: 'download' } : { observe: { returnSnapshot: 'none' } }) }) }
    finally { grant = undefined }
  }
  const responses = async () => (await execute('browser_network_requests', { tabId: tab.tabId })).requests ?? []
  const beforeResponses = async () => new Set<string>((await responses()).map((r: any) => r.responseRef))
  const readResponse = async (path: string, before: Set<string>, timeout = 8000) => {
    const until = Date.now() + timeout
    do {
      const rows = (await responses()).filter((r: any) => !before.has(r.responseRef) && r.url === `${LIEPIN_RESUME_ORIGINS[1]}${path}`
        && r.method === 'POST' && r.status === 200 && r.finished && /json/i.test(r.mimeType))
      if (rows.length) return (await execute('browser_network_response', { tabId: tab.tabId, responseRef: rows.at(-1).responseRef, maxBytes: 1048576 })).data
      await delay(150, undefined, { signal })
    } while (Date.now() < until)
    throw new Error('PLATFORM_RESUME_RESPONSE_MISSING: 平台页面未返回所需记录，请稍后重新同步')
  }
  const selected = async (page: any, control: any) => {
    if (statesOf(control).some(s => ['selected', 'checked'].includes(s))) return true
    await broker.inspectRefs(page, [control.ref], signal, true, true)
    const inspection = broker.getInspection(page, control.ref)
    return [inspection?.element, ...(inspection?.ancestors ?? []).slice(0, 2)].some(n => String(n?.attributes?.class ?? '').split(/\s+/).includes('ant-im-segmented-item-selected'))
  }
  const closePreview = async () => {
    const page = await snapshot(), dialog = page.dialogs?.find((d: any) => normalized(d.text || d.name) === '附件预览')
    if (!dialog) return !page.dialogs?.length
    const controls = page.items.filter((r: any) => r.dialogRef === dialog.ref && r.role === 'div' && visible(r) && r.bounds?.width > 10 && r.bounds?.height > 10)
    await broker.inspectRefs(page, controls.map((r: any) => r.ref), signal, true, true)
    const icons = controls.filter((r: any) => broker.getInspection(page, r.ref)?.element?.attributes?.class === 'im-ui-new-window-open').sort((a: any, b: any) => a.bounds.x - b.bounds.x)
    if (icons.length !== 3) return false
    // Observed preview toolbar: download, open in window, close. The class and
    // three-control geometry must both match; no arbitrary unlabeled click.
    await click(page, icons[2].ref)
    return !(await snapshot()).dialogs?.length
  }
  try {
    if (!tab) { tab = { tabId: (await execute('browser_open_tab', { url: entry })).tabId }; created = true }
    await execute('browser_network_requests', { tabId: tab.tabId })
    await execute('browser_navigate', { tabId: tab.tabId, url: entry })
    let page: any, filter: any
    for (let i = 0; i < 30; i++) {
      page = await snapshot()
      filter = page.items.find((r: any) => r.role === 'label' && normalized(r.name) === '有简历' && visible(r))
      if (filter && !statesOf(filter).includes('occluded') && !page.dialogs?.length) break
      if (filter && statesOf(filter).includes('occluded')) await execute('browser_scroll', { tabId: tab.tabId, deltaY: -600 })
      else await delay(150, undefined, { signal })
    }
    if (!filter || page.dialogs?.length || statesOf(filter).includes('occluded')) throw new Error('未找到可操作的“沟通 → 有简历”，请在猎聘核对页面')
    let before = new Set<string>()
    if (!await selected(page, filter)) { before = await beforeResponses(); await click(page, filter.ref) }
    const contactData = liepinContacts(await readResponse(liepinResumeResponses.contacts, before))
    page = await snapshot(); filter = page.items.find((r: any) => r.role === 'label' && normalized(r.name) === '有简历' && visible(r))
    if (!filter || !await selected(page, filter)) throw new Error('未能确认猎聘已切换到“有简历”，未更新候选人')
    const contacts = contactData.rows
    for (const contact of contacts) for (const target of targets.filter(t => t.platformIdentity!.id === contact.resumeId)) {
      const key = candidateContactKeys(target)[0]!
      matched.add(key)
      if (await saveCandidateContact(store, target, { greeted: false, resumeReceived: true, source: 'chat' })) updated.add(key)
    }
    incomplete ||= contactData.hasMore
    let previous = ''
    for (let screen = 0; screen < 20; screen++) {
      page = await snapshot()
      const visibleContacts = contacts.filter(c => page.items.some((r: any) => r.role === 'span' && normalized(r.name) === normalized(c.name) && visible(r)))
      const signature = visibleContacts.map(c => c.imId).join('|')
      if (!signature || signature === previous) { incomplete ||= contacts.some(c => !visited.has(c.imId) && targets.some(t => t.platformIdentity!.id === c.resumeId || normalized(t.name) === normalized(c.name))); break }
      previous = signature
      for (const contact of visibleContacts) {
        if (visited.has(contact.imId)) continue
        visited.add(contact.imId)
        const possible = targets.filter(t => t.platformIdentity!.id === contact.resumeId || normalized(t.name) === normalized(contact.name))
        if (!possible.length) continue
        page = await snapshot()
        const names = page.items.filter((r: any) => r.role === 'span' && normalized(r.name) === normalized(contact.name) && visible(r))
        if (names.length !== 1 || contacts.filter(c => normalized(c.name) === normalized(contact.name)).length !== 1) { incomplete = true; continue }
        await broker.inspectRefs(page, [names[0].ref], signal, true, true)
        const detail = broker.getInspection(page, names[0].ref)
        if (![detail?.element, ...(detail?.ancestors ?? [])].some(n => String(n?.attributes?.class ?? '').split(/\s+/).includes('im-ui-contact-list-item'))) { incomplete = true; continue }
        before = await beforeResponses(); await click(page, names[0].ref)
        const messages = await readResponse(liepinResumeResponses.messages, before)
        const verified = possible.map(target => ({ target, conversation: liepinConversation(messages, contact, target.platformIdentity!.id) })).filter(r => r.conversation.resumeId)
        const target = verified[0]?.target, conversation = verified[0]?.conversation
        if (!target || !conversation) { incomplete = true; continue }
        const key = candidateContactKeys(target)[0]!
        for (const { target: alias } of verified) {
          const identityKey = candidateContactKeys(alias)[0]!
          matched.add(identityKey)
          if (await saveCandidateContact(store, alias, { greeted: false, resumeReceived: true, source: 'chat' })) updated.add(identityKey)
        }
        if (!conversation.files.length) continue
        // Multiple message cards without DOM message IDs cannot safely be
        // paired to individual message versions. Preserve facts and skip them.
        if (conversation.files.length !== 1) { incomplete = true; continue }
        const evidence = conversation.files[0]
        const prior = (await receivedResumes(store)).find(r => matchesReceivedResume(target, r) && r.messageId === evidence.messageId && r.attachmentId === evidence.attachmentId)
        if (prior && await cachedReceivedFile(store, prior)) continue
        for (let i = 0; i < 20; i++) {
          page = await snapshot()
          if (page.items.some((r: any) => r.role === 'div' && normalized(r.name) === '附件简历' && visible(r))) break
          await delay(100, undefined, { signal })
        }
        const cards = page.items.filter((r: any) => r.role === 'div' && normalized(r.name) === '附件简历' && visible(r))
        if (cards.length !== 1) { incomplete = true; continue }
        before = await beforeResponses(); await click(page, cards[0].ref)
        let address = liepinAttachmentAddress(await readResponse(liepinResumeResponses.attachment, before))
        page = await snapshot()
        const dialogs = page.dialogs?.filter((d: any) => normalized(d.text || d.name) === '附件预览') ?? []
        const links = page.items.filter((r: any) => r.role === 'link' && r.dialogRef === dialogs[0]?.ref && visible(r))
        if (dialogs.length !== 1 || links.length !== 1) throw new Error('附件预览下载入口已变化，未采集文件')
        before = await beforeResponses()
        const capture = await click(page, links[0].ref, true)
        if (!capture.complete || !capture.captureId) throw new Error('附件文件未完整取得，未提供下载或上传入口')
        const file = await readCapturedFile(capture.captureId, args => execute('artifact_read', args), signal)
        // The download operation refreshes the signed link with download=1.
        address = liepinAttachmentAddress(await readResponse(liepinResumeResponses.attachment, before))
        for (const { target: alias } of verified) {
          const { record } = await saveReceivedResume(store, alias, { ...evidence, resumeId: alias.platformIdentity!.id, ...address })
          await cacheReceivedFile(store, record, { ...file, fileName: address.fileName })
        }
        attachmentCount++; updated.add(key)
        if (!await closePreview()) throw new Error('附件预览未能关闭，已停止继续读取')
      }
      if (contacts.every(c => visited.has(c.imId) || !targets.some(t => c.resumeId ? t.platformIdentity!.id === c.resumeId : normalized(t.name) === normalized(c.name)))) break
      page = await snapshot()
      const last = [...page.items].reverse().find((r: any) => r.role === 'span' && visible(r) && visibleContacts.some(c => normalized(c.name) === normalized(r.name)))
      if (!last) { incomplete = true; break }
      await execute('browser_scroll', { tabId: tab.tabId, snapshotId: page.snapshotId, ref: last.ref, deltaY: Math.floor((page.viewport?.height ?? 700) * .65) })
      if (screen === 19) incomplete = true
    }
  } catch (error) {
    unknown = /UNKNOWN/.test(String(error))
    if (unknown || signal.aborted || !matched.size) throw error
    incomplete = true; failure = safeError(error)
  } finally {
    if (tab && !unknown) {
      const cleanupSignal = AbortSignal.timeout(6000)
      try {
        if (created) await execute('browser_close_tab', { tabId: tab.tabId }, cleanupSignal)
        else if (restoreUrl) await execute('browser_navigate', { tabId: tab.tabId, url: restoreUrl }, cleanupSignal)
      } catch { restoreFailed = true }
    }
  }
  return { platform: 'liepin' as const, matched: matched.size, updated: updated.size,
    detail: `已按平台唯一标识核对“沟通 → 有简历”，新取得 ${attachmentCount} 份附件${incomplete ? '；部分记录未能核验，原状态保留' : ''}${failure ? `；${failure}` : ''}${restoreFailed ? '；请手动返回原页面' : ''}` }
}
