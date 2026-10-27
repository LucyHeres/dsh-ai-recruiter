export type TaskKind = 'greeting' | 'resume_import' | 'talent_sourcing'
export interface TaskFeature {
  kind: TaskKind
  label: string
  description: string
  available: boolean
  progressLabel: string
  unit: string
}
export const TASK_FEATURES: readonly TaskFeature[] = [
  { kind: 'greeting', label: '打招呼', description: '按设定条件主动沟通人才', available: true, progressLabel: '已打招呼', unit: '人' },
  { kind: 'resume_import', label: '简历入库', description: '批量采集已收简历并上传薪人薪事', available: true, progressLabel: '已成功入库', unit: '份' },
  { kind: 'talent_sourcing', label: '人才寻聘', description: '按职位要求搜索人才、阅读简历并分析匹配度', available: true, progressLabel: '已评估候选人', unit: '人' },
]
export const taskFeature = (kind: TaskKind = 'greeting') => TASK_FEATURES.find(feature => feature.kind === kind) ?? TASK_FEATURES[0]

/** 平台词表与元数据的唯一事实来源。新增平台只在这里登记一次，
 *  Platform 联合类型由 key 推导，不再需要同步修改第二处。 */
export const PLATFORMS = {
  liepin: { label: '猎聘', channelType: 4, url: 'https://lpt.liepin.com/recommend', searchUrl: 'https://lpt.liepin.com/search',
    origins: ['https://lpt.liepin.com', 'https://www.liepin.com', 'https://passport.liepin.com'] },
  boss: { label: 'BOSS 直聘', channelType: 11, url: 'https://www.zhipin.com/web/chat/recommend', searchUrl: undefined,
    origins: ['https://www.zhipin.com', 'https://login.zhipin.com'] },
} as const
export type Platform = keyof typeof PLATFORMS
/** 稳定的平台 key 顺序，供运行时 zod 枚举与遍历使用。 */
export const PLATFORM_KEYS = Object.keys(PLATFORMS) as [Platform, ...Platform[]]
// Temporary local test package; replace with the production download before release.
export const EXTENSION_INSTALL_URL = 'https://xinrenxinshi.oss-cn-beijing.aliyuncs.com/xinzhao/xinzhao_%E6%9C%AC%E5%9C%B0%E6%B5%8B%E8%AF%95%E7%89%88_v3.2.46.zip'
export const MINIMUM_EXTENSION_VERSION = '3.2.46'
/** 首次唤起 Chrome 扩展实测约 40s，留出余量避免过早报超时。 */
// The extension's local probe may back off for 60s before starting its handshake.
export const ENSURE_TIMEOUT_SECONDS = 90
export interface ExtensionInstallation {
  status: 'installed' | 'not_installed' | 'outdated' | 'unknown'
  version?: string
  detail: string
  source: 'connection' | 'browser_profile'
  checkedAt: string
}
export interface ConnectionState {
  gateway: boolean
  connected: boolean
  authenticated: boolean
  extensionVersion?: string
  ready: boolean
  available: boolean
  busy: boolean
  /** Actual local connection attempt, separate from a queued/preparing task. */
  connecting?: boolean
  requiresBegin: boolean
  executionOwner: string | null
  activeWorkflow: boolean
  detail: string
}
export type TaskResultStage = 'sending' | 'succeeded' | 'unknown' | 'skipped' | 'failed'
/** Observed website identity, never supplied by the task model. */
export type PlatformCandidateIdentity = { kind: 'resume'; id: string; source: 'card_class' }
export interface TaskResult {
  key: string
  name: string
  stage: TaskResultStage
  detail: string
  updatedAt: string
  attemptedAt?: string
  clickedAt?: string
  confirmedAt?: string
  retryable?: boolean
  /** 仅存身份来源类型，原文证据不进入历史记录。 */
  identityKind?: 'url' | 'text' | 'platform_id'
  platformIdentity?: PlatformCandidateIdentity
  /** Hashes of verified older identity formats for cross-version history. */
  identityAliases?: string[]
}
export interface WorkbenchJob {
  /** Display history was cleared; minimal execution receipts may remain. */
  historyCleared?: boolean
  /** Talent data was cleared; retained write receipts are excluded from live metrics. */
  talentCleared?: boolean
  kind: TaskKind
  id: string
  platform: Platform
  tabId?: number
  source?: 'workbench' | 'chat'
  sessionId?: string
  platformJobName?: string
  jobName?: string
  jobId?: string
  destinationLabel?: string
  resumeSource?: 'platform_received'
  limit: number
  phase?: string
  nextActionAt?: string
  /** source=model 表示这是模型自述，不是已核验事实；缺省为宿主工具级事实。 */
  events?: { at: string; message: string; source?: 'model' | 'host' }[]
  diagnosis?: ResumeDiagnosis
  status: 'queued' | 'running' | 'stopping' | 'completed' | 'stopped' | 'failed' | 'unknown'
  createdAt: string
  updatedAt: string
  detail: string
  results: TaskResult[]
}
export interface ResumeDiagnosis {
  at: string
  url: string
  title: string
  summary: string
  steps: string[]
  elementCount: number
  candidateCount: number
  reasons: { reason: string; count: number }[]
  samples: { role: string; text: string; reason: string }[]
}
export type GreetingStage = TaskResultStage
export type GreetingResult = TaskResult
export interface GreetingJob extends WorkbenchJob {
  kind: 'greeting'
  mode?: 'recommend' | 'search'
  search?: { keyword: string; city?: string; ageUnder?: number; experienceMin?: number; experienceMax?: number }
  jobId?: string
  jobName?: string
  platformJobs?: { id: string; name: string }[]
  selectedPlatformJob?: { id: string; name: string }
  intervalMinSeconds?: number
  intervalMaxSeconds?: number
}
/** 搜索模式只对有搜索入口的平台生效，入口 URL 统一来自 PLATFORMS。 */
export const greetingEntry = (job: Pick<GreetingJob, 'platform' | 'mode'>) => {
  const platform = PLATFORMS[job.platform]
  return job.mode === 'search' && platform.searchUrl ? platform.searchUrl : platform.url
}
export interface WorkbenchState {
  features: TaskFeature[]
  connection: ConnectionState
  extensionInstallation: ExtensionInstallation
  jobs: WorkbenchJob[]
  activeJobId: string | null
  nativeConnection: { registered: boolean; error: string }
  dailyUsage: Record<Platform, number>
  dailyLimit: number
}
export interface DeveloperLogs {
  directory: string
  level: string
  runId: string
  taskId?: string
  lines: string[]
  truncated: boolean
  dropped: number
  writeFailed: boolean
}
export interface BrowserTab { tabId: number; title: string; url: string }

