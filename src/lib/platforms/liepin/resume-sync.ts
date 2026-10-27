import { setTimeout as delay } from 'node:timers/promises'
import type { AgentBrowserTools, AgentBrowserCall } from '../../agent-browser-tools.js'
import { normalized, statesOf } from '../../page-actions.js'
import { candidateContactKeys, saveCandidateContact } from '../../candidate-contact.js'
import { saveReceivedResume, type ReceivedResumeRecord } from '../../received-resume-store.js'
import { safeError } from '../../task-error.js'
import { liepinContacts, liepinConversation, liepinAttachmentAddress, liepinResumeResponses, type LiepinContact } from './received-resumes.js'
import type { Store } from '../../store.js'
import type { SourcingCandidate } from '../../../shared/sourcing.js'
import type { CommunicationSyncRow } from '../types.js'
import { liepinDefinition } from './definition.js'
import { assertPlatformPageLogin, isPlatformLoginRequired, platformPageNeedsLogin } from '../../platform-login.js'
import { PLATFORMS } from '../../../shared/workbench.js'
import { readCapturedFile, type CapturedFile } from '../../file-transfer.js'

export const LIEPIN_RESUME_ORIGINS = ['https://lpt.liepin.com', 'https://api-lpt.liepin.com', ...PLATFORMS.liepin.origins.filter(origin => origin !== 'https://lpt.liepin.com')]
const entry = liepinDefinition.communication!.entries[0]!
const receivedTab = liepinDefinition.communication!.filters!.resume_received![0]!
const visible = (r: any) => r?.ref && !statesOf(r).some(s => ['hidden', 'invisible', 'blocked_by_dialog'].includes(s))

/** The host grants one exact control after checking its meaning. No model can
 * supply a send button, arbitrary key, capture target or endpoint. */
export function assertLiepinResumeRead(call: AgentBrowserCall, grant?: { snapshotId: string; ref: string; capture?: boolean }) {
  if (call.readOnly && ['browser_list_tabs', 'browser_snapshot', 'browser_inspect_element', 'browser_network_requests', 'browser_network_response', 'artifact_read'].includes(call.name)) return
  if (call.readOnly && call.name === 'browser_wait' && call.args.condition?.type === 'dom_quiet') return
  if (call.purpose !== 'business_write' && ['browser_navigate', 'browser_open_tab', 'browser_close_tab', 'browser_scroll'].includes(call.name)) return
  if (call.purpose !== 'business_write' && ['browser_click', 'browser_acquire_file'].includes(call.name)
    && grant?.snapshotId === call.args.snapshotId && grant?.ref === call.args.ref
    && (call.name !== 'browser_acquire_file' || grant?.capture && ['click', 'download'].includes(call.args.mode))) return
  throw new Error('PLATFORM_RESUME_READ_ONLY: 简历同步不能发送消息或索要简历')
}

