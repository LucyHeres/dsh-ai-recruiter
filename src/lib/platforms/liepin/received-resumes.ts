/** DTOs observed through the chat UI. No private endpoint is called here. */
export const liepinResumeResponses = {
  contacts: '/api/com.liepin.im.b.contact.filter-contacts-v1',
  messages: '/api/com.liepin.im.b.chat.chat-list',
  attachment: '/api/com.liepin.zhuque.resumeview.get-resume-attachment',
} as const
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{4,180}$/.test(v)
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v) ? v : undefined
const json = (v: any) => { try { return typeof v === 'string' && v.length <= 100000 ? object(JSON.parse(v)) : object(v) } catch { return } }
const business = (payload: unknown) => {
  const ext = json(payload)?.ext
  return ext?.extType === 203 && object(ext.extBody) ? ext.extBody : undefined
}
function resumeIdentity(payload: unknown, userId: string) {
  const body = business(payload), data = object(body?.bizData)
  const online = json(data?.onlineResume?.param)
  const value = body?.bizType === '7' && online?.userId === userId ? online?.encodeResId
    : body?.bizType === '2' && data?.resumeInfo?.userId === userId ? data?.resumeInfo?.resumeId : undefined
  return id(value) ? value : undefined
}
export interface LiepinContact {
  userId: string; imId: string; ownImId: string; name: string; resumeId?: string
  payload: string; messageId?: string; receivedAt?: string; incoming: boolean; revoked: boolean
}
const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 8640000000000000 ? new Date(value).toISOString() : undefined
export function liepinContacts(response: any): { rows: LiepinContact[]; hasMore: boolean } {
  if (response?.flag !== 1 || !Array.isArray(response.data?.list)) throw new Error('LIEPIN_CONTACT_RESPONSE_CHANGED: 会话列表结构已变化')
  const rows: LiepinContact[] = response.data.list.slice(0, 500).flatMap((r: any) => {
    if (!id(r.oppositeUserId) || !id(r.oppositeImId) || !id(r.imId) || r.oppositeImUserType !== '0' || typeof r.name !== 'string') return []
    return [{ userId: r.oppositeUserId, imId: r.oppositeImId, ownImId: r.imId, name: r.name.slice(0, 100),
      resumeId: resumeIdentity(r.lastPayload, r.oppositeUserId), payload: r.lastPayload, messageId: id(r.latestMsgId) ? r.latestMsgId : undefined,
      receivedAt: time(r.latestMsgTime), incoming: r.latestMsgSendImId === r.oppositeImId, revoked: r.latestMsgIsRevoke === true }]
  })
  return { rows, hasMore: response.data.hasMore === true }
}
export interface LiepinReceivedFile { resumeId: string; conversationId: string; messageId: string; attachmentId: string; receivedAt?: string }
/** Every attachment is bound to an incoming, unretracted message in the exact
 * conversation and to the resume key already verified in that conversation. */
export function liepinConversation(response: any, contact: LiepinContact, expectedResumeId?: string) {
  if (response?.flag !== 1 || !Array.isArray(response.data?.list)) throw new Error('LIEPIN_CHAT_RESPONSE_CHANGED: 聊天记录结构已变化')
  const messages = response.data.list.filter((r: any) => r.oppositeImId === contact.imId && r.imId === contact.ownImId
    && r.oppositeUserId === contact.userId && r.oppositeImUserType === '0' && !r.revokeFlag)
  const identities = new Set([contact.resumeId, ...messages.map((r: any) => resumeIdentity(r.payload, contact.userId))].filter(Boolean) as string[])
  // The platform can return different encoded resume aliases in older job
  // cards and newer shared resumes. They are linked only by the same actual
  // chat/user IDs; the requested candidate ID must occur in that evidence.
  const resumeId = expectedResumeId ? identities.has(expectedResumeId) ? expectedResumeId : undefined
    : contact.resumeId ?? (identities.size === 1 ? [...identities][0] : undefined)
  if (!resumeId || !messages.length) return { resumeId: undefined, files: [] as LiepinReceivedFile[] }
  const files: LiepinReceivedFile[] = []
  for (const r of messages) {
    const body = business(r.payload), data = object(body?.bizData), param = json(data?.attachmentResume?.param)
    if (r.msgSendImId !== contact.imId || body?.bizType !== '7' || data?.revokeFlag || !id(r.msgId)
      || !id(param?.encodeAttachmentId) || param?.userId !== contact.userId) continue
    files.push({ resumeId, conversationId: contact.imId, messageId: r.msgId, attachmentId: param.encodeAttachmentId, receivedAt: time(r.msgTime) })
  }
  return { resumeId, files }
}
export function liepinAttachmentAddress(response: any) {
  const data = response?.flag === 1 ? response.data : undefined
  if (!data || typeof data.fileName !== 'string' || !data.fileName.trim() || typeof data.accessPath !== 'string') throw new Error('LIEPIN_ATTACHMENT_RESPONSE_CHANGED')
  const url = new URL(data.accessPath)
  if (url.origin !== 'https://tdoss.liepin.com' || url.username || url.password || !url.pathname.startsWith('/o/recruit-auth/resume/attachment-res/')) throw new Error('LIEPIN_ATTACHMENT_ADDRESS_INVALID')
  const extension = String(data.fileExtension).replace(/^\./, '').toLowerCase()
  if (!['pdf', 'doc', 'docx'].includes(extension)) throw new Error('LIEPIN_ATTACHMENT_FORMAT_UNSUPPORTED')
  const fileName = data.fileName.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 150)
  return { downloadUrl: url.href, fileName: new RegExp(`\\.${extension}$`, 'i').test(fileName) ? fileName : `${fileName}.${extension}` }
}
