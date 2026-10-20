import { readCapturedFile } from './file-transfer.js'
// 招聘助手编排：搜索/筛选 → 采集 → 入库。
//
// 分工（与薪招的既有契约对齐）：
//  - 扩展只采集和按任务分片返回文件；DSH 在内存接收并调用文件服务上传。
//    原始文件不写入本地记录，不作为模型输出。
//  - 解析与入库走薪人薪事内部业务接口（`XinClient`），凭据来自宿主 xrxsAuth。
//  - 每完成一步就落盘，崩溃后按阶段恢复；**结果未知的写操作一律不重放**。
import { z } from 'zod'
import { BrowserClient, gatewayOutcome, unwrapToolResult, type McpToolInfo } from './browser-client.js'
import { XinClient, DELIVERY_TYPES, checkUploadResumes, type XinOperationName } from './xin-client.js'
import type { Store } from './store.js'
import { logError, logKey, type DeveloperLog } from './developer-log.js'

/**
 * 职位广告（`jobAds`）按平台区分的 `channelType` 取值。
 *
 * 注意与上传简历的渠道语义不同：上传页的「来源渠道」是 0 默认 / 20 内推 /
 * 34 猎头（见 `UPLOAD_CHANNEL_TYPES`），这里表示候选人来自哪个招聘平台。
 */
export const CHANNEL_TYPES: Record<string, number> = {
  lagou: 1, zhilian: 2, '51job': 3, liepin: 4, boss: 5,
}

export interface CandidateCard {
  index: number
  name?: string
  age?: string
  degree?: string
  city?: string
  experience?: string
  expect?: string
  raw: string
}

export interface IngestItem {
  /** 采集阶段的 captureId；入库不改动它。 */
  captureId: string
  /** 候选人稳定标识，用于幂等记录；同一任务内不得重复。 */
  candidateKey: string
  /** 投递职位 ID，简历归属的应聘职位。 */
  jobId: string
  /** 来源渠道：0 默认渠道 / 20 内推 / 34 猎头；必须显式给出。 */
  channelType: number
  /** 投递类型：0 主动投递 / 1 被动投递；不传时按薪招被动投递 1 处理。 */
  deliveryType?: number
  /** 上传位置-大库：1 新简历、4 人才库（配 resumeLibraryStatus 传分类ID）。 */
  resumeLibrary: number
  /** 上传位置-小状态：10 未处理 / 11 待定。 */
  resumeLibraryStatus: number
  /** 内推渠道时必传。 */
  recommenderId?: string
  /** 猎头渠道时必传。 */
  headhunterSupplierId?: string
  /** 覆盖上传文件名；不传则用采集到的文件名。 */
  name?: string
}

export type IngestStage = 'pending' | 'uploaded' | 'preuploaded' | 'saved' | 'unknown' | 'failed'

export interface IngestRecord {
  candidateKey: string
  stage: IngestStage
  captureId: string
  fileKey?: string
  /** 主系统预上传返回的解析缓存标识，不是真实入库简历 ID。 */
  preuploadResumeId?: string
  isRepeat?: boolean
  repeatLevel?: number
  repeatResumeId?: string
  resumeId?: string
  /** 保存接口的返回；只有 status=true 时才会写入。 */
  response?: unknown
  error?: string
  updatedAt: string
}

const nowIso = () => new Date().toISOString()

/**
 * 去掉值为 `undefined` 的属性。
 *
 * 工具输出的 canonical value 必须能无损往返 JSON，而 JSON.stringify 会丢掉
 * `undefined` 属性，于是「原对象」与「序列化后」不相等，宿主会判定 INVALID_TOOL_OUTPUT。
 * 可选字段因此必须显式缺席，而不是留成 undefined。
 */
export function clean<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => clean(item)) as unknown as T
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) out[key] = clean(item)
    }
    return out as T
  }
  return value
}