export async function syncLiepinResumes(broker: AgentBrowserTools, candidates: SourcingCandidate[], store: Store, signal: AbortSignal,
  options: { attachment?: ReceivedResumeRecord; capture?: boolean; onAttachment?: (row: ReceivedResumeRecord, file?: CapturedFile) => void } = {}): Promise<CommunicationSyncRow> {
  const platformCandidates = candidates.filter(c => c.platform === 'liepin')
  const targets = platformCandidates.filter(c => c.platformIdentity?.id)
  const unidentified = platformCandidates.length - targets.length
  for (const name of ['browser_network_requests', 'browser_network_response', ...(options.capture ? ['browser_acquire_file', 'artifact_read'] : [])]) {
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
  const existing = tabs.filter((t: any) => { try { return (PLATFORMS.liepin.origins as readonly string[]).includes(new URL(t.url).origin) } catch { return false } })
  if (existing.length > 1 && existing.filter((t: any) => t.active).length !== 1) throw new Error('请切到需要同步的猎聘页面，避免使用错误账号的标签页')
  let tab = existing.find((t: any) => t.active) ?? existing[0]
  const matched = new Set<string>(), updated = new Set<string>(), visited = new Set<string>(), processedRows = new Set<string>(), incompleteReasons = new Set<string>()
  let attachmentCount = 0, scanned = 0, failedContacts = 0, unavailableContacts = 0, unlinkedContacts = 0, incomplete = false, failure = ''
  const markIncomplete = (reason: string) => { incomplete = true; incompleteReasons.add(reason) }
  const snapshot = async () => { await execute('browser_snapshot', { tabId: tab.tabId, format: 'dom', viewportOnly: true }); const p = broker.currentPage(); assertPlatformPageLogin(p, 'liepin', '同步平台简历'); return p }
  const click = async (page: any, ref: string, capture = false) => {
    grant = { snapshotId: page.snapshotId, ref, capture }
    try { return await execute(capture ? 'browser_acquire_file' : 'browser_click', { tabId: tab.tabId, snapshotId: page.snapshotId, ref,
      ...(capture ? { mode: 'click' } : { observe: { returnSnapshot: 'none' } }) }) }
    finally { grant = undefined }
  }
  const responses = async (path: string) => (await execute('browser_network_requests', { tabId: tab.tabId, urlPattern: path })).requests ?? []
  const beforeResponses = async (path: string) => new Set<string>((await responses(path)).map((r: any) => r.responseRef))
  const responseData = new Map<string, any>()
  const readResponse = async (path: string, before: Set<string>, matches?: (data: any) => boolean, allowCached = true) => {
    const until = Date.now() + 8000
    do {
      signal.throwIfAborted()
      const observed = (await responses(path)).filter((r: any) => r.url === `${LIEPIN_RESUME_ORIGINS[1]}${path}` && r.method === 'POST')
      const fresh = observed.filter((r: any) => !before.has(r.responseRef))
      // Clicking the active chat can be a no-op. Only reuse a response from
      // this page/task when its chat/user/resume IDs verify the exact target.
      // A pending or mismatched new response must never fall back to old data.
      const rows = (allowCached && matches && !fresh.length ? observed : fresh)
        .filter((r: any) => r.status === 200 && r.finished && !r.failed && /json/i.test(r.mimeType))
      for (const row of [...rows].reverse()) {
        if (!responseData.has(row.responseRef)) responseData.set(row.responseRef,
          (await execute('browser_network_response', { tabId: tab.tabId, responseRef: row.responseRef, maxBytes: 1048576 })).data)
        const data = responseData.get(row.responseRef)
        if (!matches || matches(data)) return data
      }
      await delay(150, undefined, { signal })
    } while (Date.now() < until)
    const label = path === liepinResumeResponses.messages ? '当前候选人的聊天记录' : path === liepinResumeResponses.attachment ? '当前附件的下载信息' : '有简历列表'
    throw new Error(`PLATFORM_RESUME_RESPONSE_MISSING: 未取得可核验的${label}`)
  }
  const selected = async (page: any, control: any) => {
    if (statesOf(control).some(s => ['selected', 'checked'].includes(s))) return true
    await broker.inspectRefs(page, [control.ref], signal, true, true)
    const inspection = broker.getInspection(page, control.ref)
    return [inspection?.element, ...(inspection?.ancestors ?? []).slice(0, 2)].some(n => String(n?.attributes?.class ?? '').split(/\s+/).includes('ant-im-segmented-item-selected'))
  }
  const settle = async () => {
    if (broker.tools.some(t => t.name === 'browser_wait')) await execute('browser_wait', {
      tabId: tab.tabId, condition: { type: 'dom_quiet', quietMs: 500, timeoutMs: 3000 },
    })
  }
  const receivedFilter = (page: any) => {
    const filters = page.items.filter((r: any) => r.role === 'label' && normalized(r.name) === receivedTab && visible(r))
    return !page.dialogs?.length && filters.length === 1 && !statesOf(filters[0]).includes('occluded') ? filters[0] : undefined
  }
  const refreshCachedFilter = async () => {
    // A newly attached monitor cannot see a list restored from page cache.
    // Refresh only when no list POST was observed; never replay a pending or
    // failed request, and only use the sibling control in the same segment.
    if ((await responses(liepinResumeResponses.contacts)).some((r: any) => r.method === 'POST')) return false
    const page = await snapshot(), received = receivedFilter(page)
    if (!received || !await selected(page, received)) return false
    const all = page.items.filter((r: any) => r.role === 'label' && visible(r) && !statesOf(r).includes('occluded')
      && liepinDefinition.communication!.filters!.all!.includes(normalized(r.name)))
    await broker.inspectRefs(page, [received.ref, ...all.map((r: any) => r.ref)], signal, true, true)
    const groupRef = (ref: string) => broker.getInspection(page, ref)?.ancestors?.find((n: any) =>
      String(n.attributes?.class ?? '').split(/\s+/).includes('ant-im-segmented-group'))?.ref
    const group = groupRef(received.ref), siblings = all.filter((r: any) => group && groupRef(r.ref) === group)
    if (siblings.length !== 1) return false
    await click(page, siblings[0].ref)
    await settle()
    const fresh = await snapshot(), control = fresh.items.find((r: any) => r.ref === siblings[0].ref && visible(r))
      ?? fresh.items.find((r: any) => r.role === 'label' && normalized(r.name) === normalized(siblings[0].name) && visible(r))
    return !fresh.dialogs?.length && !!control && await selected(fresh, control)
  }
  const receivedContacts = async () => {
    await settle()
    // Liepin can remount its initial chat view after the filter click and
    // reset it to “全部”. Reacquire the control and response baseline once;
    // neither the old response nor the click receipt proves selection.
    for (let attempt = 0; attempt < 2; attempt++) {
      let page: any, filter: any
      for (let i = 0; i < 30; i++) {
        page = await snapshot(); filter = receivedFilter(page)
        if (filter) break
        const covered = page.items.some((r: any) => r.role === 'label' && normalized(r.name) === receivedTab && statesOf(r).includes('occluded'))
        if (covered) await execute('browser_scroll', { tabId: tab.tabId, deltaY: -600 })
        else await delay(150, undefined, { signal })
      }
      if (!filter) throw new Error('未找到可操作的“沟通 → 有简历”，请在猎聘核对页面')
      let before = new Set<string>()
      if (!await selected(page, filter)) {
        before = await beforeResponses(liepinResumeResponses.contacts)
        await click(page, filter.ref)
      }
      await settle()
      let confirmed = false
      for (let i = 0; i < 10; i++) {
        page = await snapshot(); filter = receivedFilter(page)
        if (filter && await selected(page, filter)) { confirmed = true; break }
        if (page.dialogs?.length) break
        if (i < 9) await delay(150, undefined, { signal })
      }
      if (confirmed) {
        let response: any
        try { response = await readResponse(liepinResumeResponses.contacts, before) }
        catch (error) {
          if (attempt === 0 && !signal.aborted && String(error).includes('PLATFORM_RESUME_RESPONSE_MISSING') && await refreshCachedFilter()) continue
          throw error
        }
        const data = liepinContacts(response)
        page = await snapshot(); filter = receivedFilter(page)
        if (filter && await selected(page, filter)) return data
      }
      if (page.dialogs?.length) break
      await settle()
    }
    throw new Error('未能确认猎聘已切换到“有简历”，未更新候选人')
  }
  const contactNames = async (page: any, contacts: LiepinContact[]) => {
    const names = new Set(contacts.map(c => normalized(c.name)))
    const controls = page.items.filter((r: any) => r.role === 'span' && names.has(normalized(r.name)) && visible(r) && !r.dialogRef)
    await broker.inspectRefs(page, controls.map((r: any) => r.ref), signal, true, true)
    // Names also occur in the active chat header and message bodies. Only the
    // platform's actual contact-list rows can select a conversation.
    const rows = new Map<string, any>()
    for (const r of controls) {
      const detail = broker.getInspection(page, r.ref)
      const row = [detail?.element, ...(detail?.ancestors ?? [])].find(n => String(n?.attributes?.class ?? '').split(/\s+/).includes('im-ui-contact-list-item'))
      if (!row) continue
      const rowRef = row.ref ?? r.ref
      const text = normalized(page.items.find((n: any) => n.ref === rowRef)?.name || r.context?.text || r.name)
      const bounds = row.bounds ?? r.bounds
      const rowKey = JSON.stringify([r.name, text, bounds])
      if (!rows.has(rowRef)) rows.set(rowRef, { ...r, contactRowRef: rowRef, contactBounds: bounds, contactRowKey: rowKey })
    }
    return [...rows.values()]
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
  const skipUnavailableContact = async (page: any, contact: LiepinContact) => {
    const compact = (value: string) => normalized(value).replace(/\s/g, '')
    const message = compact(`用户“${contact.name}”的账号已经停用，该对话将被删除知道了`)
    const dialog = page.dialogs?.length === 1 && page.dialogs.find((d: any) => compact(d.text || d.name) === message)
    if (!dialog) return false
    const controls = page.items.filter((r: any) => r.dialogRef === dialog.ref && r.role === 'button' && normalized(r.name) === '知道了' && visible(r))
    if (controls.length !== 1) return false
    // This is the platform's notice for the exact contact just opened. It
    // supplies no new receipt or attachment; keep all existing local facts.
    await click(page, controls[0].ref)
    if ((await snapshot()).dialogs?.length) throw new Error('猎聘账号停用提示尚未关闭，已停止继续读取')
    unavailableContacts++
    return true
  }
  try {
    if (tab && platformPageNeedsLogin(tab)) assertPlatformPageLogin(tab, 'liepin', '同步平台简历')
    if (!tab) tab = { tabId: (await execute('browser_open_tab', { url: entry })).tabId }
    await execute('browser_network_requests', { tabId: tab.tabId })
    await execute('browser_navigate', { tabId: tab.tabId, url: entry })
    const contactData = await receivedContacts()
    let page: any
    const contacts = contactData.rows
    scanned = contacts.length
    for (const contact of contacts) for (const target of targets.filter(t => t.platformIdentity!.id === contact.resumeId)) {
      const key = candidateContactKeys(target)[0]!
      matched.add(key)
      if (await saveCandidateContact(store, target, { greeted: false, resumeReceived: true, source: 'chat' })) updated.add(key)
    }
    if (contactData.hasMore) markIncomplete('平台会话列表还有后续记录，尚未全部读取')
    const relevant = (c: LiepinContact) => targets.some(t => t.platformIdentity!.id === c.resumeId || normalized(t.name) === normalized(c.name))
    let previous = ''
    for (let screen = 0; screen < 20; screen++) {
      page = await snapshot()
      const listNames = await contactNames(page, contacts)
      const visibleContacts = contacts.filter(c => listNames.some((r: any) => normalized(r.name) === normalized(c.name)))
      const signature = listNames.map((r: any) => r.contactRowKey).join('|')
      if (!signature || signature === previous) {
        const remaining = contacts.filter(c => !visited.has(c.imId) && relevant(c))
        if (remaining.length) markIncomplete(`${remaining.length} 个关联会话尚未在列表中定位`)
        break
      }
      previous = signature
      for (const row of listNames) {
        const group = contacts.filter(c => normalized(c.name) === normalized(row.name))
        if (processedRows.has(row.contactRowKey) || group.every(c => visited.has(c.imId))) continue
        const possible = targets.filter(t => group.some(c => t.platformIdentity!.id === c.resumeId) || normalized(t.name) === normalized(row.name))
        if (!possible.length) continue
        processedRows.add(row.contactRowKey)
        let contact = group[0]!
        try {
          page = await snapshot()
          const names = await contactNames(page, group)
          const sameBounds = (a: any, b: any) => a && b && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(a[k]) && Math.abs(a[k] - b[k]) <= 2)
          const rebound = names.filter((n: any) => n.contactRowKey === row.contactRowKey || sameBounds(n.contactBounds, row.contactBounds))
          if (rebound.length !== 1) { markIncomplete('部分会话列表行在读取前已变化，未更新其状态'); continue }
          let before = await beforeResponses(liepinResumeResponses.messages); await click(page, rebound[0].ref)
          page = await snapshot()
          if (await skipUnavailableContact(page, contact)) {
            if (group.length === 1) visited.add(contact.imId)
            else markIncomplete('停用的同名会话未能唯一关联，原状态保留')
            continue
          }
          if (page.dialogs?.length) throw new Error('猎聘会话出现未处理提示，未继续读取该候选人')
          for (const fresh of await contactNames(page, group)) if (sameBounds(fresh.contactBounds, rebound[0].contactBounds)) processedRows.add(fresh.contactRowKey)
          // A name is only a navigation lead. For same-name contacts require
          // a fresh response and bind it by chat/user IDs before any update.
          const messages = await readResponse(liepinResumeResponses.messages, before,
            data => group.some(c => liepinConversation(data, c).chatMatched), group.length === 1)
          const identities = group.filter(c => liepinConversation(messages, c).chatMatched)
          if (identities.length !== 1) { markIncomplete('当前会话的聊天与用户身份未能唯一核验'); continue }
          contact = identities[0]!
          visited.add(contact.imId)
          const verified = possible.map(target => ({ target, conversation: liepinConversation(messages, contact, target.platformIdentity!.id) })).filter(r => r.conversation.resumeId)
          const target = verified[0]?.target, conversation = verified[0]?.conversation
          if (!target || !conversation) { unlinkedContacts++; continue }
          const key = candidateContactKeys(target)[0]!
          for (const { target: alias } of verified) {
            const identityKey = candidateContactKeys(alias)[0]!
            matched.add(identityKey)
            if (await saveCandidateContact(store, alias, { greeted: false, resumeReceived: true, source: 'chat' })) updated.add(identityKey)
          }
          if (!conversation.files.length) continue
          // Multiple message cards without DOM message IDs cannot safely be
          // paired to individual message versions. Preserve facts and skip them.
          if (conversation.files.length !== 1) { markIncomplete('部分会话有多份附件，未能逐份核验'); continue }
          const evidence = conversation.files[0]
          if (options.attachment && (options.attachment.conversationId !== evidence.conversationId
            || options.attachment.messageId !== evidence.messageId || options.attachment.attachmentId !== evidence.attachmentId)) continue
          for (let i = 0; i < 20; i++) {
            page = await snapshot()
            if (page.items.some((r: any) => r.role === 'div' && normalized(r.name) === '附件简历' && visible(r))) break
            await delay(100, undefined, { signal })
          }
          const cards = page.items.filter((r: any) => r.role === 'div' && normalized(r.name) === '附件简历' && visible(r))
          if (cards.length !== 1) { markIncomplete('部分会话的附件卡片未能唯一定位'); continue }
          before = await beforeResponses(liepinResumeResponses.attachment); await click(page, cards[0].ref)
          const address = liepinAttachmentAddress(await readResponse(liepinResumeResponses.attachment, before, undefined, false))
          let file: CapturedFile | undefined
          if (options.capture) {
            // Preview accessPath (download=0) is not a durable original-file URL.
            // Acquire the verified preview's original through the logged-in extension.
            page = await snapshot()
            const dialogs = page.dialogs?.filter((d: any) => normalized(d.text || d.name) === '附件预览') ?? []
            const links = page.items.filter((r: any) => r.role === 'link' && r.dialogRef === dialogs[0]?.ref && visible(r))
            if (dialogs.length !== 1 || links.length !== 1) throw new Error('附件预览下载入口已变化，未取得原始文件')
            const captured = await click(page, links[0].ref, true)
            if (!captured.complete || !captured.captureId) throw new Error('附件文件未完整取得，请重试下载')
            file = await readCapturedFile(captured.captureId, args => execute('artifact_read', args), signal)
          }
          for (const { target: alias } of verified) {
            const { record } = await saveReceivedResume(store, alias, { ...evidence, resumeId: alias.platformIdentity!.id, ...address })
            options.onAttachment?.(record, file ? { ...file, fileName: address.fileName } : undefined)
          }
          attachmentCount++; updated.add(key)
          if (options.capture) return { platform: 'liepin', matched: matched.size, updated: updated.size, scanned, unidentified,
            status: 'completed', detail: '已通过浏览器取得原始附件' }
          if (!await closePreview()) throw new Error('附件预览未能关闭，已停止继续读取')
        } catch (error) {
          if (isPlatformLoginRequired(error) || /UNKNOWN/.test(String(error)) || signal.aborted) throw error
          if (options.capture) throw error
          if (await skipUnavailableContact(await snapshot(), contact)) {
            if (group.length === 1) visited.add(contact.imId)
            else markIncomplete('停用的同名会话未能唯一关联，原状态保留')
            continue
          }
          incomplete = true; failedContacts++; failure ||= safeError(error)
          if (!await closePreview()) throw new Error('当前页面仍有未处理提示，已停止继续读取')
        }
      }
      if (contacts.every(c => visited.has(c.imId) || !relevant(c))) break
      page = await snapshot()
      const last = (await contactNames(page, visibleContacts)).at(-1)
      if (!last) { markIncomplete('会话列表滚动入口未能定位'); break }
      await execute('browser_scroll', { tabId: tab.tabId, snapshotId: page.snapshotId, ref: last.ref, deltaY: Math.floor((page.viewport?.height ?? 700) * .65) })
      if (screen === 19) markIncomplete('会话列表尚未全部读取，已达到本轮读取上限')
    }
  } catch (error) {
    if (options.capture || isPlatformLoginRequired(error) || /UNKNOWN/.test(String(error)) || signal.aborted || !matched.size) throw error
    incomplete = true; failure = safeError(error)
  }
  // Keep the final chat/filter state visible, including tabs opened by sync.
  // The workbench releases browser ownership separately in its own finally.
  return { platform: 'liepin', matched: matched.size, updated: updated.size, scanned, unidentified,
    status: incomplete ? 'partial' : 'completed',
    detail: `已读取“沟通 → 有简历”，已更新 ${attachmentCount} 份附件链接（文件按需获取）${unidentified ? `；已跳过 ${unidentified} 条缺少平台 ID 的历史记录，未关联、未改变其状态` : ''}${unlinkedContacts ? `；${unlinkedContacts} 个会话的简历 ID 缺失或与当前人选不符，已跳过、未更新其状态` : ''}${unavailableContacts ? `；已跳过 ${unavailableContacts} 位账号停用的候选人，已有简历保留` : ''}${incompleteReasons.size ? `；${[...incompleteReasons].join('；')}` : ''}${failedContacts ? `；${failedContacts} 位候选人读取失败，已继续核对其他人选` : ''}${failure ? `；${failure}` : ''}` }
}

export async function refreshLiepinAttachment(broker: AgentBrowserTools, candidate: SourcingCandidate, row: ReceivedResumeRecord, store: Store, signal: AbortSignal, capture = false) {
  let refreshed: ReceivedResumeRecord | undefined
  let file: CapturedFile | undefined
  await syncLiepinResumes(broker, [candidate], store, signal, { attachment: row, capture, onAttachment: (record, original) => {
    if (record.id === row.id) { refreshed = record; file = original }
  } })
  if (!refreshed) throw new Error('原附件未能重新定位，请确认平台登录、附件未撤回且仍有访问权限')
  if (capture) {
    if (!file) throw new Error('附件原始文件未完整取得，请重试下载')
    return { record: refreshed, file }
  }
  return refreshed
}
