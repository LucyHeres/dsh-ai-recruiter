import { createRequire } from 'node:module'
import type { BrowserAgentTool, BrowserAgentSeed } from './browser-agent.js'
import { createHash } from 'node:crypto'
import type { McpToolInfo } from './browser-client.js'
import { allowedTab, normalized, itemText, statesOf } from './page-actions.js'
import { modelPageObservation } from './model-observation.js'
import { safeError } from './task-error.js'
import { browserFailureCode } from './browser-errors.js'
import type { DeveloperLog } from './developer-log.js'
import { actionEffects } from './action-effects.js'

const Ajv = createRequire(import.meta.url)('ajv')
export interface AgentBrowserCall { name: string; args: Record<string, any>; purpose: 'navigation' | 'business_write'; readOnly: boolean; signal: AbortSignal }
type Options = { origins: readonly string[]; signal: AbortSignal; confirmationId: string; logger?: DeveloperLog; allow?: (info: McpToolInfo) => boolean; hostTools?: readonly string[]; observationFormat?: 'dom' | 'semantic'; observationViewportOnly?: boolean; observationWait?: 'none' | 'dom_quiet' | ((name: string, args: Record<string, any>) => 'none' | 'dom_quiet') }

/** Tool transport, schema validation, task scope and observation cache. No page
 * workflow, button names or feature-specific recovery lives in this broker. */
