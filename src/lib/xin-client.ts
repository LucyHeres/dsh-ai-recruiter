import { uploadCapturedFile, type CapturedFile } from './file-transfer.js'
// 薪人薪事业务请求使用灵听的 Cookie、UA、CSRF 与 OAuth 凭据组合。
// 薪招接口另外用系统会话换取专用 token，Authorization 发送原始 token。
// 凭据只从宿主 xrxsAuth 获取，仅保留在内存；禁止自动跟随重定向。
import { record } from './bridge.js'
import { RESUME_LIBRARIES, RESUME_LIBRARY_STATUSES } from '../shared/workbench.js'
import type { DeveloperLog } from './developer-log.js'
import { HttpLog } from './http-log.js'

/** 授权服务返回的会话和该公司授权时绑定的部署地址。UA 可以为空。 */
export interface XrxsSession { sessionId: string; ua: string; csrf: string; apiURL: string; systemURL: string }
export interface XrxsCredentials {
  accessToken: string; tokenType?: string; companyId?: string; accountId?: string
  apiURL: string; systemURL: string
}
export interface XrxsTarget { companyId: string }

/** 结构性契约：只需要这两个方法，避免把 xrxs-dsh-auth 变成硬依赖。 */
export interface XrxsAuthProvider {
  session(target?: XrxsTarget | AbortSignal, signal?: AbortSignal): Promise<XrxsSession>
  credentials(target?: XrxsTarget | AbortSignal, signal?: AbortSignal): Promise<XrxsCredentials>
}

export interface XinOperationField {
  kind: 'id' | 'int' | 'bool' | 'text' | 'json'
  required?: boolean
  maxLength?: number
  /** 允许的枚举值。 */
  enum?: readonly (string | number)[]
  optional?: boolean
  /** kind='json'：数组元素个数下限。 */
  minItems?: number
  /** kind='json'：数组元素个数上限。 */
  maxItems?: number
  /**
   * kind='json'：数组元素的字段白名单。
   *
   * 批量接口的元素是对象，只在整体上校验「是不是数组」不够——未声明的键会连同
   * 真实参数一起发给服务端，所以这里对每个元素逐字段复用同一套校验。
   */
  itemFields?: Record<string, XinOperationField>
}
export interface XinOperation {
  path: string
  method: 'GET' | 'POST'
  encoding: 'none' | 'form' | 'json'
  /** read 只查询；write 会创建或修改业务数据。 */
  kind: 'read' | 'write'
  fields: Record<string, XinOperationField>
  timeoutMs?: number
  /** session 使用宿主业务会话；extension 使用系统会话换取的薪招 token。 */
  auth?: 'extension' | 'session'
  /**
   * 覆盖发送域名（绝对 origin），仅用于**已确认与业务系统域名不同**的接口。
   *
   * 默认目的地是授权返回的 systemURL，凭据只对签发它们的部署有效，因此这里
   * 是一个显式例外：一旦设置，该操作就不再发送到 systemURL，而是发送到这里。
   */
  host?: string
}

const id = (required = true): XinOperationField => ({ kind: 'id', required })
const text = (maxLength = 2000, required = false): XinOperationField => ({ kind: 'text', required, maxLength })
const int = (required = false, enumValues?: readonly number[]): XinOperationField => ({ kind: 'int', required, ...(enumValues ? { enum: enumValues } : {}) })
const bool = (): XinOperationField => ({ kind: 'bool' })

/**
 * 允许调用的招聘业务操作目录。
 *
 * 这是一份**白名单**：不在表内的路径不会被发出。字段类型和长度在校验阶段拒绝，
 * 不把未声明的参数透传给服务端。
 */