/** 从页面文本里尽力切出候选人卡片；仅作提示，模型必须回到 text 核对。 */
export function parseCandidateCards(text: string): CandidateCard[] {
  if (!text) return []
  // 卡片之间由操作按钮分隔，且**候选人资料在按钮之前**：按分隔符切开后每一段
  // 承载一位候选人的信息（最后一段只是页脚按钮）。用前瞻切分会把首位候选人丢掉。
  const pieces = text.split(/(?:回复TA|打招呼|立即沟通)/)
  // 只有含候选人特征（年龄/毕业/工作年限）的段落才算一张卡片，页眉页脚自然被排除。
  const SIGNATURE = /\d{2}岁|年毕业|工作\d+年|应届/
  const cards: CandidateCard[] = []
  for (const piece of pieces) {
    const raw = piece.replace(/\s+/g, ' ').trim().slice(0, 800)
    if (!raw || !SIGNATURE.test(raw)) continue
    // 姓名不锚定行首：卡片文本前面还有投递日期、职位名等噪声。
    const name = /([\u4e00-\u9fa5]{1,4})(?:先生|女士|同学)/.exec(raw)?.[1]
    const age = /(\d{2})岁/.exec(raw)?.[1]
    const degree = /(博士|硕士|本科|大专|中专|高中)/.exec(raw)?.[1]
    const city = /(?:^|\s)([\u4e00-\u9fa5]{2,8})(?=\s*期望)/.exec(raw)?.[1]
    const experience = /(工作\d+年|\d{4}年毕业|应届)/.exec(raw)?.[1]
    const expect = /期望[:：]\s*([^\s]{1,20})/.exec(raw)?.[1]
    cards.push({ index: cards.length, name, age, degree, city, experience, expect, raw })
  }
  return cards
}

export interface EngineDeps {
  browser: BrowserClient
  xin: XinClient | null
  store: Store
  signal?: AbortSignal
  uploadOrigins?: string[]
  logger?: DeveloperLog
}
interface IngestInput { taskId: string; items: IngestItem[]; retryUploadUrlOnce?: boolean; onProgress?: (state: IngestRecord) => Promise<void> }

export class RecruitEngine {
  constructor(private readonly deps: EngineDeps) {}

  private async gateway(name: string, args: Record<string, unknown>): Promise<any> {
    const raw = await this.deps.browser.call(name, args, undefined, this.deps.signal)
    const value = unwrapToolResult(raw)
    const outcome = gatewayOutcome(value)
    if (outcome.status !== 'succeeded') {
      const code = outcome.error ?? 'GATEWAY_FAILED'
      // BUSY / 过期 / 未知结果都必须原样上报，由调用方决定，不在这里重试。
      throw new Error(`网关 ${name} 未成功：${code}`)
    }
    return outcome.output
  }

  /** Discovery does not start a gateway; readiness is reported separately. */
  async browserStatus(): Promise<{ available: boolean; ready: boolean; tools: string[]; detail?: string }> {
    try {
      await this.deps.browser.initialize()
      const tools: McpToolInfo[] = await this.deps.browser.listTools()
      let ready = false
      let detail = '工具可发现；尚未确认扩展连接。本机连接会自动配置，调用 browser_ensure 等待扩展连接；失败时检查 nativeConnection 或使用备用配对。'
      if (tools.some(t => t.name === 'browser_status')) {
        try {
          const status = unwrapToolResult(await this.deps.browser.call('browser_status', {}))
          ready = status?.ready === true
          detail = ready ? '网关与扩展已连接' : '网关已启动，扩展尚未就绪'
        } catch (_) { detail = '网关未运行或扩展未连接；完成本机配对后调用 browser_ensure。' }
      }
      return { available: true, ready, tools: tools.filter(t => t.name !== 'artifact_read').map(t => t.name), detail }
    } catch (error) {
      return { available: false, ready: false, tools: [], detail: error instanceof Error ? error.message : String(error) }
    }
  }

  async listTabs() {
    return this.gateway('browser_list_tabs', {})
  }