export interface PublishedChannel { id: string; name: string }
export interface JobOption { id: string; name: string; label: string; department?: string; city?: string; code?: string; platforms?: Platform[]; publishedChannels?: PublishedChannel[] }

/** 上传位置的「大库」取值；与 resumeLibraryStatus 组合后唯一确定入库位置。 */
export const RESUME_LIBRARIES = { newResume: 1, talentBank: 4 } as const
/** 新简历下的小状态。人才库时该值改为人才库分类 ID，所以不放进枚举里。 */
export const RESUME_LIBRARY_STATUSES = { pending: 10, undetermined: 11 } as const
/** 投递类型选项；未选择时按被动投递处理（服务端默认值）。 */
export const DELIVERY_TYPE_OPTIONS = [
  { id: '1', label: '被动投递', deliveryType: 1 },
  { id: '0', label: '主动投递', deliveryType: 0 },
] as const
/** 表单默认选中值：新简历 · 未处理、默认渠道、被动投递。 */
export const RESUME_DEFAULTS = {
  destination: '1:10',
  channel: '0',
  delivery: '1',
} as const

export interface ResumeOptions {
  jobs: { id: string; label: string }[]
  destinations: { id: string; label: string; resumeLibrary: number; resumeLibraryStatus: number }[]
  channels: { id: string; label: string; channelType: number; requires?: string }[]
  deliveries: { id: string; label: string; deliveryType: number }[]
  defaults: { destination: string; channel: string; delivery: string }
}