export const XIN_OPERATIONS = {
  /** 与灵听相同的业务登录态检查；不以 HTTP 200 代替业务成功。 */
  predata: { path: '/support/service/storm/ajax-get-predata-v2', method: 'GET', encoding: 'none', kind: 'read', auth: 'session', fields: {} },
  /** 取得文件服务上传地址（返回纯字符串 URL，不是对象）。 */
  getUploadUrl: { path: '/recruitment/service/ajax-register-get-upload-url', method: 'GET', encoding: 'none', kind: 'read', auth: 'session', fields: {} },
  channelList: { path: '/recruitment/service/ajax-get-channel-list-setting', method: 'GET', encoding: 'none', kind: 'read', auth: 'session', fields: { status: int(true, [0, 1]) } },
  /** 薪招取职位/公司初始数据。 */
  extensionInit: { path: '/recruitment/service/ajax-extension-get-init', method: 'GET', encoding: 'none', kind: 'read', auth: 'extension', fields: {} },
  destinationLabels: { path: '/recruitment/service/ajax-extension-get-label-list', method: 'GET', encoding: 'none', kind: 'read', auth: 'extension', fields: {} },
  /** 系统职位管理列表；CLI 文档的 pageNum/pageSize 在原接口中对应 p/pn。 */
  jobList: { path: '/recruitment/service/ajax-get-new-job-list', method: 'POST', encoding: 'form', kind: 'read', auth: 'session', fields: { p: int(true), pn: int(true), hireStatus: int(true, [0, 1, 2, 3, 4]), keyword: text(200) } },
  jobDetail: { path: '/recruitment/service/ajax-get-job-detail', method: 'POST', encoding: 'form', kind: 'read', auth: 'session', fields: { jobId: id() } },
  jobAds: { path: '/recruitment/service/ajax-list-job-ad', method: 'GET', encoding: 'none', kind: 'read', auth: 'session', fields: { jobId: id(), channelType: int(true, [4, 11]) } },
  /** 按手机号/邮箱查重。注意：该接口不接受 fileKey。 */
  checkSimilar: {
    path: '/recruitment/service/ajax-extension-check-similar-resume', method: 'POST', encoding: 'form', kind: 'read', auth: 'extension',
    fields: { mobile: text(32), email: text(128), name: text(64), sex: int(), resumeId: text(64) },
  },
  /** 解析薪招简历。resumeBodyType：0=HTML 正文，2=文件 Key，3=附件下载地址。 */
  parseResume: {
    path: '/recruitment/service/ajax-extension-upload-resume', method: 'POST', encoding: 'form', kind: 'write', auth: 'extension', timeoutMs: 45_000,
    fields: {
      resumeBody: text(200_000, true), resumeBodyType: int(true, [0, 1, 2, 3]),
      channelType: int(true), deliveryType: int(true, [0, 1]), pageUrl: text(2000),
    },
  },
  /** 保存已解析的薪招简历。 */
  saveResume: {
    path: '/recruitment/service/ajax-extension-save-resume', method: 'POST', encoding: 'form', kind: 'write', auth: 'extension', timeoutMs: 45_000,
    fields: {
      resumeId: text(64), name: text(64), mobile: text(32), email: text(128), gender: int(), workYear: int(),
      positionName: text(200), eduGrade: int(), taskId: text(64), type: int(), channelType: int(),
      exists: bool(), resumeBody: text(200_000), pageUrl: text(2000), resumeType: int(), typeStatus: int(),
      resumeBodyType: int(false, [0, 1, 2, 3]),
    },
  },
  /** 主系统预上传：解析并返回临时 resumeId；此时尚未最终入库。 */
  preuploadResume: {
    path: '/recruitment/service/ajax-add-preupload-resume', method: 'POST', encoding: 'form', kind: 'write', auth: 'session', timeoutMs: 120_000,
    fields: { fileKey: text(200_000, true) },
  },
  /** 主系统提交上传：resumeFileKeys 是表单内的 JSON 字符串，标识来自预上传回执。 */
  submitUploadResume: {
    path: '/recruitment/service/ajax-submit-upload-resume', method: 'POST', encoding: 'form', kind: 'write', auth: 'session', timeoutMs: 120_000,
    fields: {
      jobId: id(), channelType: int(true), deliveryType: int(true, [0, 1]),
      resumeLibrary: int(true), resumeLibraryStatus: int(true),
      recommenderId: id(false), headhunterSupplierId: id(false),
      resumeFileKeys: {
        kind: 'json', required: true, minItems: 1, maxItems: 10, maxLength: 40_000,
        itemFields: { fileKey: text(200_000, true), resumeId: id() },
      },
    },
  },
} as const satisfies Record<string, XinOperation>

