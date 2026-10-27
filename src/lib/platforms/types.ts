import type { AgentBrowserCall, AgentBrowserTools } from '../agent-browser-tools.js'
import type { PositionEvidence, PositionOutcome } from '../position-evidence.js'
import type { GreetingJob, PlatformCandidateIdentity } from '../../shared/workbench.js'
import type { SourcingCandidate, SourcingSearchFilters, CommunicationSyncResult } from '../../shared/sourcing.js'
import type { Store } from '../store.js'
import type { SourcingDriver, SourcingDriverContext } from '../sourcing/types.js'
import type { PositionTitleAlias } from '../position-controls.js'
import type { VisualResume } from '../sourcing/visual-resume.js'
import type { ReceivedResumeRecord } from '../received-resume-store.js'
import type { CapturedFile } from '../file-transfer.js'

export type ResumeCaptureContext = {
  broker: AgentBrowserTools; page: any; candidate: { name: string; listText: string }
  input: { identityRef: string; resumeRefs: string[] }; signal: AbortSignal
  readVisual(page: any, name: string, signal: AbortSignal): Promise<VisualResume>
}

export type CommunicationSource = 'chat' | 'received_list'
export type CommunicationSyncRow = CommunicationSyncResult['platforms'][number] & { updated: number }
/** 沟通状态读取的纯页面能力：只做 URL/节点语义判断，不触网、不产生写操作。
 *  平台差异留在这里，通用流程不再按平台名分支。 */
export interface PlatformCommunication {
  /** 读取状态时需要依次访问的页面；第一项用于新建标签页。 */
  entries: readonly string[]
  /** 当前页面属于哪类可读列表；其它页面返回 undefined。 */
  scope(page: any): CommunicationSource | undefined
  /** 从已 inspect 的节点解析平台业务 ID。没有稳定 ID 的平台可以省略。 */
  identity?(node: any, source: CommunicationSource): string[]
  /** 平台实际展示的列表筛选；空数组表示不支持该视图，不能借用其它筛选的语义。 */
  filters?: Partial<Record<'all' | 'greeted' | 'resume_received', readonly string[]>>
  /** 沟通卡片没有年龄或资料链接时，提供可 inspect 的记录锚点。 */
  recordSeed?(item: any): boolean
  /** 标记「收到简历」卡片的外层类名，用于区分接收记录与普通会话。 */
  receivedWrapper?: string
}
/** 网络响应型同步的平台差异。省略时走通用 DOM 读取。 */
export interface PlatformCommunicationSync {
  origins?: readonly string[]
  hostTools?: string[]
  sync(broker: AgentBrowserTools, candidates: SourcingCandidate[], store: Store, signal: AbortSignal): Promise<CommunicationSyncRow>
}
/** 打招呼的平台差异：是否只允许点击当前候选人的单人招呼按钮。 */
export interface PlatformGreeting {
  requireDirectButton?: boolean
}
/** 简历入库读取「平台已收简历」时的平台差异。入口 URL 仍以 definition.receivedEntry 为准。 */
export interface PlatformReceivedResumes {
  /** 收到简历列表路径，用于核验当前页面确实在接收列表。 */
  receivedPath?: string
  /** 该列表下必须选中的 tab 名称。 */
  requiredTab?: string
  /** 平台「全部职位」筛选项的 elementId。 */
  allPositionsElementId?: string
  /** 注入入库 Agent 的平台路径说明；不同平台的入口页面和 tab 完全不同。 */
  guidance?: string
}

