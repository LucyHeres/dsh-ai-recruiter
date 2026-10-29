import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeftIcon, ArrowRightIcon, GearIcon, ChevronDownIcon, ExternalLinkIcon, PlayIcon, ReloadIcon, StopIcon, DownloadIcon, FileTextIcon, CheckIcon, UploadIcon, MixerHorizontalIcon, CheckCircledIcon, ExclamationTriangleIcon, BackpackIcon, ReaderIcon, MagnifyingGlassIcon, Cross2Icon } from '@radix-ui/react-icons'
import { PLATFORMS, type JobOption, type Platform, type WorkbenchJob, type WorkbenchState } from '../../shared/workbench.js'
import { SelectMenu } from '../components/select-menu.js'
import { SidePanel } from '../components/side-panel.js'
import { JobDescription } from '../components/job-description.js'
import type { CommunicationSyncResult, SourcingCandidateDetail, SourcingJob, SourcingPosition, SourcingResults, SourcingResultCandidate, ReceivedResumeAttachment, ResumeDownloadChunk, CandidateListProfile } from '../../shared/sourcing.js'
import { readResumeDownload } from '../received-resume-download.js'
import { sourcingRunNotice } from '../../shared/sourcing-status.js'
import { communicationLabels, communicationState, greetingLabel, greetingDetail, greetingNotice, hasGreeted } from '../../shared/communication.js'
import { DEFAULT_MINIMUM_SCORE, sourcingMinimumScore, sourcingCriterionScore, sourcingTotalTarget, sourcingTierLabels } from '../../shared/sourcing-score.js'
import { sourcingPlatformsForChannels } from '../../shared/published-channels.js'
import { renderPlatformTag } from '../components/platform-tag.js'
import { defaultSourcingSettings, SOURCING_MAX_LIMIT, withSourcingJobDescription, type SourcingSettings } from '../../shared/sourcing-settings.js'
import { isExtensionRequired, extensionNeedsSetup, extensionSetupMessage } from '../../shared/connection-status.js'
import { useResizableSplit } from '../components/resizable-split.js'

type Rpc = <T>(method: string, request?: unknown, signal?: AbortSignal) => Promise<T>
const stamp = (s: string) => new Date(s).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const roundStamp = (s: string) => new Date(s).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const states = { queued: '等待执行', running: '寻聘中', stopping: '停止中', completed: '本轮完成', stopped: '已停止', failed: '未完成', unknown: '已停止' }
const matches = { match: '符合', partial: '部分符合', mismatch: '明确不符', unknown: '材料未说明' }
const phases: Record<string, string> = { connecting: '正在连接浏览器扩展', preparing: '正在整理职位要求', searching: '正在准备推荐人才', reading: '正在读取候选人简历', evaluating: '正在评估匹配度', greeting: '正在核对身份并打招呼' }
const channelStates = { queued: '等待中', running: '寻聘中', completed: '已完成', stopped: '已停止', failed: '未完成' }
type CandidateFilters = { score: string; communication: string; received: string; platform: string }
type TalentNotice = { message: string; error?: boolean }
const emptyFilters: CandidateFilters = { score: 'all', communication: 'all', received: 'all', platform: 'all' }
/** Result toasts carry a full sync summary; keep them readable before auto-dismiss. */
const NOTICE_DURATION_MS = 6000

function SourcingLoadingDots() {
  return <span className="air-sourcing-loading-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
}

function resumeProgress(person: Pick<SourcingResultCandidate, 'communication' | 'resumeReceived' | 'resumeAttachments'>) {
  const steps = [
    { label: '打招呼', done: communicationState(person.communication) === 'recorded', status: communicationLabels[communicationState(person.communication)] },
    { label: '获取简历', done: !!person.resumeReceived || !!person.resumeAttachments?.length, status: '未获取简历' },
    { label: '简历入库', done: !!person.resumeAttachments?.some(file => file.uploadedAt), status: '未入库' },
  ]
  return <ol className="air-resume-progress" aria-label="简历流程进度">{steps.map((step, index) => <li key={step.label} className={`air-resume-progress-step${step.done ? ' is-complete' : ''}${index > 0 && step.done && steps[index - 1].done ? ' is-connected' : ''}`} aria-label={step.done ? `${step.label}已完成` : step.status} title={step.done ? `${step.label}已完成` : step.status}>
    <span className="air-resume-progress-node" aria-hidden="true">{step.done && <CheckIcon />}</span><span>{step.label}</span>
  </li>)}</ol>
}

function historySummary(profile: CandidateListProfile | undefined, kind: 'work' | 'education') {
  const rows = profile?.[kind] ?? [], Icon = kind === 'work' ? BackpackIcon : ReaderIcon
  const label = kind === 'work' ? '工作经历' : '教育经历'
  return <section className={`air-person-history is-${kind}`} aria-label={label}>
    <Icon aria-hidden="true" />
    {rows.length ? <ul>{rows.slice(0, 2).map((row, index) => <li key={`${row.organization}:${index}`}>
      <span className="air-person-history-text"><span title={row.organization}>{row.organization}</span>{row.description && <span title={row.description}>{row.description}</span>}</span>
      {row.period && <span className="air-person-history-period" title={row.period}>{row.period}</span>}
    </li>)}</ul> : <span className="air-person-history-empty">未展示{label}</span>}
  </section>
}

function candidateBasics(person: SourcingResultCandidate) {
  const basic = ['工作经验', '学历'].flatMap(label => person.fields.filter(field => field.label === label))
  const age = person.listProfile?.age?.replace(/\s+/g, '')
  const expectation = [person.listProfile?.expectation?.city, person.listProfile?.expectation?.role].filter(Boolean).join(' · ')
  return <div className="air-person-basics" aria-label="基础信息">
    <p className="air-person-basic-line">{age && <span>{age}</span>}{basic.map(field => <span key={field.label}>{field.label === '工作经验' ? field.value.replace(/^工作(?:经验)?\s*/, '').replace(/\s+(?=年)/g, '') : field.value}</span>)}{!basic.length && !age && <span>基础信息未展示</span>}</p>
    <p className="air-person-expectation" title={`期望：${expectation || '未展示'}`}><span className="air-person-expectation-label">期望：</span>{expectation || '未展示'}</p>
    {!person.listProfile?.work.length && <p className="air-person-current-company" title={person.fields.find(field => field.label === '公司')?.value}>{person.fields.find(field => field.label === '公司')?.value}</p>}
  </div>
}

function matchesCandidateSearch(person: SourcingResultCandidate, terms: string[]) {
  if (!terms.length) return true
  const profile = person.listProfile
  const text = [person.name, ...person.fields.map(field => field.value), profile?.age,
    profile?.expectation?.city, profile?.expectation?.role,
    ...[...(profile?.work ?? []), ...(profile?.education ?? [])].flatMap(row => [row.organization, row.description]),
  ].filter(Boolean).join('\n').normalize('NFKC').toLowerCase()
  return terms.every(term => text.includes(term))
}