export type XinOperationName = keyof typeof XIN_OPERATIONS

/** 简历上传的来源渠道；与 web 端上传页「来源渠道」一致。 */
export const UPLOAD_CHANNEL_TYPES = {
  /** 默认渠道，不需要额外身份字段。 */
  default: 0,
  /** 内推，必须同时提供 recommenderId。 */
  referral: 20,
  /** 猎头，必须同时提供 headhunterSupplierId。 */
  headhunter: 34,
} as const

/** 投递类型；不传时服务端按被动投递处理。 */
export const DELIVERY_TYPES = { active: 0, passive: 1 } as const

export type UploadChannelType = (typeof UPLOAD_CHANNEL_TYPES)[keyof typeof UPLOAD_CHANNEL_TYPES]

/**
 * 来源渠道与上传位置的组合约束。
 *
 * 单字段校验（`checkFields`）看不出字段之间的关系，但服务端对这两组有硬性要求：
 * 内推必须带内推人、猎头必须带供应商、非内推/猎头渠道不接受这两个身份字段；
 * 大库只允许 1（此时小状态是 10/11）或 4（此时小状态是人才库分类 ID）。
 * 这里在发出请求前拦下，避免把必然被拒或归属错误的简历提交上去。
 */
export function checkUploadResumes(items: unknown): XinFailure | null {
  if (!Array.isArray(items)) return null
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!record(item)) continue
    const channelType = Number(item.channelType)
    const recommenderId = typeof item.recommenderId === 'string' ? item.recommenderId : ''
    const supplierId = typeof item.headhunterSupplierId === 'string' ? item.headhunterSupplierId : ''
    if (channelType === UPLOAD_CHANNEL_TYPES.referral && !recommenderId) {
      return { code: 'MISSING_PARAM', message: `files[${index}].recommenderId：内推渠道（20）必须提供内推人员工ID`, outcome: 'not-sent' }
    }
    if (channelType === UPLOAD_CHANNEL_TYPES.headhunter && !supplierId) {
      return { code: 'MISSING_PARAM', message: `files[${index}].headhunterSupplierId：猎头渠道（34）必须提供猎头供应商ID`, outcome: 'not-sent' }
    }
    if (channelType !== UPLOAD_CHANNEL_TYPES.referral && recommenderId) {
      return { code: 'INVALID_PARAM', message: `files[${index}].recommenderId：仅内推渠道（20）可传内推人员工ID`, outcome: 'not-sent' }
    }
    if (channelType !== UPLOAD_CHANNEL_TYPES.headhunter && supplierId) {
      return { code: 'INVALID_PARAM', message: `files[${index}].headhunterSupplierId：仅猎头渠道（34）可传猎头供应商ID`, outcome: 'not-sent' }
    }
    const library = Number(item.resumeLibrary)
    const status = Number(item.resumeLibraryStatus)
    if (library === RESUME_LIBRARIES.newResume && ![RESUME_LIBRARY_STATUSES.pending, RESUME_LIBRARY_STATUSES.undetermined].includes(status as 10 | 11)) {
      return { code: 'INVALID_PARAM', message: `files[${index}].resumeLibraryStatus：新简历（1）只能是 10 未处理或 11 待定`, outcome: 'not-sent' }
    }
    if (![RESUME_LIBRARIES.newResume, RESUME_LIBRARIES.talentBank].includes(library as 1 | 4)) {
      return { code: 'INVALID_PARAM', message: `files[${index}].resumeLibrary：只支持 1 新简历或 4 人才库`, outcome: 'not-sent' }
    }
  }
  return null
}

export interface XinFailure { code: string; message: string; outcome: 'not-sent' | 'rejected' | 'unknown' }
export type XinResult<T = any> = { ok: true; data: T } | { ok: false; failure: XinFailure }

/** 系统业务接口使用 message，API 网关也可能返回 msg；空白和非字符串不作为错误说明。 */
function businessMessage(value: unknown): string {
  if (!record(value)) return ''
  for (const key of ['message', 'msg']) {
    const message = value[key]
    if (typeof message === 'string' && message.trim()) return message
  }
  return ''
}