export class AgentBrowserTools {
  readonly tools: BrowserAgentTool[]
  /** Read-only refreshes must not masquerade as recovery of a fixed route. */
  inputRevision = 0
  private readonly pages = new Map<number, any>()
  private readonly inspectTails = new Map<number, Promise<unknown>>()
  private readonly inspected = new WeakMap<object, Set<string>>()
  private readonly inspections = new WeakMap<object, Map<string, any>>()
  private before?: (call: AgentBrowserCall) => Promise<void>
  private around?: (call: AgentBrowserCall, dispatch: () => Promise<any>) => Promise<any>
  constructor(infos: McpToolInfo[], private readonly call: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<any>,
    private readonly options: Options) {
    const ajv = new Ajv({ allErrors: true, strict: false })
    this.tools = infos.filter(info => (info._meta?.browserAgent?.available === true || options.hostTools?.includes(info.name)) && (options.allow?.(info) ?? true)).map(info => {
      const schema: any = structuredClone(info.inputSchema ?? { type: 'object', properties: {} })
      schema.properties ??= {}
      for (const key of ['policy', 'documentId']) delete schema.properties[key]
      schema.required = (schema.required ?? []).filter((key: string) => !['policy', 'documentId'].includes(key))
      const readOnly = info.annotations?.readOnlyHint === true
      const autoObserve = !readOnly && schema.properties.observe?.properties?.returnSnapshot?.enum?.includes('viewport') &&
        schema.properties.observe?.properties?.wait?.enum?.includes('dom_quiet')
      if (autoObserve) schema.properties.observe.description = `${schema.properties.observe.description ?? ''} 宿主默认在操作后等待页面安静并返回视口快照；优先使用返回的 snapshot。若本轮有依赖旧引用的后续输入，显式设 returnSnapshot=none；新快照会替换旧引用。`
      if (!readOnly) schema.properties.purpose = { type: 'string', enum: ['navigation', 'business_write'],
        description: '根据当前目标与页面语义声明用途：可能提交业务/发送消息用 business_write；浏览、取消、返回等用 navigation。不能用此字段绕过授权。' }
      const validate = ajv.compile(schema)
      return { name: info.name, description: info.description ?? info.name, inputSchema: schema,
        contextSnapshot: (args: Record<string, unknown>, value: unknown) => this.contextSnapshot(args, value),
        failureKey: (args: Record<string, unknown>) => this.failureKey(args),
        failureLabel: (args: Record<string, unknown>) => this.failureLabel(args),
        recover: (error: unknown, args: Record<string, unknown>, signal: AbortSignal) => info.name === 'browser_snapshot'
          ? Promise.resolve(undefined) : this.recoverObservation(error, args, signal, readOnly),
        // Same-tab tools can replace refs or enrich observation state, even
        // while only reading the website. Preserve their model order without
        // enumerating observation-producing tool names.
        readOnly: readOnly && !('tabId' in schema.properties),
        execute: async (input: Record<string, unknown>, signal: AbortSignal) => {
          const started = Date.now()
          const boundedInput = { ...input }
          // 只读能力没有 purpose 语义（只有写操作需要声明用途），schema 也不声明它。
          // 宿主内部调用方可能统一带上这个字段；它是宿主元数据，不该让整个任务因为
          // additionalProperties:false 校验失败而中止（真实事故：预设对 browser_wait
          // 传了 purpose，导致每次新开标签页首屏都 tool_failed 并立刻交棒）。
          if (readOnly) delete boundedInput.purpose
          // 快照始终带 frameId（顶层为 0），宿主内部调用方常把它原样带给后续工具。
          // 只有声明了 frameId 的工具才接受它：交互类能力从快照记录里取帧，且扩展对
          // 非顶层帧的交互是明确拒绝的（FRAME_INTERACTION_UNSUPPORTED），因此对未声明
          // 它的工具剥离 frameId 不改变行为，只避免 additionalProperties:false 拒绝。
          // （真实事故：预设把 frameId=0 带给 browser_click，首屏后的第一次点击必失败。）
          if (!schema.properties.frameId) delete boundedInput.frameId
          const argumentAdjustments = readOnly ? Object.entries(schema.properties).flatMap(([field, definition]: [string, any]) => {
            const requested = input[field]
            if (!/^(?:max[A-Z]|limit$)/.test(field) || typeof requested !== 'number' || !Number.isFinite(requested)
              || !Number.isFinite(definition.maximum) || requested <= definition.maximum) return []
            boundedInput[field] = definition.maximum
            return [{ field, requested, applied: definition.maximum }]
          }) : []
          if (!validate(boundedInput)) {
            const issues = validate.errors?.slice(0, 4).map((issue: any) => ({ path: issue.instancePath, keyword: issue.keyword, constraints: issue.params }))
            throw Object.assign(new Error(`BROWSER_ARGUMENT_INVALID: ${JSON.stringify(issues)}`), {
              validationIssues: issues?.map((issue: any) => ({ path: issue.path, keyword: issue.keyword })) })
          }
          const { purpose = 'navigation', ...args } = boundedInput as Record<string, any>
          const beforePage = this.pages.get(args.tabId)
          // Use the extension's existing bounded post-input observation, not a
          // second write or a separate model turn. Explicit options win.
          const observationWait = typeof options.observationWait === 'function' ? options.observationWait(info.name, args) : options.observationWait ?? 'dom_quiet'
          if (autoObserve && args.observe?.returnSnapshot !== 'none') args.observe = { wait: observationWait, returnSnapshot: 'viewport', requireChange: false, timeoutMs: observationWait === 'none' ? 500 : 2500, ...args.observe }
          const observationFormat = args.observe?.format ?? options.observationFormat
          const intent = purpose === 'business_write' ? purpose : 'navigation'
          const argsWithPolicy: Record<string, any> = { ...args, policy: { allowedOrigins: [...options.origins], maxWrites: 1000,
            riskLevel: readOnly ? 'read' : intent === 'business_write' ? 'business_write' : 'browser_mutation',
            ...(intent === 'business_write' ? { requiresConfirmation: true, confirmationId: options.confirmationId } : {}) } }
          // Older extensions attach only DOM snapshots. Ask them to settle once
          // without capturing, then read the requested semantic format once.
          // Explicit returnSnapshot=none keeps refs valid for grouped inputs.
          if (autoObserve && args.observe?.returnSnapshot !== 'none' && observationFormat) {
            const formats = schema.properties.observe?.properties?.format?.enum
            argsWithPolicy.observe = !Array.isArray(formats) && observationFormat === 'dom' ? args.observe
              : Array.isArray(formats) && formats.includes(observationFormat)
              ? { ...args.observe, format: observationFormat }
              : { ...args.observe, returnSnapshot: 'none' }
          }
          if (args.snapshotId) {
            const page = this.getPage(args.tabId, args.snapshotId)
            if (args.ref && !page.items?.some((item: any) => item.ref === args.ref)) throw new Error('ELEMENT_NOT_FOUND')
            Object.assign(argsWithPolicy, { documentId: page.documentId })
          }
          await this.before?.({ name: info.name, args, purpose: intent, readOnly, signal })
          const preflightMs = Date.now() - started
          if (info.name === 'browser_snapshot') {
            if (!args.format) argsWithPolicy.format = options.observationFormat ?? 'semantic'
            if (args.viewportOnly === undefined && schema.properties.viewportOnly && options.observationViewportOnly !== undefined) argsWithPolicy.viewportOnly = options.observationViewportOnly
          }
          const dispatch = async () => { let dispatched = false; try {
            const remoteStarted = Date.now()
            const raw = this.withoutStaleSnapshot(await this.call(info.name, argsWithPolicy, signal))
            try { options.logger?.write('info', 'browser_agent.browser_call', { tool: info.name, preflightMs,
              remoteMs: Date.now() - remoteStarted, observationFormat,
              waitedMs: (raw?.verification ?? raw?.output?.verification)?.waitedMs,
              attachedSnapshot: !!(raw?.snapshot?.snapshotId || raw?.output?.snapshot?.snapshotId) }) } catch { /* observer only */ }
            dispatched = true
            if (!readOnly) this.inputRevision++
            this.observe(raw, args.tabId)
            if (info.name === 'browser_inspect_element' && (raw?.item || raw?.element)) this.mergeInspection(args, raw.item ?? {}, raw)
            const value = this.format(raw)
            if (argumentAdjustments.length && value && typeof value === 'object' && !Array.isArray(value)) value.argumentAdjustments = argumentAdjustments
            if (autoObserve && args.observe?.returnSnapshot !== 'none' && observationFormat
              && (raw?.snapshot ?? raw?.output?.snapshot)?.format !== observationFormat) {
              const tabId = raw?.tabId ?? raw?.output?.tabId ?? args.tabId
              try {
                const snapshot = await this.tools.find(tool => tool.name === 'browser_snapshot')!.execute({ tabId, format: observationFormat }, signal)
                return raw?.output?.snapshot ? { ...value, output: { ...value.output, snapshot } } : { ...value, snapshot }
              } catch (error) {
                signal.throwIfAborted()
                return { ...value, observationError: browserFailureCode(error) ?? 'OBSERVATION_UNAVAILABLE', note: 'Input receipt preserved. Re-observe; do not replay input.' }
              }
            }
            // Navigation/scroll has no observe option in the current protocol.
            // Append one read, keeping its failure distinct from the input receipt.
            if ((autoObserve ? args.observe.returnSnapshot !== 'none' : ['browser_open_tab', 'browser_navigate', 'browser_history', 'browser_scroll', 'browser_wait'].includes(info.name)) &&
              !raw?.snapshot?.snapshotId && !raw?.output?.snapshot?.snapshotId) {
              const tabId = raw?.tabId ?? raw?.output?.tabId ?? args.tabId
              if (Number.isInteger(tabId)) {
                try {
                  const snapshot = await this.tools.find(tool => tool.name === 'browser_snapshot')!.execute({ tabId,
                    ...(args.frameId === undefined ? {} : { frameId: args.frameId }) }, signal)
                  return { ...(value && typeof value === 'object' ? value : { result: value }), snapshot }
                } catch (error) {
                  signal.throwIfAborted()
                  return { ...(value && typeof value === 'object' ? value : { result: value }),
                    observationError: browserFailureCode(error) ?? 'OBSERVATION_UNAVAILABLE', note: 'Input receipt preserved. Read the page again; do not replay the input.' }
                }
              }
            }
            return value
          } catch (error) {
            // Any ambiguous mutating transport outcome is fatal, regardless of
            // whether the model described the action as navigation or commit.
            if (!readOnly && (dispatched || /RESULT_UNKNOWN|OUTCOME_UNKNOWN|DEADLINE|TIMEOUT|TRANSPORT|CDP_TARGET_DETACHED|已退出|无法启动|ECONN|socket|closed|cancelled/i.test(String(error)))) {
              throw new Error(`BROWSER_WRITE_OUTCOME_UNKNOWN: ${safeError(error)}`)
            }
            if (readOnly && /RESULT_UNKNOWN|OUTCOME_UNKNOWN/.test(String(error))) {
              throw new Error('BROWSER_OBSERVATION_UNAVAILABLE: 只读观察未返回明确结果，可重新观察；这不改变已有写入记录')
            }
            throw error
          } }
          const invocation = { name: info.name, args, purpose: intent, readOnly, signal }
          const result = await (this.around ? this.around(invocation, dispatch) : dispatch())
          if (!readOnly) {
            try {
              const effects = actionEffects(beforePage, this.pages.get(args.tabId), args.ref, result)
              if (effects) return { ...result, effects }
            } catch { /* Optional UI evidence must preserve the original action receipt. */ }
          }
          return result
        } }
    })
    if (!this.tools.some(tool => tool.name === 'browser_snapshot')) throw new Error('BROWSER_AGENT_TOOL_REGISTRY_UNAVAILABLE: 网关未提供通用 Agent 工具元数据')
    const observationSchema = { type: 'object', properties: { tabId: { type: 'integer' }, snapshotId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 }, query: { type: 'string', maxLength: 300 } }, required: ['tabId', 'snapshotId'], additionalProperties: false }
    const validateObservation = ajv.compile(observationSchema)
    this.tools.push({ name: 'browser_read_observation', readOnly: true,
      contextSnapshot: (args, value) => this.contextSnapshot(args, value),
      description: '续读或检索已取得的完整快照，保持同一 snapshot/ref。offset/limit 分页，query 检索原文。源快照遗漏时需 browser_snapshot 按 coverage.source.nextOffset 再取。',
      inputSchema: observationSchema,
      execute: async args => {
        if (!validateObservation(args)) throw new Error('BROWSER_ARGUMENT_INVALID: 观察读取参数不符合 schema')
        const page = this.getPage(Number(args.tabId), String(args.snapshotId))
        return modelPageObservation(page, { offset: Math.max(0, Number(args.offset ?? 0)), limit: Math.min(200, Math.max(1, Number(args.limit ?? 100))), query: args.query == null ? undefined : String(args.query).slice(0, 300) })
      } })
  }
  setBeforeCall(handler: (call: AgentBrowserCall) => Promise<void>) { this.before = handler }
  setAroundCall(handler: (call: AgentBrowserCall, dispatch: () => Promise<any>) => Promise<any>) { this.around = handler }
  getPage(tabId: number, snapshotId?: string): any {
    const page = this.pages.get(tabId)
    if (!page || (snapshotId && page.snapshotId !== snapshotId)) throw new Error('SNAPSHOT_EXPIRED: 请先读取目标标签页的新快照')
    return page
  }
  currentPage(): any { return [...this.pages.values()].at(-1) }
  /** Actual read-only startup, with no invented navigation or arbitrary tab choice. */
  async bootstrap(preferredTabId?: number, signal = this.options.signal, entryUrl?: string): Promise<BrowserAgentSeed[]> {
    const list = this.tools.find(tool => tool.name === 'browser_list_tabs')
    if (!list) return []
    const seeds: BrowserAgentSeed[] = []
    try {
      const value: any = await list.execute({}, signal)
      seeds.push({ name: list.name, args: {}, value })
      const tabs = (Array.isArray(value) ? value : value?.tabs ?? []).map((tab: any) => ({ ...tab, tabId: tab.tabId ?? tab.id }))
        .filter((tab: any) => allowedTab(tab, this.options.origins))
      const entries = entryUrl ? tabs.filter((tab: any) => {
        try {
          const actual = new URL(tab.url), expected = new URL(entryUrl)
          return actual.origin === expected.origin && actual.pathname === expected.pathname
            && [...expected.searchParams].every(([key, value]) => actual.searchParams.get(key) === value)
        } catch { return false }
      }) : []
      const selected = tabs.find((tab: any) => (tab.tabId ?? tab.id) === preferredTabId)
        ?? (entries.length === 1 ? entries[0] : tabs.length === 1 ? tabs[0] : undefined)
      if (selected) {
        const args = { tabId: selected.tabId ?? selected.id }
        const snapshot = this.tools.find(tool => tool.name === 'browser_snapshot')!
        seeds.push({ name: snapshot.name, args, value: await snapshot.execute(args, signal) })
      }
    } catch { signal.throwIfAborted() /* model may inspect or choose another authorized path */ }
    return seeds
  }
  /**
   * 稳定身份，跨 ref 重新生成仍然相同。刻意不含 bounds／states：
   * 面板一开一合、滚动一个像素、焦点切换都会改变它们，会让同一个真实目标的
   * 失败计数不断清零，反空转保护因此要等很久才生效。
   */
  failureKey(args: Record<string, unknown>) {
    const page = this.pages.get(Number(args.tabId))
    const target = page?.items?.find((item: any) => item.ref === args.ref)
    if (!page) return undefined
    if (!target) return createHash('sha256').update(JSON.stringify([args.tabId, page.documentId ?? page.url, 'missing-target',
      Object.fromEntries(Object.entries(args).filter(([key]) => !['ref', 'snapshotId', 'evidenceRefs', 'reason'].includes(key)).sort(([a], [b]) => a.localeCompare(b)))])).digest('hex')
    return createHash('sha256').update(JSON.stringify([args.tabId, args.frameId, page.documentId ?? page.url,
      args.name, target.role, itemText(target), target.elementId, target.href])).digest('hex')
  }
  /**
   * 面向模型的失败标签：只用角色与元素标识，**不含页面文案**。
   * 名称是页面内容，把它写进后续消息会把被压缩掉的旧快照正文重新灌回上下文。
   */
  failureLabel(args: Record<string, unknown>) {
    const page = this.pages.get(Number(args.tabId))
    const target = page?.items?.find((item: any) => item.ref === args.ref)
    if (!target) return undefined
    const id = target.elementId ? `#${String(target.elementId).slice(0, 40)}` : ''
    return `${target.role ?? 'element'}${id}`
  }
  async recoverObservation(error: unknown, args: Record<string, unknown>, signal: AbortSignal, readOnly = false): Promise<unknown> {
    const code = browserFailureCode(error)
    if (!Number.isInteger(args.tabId) || !args.snapshotId) return undefined
    signal.throwIfAborted()
    if (['SNAPSHOT_EXPIRED', 'PAGE_CHANGED', 'ELEMENT_NOT_FOUND', 'ELEMENT_NOT_IN_VIEWPORT'].includes(code ?? '')) {
      const snapshot = this.tools.find(tool => tool.name === 'browser_snapshot')!
      const domFallback = readOnly && code === 'SNAPSHOT_EXPIRED' && this.pages.get(Number(args.tabId))?.format === 'semantic'
      return { snapshot: await snapshot.execute({ tabId: args.tabId, ...(args.frameId === undefined ? {} : { frameId: args.frameId }),
        ...(domFallback ? { format: 'dom' } : {}) }, signal),
        ...(domFallback ? { observationMode: 'dom', note: 'The semantic reference could not be read. This fresh DOM observation has new refs; choose from it instead of replaying the failed reference.' } : {}),
        ...(code === 'ELEMENT_NOT_IN_VIEWPORT' ? { note: 'The target was outside the viewport and the input was not dispatched. Use the fresh bounds to scroll its container, then use the new snapshot and ref. Do not retry the offscreen reference or substitute a surrounding section.' } : {}) }
    }
    const interactionBlocked = code === 'ELEMENT_OCCLUDED' || code === 'ELEMENT_HIDDEN'
    if (!['CANDIDATE_EVIDENCE_INVALID', 'CANDIDATE_EVIDENCE_UNREADABLE'].includes(code ?? '') && !interactionBlocked) return undefined
    const page = this.getPage(Number(args.tabId), String(args.snapshotId))
    const refs = [args.ref, ...(Array.isArray(args.evidenceRefs) ? args.evidenceRefs : [])]
    const evidence = refs.map(ref => {
      const item = page.items?.find((item: any) => item.ref === ref)
      return item ? { ref, role: item.role, text: itemText(item).slice(0, 1600), states: statesOf(item) } : { ref, missing: true }
    })
    let inspection: unknown, inspectionError: string | undefined
    if (interactionBlocked && typeof args.ref === 'string') {
      const inspect = this.tools.find(tool => tool.name === 'browser_inspect_element')
      if (inspect) {
        try {
          inspection = await inspect.execute({ tabId: args.tabId, snapshotId: args.snapshotId, ref: args.ref,
            ...(args.frameId === undefined ? {} : { frameId: args.frameId }) }, signal)
        } catch (error) {
          signal.throwIfAborted()
          inspectionError = browserFailureCode(error) ?? 'INSPECTION_UNAVAILABLE'
        }
      }
    }
    const snapshotTool = this.tools.find(tool => tool.name === 'browser_snapshot')!
    const format: any = (snapshotTool.inputSchema.properties as any)?.format
    const domFallback = interactionBlocked && page.format === 'semantic' && format
      && (!Array.isArray(format.enum) || format.enum.includes('dom'))
    const snapshot = code === 'CANDIDATE_EVIDENCE_UNREADABLE' || interactionBlocked
      ? await snapshotTool.execute({ tabId: args.tabId, ...(domFallback ? { format: 'dom' } : {}),
        ...(args.frameId === undefined ? {} : { frameId: args.frameId }) }, signal) : undefined
    return { snapshotId: page.snapshotId, evidence, ...(snapshot ? { snapshot } : {}),
      ...(inspection === undefined ? {} : { inspection }), ...(inspectionError ? { inspectionError } : {}),
      ...(domFallback ? { observationMode: 'dom' } : {}),
      note: interactionBlocked
        ? `The original input was not replayed. ${code === 'ELEMENT_HIDDEN' ? 'The browser reported a hidden target, not proof of a covering overlay. A dropdown may expose an internal search input that is not its visible trigger.' : 'The browser reported a failed hit-test, which may involve another layer of the same component or a real obstruction.'} Inspection describes the failed target and its ancestors, not permission to click. Use the fresh snapshot refs to identify the visible trigger or resolve a real obstruction; do not repeat the unchanged failed target.`
        : 'Current identity evidence, not permission to click. Hidden or modal-background identity sources are invalid; choose a readable related source or resolve the foreground.' }
  }
  private withoutStaleSnapshot(value: any): any {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(item => this.withoutStaleSnapshot(item))
    // Preserve the write receipt and failed verification. A captured-but-stale
    // snapshot must not become the broker's new actionable page.
    if (value.verification?.snapshotStale) {
      const { snapshot: _snapshot, ...rest } = value
      const output = rest.output && typeof rest.output === 'object'
        ? Object.fromEntries(Object.entries(rest.output).filter(([key]) => key !== 'snapshot')) : rest.output
      return { ...rest, ...(output ? { output } : {}), observationUnavailable: 'Snapshot changed during capture; inspect again. Do not replay the input.' }
    }
    return { ...value, ...(value.output ? { output: this.withoutStaleSnapshot(value.output) } : {}) }
  }
  contextSnapshot(args: Record<string, unknown>, value: any) {
    const find = (item: any): any => {
      if (!item || typeof item !== 'object') return undefined
      if (item.representation === 'semantic-v1' && item.snapshotId) return item
      for (const key of ['snapshot', 'page', 'output', 'recovery', 'observation', 'correction']) { const found = find(item[key]); if (found) return found }
    }
    const page = find(value), tabId = page?.tabId ?? args.tabId
    if (!page || !Number.isInteger(tabId)) return undefined
    const summarize = (item: any): any => {
      if (item === page) return { representation: 'historical-snapshot-summary', tabId, snapshotId: page.snapshotId, url: page.url,
        note: 'Superseded page content omitted. Use the latest snapshot; old refs are not actionable.' }
      if (!item || typeof item !== 'object') return item
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, ['snapshot', 'page', 'output', 'recovery', 'observation', 'correction'].includes(key) ? summarize(child) : child]))
    }
    return { key: `${tabId}:${page.frameId ?? args.frameId ?? 0}`, version: String(page.snapshotId), summary: summarize(value) }
  }
  private observe(value: any, tabId?: number) {
    if (!value || typeof value !== 'object') return
    if (value.snapshotId && Array.isArray(value.items)) {
      const id = value.tabId ?? tabId
      if (!allowedTab({ tabId: id, url: value.url }, this.options.origins)) throw new Error('ORIGIN_NOT_ALLOWED')
      this.pages.delete(id); this.pages.set(id, { ...value, tabId: id })
      while (this.pages.size > 12) this.pages.delete(this.pages.keys().next().value!)
    }
    for (const key of ['snapshot', 'page', 'output']) if (value[key] && value[key] !== value) this.observe(value[key], tabId)
  }
  private format(value: any): any {
    if (!value || typeof value !== 'object') return value
    if (value.snapshotId && Array.isArray(value.items)) return { ...modelPageObservation(value, { compact: true }), tabId: value.tabId, ...(value.frameId === undefined ? {} : { frameId: value.frameId }) }
    if (Array.isArray(value)) return value.map(item => this.format(item))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ['snapshot', 'page', 'output'].includes(key) ? this.format(item) : item]))
  }
  getInspection(page: any, ref: string): any {
    this.getPage(page.tabId, page.snapshotId)
    return this.inspections.get(page)?.get(ref)
  }
  private mergeInspection(args: Record<string, any>, detail: any, inspection?: any) {
    const page = this.getPage(args.tabId, args.snapshotId)
    const item = page.items?.find((item: any) => item.ref === args.ref)
    if (item) {
      Object.assign(item, detail)
      const refs = this.inspected.get(page) ?? new Set<string>(); refs.add(args.ref); this.inspected.set(page, refs)
      if (inspection) {
        const details = this.inspections.get(page) ?? new Map<string, any>()
        details.set(args.ref, inspection); this.inspections.set(page, details)
      }
    }
  }
  async inspectRefs(page: any, refs: string[], signal = this.options.signal, reuse = false, includeDom = false) {
    // The extension stores node signatures in one record per snapshot; serial
    // inspections avoid competing read/modify/write updates of that record.
    const task = (this.inspectTails.get(page.tabId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (page.format !== 'semantic' && !includeDom) return
      if (includeDom && !this.tools.some(tool => tool.name === 'browser_inspect_element')) return
      for (const ref of [...new Set(refs)]) {
        signal.throwIfAborted()
        this.getPage(page.tabId, page.snapshotId)
        if (reuse && this.inspected.get(page)?.has(ref)) continue
        const item = page.items?.find((item: any) => item.ref === ref)
        if (!item) throw new Error('ELEMENT_NOT_FOUND')
        const detail = await this.call('browser_inspect_element', { tabId: page.tabId, snapshotId: page.snapshotId, documentId: page.documentId, ref,
          policy: { allowedOrigins: [...this.options.origins], riskLevel: 'read' } }, signal)
        if (!detail?.item && !detail?.element) throw new Error('SEMANTIC_DETAILS_UNAVAILABLE')
        signal.throwIfAborted()
        this.mergeInspection({ tabId: page.tabId, snapshotId: page.snapshotId, ref }, detail.item ?? {}, detail)
      }
    })
    this.inspectTails.set(page.tabId, task)
    await task
  }
  candidateContext(page: any, refs: string[], name: string) {
    for (const ref of refs) {
      const item = page.items?.find((item: any) => item.ref === ref)
      const context = item?.contextCandidates?.find((context: any) => normalized(context.text).replace(/\s/g, '').includes(normalized(name).replace(/\s/g, '')))
      if (context) item.context = context
    }
  }
}