  /**
   * 读取页面并尽力解析候选人。
   *
   * 整页文本会被扩展截断（约 4600 字），需要逐屏时应改传 `viewportOnly:true` 并
   * 配合滚动；这里如实把截断情况标出来，不把不完整内容当作完整候选列表。
   */
  async scan(input: { tabId: number; viewportOnly?: boolean; maxDepth?: number }) {
    const output = await this.gateway('browser_snapshot', {
      tabId: input.tabId,
      viewportOnly: input.viewportOnly ?? false,
      ...(input.maxDepth ? { maxDepth: input.maxDepth } : {}),
    })
    const text = typeof output?.text === 'string' ? output.text : ''
    const items = Array.isArray(output?.items) ? output.items : []
    const cards = parseCandidateCards(text)
    return {
      snapshotId: output?.snapshotId,
      url: output?.url,
      documentId: output?.documentId,
      viewport: output?.viewport,
      candidates: cards,
      interactiveCount: items.length,
      interactive: items.slice(0, 60).map((i: any) => ({ ref: i?.ref, role: i?.role, name: i?.name })),
      text,
      bestEffort: true,
      warning: cards.length
        ? '候选人字段由页面文本尽力解析，可能缺漏；入库前必须用 text 与页面本身核对。'
        : '未从页面文本识别到候选人卡片；请确认当前标签页是招聘平台的候选人列表页。',
    }
  }

  /**
   * 采集一份简历附件。
   *
   * 文件只进入扩展 artifact；本工具只回传 captureId 与元数据，绝不返回文件内容。
   * `complete` 只代表响应体读全，不代表候选人资料完整。
   */
  async capture(input: { tabId: number; snapshotId?: string; ref?: string; selector?: string; mode?: 'link' | 'click' | 'download'; fileName?: string; policy?: Record<string, unknown>; documentId?: string }) {
    if (!input.snapshotId && !input.ref && !input.selector) throw new Error('需要 selector，或来自同一次快照的 snapshotId + ref')
    if (input.selector && (input.snapshotId || input.ref)) throw new Error('selector 不能与 snapshotId/ref 同时使用')
    const output = await this.gateway('browser_acquire_file', {
      tabId: input.tabId,
      mode: input.mode ?? 'download',
      ...(input.policy ? { policy: input.policy } : {}),
      ...(input.documentId ? { documentId: input.documentId } : {}),
      ...(input.selector ? { selector: input.selector } : { snapshotId: input.snapshotId, ref: input.ref }),
      ...(input.fileName ? { fileName: input.fileName } : {}),
    })
    return {
      captureId: output?.captureId,
      fileName: output?.fileName,
      mimeType: output?.mimeType,
      size: output?.size,
      expiresAt: output?.expiresAt,
      captureStrategy: output?.captureStrategy,
      complete: output?.complete,
      completeness: output?.completeness,
      warnings: output?.warnings ?? [],
      note: 'captureId 有效期很短（约 15 分钟）；请尽快入库，不要把 captureId 传给招聘业务接口。',
    }
  }