/** 业务返回码 → 可操作的失败语义。 */
function classifyCode(code: unknown, message: string): XinFailure {
  switch (Number(code)) {
    case 401: return { code: 'UNAUTHENTICATED', message: message || '未登录或登录已过期', outcome: 'rejected' }
    case 403: return { code: 'FORBIDDEN', message: message || '当前账号没有接口权限', outcome: 'rejected' }
    case 318241003: return { code: 'EXTENSION_AUTH_REQUIRED', message: '薪招登录态已失效，请重新发起检查；已发出的写请求不会自动重放', outcome: 'rejected' }
    case 2006: return { code: 'SESSION_INVALID', message: message || '会话已失效，请重新授权', outcome: 'rejected' }
    case 5001: return { code: 'UNAUTHENTICATED', message: message || '未登录或客户端特征不符', outcome: 'rejected' }
    case 2077: return { code: 'CSRF_REJECTED', message: message || 'CSRF 校验失败，请重新授权后再试', outcome: 'rejected' }
    default: return { code: 'UPSTREAM_REJECTED', message: message || '业务接口返回失败', outcome: 'rejected' }
  }
}

/**
 * 单个值的白名单校验。
 *
 * `json` 用于批量接口的对象数组：既限制元素个数，也逐字段校验元素内容，
 * 未声明的键一律拒绝，不把调用方的多余参数透传给服务端。
 */
function checkValue(name: string, field: XinOperationField, value: unknown): XinFailure | null {
  if (field.kind === 'int') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return { code: 'INVALID_PARAM', message: `${name} 必须是整数`, outcome: 'not-sent' }
    if (field.enum && !field.enum.includes(value)) return { code: 'INVALID_PARAM', message: `${name} 只能是 ${field.enum.join('/')}`, outcome: 'not-sent' }
    return null
  }
  if (field.kind === 'bool') {
    if (typeof value !== 'boolean') return { code: 'INVALID_PARAM', message: `${name} 必须是布尔值`, outcome: 'not-sent' }
    return null
  }
  if (field.kind === 'json') {
    if (!Array.isArray(value)) return { code: 'INVALID_PARAM', message: `${name} 必须是数组`, outcome: 'not-sent' }
    if (field.minItems !== undefined && value.length < field.minItems) return { code: 'INVALID_PARAM', message: `${name} 至少 ${field.minItems} 项`, outcome: 'not-sent' }
    if (field.maxItems !== undefined && value.length > field.maxItems) return { code: 'INVALID_PARAM', message: `${name} 最多 ${field.maxItems} 项`, outcome: 'not-sent' }
    if (field.itemFields) {
      for (let index = 0; index < value.length; index += 1) {
        const item = value[index]
        if (!item || typeof item !== 'object' || Array.isArray(item)) return { code: 'INVALID_PARAM', message: `${name}[${index}] 必须是对象`, outcome: 'not-sent' }
        for (const key of Object.keys(item as Record<string, unknown>)) {
          if (!(key in field.itemFields)) return { code: 'UNKNOWN_PARAM', message: `参数 ${name}[${index}].${key} 不在允许列表内`, outcome: 'not-sent' }
        }
        for (const [key, sub] of Object.entries(field.itemFields)) {
          const nested = (item as Record<string, unknown>)[key]
          if (nested === undefined || nested === null || nested === '') {
            if (sub.required) return { code: 'MISSING_PARAM', message: `缺少必填参数 ${name}[${index}].${key}`, outcome: 'not-sent' }
            continue
          }
          const invalid = checkValue(`${name}[${index}].${key}`, sub, nested)
          if (invalid) return invalid
        }
      }
    }
    if (field.maxLength) {
      let size = 0
      try { size = JSON.stringify(value).length } catch { return { code: 'INVALID_PARAM', message: `${name} 无法序列化`, outcome: 'not-sent' } }
      if (size > field.maxLength) return { code: 'INVALID_PARAM', message: `${name} 超过 ${field.maxLength} 字符`, outcome: 'not-sent' }
    }
    return null
  }
  if (typeof value !== 'string') return { code: 'INVALID_PARAM', message: `${name} 必须是字符串`, outcome: 'not-sent' }
  if (field.kind === 'id' && !/^[A-Za-z0-9_-]{1,64}$/.test(value)) return { code: 'INVALID_PARAM', message: `${name} 格式非法`, outcome: 'not-sent' }
  if (field.maxLength && value.length > field.maxLength) return { code: 'INVALID_PARAM', message: `${name} 超过 ${field.maxLength} 字符`, outcome: 'not-sent' }
  return null
}