export type SearchControl = { kind: 'position' | 'position_confirm' | 'job_option' | 'filter' | 'filter_open' | 'confirm' | 'search'; field?: string; selected: boolean; active: boolean; expanded: boolean }
export type FilterProof = { field: string; ref: string; quote: string; state?: string }
export interface SearchEvidence {
  enabled(page: any): boolean
  inspect(page: any, refs: string[], signal: AbortSignal, reuse?: boolean): Promise<void>
  control(page: any, ref: string): SearchControl | undefined
  position(page: any, job: Pick<GreetingJob, 'jobId' | 'jobName' | 'platformJobs'>, proof: PositionEvidence): PositionOutcome | undefined
  scan(page: any, names: string[], expected: SourcingSearchFilters, signal: AbortSignal): Promise<void>
  completeFilterProofs<T extends FilterProof>(page: any, proofs: T[]): T[]
  filterPage(page: any, proofs: { ref: string; field: string }[]): any
  summary(page: any, expected?: SourcingSearchFilters): Record<string, unknown>
}
export interface PositionRoute {
  assertInput(call: AgentBrowserCall, page: any): void
  allowsChoice(call: AgentBrowserCall, page: any): boolean
  isSelectedTrigger(tabId: number, page: any, ref: string): boolean
  dispatch(call: AgentBrowserCall, page: any, dispatch: () => Promise<any>, verifiedTrigger?: boolean): Promise<any>
}
/** 纯元数据 + 纯页面判断，供通用流程与既有预设共用；不 import 任何浏览器驱动。 */
export interface PlatformDefinition {
  sourcingEntry: string
  /** 同一推荐来源的内嵌文档地址；只识别帧快照的页面归属，
   *  顶层导航始终使用 sourcingEntry，不单独打开这些文档。 */
  sourcingEntryAliases?: readonly string[]
  sourcingSearchEntry?: string
  receivedEntry: string
  listPaths: readonly string[]
  receivedTab?: string
  greetingLabels: ReadonlySet<string>
  /** 推荐页职位控件在名称后带的业务后缀（如猎聘「高交付」）。 */
  positionAlias?: PositionTitleAlias
  communication?: PlatformCommunication
  greeting?: PlatformGreeting
  receivedResumes?: PlatformReceivedResumes
}
/** Website paths, prompts and custom controls have one owner. Workflow code
 * consumes this contract and never selects an implementation by hostname. */
export interface RecruitmentPlatform {
  receivedAttachment?: {
    acceptsUrl(url: URL): boolean
    refresh(broker: AgentBrowserTools, candidate: SourcingCandidate, row: ReceivedResumeRecord, store: Store, signal: AbortSignal,
      capture?: boolean): Promise<ReceivedResumeRecord | { record: ReceivedResumeRecord; file: CapturedFile }>
  }
  candidateIdentity?(page: any, refs: string[], broker: AgentBrowserTools): PlatformCandidateIdentity | undefined
  /** Normalize known UI state within a verified single card; never join names. */
  candidateTextIdentity?(text: string): { canonical: string; aliases: string[] }
  sourcingEntry: string
  sourcingEntryAliases?: readonly string[]
  sourcingSearchEntry?: string
  sourcingHints: string
  sourcingSearchHints?: string
  /** 平台自有的详情读取，例如已打开的图片简历；列表摘要不能进入此通道。 */
  readResume?(context: ResumeCaptureContext): Promise<{ page: any; resumeText: string; truncated: boolean; foregroundSource?: string;
    evidence?: { kind: 'visual'; imageHashes: string[]; pages: number } } | undefined>
  allowsNavigation?(page: any, ref: string, broker: AgentBrowserTools): boolean
  observationFormat?: 'dom' | 'semantic'
  createSearchEvidence(broker: AgentBrowserTools): SearchEvidence
  createPositionRoute(names: string[], sourceMode?: 'recommend' | 'search'): PositionRoute
  createSourcingDriver?(context: SourcingDriverContext): SourcingDriver
  /** 沟通状态同步。纯页面能力放在 definition，重实现放在这里。 */
  communicationSync?: PlatformCommunicationSync
  greeting?: PlatformGreeting
  receivedResumes?: PlatformReceivedResumes
}

/** Unsupported custom controls fall back to the common AX/DOM verifiers. */
export class StandardSearchEvidence implements SearchEvidence {
  enabled(_page: any) { return false }
  async inspect(_page: any, _refs: string[], _signal: AbortSignal) {}
  control(_page: any, _ref: string): SearchControl | undefined { return undefined }
  position(_page: any, _job: Pick<GreetingJob, 'jobId' | 'jobName' | 'platformJobs'>, _proof: PositionEvidence): PositionOutcome | undefined { return undefined }
  async scan(_page: any, _names: string[], _expected: SourcingSearchFilters, _signal: AbortSignal) {}
  completeFilterProofs<T extends FilterProof>(_page: any, proofs: T[]): T[] { return proofs }
  filterPage(page: any, _proofs: { ref: string; field: string }[]) { return page }
  summary(_page: any) { return {} }
}
export class StandardPositionRoute implements PositionRoute {
  assertInput(_call: AgentBrowserCall, _page: any) {}
  allowsChoice(_call: AgentBrowserCall, _page: any) { return false }
  isSelectedTrigger(_tabId: number, _page: any, _ref: string) { return false }
  dispatch(_call: AgentBrowserCall, _page: any, dispatch: () => Promise<any>) { return dispatch() }
}