export function SourcingPanel({ rpc, state, locked, pending, busy, blockingReason = '', onStart, onReconcile, onRequireExtension, selectedTaskId, selectedRecord, positionId, compact = false, positions, executionId }: {
  positionId?: string; rpc: Rpc; state?: WorkbenchState; locked: boolean; pending: boolean; busy: string; selectedTaskId?: string; selectedRecord?: WorkbenchJob
  compact?: boolean; positions?: JobOption[]
  blockingReason?: string
  /** Undefined permits workbench history; null means this conversation has no execution. */
  executionId?: string | null
  onStart: (settings: Record<string, unknown>) => void; onReconcile: () => void
  onRequireExtension?: () => void
}) {
  const [jobs, setJobs] = useState<JobOption[]>([])
  const [jobsLoading, setJobsLoading] = useState(false)
  const [jobId, setJobId] = useState(positionId || '')
  const [position, setPosition] = useState<SourcingPosition>()
  const [positionLoading, setPositionLoading] = useState(false)
  const [supplement, setSupplement] = useState('')
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [limit, setLimit] = useState(20)
  const [results, setResults] = useState<SourcingResults>()
  const [roundId, setRoundId] = useState('all')
  const resultRoundId = executionId === undefined ? roundId : executionId
  const [detailData, setDetailData] = useState<SourcingCandidateDetail>()
  const [view, setView] = useState<'requirements' | 'results'>('results')
  const [selectedKey, setSelectedKey] = useState('')
  const [filter, setFilter] = useState<CandidateFilters>(emptyFilters)
  const [detail, setDetail] = useState<'analysis' | 'resume'>('analysis')
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [mobileDetail, setMobileDetail] = useState(false)
  const [sort, setSort] = useState('newest')
  const [detailLoading, setDetailLoading] = useState(false)
  const [progressExpanded, setProgressExpanded] = useState(state?.jobs.some(row => row.id === state.activeJobId && row.kind === 'talent_sourcing' && (row as SourcingJob).jobId === (positionId || jobId)) ?? false)
  const [minimumScore, setMinimumScore] = useState(DEFAULT_MINIMUM_SCORE)
  const [syncingCommunication, setSyncingCommunication] = useState(false)
  const [communicationNotice, setCommunicationNotice] = useState<TalentNotice>()
  const [startingUpload, setStartingUpload] = useState(false)
  const [downloading, setDownloading] = useState('')
  const [jobDescription, setJobDescription] = useState<string>()
  const [candidateQuery, setCandidateQuery] = useState('')
  const candidateSearch = useRef<HTMLInputElement>(null)
  const communicationRequest = useRef<AbortController>()
  const downloadRequest = useRef<AbortController>()
  const uploadRequest = useRef<AbortController>()
  const settingsJobId = useRef(jobId)
  settingsJobId.current = jobId
  const filterMenu = useRef<HTMLDetailsElement>(null), feedbackMenu = useRef<HTMLDetailsElement>(null), attachmentMenu = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    setCommunicationNotice(undefined); setSyncingCommunication(false); setStartingUpload(false); setDownloading('')
    return () => { communicationRequest.current?.abort(); communicationRequest.current = undefined; downloadRequest.current?.abort(); downloadRequest.current = undefined; uploadRequest.current?.abort(); uploadRequest.current = undefined }
  }, [jobId])
  useEffect(() => {
    if (!communicationNotice) return
    const timer = setTimeout(() => setCommunicationNotice(current => current === communicationNotice ? undefined : current), NOTICE_DURATION_MS)
    return () => clearTimeout(timer)
  }, [communicationNotice])
  useEffect(() => {
    const menus = [filterMenu, feedbackMenu, attachmentMenu]
    const dismiss = (event: PointerEvent) => {
      for (const menu of menus) if (event.target instanceof Node && !menu.current?.contains(event.target) && menu.current) menu.current.open = false
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      for (const menu of menus) if (menu.current?.open) {
        menu.current.open = false; menu.current.querySelector('summary')?.focus(); event.preventDefault()
      }
    }
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape) }
  }, [])
  useEffect(() => {
    if (filterMenu.current) filterMenu.current.open = false
    if (feedbackMenu.current) feedbackMenu.current.open = false
    if (attachmentMenu.current) attachmentMenu.current.open = false
  }, [jobId, view])
  const positionChannels = position?.id === jobId ? position.publishedChannels : undefined
  const availablePlatforms = position?.id === jobId ? positionChannels ? sourcingPlatformsForChannels(positionChannels) : position.platforms ?? [] : []
  const selectedPlatforms = platforms.filter(platform => availablePlatforms.includes(platform))
  useEffect(() => {
    setPlatforms(previous => {
      const retained = previous.filter(platform => availablePlatforms.includes(platform))
      return retained.length || !previous.length ? retained : availablePlatforms
    })
  }, [jobId, position?.id, availablePlatforms.join(',')])
  useEffect(() => { if (positionId && positionId !== jobId) changeJob(positionId) }, [positionId])
  const detailPane = useRef<HTMLElement>(null), listPane = useRef<HTMLDivElement>(null), wasMobileDetail = useRef(false)
  const activeJob = state?.jobs.find(row => row.id === state.activeJobId)
  const activeUpload = activeJob?.resumeSource === 'platform_received' && activeJob.jobId === jobId && ['queued', 'running', 'stopping'].includes(activeJob.status) ? activeJob : undefined
  const currentActive = activeJob?.kind === 'talent_sourcing' && (activeJob as SourcingJob).jobId === jobId && (executionId === undefined || activeJob.id === executionId) && ['queued', 'running', 'stopping'].includes(activeJob.status)
  useEffect(() => { if (currentActive) setProgressExpanded(true) }, [currentActive])
  useEffect(() => { if (executionId !== undefined) { setSelectedKey(''); setDetailData(undefined); setMobileDetail(false); setDetail('analysis'); setError('') } }, [executionId])

  useEffect(() => {
    if (positions) { setJobs(positions); return }
    const abort = new AbortController(); setJobsLoading(true)
    rpc<JobOption[]>('greetingJobOptions', {}, abort.signal).then(value => { if (!abort.signal.aborted) { setJobs(value); setError('') } })
      .catch(e => { if (!abort.signal.aborted) setError(String(e.message || e)) }).finally(() => { if (!abort.signal.aborted) setJobsLoading(false) })
    return () => abort.abort()
  }, [rpc, reload, positions])
  useEffect(() => {
    if (!jobId) return
    const abort = new AbortController(); setPositionLoading(true)
    rpc<SourcingPosition>('sourcingPosition', { jobId }, abort.signal).then(value => {
      if (abort.signal.aborted) return
      const settings = value.settings ?? defaultSourcingSettings()
      const available = value.publishedChannels ? sourcingPlatformsForChannels(value.publishedChannels) : value.platforms ?? []
      setPosition(value); setSupplement(settings.supplement); setLimit(settings.limit); setMinimumScore(settings.minimumScore)
      setJobDescription(settings.jobDescription)
      setPlatforms(settings.platforms === undefined ? available : settings.platforms.filter(platform => available.includes(platform)))
    })
      .catch(e => { if (!abort.signal.aborted) setError(String(e.message || e)) }).finally(() => { if (!abort.signal.aborted) setPositionLoading(false) })
    return () => abort.abort()
  }, [jobId, rpc, reload])
  useEffect(() => {
    if (!jobId || !resultRoundId) { setLoading(false); return }
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>
    setLoading(true)
    const poll = async () => {
      try {
        const value = await rpc<SourcingResults>('sourcingResults', { jobId, roundId: resultRoundId }, abort.signal)
        if (!abort.signal.aborted) { setResults(value); setLoading(false) }
      } catch (error) { if (!abort.signal.aborted) { setError(error instanceof Error ? error.message : String(error)); setLoading(false) } }
      finally { if (!abort.signal.aborted) timer = setTimeout(poll, 2000) }
    }
    void poll(); return () => { abort.abort(); clearTimeout(timer) }
  }, [jobId, resultRoundId, rpc, reload])
  useEffect(() => {
    if (selectedTaskId && selectedTaskId !== selectedRecord?.id) setRoundId('all')
  }, [selectedTaskId])
  useEffect(() => {
    if (selectedRecord?.kind !== 'talent_sourcing') return
    const record = selectedRecord as SourcingJob
    if (record.jobId !== jobId) changeJob(record.jobId)
    setRoundId(record.id); setView('results')
  }, [selectedRecord])

  const displayedResults = resultRoundId && results?.jobId === jobId && results.roundId === resultRoundId ? results : undefined
  const displayedRun = executionId === undefined || displayedResults?.current?.id === executionId ? displayedResults?.current : undefined
  const rounds = executionId === undefined ? displayedResults?.rounds ?? (results?.jobId === jobId ? results.rounds : []) : displayedResults?.rounds.filter(round => round.id === executionId) ?? []
  const { splitRoot, splitHandle } = useResizableSplit(!compact && view === 'results' && !!jobId && (!!displayedResults || rounds.length > 0))
  const allCandidates = (displayedResults?.candidates ?? []).filter(row => executionId === undefined || row.roundId === executionId)
  const searchTerms = candidateQuery.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const candidates = allCandidates.filter(row =>
    (!row.scoring?.needsReview && row.score >= sourcingMinimumScore(row)) && (filter.score === 'all' || row.score >= Number(filter.score))
    && (filter.communication === 'all' || communicationState(row.communication) === filter.communication)
    && ((filter.received ?? 'all') === 'all' || (filter.received === 'received' ? !!row.resumeReceived : !row.resumeReceived))
    && (filter.platform === 'all' || row.platform === filter.platform)
    && matchesCandidateSearch(row, searchTerms))
    .slice().sort((a, b) => {
      const newer = (Date.parse(b.collectedAt) || 0) - (Date.parse(a.collectedAt) || 0)
      return (sort === 'newest' ? newer : sort === 'score-asc' ? a.score - b.score : sort === 'coverage-desc' ? b.coverage - a.coverage : b.score - a.score) || newer || a.resultKey.localeCompare(b.resultKey)
    })
  const selected = candidates.find(row => row.resultKey === selectedKey) ?? candidates[0]
  useEffect(() => { if (attachmentMenu.current) attachmentMenu.current.open = false }, [selected?.resultKey])
  useEffect(() => { if (selected && selected.resultKey !== selectedKey) setSelectedKey(selected.resultKey) }, [selected?.resultKey, selectedKey])
  const revision = rounds.find(round => round.id === selected?.roundId)?.updatedAt
  useEffect(() => {
    if (!selected || compact && !mobileDetail) { setDetailLoading(false); return }
    const abort = new AbortController(); setDetailLoading(true)
    rpc<SourcingCandidateDetail>('sourcingCandidate', { jobId, id: selected.roundId, key: selected.key }, abort.signal)
      .then(value => { if (!abort.signal.aborted) setDetailData(value) })
      .catch(error => { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (!abort.signal.aborted) setDetailLoading(false) })
    return () => abort.abort()
  }, [rpc, jobId, selected?.resultKey, revision, reload, compact, mobileDetail])
  const displayedDetail = detailData?.jobId === jobId && detailData.roundId === selected?.roundId && detailData.candidate.key === selected?.key ? detailData : undefined
  const candidate = displayedDetail ? { ...displayedDetail.candidate,
    communication: communicationState(selected?.communication) === 'recorded' ? 'recorded' as const : communicationState(displayedDetail.candidate.communication),
    resumeReceived: !!(selected?.resumeReceived || displayedDetail.candidate.resumeReceived), resumeAttachments: selected?.resumeAttachments ?? displayedDetail.candidate.resumeAttachments } : undefined
  const pendingAttachmentIds = [...new Set(candidates.flatMap(person => (person.resumeAttachments ?? []).filter(file => !file.uploadedAt && !file.uploadStopped).map(file => file.id)))]
  const effectivePosition = position?.id === jobId ? withSourcingJobDescription(position, jobDescription) : undefined
  const validLimit = Number.isInteger(limit) && limit >= 1 && limit <= SOURCING_MAX_LIMIT
  const valid = !!effectivePosition && !!(effectivePosition.description.trim() || supplement.trim()) && selectedPlatforms.length > 0 && validLimit && Number.isInteger(minimumScore) && minimumScore >= 0 && minimumScore <= 100
  function changeJob(id: string) {
    setJobId(id); setPosition(undefined); setPlatforms([]); setResults(undefined); setRoundId('all'); setDetailData(undefined); setSupplement(''); setSelectedKey(''); setView('results'); setFilter(emptyFilters); setError(''); setMobileDetail(false)
    setLimit(20); setMinimumScore(DEFAULT_MINIMUM_SCORE)
    setJobDescription(undefined)
    setCandidateQuery('')
  }
  function persistSettings(settings: Partial<SourcingSettings>) {
    const target = jobId
    // Dispatch on change, without tying the write to a component's abort signal:
    // leaving this position must not cancel its last settings update.
    void rpc('saveSourcingSettings', { jobId: target, settings }).then(() => {
      if (settingsJobId.current === target) setError(current => current.startsWith('寻聘设置保存失败：') ? '' : current)
    }).catch(error => {
      if (settingsJobId.current === target) setError(`寻聘设置保存失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
  function changeView(next: 'requirements' | 'results') { setView(next) }
  function selectCandidate(key: string) { setSelectedKey(key); setDetail('analysis'); setMobileDetail(true) }
  function changeRound(id: string) { setRoundId(id); setSelectedKey(''); setDetail('analysis'); setMobileDetail(false) }
  useEffect(() => { detailPane.current?.scrollTo({ top: 0 }) }, [selected?.resultKey, detail])
  useEffect(() => {
    const pane = detailPane.current
    if (mobileDetail && pane && compact) {
      pane.focus({ preventScroll: true }); pane.scrollIntoView({ block: 'nearest' })
    } else if (!mobileDetail && wasMobileDetail.current && compact) {
      listPane.current?.querySelector<HTMLButtonElement>('.air-sourcing-person.is-selected .air-sourcing-person-select')?.focus({ preventScroll: true })
    }
    wasMobileDetail.current = mobileDetail
  }, [candidate ? selected?.resultKey : undefined, mobileDetail])
  const extensionRequired = extensionNeedsSetup(state?.extensionInstallation)
  function requireExtension() {
    if (!extensionRequired) return false
    if (onRequireExtension) onRequireExtension()
    else setError(extensionSetupMessage(state?.extensionInstallation))
    return true
  }
  async function syncCommunication() {
    if (!jobId || locked || syncingCommunication || startingUpload || communicationRequest.current) return
    if (requireExtension()) return
    const controller = new AbortController(); communicationRequest.current = controller
    setSyncingCommunication(true); setCommunicationNotice(undefined); setError('')
    try {
      const result = await rpc<CommunicationSyncResult>('syncCommunication', { jobId, roundId: resultRoundId ?? 'all' }, controller.signal)
      if (controller.signal.aborted) return
      const incomplete = result.platforms.some(row => row.status === 'partial' || row.status === 'failed')
      const scanned = result.platforms.reduce((sum, row) => sum + (row.scanned ?? 0), 0)
      const skipped = result.platforms.reduce((sum, row) => sum + (row.unidentified ?? 0), 0)
      const summary = incomplete ? `同步尚未完成。${scanned ? `已读取 ${scanned} 条平台记录。` : ''}`
        : skipped ? `可关联记录同步完成：核对 ${Math.max(0, result.checked - skipped)} 位候选人，匹配 ${result.matched} 人，更新 ${result.updated} 人；另跳过 ${skipped} 条缺少平台 ID 的历史记录。`
        : `本次核对 ${result.checked} 位候选人，匹配 ${result.matched} 人，更新 ${result.updated} 人。`
      setCommunicationNotice({ message: `${summary}${result.platforms.map(row => `${PLATFORMS[row.platform].label}：${row.detail}`).join('；')}`, error: incomplete })
      setReload(value => value + 1)
    } catch (error) {
      if (!controller.signal.aborted && isExtensionRequired(error) && onRequireExtension) onRequireExtension()
      else if (!controller.signal.aborted) setCommunicationNotice({ message: error instanceof Error ? error.message : String(error), error: true })
    }
    finally { if (communicationRequest.current === controller) { communicationRequest.current = undefined; setSyncingCommunication(false) } }
  }
  async function uploadReceived() {
    if (!jobId || !resultRoundId || locked || syncingCommunication || startingUpload || uploadRequest.current || !pendingAttachmentIds.length) return
    const controller = new AbortController(); uploadRequest.current = controller
    setStartingUpload(true); setError(''); setCommunicationNotice(undefined)
    try {
      await rpc<WorkbenchJob>('uploadReceivedResumes', { id: crypto.randomUUID(), jobId, roundId: resultRoundId, attachmentIds: pendingAttachmentIds }, controller.signal)
      if (controller.signal.aborted) return
      setCommunicationNotice({ message: '已开始上传当前筛选列表的附件简历，目标为当前职位 · 新简历 · 未处理。可在任务记录中查看每份结果。' })
      setReload(value => value + 1)
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (uploadRequest.current === controller) { uploadRequest.current = undefined; setStartingUpload(false) } }
  }
  async function downloadResume(person: SourcingResultCandidate, attachment: ReceivedResumeAttachment) {
    if (downloadRequest.current) return
    const controller = new AbortController(); downloadRequest.current = controller; setDownloading(attachment.id); setError('')
    try {
      const file = await readResumeDownload((offset, downloadId) => rpc<ResumeDownloadChunk>('downloadReceivedResume', { jobId, roundId: person.roundId, key: person.key, attachmentId: attachment.id, offset, ...(downloadId ? { downloadId } : {}) }, controller.signal), controller.signal)
      const url = URL.createObjectURL(file.blob), link = document.createElement('a')
      link.href = url; link.download = file.fileName; document.body.appendChild(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (downloadRequest.current === controller) { downloadRequest.current = undefined; setDownloading('') } }
  }
  function attachmentStatus(file: ReceivedResumeAttachment) {
    return file.uploadedAt ? '已入库' : file.uploadStopped ? activeUpload ? '正在上传…' : '上传已停止，请核对入库记录' : file.uploadError ? '上传失败，可重试' : '未入库'
  }
  function resumeDownload(person: SourcingResultCandidate) {
    const file = person.resumeAttachments?.[0]
    if (!file) return null
    return <button type="button" className="air-attachment-trigger air-person-download" title={`下载 ${file.fileName}（${attachmentStatus(file)}）`} aria-label={`下载${person.name}的附件简历：${file.fileName}`} aria-busy={downloading === file.id} disabled={!!downloading} onClick={() => void downloadResume(person, file)}><DownloadIcon aria-hidden="true" />{downloading === file.id ? '下载中…' : '下载'}</button>
  }
  function attachmentDownload(person: SourcingResultCandidate) {
    const files = person.resumeAttachments ?? []
    if (!files.length) return null
    const pending = files.some(file => file.id === downloading)
    const label = <><DownloadIcon aria-hidden="true" />{pending ? '下载中…' : '附件简历'}</>
    if (files.length === 1) return <button type="button" className="air-attachment-trigger" title={`${files[0].fileName}（${attachmentStatus(files[0])}）`} aria-label={`下载${person.name}的附件简历：${files[0].fileName}`} aria-busy={pending} disabled={!!downloading} onClick={() => void downloadResume(person, files[0])}>{label}</button>
    return <details className="air-attachment-menu" ref={attachmentMenu}>
      <summary className="air-attachment-trigger" aria-label={`${person.name}的附件简历，共 ${files.length} 份`} aria-busy={pending} aria-disabled={!!downloading} onClick={event => { if (downloading) event.preventDefault() }}>{label}</summary>
      <div className="air-attachment-popover" aria-label="选择要下载的附件简历">{files.map(file => <button type="button" key={file.id} className="air-attachment-option" title={file.uploadError || file.fileName} aria-label={`下载${person.name}的附件简历：${file.fileName}`} disabled={!!downloading} onClick={() => {
        if (attachmentMenu.current) { attachmentMenu.current.open = false; attachmentMenu.current.querySelector('summary')?.focus() }
        void downloadResume(person, file)
      }}><FileTextIcon aria-hidden="true" /><span><span>{file.fileName}</span><small>{attachmentStatus(file)}</small></span><DownloadIcon aria-hidden="true" /></button>)}</div>
    </details>
  }
  async function stopSourcing() {
    if (!currentActive || stopping) return
    setStopping(true)
    try { await rpc('stop', { id: state?.activeJobId }) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setStopping(false) }
  }
  const actionStopping = currentActive && (stopping || activeJob?.status === 'stopping')
  const actionDisabled = currentActive ? actionStopping : !jobId || locked || pending || !!busy || !extensionRequired && (positionLoading || !availablePlatforms.length)
  const actionLabel = currentActive ? actionStopping ? '正在停止…' : '停止寻聘' : busy ? '正在处理…' : '开始寻聘'
  const ActionIcon = currentActive ? StopIcon : PlayIcon
  const startDisabledReason = !jobId ? '请先选择招聘职位'
    : pending ? '启动结果尚未确认，请刷新任务状态'
    : busy ? '正在处理请求，请稍候'
    : locked ? blockingReason || (state?.activeJobId ? '当前招聘任务结束后可开始寻聘' : state?.connection?.busy || state?.connection?.activeWorkflow ? '浏览器正被其他任务占用，请稍候' : !state ? '正在读取任务状态，请稍候' : '任务状态暂不可用，请刷新后重试')
    : positionLoading ? '正在读取职位信息，请稍候'
    : position?.id !== jobId ? '职位信息读取未完成，请刷新后重试'
    : !availablePlatforms.length ? positionChannels?.length ? '当前发布渠道暂不支持自动寻聘' : '请先在薪人薪事设置职位发布渠道'
    : ''
  const settingsDisabledReason = startDisabledReason || (!(effectivePosition?.description.trim() || supplement.trim()) ? '请先补充职位说明或招聘要求'
    : !selectedPlatforms.length ? '请至少选择一个招聘平台'
    : !validLimit ? `目标打招呼人数须为 1–${SOURCING_MAX_LIMIT} 的整数`
    : !Number.isInteger(minimumScore) || minimumScore < 0 || minimumScore > 100 ? '最低匹配分须为 0–100 的整数' : '')
  function actionButton(settings = false) {
    const disabled = actionDisabled || settings && !currentActive && !extensionRequired && !valid
    const reason = disabled && !currentActive ? settings ? settingsDisabledReason : startDisabledReason : ''
    const hintId = `air-start-hint-${compact ? 'compact' : 'workbench'}-${settings ? 'settings' : 'progress'}`
    const button = <button type="button" className="air-button air-button-primary" disabled={disabled} aria-describedby={reason ? hintId : undefined} onClick={sourcingAction}><ActionIcon aria-hidden="true" />{actionLabel}</button>
    return reason ? <span className={`air-start-button-hint ${settings ? 'is-settings' : ''}`} tabIndex={0} aria-label="开始寻聘暂不可用" aria-describedby={hintId}>{button}<span id={hintId} className="air-start-tooltip" role="tooltip">{reason}</span></span> : button
  }
  function sourcingAction() {
    if (actionDisabled) return
    if (currentActive) { void stopSourcing(); return }
    if (requireExtension()) return
    if (!valid) { changeView('requirements'); return }
    setError(''); onStart({ jobId, platforms: selectedPlatforms, supplement, ...(jobDescription === undefined ? {} : { jobDescription }), limit, minimumScore, autoGreet: true, confirmed: true }); setView('results')
  }
  const hasFilters = searchTerms.length > 0 || executionId === undefined && roundId !== 'all' || Object.values(filter).some(value => value !== 'all')
  const activeFilterCount = Object.values(filter).filter(value => value && value !== 'all').length
  function resetFilters() { setFilter(emptyFilters); setCandidateQuery(''); changeRound('all') }
  function updateFilter(key: keyof CandidateFilters, value: string) { setFilter(previous => ({ ...previous, [key]: value })); setMobileDetail(false) }
  const candidateIndex = selected ? candidates.findIndex(row => row.resultKey === selected.resultKey) : -1
  const displayPosition = effectivePosition ?? displayedRun?.position
  const jobName = displayPosition?.name || jobs.find(job => job.id === jobId)?.name || '当前职位'
  const resumeFeedback = activeUpload?.status === 'stopping' ? '正在停止上传…' : '简历上传中'
  const basicRequirements = displayPosition?.basicRequirements
  const basicFields = [
    { label: '学历要求', value: basicRequirements?.education ?? displayPosition?.searchFields?.education },
    { label: '工作经验', value: basicRequirements?.experience ?? displayPosition?.searchFields?.experience },
    { label: '工作城市', value: basicRequirements?.city ?? displayPosition?.searchFields?.city ?? displayPosition?.city },
    { label: '薪酬范围', value: basicRequirements?.salary },
  ].filter(field => field.value)
  const descriptionText = displayPosition?.jobDescription?.text ?? displayPosition?.description
  const batchRunning = displayedRun && ['queued', 'running', 'stopping'].includes(displayedRun.status)
  return <section className={`air-sourcing ${compact ? 'is-compact' : ''} ${view === 'requirements' ? 'is-settings-open' : ''}`} aria-label="人才寻聘">
    {communicationNotice && <div className={`air-feedback-toast${communicationNotice.error ? ' is-error' : ''}`} role={communicationNotice.error ? 'alert' : 'status'} aria-live={communicationNotice.error ? 'assertive' : 'polite'} aria-atomic="true">{communicationNotice.error ? <ExclamationTriangleIcon aria-hidden="true" /> : <CheckCircledIcon aria-hidden="true" />}<p>{communicationNotice.message}</p></div>}
    <section className="air-hunt-progress" aria-label="寻聘进度">
      <header className="air-hunt-progress-header" onClick={event => {
        if ((event.target as Element).closest('.air-hunt-toggle, .air-sourcing-context-actions')) return
        setProgressExpanded(v => !v)
      }}><button type="button" className="air-hunt-toggle" aria-expanded={progressExpanded} aria-controls="air-hunt-progress-body" onClick={() => setProgressExpanded(v => !v)}><ChevronDownIcon aria-hidden="true" /><h2>寻聘进度</h2><span className={`air-sourcing-caption is-${displayedRun?.status || 'idle'}`}>{displayedRun ? states[displayedRun.status] : '尚未开始'}{displayedRun?.status === 'running' && <SourcingLoadingDots />}</span></button><div className="air-sourcing-context-actions">
        <button type="button" className="air-button air-button-outline" disabled={!jobId} onClick={() => changeView('requirements')}><GearIcon aria-hidden="true" />寻聘设置</button>
        {actionButton()}
      </div></header>
      {progressExpanded && <div id="air-hunt-progress-body">{displayedRun ? <>        <div className="air-sourcing-run">
          <div className="air-sourcing-run-summary">
            <span className="air-sourcing-progress-label">已找到 <b>{displayedRun.candidateCount}</b> / {sourcingTotalTarget(displayedRun)} 人</span>
            <progress aria-label="本轮候选人评估进度" className="air-progress-track" max={sourcingTotalTarget(displayedRun)} value={displayedRun.candidateCount} />
            <span className="air-sourcing-phase">{batchRunning ? displayedRun.phase === 'searching' && displayedRun.sourceMode === 'search' ? '正在搜索候选人' : phases[displayedRun.phase || ''] || '正在处理本轮寻聘' : ''}</span>
            <span className="air-sourcing-run-meta"><span>{executionId !== undefined ? '本次执行' : roundId === 'all' ? '最近一轮' : '所选轮次'}</span><time dateTime={displayedRun.createdAt}>{stamp(displayedRun.createdAt)}</time></span>
          </div>
          <div className="air-hunt-metrics"><span>最低匹配度 <b>{sourcingMinimumScore(displayedRun)}</b> 分</span><span>已扫描 <b>{displayedRun.scanned ?? displayedRun.candidateCount}</b> 人</span><span>已跳过 <b>{(displayedRun.skippedLowScore ?? 0) + (displayedRun.skippedByFilters ?? 0) + (displayedRun.skippedUnverified ?? 0)}</b> 人</span><span>已打招呼 <b>{displayedRun.greetings?.filter(hasGreeted).length ?? 0}</b> 人</span><span>{displayedRun.autoGreet ? '自动打招呼已开启' : '自动打招呼未开启'}</span></div>
          {['stopped', 'failed', 'unknown'].includes(displayedRun.status) && <p className="air-hunt-notice" role="status">{sourcingRunNotice(displayedRun)}</p>}
          <details className="air-sourcing-execution" key={displayedRun.id}><summary>执行详情</summary>
            <div className="air-sourcing-execution-body">
              <div className="air-sourcing-channel-status">{displayedRun.channels.map(channel => <span key={channel.platform}><b>{PLATFORMS[channel.platform].label}</b> {channelStates[channel.status]}{channel.limit != null && <> · {channel.candidateCount ?? 0}/{channel.limit} 人</>}</span>)}</div>
              {!!displayedRun.greetings?.length && <ul className="air-hunt-greetings" aria-label="打招呼实时进度">{displayedRun.greetings.map(row => <li key={row.key}><b>{row.name}</b><span>{PLATFORMS[row.platform].label}</span><span>{greetingLabel(row)}</span><small>{greetingDetail(row)}</small></li>)}</ul>}
              {!!displayedRun.events?.length && <ol className="air-hunt-events" aria-label="寻聘执行动态">{displayedRun.events.slice(-5).map((event, index) => <li key={index}><time>{new Date(event.at).toLocaleTimeString('zh-CN', {hour12:false})}</time><span>{greetingNotice(event.message)}</span></li>)}</ol>}
              <details><summary>本轮使用的职位要求与补充</summary><div className="air-sourcing-description">{displayedRun.position?.descriptionHtml ? <JobDescription html={displayedRun.position.descriptionHtml} /> : displayedRun.position?.description || '未保存职位说明'}{displayedRun.supplement && `\n本轮补充：${displayedRun.supplement}`}</div></details>
            </div>
          </details>
        </div>
</> : <div className="air-hunt-idle"><span>{selectedPlatforms.map(platform => PLATFORMS[platform].label).join(' / ') || (positionLoading ? '正在读取职位发布渠道…' : availablePlatforms.length ? '请选择本轮寻聘平台' : positionChannels?.length ? '当前发布渠道暂不支持自动寻聘' : '当前职位暂无可寻聘的发布渠道')}</span><span>每个平台 {limit} 人 · 共 {limit * selectedPlatforms.length} 人</span><span>最低匹配度 {Number.isInteger(minimumScore) ? `${minimumScore} 分` : '未设置'}</span><span>自动打招呼已开启</span></div>}</div>}
    </section>
    {error && <div className="air-alert" role="alert">{error}<button type="button" className="air-text-button" onClick={() => setError('')}>关闭</button></div>}
    {pending && <div className="air-pending"><p>任务启动结果暂未确认，请刷新任务状态后再操作。</p><button type="button" className="air-text-button" disabled={!!busy} onClick={onReconcile}>刷新任务状态</button></div>}
    {!jobId ? <div className="air-sourcing-empty"><h2>从一个在招职位开始</h2><p>选择职位后，自动带入职位说明和招聘要求。补充本轮偏好，即可跨渠道寻聘并比较候选人。</p></div> : <>
      {displayedResults || rounds.length > 0 ? <>
        <div className="air-talent-toolbar">
          <div className="air-talent-heading">
            <div className="air-talent-heading-copy">
              <h2 className="air-talent-title">人才列表 <span>{allCandidates.filter(person => !person.scoring?.needsReview && person.score >= sourcingMinimumScore(person)).length}</span></h2>
              {activeUpload && <details className="air-talent-feedback" ref={feedbackMenu} onToggle={event => { if (event.currentTarget.open && filterMenu.current) filterMenu.current.open = false }} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false }}>
                <summary aria-label={`${resumeFeedback}，查看详情`}><span role="status">{resumeFeedback}</span><span className="air-talent-feedback-label">详情</span><ChevronDownIcon aria-hidden="true" /></summary>
                <div className="air-talent-feedback-panel"><b>上传进度</b><p>{activeUpload.detail}</p></div>
              </details>}
            </div>
            <div className="air-talent-resume-tools" aria-label="平台简历操作">
              <button type="button" className="air-text-button" disabled={locked || syncingCommunication || startingUpload} onClick={() => void syncCommunication()} title="从猎聘“沟通 → 有简历”或 BOSS“沟通 → 已获取简历”同步"><ReloadIcon className="air-resume-sync-icon" aria-hidden="true" />{syncingCommunication ? '正在同步…' : '同步平台简历'}</button>
              {activeUpload ? <button type="button" className="air-button air-button-outline" onClick={() => void rpc('stop', { id: activeUpload.id }).catch(e => setError(String(e.message || e)))}><StopIcon aria-hidden="true" />停止上传</button>
                : <button type="button" className="air-button air-button-outline" disabled={locked || syncingCommunication || startingUpload || !pendingAttachmentIds.length} onClick={() => void uploadReceived()} title={`上传当前筛选列表中 ${pendingAttachmentIds.length} 份未入库附件到 ${jobName} · 新简历 · 未处理`}><UploadIcon aria-hidden="true" />{startingUpload ? '正在启动入库…' : `简历入库（${pendingAttachmentIds.length}）`}</button>}
            </div>
          </div>
          <div className="air-sourcing-filterbar" aria-label="搜索、筛选与排序候选人">
          <div className="air-sourcing-filter-controls">
            {executionId === undefined && <SelectMenu id="air-filter-round" label="寻聘轮次" value={roundId} onChange={changeRound} options={[{value:'all',label:'寻聘轮次：全部'}, ...rounds.map(round => ({value:round.id,label:roundStamp(round.createdAt)}))]} />}
            <details className={`air-talent-filters${activeFilterCount ? ' is-filtered' : ''}`} ref={filterMenu} onToggle={event => { if (event.currentTarget.open && feedbackMenu.current) feedbackMenu.current.open = false }} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false }}>
              <summary><MixerHorizontalIcon aria-hidden="true" />筛选{activeFilterCount > 0 && <span className="air-talent-filter-count">{activeFilterCount}</span>}<ChevronDownIcon aria-hidden="true" /></summary>
              <div className="air-talent-filter-panel" aria-label="更多筛选条件">
                <div className="air-talent-filter-heading"><b>筛选条件</b><span>选择后立即生效</span></div>
                <div className="air-talent-filter-fields">
                <div><label htmlFor="air-filter-score">匹配度</label>
            <SelectMenu id="air-filter-score" label="匹配度分值" value={filter.score} onChange={value => updateFilter('score', value)} options={[{value:'all',label:'不限'},{value:'90',label:'90 分及以上'},{value:'80',label:'80 分及以上'},{value:'70',label:'70 分及以上'},{value:'60',label:'60 分及以上'},{value:'50',label:'50 分及以上'},{value:'40',label:'40 分及以上'},{value:'30',label:'30 分及以上'},{value:'20',label:'20 分及以上'},{value:'10',label:'10 分及以上'}]} />
                </div><div><label htmlFor="air-filter-communication">沟通情况</label>
            <SelectMenu id="air-filter-communication" label="沟通情况" value={filter.communication} onChange={value => updateFilter('communication', value)} options={[{value:'all',label:'不限'}, ...Object.entries(communicationLabels).map(([value,label]) => ({value,label}))]} />
                </div><div><label htmlFor="air-filter-resume-received">简历接收</label>
            <SelectMenu id="air-filter-resume-received" label="简历接收" value={filter.received ?? 'all'} onChange={value => updateFilter('received', value)} options={[{value:'all',label:'不限'},{value:'received',label:'已收到简历'},{value:'not_received',label:'未收到简历'}]} />
                </div><div><label htmlFor="air-filter-platform">来源平台</label>
            <SelectMenu id="air-filter-platform" label="来源平台" value={filter.platform} onChange={value => updateFilter('platform', value)} options={[{value:'all',label:'不限'}, ...Object.entries(PLATFORMS).map(([value,platform]) => ({value,label:platform.label}))]} />
                </div></div>
                <div className="air-talent-filter-footer"><button type="button" className="air-text-button" disabled={!activeFilterCount} onClick={() => setFilter(emptyFilters)}>清除条件</button><button type="button" className="air-button air-button-outline" onClick={() => { if (filterMenu.current) { filterMenu.current.open = false; filterMenu.current.querySelector('summary')?.focus() } }}>完成</button></div>
              </div>
            </details>
            {hasFilters && <button type="button" className="air-text-button" onClick={resetFilters}>重置</button>}
          </div>
          <div className="air-talent-search-sort">
            <div className="air-talent-search"><MagnifyingGlassIcon aria-hidden="true" /><input ref={candidateSearch} type="search" aria-label="搜索人才" placeholder="搜索姓名、公司、岗位" value={candidateQuery} onChange={event => { setCandidateQuery(event.target.value); setMobileDetail(false) }} onKeyDown={event => { if (event.key === 'Escape') { setCandidateQuery(''); event.stopPropagation() } }} />{candidateQuery && <button type="button" aria-label="清空搜索" title="清空搜索" onClick={() => { setCandidateQuery(''); candidateSearch.current?.focus() }}><Cross2Icon aria-hidden="true" /></button>}</div>
            <SelectMenu id="air-candidate-sort" className="air-talent-sort" label="候选人排序" value={sort} onChange={setSort} align="right" options={[{value:'score-desc',label:'匹配度从高到低'},{value:'score-asc',label:'匹配度从低到高'},{value:'newest',label:'最近发现优先'},{value:'coverage-desc',label:'信息完整度优先'}]} />
          </div>
          </div>
        </div>
        <div className={`air-sourcing-results ${mobileDetail ? 'is-detail-open' : ''}`} ref={splitRoot}>
          <div className="air-sourcing-list" ref={listPane} aria-label="候选名单">
            <ul>{candidates.map(person => <li className={`air-sourcing-person-row${selected?.resultKey === person.resultKey ? ' is-selected' : ''}`} key={person.resultKey}>
              <div className={`air-sourcing-person ${selected?.resultKey === person.resultKey ? 'is-selected' : ''}`}>
                <div className="air-sourcing-person-heading"><span className="air-sourcing-person-identity"><button type="button" className="air-sourcing-person-select" aria-pressed={selected?.resultKey === person.resultKey} aria-label={`查看${person.name}的候选人详情，匹配度 ${person.score} 分`} onClick={() => selectCandidate(person.resultKey)}><b>{person.name}</b></button>{renderPlatformTag(person.platform)}</span>{resumeProgress(person)}<strong>{person.score}<small> / 100</small></strong></div>
                <div className="air-person-overview">{candidateBasics(person)}<div className="air-person-histories">{historySummary(person.listProfile, 'work')}{historySummary(person.listProfile, 'education')}</div></div>
                {!!person.resumeAttachments?.length && <div className="air-person-download-row">{resumeDownload(person)}</div>}
              </div>
            </li>)}</ul>
            {!candidates.length && <div className="air-sourcing-empty-result"><h3>{loading && !displayedResults ? '正在读取轮次结果…' : searchTerms.length ? '暂无符合搜索条件的人选' : hasFilters ? '暂无符合筛选的人选' : batchRunning ? '正在寻找合适的人选' : roundId === 'all' ? '该职位尚无候选人' : '本轮尚无候选人'}</h3><p>{loading && !displayedResults ? '结果正在读取，请稍候。' : hasFilters ? '试试其他关键词或筛选条件，或查看全部候选人。' : batchRunning ? '结果会陆续出现在这里，可以先查看寻聘设置。' : displayedRun ? '展开执行详情，查看渠道状态和停止原因。' : '按职位要求开始寻聘后，候选人将显示在这里。'}</p>{hasFilters && <button type="button" className="air-text-button" onClick={resetFilters}>查看全部</button>}</div>}
          </div>
          {!compact && <div className="air-sourcing-splitter" ref={splitHandle} role="separator" aria-orientation="vertical" aria-label="调整候选列表与简历详情的宽度" tabIndex={0} title="左右拖动调整宽度，也可使用方向键" />}
          {candidate ? <article className="air-sourcing-detail" tabIndex={-1} ref={detailPane} key={selected?.resultKey} aria-label={`${candidate.name}的候选人详情`}>
            <header className="air-sourcing-detail-header">
              <button type="button" className="air-text-button air-sourcing-back" onClick={() => setMobileDetail(false)}><ArrowLeftIcon aria-hidden="true" />候选名单</button>
              <div className="air-sourcing-detail-title"><h3>{candidate.name}{renderPlatformTag(candidate.platform)}</h3>
                <div className="air-candidate-score"><strong>{candidate.score}<small>/100</small></strong><span>{candidate.scoring?.needsReview ? '未达标' : '匹配度'}</span></div>
              </div>
              <p className="air-sourcing-caption">{selected && <time dateTime={selected.roundCreatedAt}>{stamp(selected.roundCreatedAt)} 获取</time>}<span>{candidate.scope === 'summary' ? '平台列表信息' : '在线简历'}</span></p>
              {resumeProgress(candidate)}
            </header>
            <div className="air-sourcing-detail-body">
              <dl className="air-sourcing-facts">{candidate.fields.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
              <nav className="air-sourcing-detail-nav" aria-label="候选人详情内容"><div>{(['analysis', 'resume'] as const).map(value => <button key={value} type="button" aria-pressed={detail === value} onClick={() => setDetail(value)}>{value === 'analysis' ? '匹配分析' : '已读简历'}</button>)}</div>{candidate.profileUrl && <a href={candidate.profileUrl} target="_blank" rel="noreferrer noopener">去平台查看 <ExternalLinkIcon aria-hidden="true" /></a>}</nav>
              {detail === 'analysis' ? <>
                <div className="air-sourcing-score"><span>{candidate.scoring ? '核心' : ''}证据覆盖 {candidate.coverage}%</span><p>{candidate.scoring ? <>核心能力 {candidate.scoring.baseScore} 分 · 加分项 +{candidate.scoring.bonusScore} 分，总分最高 100 分。未知核心项不进入已评估权重的分母。{candidate.scoring.needsReview ? '重要条件或核心证据不足，未达标。' : '软性核实项不影响匹配分。'}</> : candidate.coverage < 100 ? '缺失信息未计分，需进一步核实。' : '按本轮职位要求与已读简历评估。'}{candidate.scope === 'summary' ? '当前按列表信息评分。' : ''}</p></div>
                <div className="air-sourcing-analysis"><h4>匹配概览</h4><p className="air-sourcing-analysis-preview">{candidate.analysis || '暂无综合分析'}</p>{!!candidate.analysis && <details><summary><span className="air-sourcing-expand">查看完整分析</span><span className="air-sourcing-collapse">收起分析</span></summary><p>{candidate.analysis}</p></details>}</div>
                {!!displayedDetail?.requirements?.supplementCoverage?.length && <details className="air-sourcing-analysis"><summary>本轮补充要求的评估方式</summary><ul>{displayedDetail.requirements.supplementCoverage.map((item, index) => <li key={index}><b>{item.quote}</b><p>{item.reason || [...item.criterionIds.map(id => displayedDetail.requirements?.criteria.find(criterion => criterion.id === id)?.label), ...item.listFields.map(field => ({ age: '年龄', education: '学历', experience: '工作年限', city: '工作城市', company: '任职公司', salary: '薪资' })[field])].filter(Boolean).join('、')}</p></li>)}</ul></details>}
                <div className="air-sourcing-section-title"><h4>逐项匹配</h4><span className="air-sourcing-caption">展开查看证据与职位依据</span></div>
                <div className="air-sourcing-assessments">{candidate.assessments.map(row => { const criterion = displayedDetail?.requirements?.criteria.find(c => c.id === row.criterionId)
                  const tier = criterion?.tier, unscored = tier === 'must' || tier === 'verify' || !!tier && row.state === 'unknown'
                  const points = sourcingCriterionScore(criterion?.weight ?? 0, row.state === 'match' && (row.evidenceKind === 'inferred' || row.confidence === 'low') ? 'partial' : row.state)
                  const evidence = row.evidenceQuotes?.length ? row.evidenceQuotes : row.quote ? [row.quote] : []
                  return <details className="air-sourcing-assessment" key={row.criterionId}>
                  <summary><span><b>{criterion?.label || row.criterionId}</b>{tier ? <small>{sourcingTierLabels[tier]}</small> : criterion?.must && <small>必须</small>}</span><span className="air-sourcing-assessment-result"><span className={`air-sourcing-match is-${row.state}`}>{row.state === 'unknown' ? tier ? '材料未说明' : '未计分' : matches[row.state]}</span>{criterion ? unscored ? <span className="air-sourcing-caption">{tier === 'verify' ? '不影响评分' : tier === 'must' ? '独立核验' : tier === 'bonus' ? '暂未加分' : '不计入分母'}</span> : <span className="air-sourcing-assessment-score" aria-label={`本项得分 ${points}，满分 ${criterion.weight} 分`}><strong>{tier === 'bonus' ? '+' : ''}{points}</strong><span> / {criterion.weight} 分{tier === 'core' ? '权重' : ''}</span></span> : <span className="air-sourcing-caption">分值未保存</span>}</span><ChevronDownIcon aria-hidden="true" /></summary>
                  <div><p>{row.reason || '暂无说明'}</p>{row.evidenceKind && row.state !== 'unknown' && <p className="air-sourcing-caption">{row.evidenceKind === 'inferred' ? '间接证据 · 基于相关经历推断' : '直接证据'}{row.confidence && ` · ${row.confidence === 'high' ? '高' : row.confidence === 'medium' ? '中' : '低'}置信度`}</p>}{evidence.map((quote, index) => <blockquote key={index}><small>候选人证据</small>{quote}</blockquote>)}{criterion?.quote && <p className="air-sourcing-evidence"><b>{tier ? '要求依据' : '职位依据'}</b>{criterion.quote}</p>}{criterion && <p className="air-sourcing-caption">{tier === 'verify' ? '此项留待面试核实，不占基础分。' : tier === 'must' ? '缺少必要证据或明确冲突时跳过。' : tier === 'bonus' ? '仅奖励已证实的优势，未满足不扣基础分。' : row.state === 'unknown' && tier ? '现有材料不足，不代表不具备；暂不计入评分分母。' : `本项满分 ${criterion.weight} 分${row.state === 'unknown' ? '，缺少证据，暂未计分。' : row.state === 'partial' ? '，部分符合按一半计分。' : ''}`}</p>}{(row.verificationQuestion || tier && row.state === 'unknown') && <p><b>建议核实：</b>{row.verificationQuestion || `请结合具体工作或项目说明“${criterion?.label}”的实践。`}</p>}</div>
                </details> })}</div>
                {!candidate.assessments.length && <p className="air-sourcing-caption">暂无逐项匹配依据，请结合已读简历核实。</p>}
              </> : <div className="air-sourcing-resume-section"><div className="air-sourcing-caption air-resume-meta"><span>{candidate.scope === 'summary' ? '仅取得列表摘要' : '平台在线简历'}</span><div className="air-resume-attachments"><span>{candidate.resumeAttachments?.length ? `已取得 ${candidate.resumeAttachments.length} 份附件` : '尚未取得附件'}</span>{selected && attachmentDownload({ ...selected, resumeAttachments: candidate.resumeAttachments })}</div>{candidate.resumeTruncated && <span>原文仅保留前 30,000 字符</span>}<time>{stamp(candidate.collectedAt)}</time></div><pre className="air-sourcing-resume">{candidate.resumeText || '暂无已读简历原文'}</pre></div>}
            </div>
            <footer className="air-sourcing-detail-footer"><span>{candidateIndex + 1} / {candidates.length} 条评估</span><div><button type="button" className="air-sourcing-icon-button" aria-label="上一位候选人" disabled={candidateIndex <= 0} onClick={() => selectCandidate(candidates[candidateIndex - 1].resultKey)}><ArrowLeftIcon aria-hidden="true" /></button><button type="button" className="air-sourcing-icon-button" aria-label="下一位候选人" disabled={candidateIndex >= candidates.length - 1} onClick={() => selectCandidate(candidates[candidateIndex + 1].resultKey)}><ArrowRightIcon aria-hidden="true" /></button></div></footer>
          </article> : <div className="air-sourcing-detail-placeholder"><p>{selected ? detailLoading ? '正在读取候选人详情…' : '详情暂未读取完成。' : '选中候选人后，在这里查看基本信息、匹配分析和已读简历。'}</p>{selected && !detailLoading && <button type="button" className="air-text-button" onClick={() => setReload(value => value + 1)}>重试读取详情</button>}</div>}
        </div>
      </> : <div className="air-sourcing-empty" aria-busy={loading}><h3>{loading ? '正在读取寻聘记录…' : '候选人将保存在这里'}</h3><p>{executionId !== undefined ? '这里仅展示当前对话本次寻聘找到的候选人。' : '按职位要求开始寻聘后，即可查看候选人和匹配分析。'}</p>{executionId === undefined && roundId !== 'all' && <button type="button" className="air-text-button" onClick={() => changeRound('all')}>查看全部轮次</button>}{!loading && <button type="button" className="air-button air-button-primary" onClick={() => changeView('requirements')}>设置本轮寻聘</button>}</div>}
    </>}
    {jobId && view === 'requirements' && <SettingsPanel compact={compact} title="寻聘设置" onClose={() => changeView('results')}><div className="air-sourcing-requirements">
      <div className="air-sourcing-brief">
        <div className="air-sourcing-section-title"><h3>{jobName}</h3></div>
        <section className="air-sourcing-requirement-section" aria-label="硬性条件" aria-busy={positionLoading}>
          <label className="air-label" htmlFor="air-sourcing-basic-requirements">硬性条件</label>
          <textarea id="air-sourcing-basic-requirements" className="air-sourcing-readonly" rows={4} readOnly disabled value={positionLoading ? '正在从薪人薪事读取…' : basicFields.length ? basicFields.map(field => `${field.label}：${field.value}`).join('\n') : '该职位暂无硬性条件'} />
        </section>
        <section className="air-sourcing-requirement-section" aria-label="职位描述">
          <label className="air-label" htmlFor="air-sourcing-job-description">职位描述</label>
          <textarea id="air-sourcing-job-description" rows={8} maxLength={20000} disabled={locked || positionLoading || position?.id !== jobId} aria-busy={positionLoading} value={positionLoading ? '' : descriptionText ?? ''} onChange={e => { setJobDescription(e.target.value); persistSettings({ jobDescription: e.target.value }) }} placeholder={positionLoading ? '正在从薪人薪事读取…' : '请输入职位职责和任职要求'} />
        </section>
        <section className="air-sourcing-requirement-section" aria-label="补充要求/加分项">
          <label className="air-label" htmlFor="air-sourcing-supplement">补充要求/加分项 <span className="air-sourcing-caption">选填</span></label>
          <textarea id="air-sourcing-supplement" rows={3} maxLength={4000} disabled={locked || positionLoading || position?.id !== jobId} value={supplement} onChange={e => { setSupplement(e.target.value); persistSettings({ supplement: e.target.value }) }} placeholder="例如：优先看独立负责过核心模块的人。留空则按职位已有要求寻聘。" />
        </section>
      </div>
      <div className="air-sourcing-settings">
        <header className="air-sourcing-settings-heading"><h3>安排本轮寻聘</h3><span className="air-sourcing-caption">自动保存</span></header>
        <fieldset className="air-sourcing-settings-field" disabled={locked || positionLoading}><legend className="air-label">招聘平台</legend><div className="air-sourcing-platform-options">{availablePlatforms.map(platform => <label className="air-sourcing-channel" key={platform}><input type="checkbox" checked={selectedPlatforms.includes(platform)} onChange={e => { const next = e.target.checked ? [...new Set([...platforms, platform])] : platforms.filter(row => row !== platform); setPlatforms(next); persistSettings({ platforms: next }) }} /><span>{PLATFORMS[platform].label}</span></label>)}</div>
          {!availablePlatforms.length && <p className="air-sourcing-caption">{positionLoading ? '正在读取当前职位的发布渠道…' : positionChannels?.length ? '当前发布渠道暂不支持自动寻聘，目前支持猎聘和 BOSS 直聘。' : positionChannels ? '当前职位暂无发布渠道，请先在薪人薪事设置后刷新。' : '发布渠道信息尚未读取，请完全退出并重开薪灵后刷新。'}</p>}
        </fieldset>
        <div className="air-sourcing-settings-field">
          <div className="air-sourcing-setting-row"><label className="air-label" htmlFor="air-sourcing-limit">目标打招呼人数</label><div className={`air-number-field${validLimit ? '' : ' is-invalid'}`}><input id="air-sourcing-limit" type="number" min={1} max={SOURCING_MAX_LIMIT} step={1} disabled={locked || positionLoading || position?.id !== jobId} value={Number.isNaN(limit) ? '' : limit} aria-invalid={!validLimit} aria-describedby="air-sourcing-limit-help" onChange={e => { const next = e.target.value ? Number(e.target.value) : NaN; setLimit(next); if (Number.isInteger(next) && next >= 1 && next <= SOURCING_MAX_LIMIT) persistSettings({ limit: next }) }} /><span>人</span></div></div>
          <p id="air-sourcing-limit-help" className={`air-sourcing-caption${validLimit ? '' : ' is-invalid'}`}>{validLimit ? `每个平台分别计算，单轮最多 ${SOURCING_MAX_LIMIT} 人，超量可能触发账号封控。达标后自动打招呼，已沟通的不重复发送。` : `请输入 1–${SOURCING_MAX_LIMIT} 之间的整数。`}</p>
        </div>
        <div className="air-sourcing-settings-field">
          <div className="air-sourcing-setting-row"><label className="air-label" htmlFor="air-sourcing-minimum-score">最低匹配分</label><div className="air-number-field"><input id="air-sourcing-minimum-score" type="number" min={0} max={100} step={1} disabled={locked || positionLoading || position?.id !== jobId} value={Number.isNaN(minimumScore) ? '' : minimumScore} aria-describedby="air-sourcing-minimum-score-help" onChange={e => { const next = e.target.value === '' ? NaN : Number(e.target.value); setMinimumScore(next); if (Number.isInteger(next) && next >= 0 && next <= 100) persistSettings({ minimumScore: next }) }} /><span>分</span></div></div>
          <p id="air-sourcing-minimum-score-help" className="air-sourcing-caption">百分制（0–100 分），仅保留达到此分数的人选。</p>
        </div>
        <footer className="air-sourcing-settings-actions">{actionButton(true)}</footer>
      </div>
    </div></SettingsPanel>}
  </section>
}

function SettingsPanel({ compact, title, onClose, children }: { compact: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  return compact ? <section className="air-compact-settings" aria-label={title}><header><button type="button" className="air-text-button" onClick={onClose}><ArrowLeftIcon aria-hidden="true" />返回人才列表</button><h2>{title}</h2></header>{children}</section>
    : <SidePanel title={title} onClose={onClose} className="air-sourcing-settings-panel">{children}</SidePanel>
}