function checkFields(spec: XinOperation, params: Record<string, unknown>): XinFailure | null {
  for (const key of Object.keys(params)) {
    if (!(key in spec.fields)) return { code: 'UNKNOWN_PARAM', message: `参数 ${key} 不在 ${spec.path} 的允许列表内`, outcome: 'not-sent' }
  }
  for (const [key, field] of Object.entries(spec.fields)) {
    const value = params[key]
    if (value === undefined || value === null || value === '') {
      if (field.required) return { code: 'MISSING_PARAM', message: `缺少必填参数 ${key}`, outcome: 'not-sent' }
      continue
    }
    const invalid = checkValue(key, field, value)
    if (invalid) return invalid
  }
  return null
}

/** 把业务错误转成模型可读的一句话，不泄露任何凭据。 */
export function describeFailure(failure: XinFailure): string {
  return `${failure.code}: ${failure.message}`
}

export type XinFetch = (input: string, init: RequestInit) => Promise<Response>

export interface XinClientOptions {
  /** 同一插件生命周期共享换票结果，避免每个工具调用撤销前一个薪招 token。 */
  extensionTokens?: ExtensionTokenCache
  logger?: DeveloperLog
}

/** 薪招换票按公司、账号与部署隔离；并发请求共享一次换票，失败不缓存。 */
export class ExtensionTokenCache {
  private readonly entries = new Map<string, Promise<string>>()
  get(identity: string, create: () => Promise<string>): Promise<string> {
    const existing = this.entries.get(identity)
    if (existing) return existing
    const pending = create().catch(error => {
      if (this.entries.get(identity) === pending) this.entries.delete(identity)
      throw error
    })
    this.entries.set(identity, pending)
    return pending
  }
  invalidate(identity: string): void { this.entries.delete(identity) }
  clear(): void { this.entries.clear() }
}

class AuthFailure extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export class XinClient {
  private boundIdentity?: string
  private readonly extensionTokens: ExtensionTokenCache

  constructor(
    private readonly auth: XrxsAuthProvider,
    private readonly systemUrl: string,
    /** 测试替身；生产恒为 globalThis.fetch。 */
    private readonly fetchImpl: XinFetch = (input, init) => fetch(input, init),
    private readonly options: XinClientOptions = {},
  ) {
    this.extensionTokens = options.extensionTokens ?? new ExtensionTokenCache()
  }

  /**
   * 默认发往授权返回的 systemURL；操作显式声明 `host` 时改发该域名。
   *
   * 凭据只对签发它们的那套部署有效，所以 systemURL 仍是默认且必须与授权一致。
   * `host` 是白名单目录里的**显式例外**，只给已确认另部署域名的接口使用；它绕过
   * systemURL 校验是有意的，但不会影响其它操作。
   */
  private originFor(spec: XinOperation, session: XrxsSession): string {
    if (spec.host) return this.normalize(spec.host, `${spec.path} 的 host 覆盖`)
    const origin = this.normalize(session.systemURL, '授权服务 systemURL')
    if (this.systemUrl && this.normalize(this.systemUrl, 'systemUrl') !== origin) {
      throw new AuthFailure('DESTINATION_MISMATCH', 'systemUrl 与当前公司授权的业务域名不一致；请清空覆盖值或使用授权服务返回的地址')
    }
    return origin
  }