  private recordId(taskId: string, candidateKey: string) {
    return `ingest-${taskId}-${candidateKey}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 90)
  }

  private async loadRecord(taskId: string, candidateKey: string): Promise<IngestRecord | null> {
    try { return await this.deps.store.get<IngestRecord>(this.recordId(taskId, candidateKey)) } catch { return null }
  }

  /**
   * 采集到的文件 → 文件服务 fileKey → 主系统预上传解析 → 提交入库。
   *
   * 每个候选人各自一次调用：接口本身接受批量，但逐人提交才能把「哪一份成功、
   * 哪一份结果未知」对应到具体候选人，也才能在出现 unknown 时立即停手。
   * saved 的记录不再提交，unknown 停止并保留 fileKey 供人工核对。
   */
  async ingest(input: IngestInput) {
    const execute = () => this.ingestItems(input)
    return this.deps.logger ? this.deps.logger.withContext({ taskId: input.taskId }, () => this.deps.logger!.trace('resume.ingest', {
      itemCount: Array.isArray(input.items) ? input.items.length : 0,
    }, execute, result => ({ saved: result.saved, failed: result.failed, unknown: result.unknown,
      outcome: result.unknown ? 'unknown' : result.failed ? 'failed' : 'succeeded' }))) : execute()
  }
  private async ingestItems(input: IngestInput) {
    if (!this.deps.xin) {
      throw new Error('宿主未挂载薪人薪事授权（xrxsAuth），无法调用入库接口；请先在薪灵完成授权。')
    }
    if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('items 不能为空')
    const seen = new Set<string>()
    for (const item of input.items) {
      if (!item.captureId || !item.candidateKey) throw new Error('每项都需要 captureId 与 candidateKey')
      if (seen.has(item.candidateKey)) throw new Error(`candidateKey 重复：${item.candidateKey}`)
      seen.add(item.candidateKey)
      if (!item.jobId) throw new Error(`candidateKey=${item.candidateKey} 缺少投递职位 jobId`)
      if (!Number.isInteger(item.channelType)) throw new Error(`candidateKey=${item.candidateKey} 缺少整数 channelType`)
      if (!Number.isInteger(item.resumeLibrary) || !Number.isInteger(item.resumeLibraryStatus)) {
        throw new Error(`candidateKey=${item.candidateKey} 缺少整数 resumeLibrary/resumeLibraryStatus`)
      }
    }
    const invalid = checkUploadResumes(input.items)
    if (invalid) throw new Error(`${invalid.code}: ${invalid.message}`)

    const ready = await this.deps.xin.call('extensionInit', {}, this.deps.signal)
    if (!ready.ok) throw new Error(`薪招授权检查失败 ${ready.failure.code}: ${ready.failure.message}`)

    const results: IngestRecord[] = []

    for (const item of input.items) {
      this.deps.logger?.updateContext({ candidateKey: /^[a-f0-9]{32}$/.test(item.candidateKey) ? item.candidateKey : logKey(item.candidateKey) })
      const prior = await this.loadRecord(input.taskId, item.candidateKey)
      if (prior?.stage === 'saved') { this.deps.logger?.write('info', 'ingest.duplicate_skipped'); results.push({ ...prior, error: '已入库，跳过重复提交' }); continue }
      if (prior?.stage === 'unknown') {
        this.deps.logger?.write('warn', 'ingest.unknown_preserved')
        results.push({ ...prior, error: '前次结果未知，已停止自动处理；请用 result 核对后再决定' })
        break
      }
      const state: IngestRecord = prior ?? { candidateKey: item.candidateKey, stage: 'pending', captureId: item.captureId, updatedAt: nowIso() }
      const save = async (patch: Partial<IngestRecord>) => {
        Object.assign(state, patch, { updatedAt: nowIso() })
        await this.deps.store.put(this.recordId(input.taskId, item.candidateKey), state)
        this.deps.logger?.write(state.stage === 'unknown' || state.stage === 'failed' ? 'warn' : 'info', 'ingest.stage_changed', {
          stage: state.stage, captureKey: logKey(state.captureId), hasUploadedFile: !!state.fileKey,
          hasPreuploadResume: !!state.preuploadResumeId, isRepeat: state.isRepeat, repeatLevel: state.repeatLevel,
        })
        try { await input.onProgress?.(state) }
        catch (error) { this.deps.logger?.write('warn', 'ingest.progress_failed', logError(error)) }
      }

      try {
        let fileKey = state.fileKey
        if (!fileKey) {
          // 文件先落到文件服务换成 fileKey；主系统业务接口不接受原始字节。
          const urlResult = await this.deps.xin.uploadUrl(this.deps.signal)
          if (!urlResult.ok) {
            await save({ stage: urlResult.failure.outcome === 'unknown' ? 'unknown' : 'failed', error: `上传地址失败 ${urlResult.failure.code}: ${urlResult.failure.message}` })
            results.push(state)
            if (urlResult.failure.outcome === 'unknown') break
            continue
          }
          const upload = new URL(urlResult.data)
          upload.searchParams.set('is_permanent', 'true')
          const uploadUrl = upload.href
          const read = () => readCapturedFile(item.captureId, args => this.gateway('artifact_read', args), this.deps.signal)
          const file = this.deps.logger ? await this.deps.logger.trace('file.read_capture', { captureKey: logKey(item.captureId) }, read,
            captured => ({ bytes: captured.blob.size })) : await read()
          if (item.name) file.fileName = item.name
          let uploaded: any
          // Persist uncertainty before sending any upload so a crash cannot trigger replay.
          await save({ stage: 'unknown', error: '文件上传已开始，结果需核对' })
          try {
            uploaded = await this.deps.xin.uploadFile(uploadUrl, file, this.deps.signal, this.deps.uploadOrigins)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (/UPLOAD_URL_EXPIRED/.test(message) && input.retryUploadUrlOnce !== false) {
              this.deps.logger?.write('warn', 'file.upload_url_refresh', { errorCode: 'UPLOAD_URL_EXPIRED', attempt: 1 })
              const fresh = await this.deps.xin.uploadUrl(this.deps.signal)
              if (fresh.ok) {
                try {
                  const refreshed = new URL(fresh.data)
                  refreshed.searchParams.set('is_permanent', 'true')
                  uploaded = await this.deps.xin.uploadFile(refreshed.href, file, this.deps.signal, this.deps.uploadOrigins)
                } catch (retryError) {
                  const retryMessage = retryError instanceof Error ? retryError.message : String(retryError)
                  await save({ stage: 'unknown', error: `上传结果未知：${retryMessage}` })
                  results.push(state); break
                }
              }
            }
            if (!uploaded) {
              await save({ stage: 'unknown', error: `上传结果未知：${message}` })
              results.push(state); break
            }
          }
          fileKey = typeof uploaded?.fileKey === 'string' && uploaded.fileKey ? uploaded.fileKey : undefined
          if (!fileKey) {
            await save({ stage: 'unknown', error: '上传未回传 fileKey，结果未知' })
            results.push(state); break
          }
          await save({ stage: 'uploaded', fileKey, preuploadResumeId: undefined,
            isRepeat: undefined, repeatLevel: undefined, repeatResumeId: undefined, error: undefined })
        }
        // 预上传会解析并写入缓存，也必须在发出前持久化不确定状态。
        if (!state.preuploadResumeId) {
          await save({ stage: 'unknown', error: '简历预上传已开始，结果需核对' })
          const preuploaded = await this.deps.xin.call('preuploadResume', { fileKey }, this.deps.signal)
          if (!preuploaded.ok) {
            await save({ stage: preuploaded.failure.outcome === 'unknown' ? 'unknown' : 'failed', error: `预上传失败 ${preuploaded.failure.code}: ${preuploaded.failure.message}` })
            results.push(state)
            if (preuploaded.failure.outcome === 'unknown') break
            continue
          }
          const parsed = preuploadReceipt.safeParse(preuploaded.data)
          if (!parsed.success) {
            await save({ stage: 'unknown', error: 'PREUPLOAD_RESPONSE_INVALID: 预上传未返回有效的解析标识，未提交入库；请核对结果' })
            results.push(state); break
          }
          await save({ stage: 'preuploaded', preuploadResumeId: parsed.data.resumeId,
            isRepeat: parsed.data.isRepeat, repeatLevel: parsed.data.repeatLevel,
            repeatResumeId: parsed.data.repeatResumeId, error: undefined })
        }
        // 写请求前先落盘「结果未知」，崩溃后不会被当成未发送而重放。
        await save({ stage: 'unknown', error: '简历提交已开始，结果需核对' })
        const submitted = await this.deps.xin.call('submitUploadResume', {
          jobId: item.jobId, channelType: item.channelType,
          deliveryType: item.deliveryType ?? DELIVERY_TYPES.passive,
          resumeLibrary: item.resumeLibrary, resumeLibraryStatus: item.resumeLibraryStatus,
          ...(item.recommenderId ? { recommenderId: item.recommenderId } : {}),
          ...(item.headhunterSupplierId ? { headhunterSupplierId: item.headhunterSupplierId } : {}),
          resumeFileKeys: [{ fileKey, resumeId: state.preuploadResumeId }],
        }, this.deps.signal)
        if (!submitted.ok) {
          await save({ stage: submitted.failure.outcome === 'unknown' ? 'unknown' : 'failed', error: `提交入库失败 ${submitted.failure.code}: ${submitted.failure.message}` })
          results.push(state)
          if (submitted.failure.outcome === 'unknown') break
          continue
        }
        await save({ stage: 'saved', response: submitted.data, error: undefined })
        results.push(state)
      } catch (error) {
        await save({ stage: state.stage === 'unknown' || state.stage === 'saved' ? 'unknown' : 'failed', error: error instanceof Error ? error.message : String(error) })
        results.push(state)
        if (state.stage === 'unknown') break
      }
    }

    return {
      taskId: input.taskId,
      total: input.items.length,
      saved: results.filter(r => r.stage === 'saved').length,
      unknown: results.filter(r => r.stage === 'unknown').length,
      failed: results.filter(r => r.stage === 'failed').length,
      results,
      note: '简历先上传文件服务，再由主系统预上传解析、提交入库；只有最终提交 status=true 才记为 saved。preuploadResumeId 仅为解析缓存标识，不是真实入库简历 ID。重复提示随记录保留，提交时按主系统规则处理；unknown 不允许自动重放。',
    }
  }
  /** 只读对账：读取本地阶段记录。 */
  async result(input: { taskId: string; candidateKeys?: string[] }) {
    const keys = input.candidateKeys ?? []
    if (!keys.length) return { taskId: input.taskId, note: '需要 candidateKeys 才能读取记录；本工具不做全目录扫描。', results: [] }
    const results: IngestRecord[] = []
    for (const key of keys) {
      const found = await this.loadRecord(input.taskId, key)
      results.push(found ?? { candidateKey: key, stage: 'pending', captureId: '', updatedAt: nowIso(), error: '无本地记录' })
    }
    return { taskId: input.taskId, results }
  }
}

/** 供 help 报告的能力清单：这些是入库链路真正依赖的操作。 */
export const REQUIRED_OPERATIONS: XinOperationName[] = ['extensionInit', 'getUploadUrl', 'preuploadResume', 'submitUploadResume']

const preuploadReceipt = z.object({
  resumeId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  isRepeat: z.boolean().optional(),
  repeatLevel: z.number().int().optional(),
  repeatResumeId: z.string().max(64).optional(),
})

const candidateKey = z.string().min(1).max(80).regex(/^[A-Za-z0-9_:.-]+$/, 'candidateKey 只允许字母数字与 _ : . -')

export const scanSpec = z.object({
  tabId: z.number().int().positive(),
  viewportOnly: z.boolean().optional(),
  maxDepth: z.number().int().min(1).max(20).optional(),
}).strict()

export const captureSpec = z.object({
  tabId: z.number().int().positive(),
  snapshotId: z.string().min(1).max(120).optional(),
  ref: z.string().min(1).max(120).optional(),
  selector: z.string().min(1).max(2000).optional(),
  mode: z.enum(['link', 'click', 'download']).default('download').describe('默认 download：先监听文件响应，再真实点击页面下载控件（薪招 3.2.38+）；link 取附件直链；click 使用站点附件解析'),
  fileName: z.string().min(1).max(160).optional(),
}).strict()

export const ingestSpec = z.object({
  taskId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  retryUploadUrlOnce: z.boolean().optional(),
  items: z.array(z.object({
    captureId: z.string().min(1).max(120),
    candidateKey,
    /** 投递职位ID：简历归属的应聘职位。 */
    jobId: z.string().min(1).max(64),
    /** 来源渠道：0 默认渠道 / 20 内推 / 34 猎头；平台渠道值见 CHANNEL_TYPES。 */
    channelType: z.number().int().min(0).describe('来源渠道，使用当前公司已开启渠道的真实 ID；20=内推（须传 recommenderId），34=猎头（须传 headhunterSupplierId），禁止猜 ID。'),
    /** 0 主动投递 / 1 被动投递；不传按服务端默认 1。 */
    deliveryType: z.number().int().min(0).max(1).optional().describe('投递类型：0=主动投递，1=被动投递（默认，不传时服务端按 1 处理）。'),
    /** 上传位置-大库：1 新简历；4 人才库（此时 resumeLibraryStatus 是分类ID）。 */
    resumeLibrary: z.number().int().min(0).describe('上传位置-大库：1=新简历，4=人才库（此时 resumeLibraryStatus 是人才库分类 ID）。人才库请先调用 ai_recruit_destinations 查询真实选项。'),
    /** 上传位置-小状态：10 未处理 / 11 待定。 */
    resumeLibraryStatus: z.number().int().min(0).describe('上传位置-小状态：与 resumeLibrary 配套，1 时 10=未处理、11=待定；4 时为当前公司人才库分类 ID（不是统一状态枚举），从 ai_recruit_destinations 返回节点的 typeStatus 取得，禁止猜 ID。'),
    recommenderId: z.string().max(64).optional().describe('内推人员工 ID，仅 channelType=20 时可传且必传。'),
    headhunterSupplierId: z.string().max(64).optional().describe('猎头供应商 ID，仅 channelType=34 时可传且必传。'),
    /** 覆盖上传文件名；不传则用采集到的文件名。 */
    name: z.string().max(64).optional(),
  }).strict()).min(1).max(50),
}).strict()

export const resultSpec = z.object({
  taskId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  candidateKeys: z.array(candidateKey).min(1).max(50),
}).strict()