  private normalize(value: string, label: string): string {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`${label} 必须是 http(s)`)
    if (parsed.username || parsed.password || parsed.hash || parsed.search || parsed.pathname !== '/') throw new Error(`${label} 必须是无路径、查询串或凭据的业务 origin`)
    return value.replace(/\/+$/, '')
  }

  /** 绑定当前公司与部署，再按接口类型取得业务会话或薪招 token。 */
  private async authContext(spec: XinOperation, signal: AbortSignal): Promise<{ origin: string; headers: Record<string, string>; secrets: string[] }> {
    signal.throwIfAborted()
    const credentials = await this.auth.credentials(signal)
    if (!credentials.accessToken || !credentials.companyId) throw new AuthFailure('IDENTITY_UNAVAILABLE', '授权服务未返回访问令牌或公司身份，请先完成薪人薪事授权')
    const identity = JSON.stringify([credentials.companyId, credentials.accountId, credentials.apiURL, credentials.systemURL])
    if (this.boundIdentity && this.boundIdentity !== identity) throw new AuthFailure('CONTEXT_CHANGED', '当前公司或授权环境已切换，本次任务已停止，请核对后重新发起')
    const session = await this.auth.session({ companyId: credentials.companyId }, signal)
    signal.throwIfAborted()
    if (!session.sessionId || !session.csrf) throw new AuthFailure('SESSION_INVALID', '授权服务未提供完整业务会话，请重新授权')
    if (session.apiURL !== credentials.apiURL || session.systemURL !== credentials.systemURL) throw new AuthFailure('CONTEXT_CHANGED', '访问令牌和业务会话所属环境不一致，请重新检查授权')
    const origin = this.originFor(spec, session)
    this.boundIdentity = identity
    const context = {
      origin,
      secrets: [credentials.accessToken, session.sessionId, session.csrf],
      headers: {
        authorization: `${credentials.tokenType || 'Bearer'} ${credentials.accessToken}`,
        'xrxs-language': 'zh',
        cookie: `QJYDSID=${session.sessionId}; WAVESSID=${session.sessionId}`,
        'user-agent': session.ua,
        'x-csrf-token': session.csrf,
      },
    }
    if (spec.auth === 'extension') {
      const token = await this.extensionTokens.get(identity, async () => {
        // pc 是薪招桌面登录槽，与浏览器扩展的 browser 登录槽分开。
        const exchangeUrl = `${origin}/recruitment/service/ajax-get-extension-login-token?type=pc`
        const exchangeInit: RequestInit = {
          method: 'GET', headers: { ...context.headers }, redirect: 'manual', signal,
        }
        const http = new HttpLog(this.options.logger, exchangeUrl, exchangeInit, { operation: 'extensionTokenExchange', authMode: 'session' }, context.secrets)
        let response: Response
        try { response = await this.fetchImpl(exchangeUrl, exchangeInit) }
        catch (error) { http.failed(error, 'request'); throw error }
        let text = ''
        let bodyComplete = true
        try { text = await response.text() }
        catch (error) {
          bodyComplete = false
          http.failed(error, 'response-body')
          if (response.ok) { http.response(response, '', false); throw error }
        }
        http.response(response, text, bodyComplete)
        if (!response.ok) throw new AuthFailure('EXTENSION_EXCHANGE_FAILED', `薪招换票失败（HTTP ${response.status}），请检查当前公司招聘权限`)
        let body: unknown
        try { body = JSON.parse(text) } catch (error) { throw new AuthFailure('EXTENSION_EXCHANGE_FAILED', '薪招换票未返回可解析的业务响应') }
        if (!record(body) || body.status !== true) {
          const failure = classifyCode(record(body) ? body.code : undefined, '')
          throw new AuthFailure(failure.code, '薪招换票被拒绝，请检查当前公司登录状态及招聘模块权限')
        }
        if (!record(body.data) || typeof body.data.token !== 'string' || !body.data.token || !Array.isArray(body.data.companyList)
          || !body.data.companyList.some((company: unknown) => record(company) && company.selected === 1)) {
          throw new AuthFailure('EXTENSION_EXCHANGE_INVALID', '薪招换票未返回 token 或当前公司的招聘权限，请检查授权公司')
        }
        return body.data.token
      })
      signal.throwIfAborted()
      context.headers.authorization = token
      context.secrets.push(token)
    }
    return context
  }

  /**
   * 调用一个白名单内的业务操作。
   *
   * 网络层失败返回 `outcome:'unknown'` —— 调用方不得重放写操作，必须先对账。
   */
  async call(name: XinOperationName, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<XinResult> {
    const invoke = () => this.execute(name, params, signal)
    const spec: XinOperation = XIN_OPERATIONS[name]
    return this.options.logger ? this.options.logger.trace('xrxs.call', {
      operation: name, method: spec.method, path: spec.path, authMode: spec.auth,
    }, invoke, result => result.ok ? { outcome: 'succeeded' } : { outcome: result.failure.outcome, errorCode: result.failure.code }) : invoke()
  }
  private async execute(name: XinOperationName, params: Record<string, unknown>, signal?: AbortSignal): Promise<XinResult> {
    const spec: XinOperation = XIN_OPERATIONS[name]
    const invalid = checkFields(spec, params) ?? (name === 'submitUploadResume' ? checkUploadResumes([params]) : null)
    if (invalid) return { ok: false, failure: invalid }
    const timeout = AbortSignal.timeout(spec.timeoutMs ?? 20_000)
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout
    let url: string
    let headers: Record<string, string>
    let secrets: string[]
    try {
      const context = await this.authContext(spec, composed)
      this.options.logger?.write('debug', 'xrxs.auth_ready', { operation: name, authMode: spec.auth })
      secrets = context.secrets
      const parts: string[] = []
      if (spec.encoding === 'none' && Object.keys(params).length) {
        parts.push(new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString())
      }
      url = `${context.origin}${spec.path}${parts.length ? `?${parts.join('&')}` : ''}`
      const contentType = spec.encoding === 'form' ? 'application/x-www-form-urlencoded;charset=UTF-8'
        : spec.encoding === 'json' ? 'application/json;charset=UTF-8'
          : undefined
      headers = contentType ? { ...context.headers, 'content-type': contentType } : context.headers
    } catch (error) {
      if (composed.aborted) return { ok: false, failure: { code: signal?.aborted ? 'CANCELLED' : 'AUTH_TIMEOUT', message: '获取登录态已取消或超时，业务请求未发出', outcome: 'not-sent' } }
      const code = error instanceof AuthFailure ? error.code : record(error) && typeof error.code === 'string' ? error.code : 'AUTH_UNAVAILABLE'
      return { ok: false, failure: { code, message: error instanceof AuthFailure ? error.message : '薪人薪事授权服务未提供可用登录态，请在授权面板检查当前公司及授权状态', outcome: 'not-sent' } }
    }
    const redact = (text: string) => secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), text).slice(0, 120)
    const init: RequestInit = {
      method: spec.method, headers,
      ...(spec.method === 'POST' && spec.encoding === 'form'
        ? { body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, spec.fields[k]?.kind === 'json' ? JSON.stringify(v) : String(v)])).toString() }
        : spec.method === 'POST' && spec.encoding === 'json' ? { body: JSON.stringify(params) } : {}),
      redirect: 'manual', signal: composed,
    }
    const http = new HttpLog(this.options.logger, url, init, { operation: name, authMode: spec.auth }, secrets)
    let response: Response
    try {
      response = await this.fetchImpl(url, init)
    } catch (error) {
      http.failed(error, 'request')
      const aborted = signal?.aborted === true
      return { ok: false, failure: { code: aborted ? 'CANCELLED' : 'TRANSFER_UNKNOWN', message: aborted ? '请求发出后被取消，结果需核对' : '请求未取得响应，结果需核对', outcome: 'unknown' } }
    }
    this.options.logger?.write(response.ok ? 'debug' : 'warn', 'xrxs.http_response', { operation: name, httpStatus: response.status })
    let text = ''
    let bodyComplete = true
    try { text = await response.text() }
    catch (error) {
      bodyComplete = false
      http.failed(error, 'response-body')
    }
    http.response(response, text, bodyComplete)
    if (!bodyComplete && response.ok) return { ok: false, failure: { code: 'UNREADABLE', message: '服务端响应读取失败，结果需核对', outcome: 'unknown' } }
    if (response.status >= 300 && response.status < 400) {
      // 只报目的地的 host+path，丢掉 query 与 hash——重定向地址常带凭据，不能进日志。
      let where = ''
      const location = response.headers.get('location')
      if (location) {
        try { const target = new URL(location, url); where = ` → ${target.host}${target.pathname}` } catch { where = '' }
      }
      const missing = where.includes('/static/html/sso404.page')
      return { ok: false, failure: { code: missing ? 'ENDPOINT_UNAVAILABLE' : 'REDIRECT_REJECTED', message: missing ? '当前环境未提供该招聘接口，请确认后端部署；有效授权不能修复缺失的接口' : `服务端要求重定向${redact(where)}（已拒绝跟随）`, outcome: 'rejected' } }
    }
    if (!response.ok) {
      // 5xx 可能已经落到服务端；按未知处理，读操作可安全重试、写操作必须先对账。
      const outcome = response.status >= 500 ? 'unknown' : 'rejected'
      // 兼容服务端的 message / msg 字段（最多 120 字），便于区分「令牌不对」和「参数不对」；
      // 不回显整个响应体，避免把服务端回显的凭据写进日志。
      let detail = ''
      try {
        const parsed = JSON.parse(text.slice(0, 2000))
        const message = businessMessage(parsed)
        if (message) detail = `：${redact(message)}`
      } catch { /* 非 JSON 响应就不带细节 */ }
      return { ok: false, failure: { code: response.status === 401 ? 'UNAUTHENTICATED' : `HTTP_${response.status}`, message: `服务端返回 ${response.status}${detail}`, outcome } }
    }
    let parsed: any
    try { parsed = JSON.parse(text) } catch {
      return { ok: false, failure: { code: 'UNREADABLE', message: '服务端返回了无法解析的内容', outcome: 'unknown' } }
    }
    this.options.logger?.write(parsed?.status === true ? 'debug' : 'warn', 'xrxs.business_result', {
      operation: name, accepted: parsed?.status === true,
      businessCode: typeof parsed?.code === 'number' || /^\d{1,12}$/.test(String(parsed?.code)) ? Number(parsed.code) : undefined,
    })
    if (parsed?.status !== true) {
      if (spec.auth === 'extension' && Number(parsed?.code) === 318241003 && this.boundIdentity) this.extensionTokens.invalidate(this.boundIdentity)
      return { ok: false, failure: classifyCode(parsed?.code, redact(businessMessage(parsed))) }
    }
    return { ok: true, data: parsed.data }
  }

  /**
   * 取得上传地址。
   *
   * 招聘侧该接口的 `data` 是**纯字符串 URL**（与主站 `/site/ajax-get-upload-url`
   * 返回 `data.url` 不同），两种形态都兼容，避免因部署差异取不到地址。
   */
  async uploadUrl(signal?: AbortSignal): Promise<XinResult<string>> {
    const result = await this.call('getUploadUrl', {}, signal)
    if (!result.ok) return result
    const raw = result.data
    const url = typeof raw === 'string' ? raw : record(raw) && typeof (raw as any).url === 'string' ? (raw as any).url : ''
    if (!url || !/^https:\/\//i.test(url)) {
      return { ok: false, failure: { code: 'UPLOAD_URL_INVALID', message: '上传地址不是 https 字符串', outcome: 'rejected' } }
    }
    return { ok: true, data: url }
  }

  async uploadFile(url: string, file: CapturedFile, signal?: AbortSignal, extraOrigins: string[] = []) {
    const upload = () => uploadCapturedFile(url, file, this.fetchImpl, signal, extraOrigins, this.options.logger)
    return this.options.logger ? this.options.logger.trace('file.upload', { bytes: file.blob.size }, upload, () => ({ outcome: 'succeeded' })) : upload()
  }

  /** 检查业务登录、薪招换票与初始化、上传地址；不写入简历，不返回任何凭据。 */
  async checkAuth(signal?: AbortSignal) {
    const login = await this.call('predata', {}, signal)
    const check = (result: XinResult) => result.ok ? { ok: true } : { ok: false, ...result.failure }
    if (!login.ok) return { authenticated: false, checks: { login: check(login) } }
    const upload = await this.uploadUrl(signal)
    const recruitment = await this.call('extensionInit', {}, signal)
    return { authenticated: true, recruitmentReady: recruitment.ok && upload.ok, checks: { login: check(login), upload: check(upload), recruitment: check(recruitment) } }
  }
}
