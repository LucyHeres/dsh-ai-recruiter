import type { Context } from '@deepseek-ai/cordis'
import React, { useEffect, useRef, useState } from 'react'
import {
  ArrowLeftIcon, FileTextIcon, ArrowRightIcon, CheckIcon, CheckCircledIcon,
  ChatBubbleIcon, ChevronRightIcon, ClockIcon,
  CounterClockwiseClockIcon, Cross2Icon, DesktopIcon, ExclamationTriangleIcon, Link2Icon, MinusCircledIcon, PlayIcon, ReloadIcon, StopIcon,
} from '@radix-ui/react-icons'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { PLATFORMS, TASK_FEATURES, taskFeature, type TaskKind, type WorkbenchState, type WorkbenchJob, type TaskResultStage, type DeveloperLogs } from '../shared/workbench.js'
import styles from './style.css'
import { taskResultRows } from '../shared/greeting-results.js'
import { greetingLabel, greetingDetail, greetingNotice, hasGreeted } from '../shared/communication.js'
import { sourcingTotalTarget } from '../shared/sourcing-score.js'
import { registerSessionPanel } from './session-panel.js'
import { TaskRecords } from './features/task-records.js'
import { DataManagement } from './features/data-management.js'
import { PositionHome } from './features/position-home.js'
import { SidePanel } from './components/side-panel.js'
import type { JobOption } from '../shared/workbench.js'
import { SourcingPanel } from './features/sourcing-panel.js'
import { browserConnectionStatus, isExtensionRequired } from '../shared/connection-status.js'
import { useExtensionSetup } from './components/extension-setup.js'
import { createWorkbenchNavigation, type WorkbenchNavigation } from './workbench-navigation.js'
import { TalentSearchIcon } from './components/talent-search-icon.js'
import { renderPlatformTag } from './components/platform-tag.js'
import { recruitmentPlatformForChannel, recruitmentPublishedChannels } from '../shared/published-channels.js'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

type Rpc = <T>(method: string, request?: unknown, signal?: AbortSignal) => Promise<T>
export const inject = ['slots', 'layout', 'connection', 'sidebarRight', 'sidebarRightTabs']
export function apply(ctx: Context) {
  const navigation = createWorkbenchNavigation()
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const rpc: Rpc = async (method, request, signal) => {
    const result = await (ctx.get('connection') as ConnectionHandle).rpc.call('/api', `aiRecruitWorkbench/${method}`, { args: request === undefined ? {} : { request } }, signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as never
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'ai-recruiter', inject: () => ({ rpc, navigation }) }, WorkbenchPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'ai-recruiter', label: 'AI 招聘工作台', order: 80 }, TalentSearchIcon))
  registerSessionPanel(ctx, rpc, position => { navigation.visit(position); ctx.layout.selectPanel('ai-recruiter' as MainPanelId); if (ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded() })}

const statusNames: Record<WorkbenchJob['status'], string> = {
  queued: '等待执行', running: '进行中', stopping: '停止中', completed: '已完成', stopped: '已停止', failed: '执行失败', unknown: '待核对',
}
const resultNames: Record<TaskResultStage, string> = { sending: '处理中', succeeded: '已确认', unknown: '待核对', skipped: '已跳过', failed: '失败' }
const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const resultIcon = { sending: ClockIcon, succeeded: CheckCircledIcon, unknown: ExclamationTriangleIcon, skipped: MinusCircledIcon, failed: ExclamationTriangleIcon }

function WorkbenchPage({ rpc, navigation }: PropsRuntime<'main'> & { rpc: Rpc; navigation?: WorkbenchNavigation }) {
  const [state, setState] = useState<WorkbenchState>()
  const [selectedKind, setSelectedKind] = useState<TaskKind>('talent_sourcing')
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [selected, setSelected] = useState<Partial<Record<TaskKind, string>>>({})
  const [copiedLogTask, setCopiedLogTask] = useState('')
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [inspectedTask, setInspectedTask] = useState<WorkbenchJob>()
  const [position, setPosition] = useState<JobOption | undefined>(() => navigation?.current())
  const [activityOpen, setActivityOpen] = useState(false)
  const [dataOpen, setDataOpen] = useState(false)
  const [dataRevision, setDataRevision] = useState(0)
  const pending = useRef<Record<string, unknown> & { id: string; kind: TaskKind }>()
  const mounted = useRef(true)
  const actionInFlight = useRef(false)
  useEffect(() => navigation?.subscribe(next => { setPosition(next); setInspectedTask(undefined); setSelectedKind('talent_sourcing'); setSelected({}); setActivityOpen(false) }), [navigation])

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const value = await rpc<WorkbenchState>('state', undefined, controller.signal)
        if (!controller.signal.aborted) { setState(value); setConnectionError('') }
      } catch (error) {
        if (!controller.signal.aborted) setConnectionError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 1500)
      }
    }
    void refresh()
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer) }
  }, [rpc])

  async function act(label: string, action: () => Promise<void>) {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setBusy(label); setError('')
    try { await action() }
    catch (error) {
      if (mounted.current && isExtensionRequired(error)) { pending.current = undefined; setup.show(); void setup.check() }
      else if (mounted.current) setError(error instanceof Error ? error.message : String(error))
    }
    finally { actionInFlight.current = false; if (mounted.current) setBusy('') }
  }

  const connection = state?.connection
  const installation = state?.extensionInstallation
  const setup = useExtensionSetup(installation, rpc, value => setState(previous => previous ? { ...previous, extensionInstallation: value } : previous))
  const extensionInstalled = installation?.status === 'installed'
  const installationLabel = extensionInstalled ? '已安装' : installation?.status === 'outdated' ? '需升级' : installation?.status === 'not_installed' ? '未安装' : installation ? '无法确认' : '待检测'
  const knownJobs = state?.jobs ?? []
  const featureJobs = [...knownJobs, ...(inspectedTask && !knownJobs.some(job => job.id === inspectedTask.id) ? [inspectedTask] : [])].filter(job => job.kind === selectedKind)
  const current = featureJobs.find(job => job.id === selected[selectedKind])
    ?? featureJobs.find(job => job.id === state?.activeJobId)
    ?? featureJobs[0]
  const results = current ? taskResultRows(current) : []
  const success = results.filter(item => current?.kind === 'greeting' ? hasGreeted(item) : item.stage === 'succeeded').length
  const locked = !state || !!busy || !!state?.activeJobId || !!connection?.busy || !!connectionError || !!connection?.activeWorkflow
  const occupied = !!state?.activeJobId || !!connection?.busy || !!connection?.activeWorkflow
  const connectionStatus = browserConnectionStatus(state, connectionError)
  const ready = connectionStatus === '已连接'
  const connecting = !setup.required && (busy === '连接中' || !!connection?.connecting)
  const feature = taskFeature(selectedKind)
  const resultFeature = taskFeature(current?.kind ?? selectedKind)
  const isActiveJob = !!current && state?.activeJobId === current.id
  const needsResumeHelp = current?.kind === 'resume_import' && !isActiveJob && (!!current.diagnosis || (!current.results.length && /未识别到可采集|停在候选人识别/.test(current.detail)))
  const needsReconcile = !!pending.current && !busy
  const positionPlatforms = position?.publishedChannels
    ? recruitmentPublishedChannels(position.publishedChannels).map(channel => ({ platform: recruitmentPlatformForChannel(channel)!, title: channel.name }))
    : [...new Set(position?.platforms ?? [])].map(platform => ({ platform, title: PLATFORMS[platform].label }))
  const blockingReason = needsReconcile ? '任务启动结果暂未确认，请刷新任务状态'
    : state?.activeJobId ? '当前任务结束后可发起下一次任务'
    : connectionError ? '连接状态更新失败，请重试读取'
    : !state ? '正在读取工作台状态'
    : occupied ? '浏览器被其他任务占用' : ''

  useEffect(() => {
    if (!current?.nextActionAt) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [current?.nextActionAt])

  function startTask(settings: Record<string, unknown>, kind: TaskKind = 'talent_sourcing') {
    if (setup.required) { setup.show(); return }
    void act('启动任务', async () => {
      const request = { ...settings, id: crypto.randomUUID(), kind }
      pending.current = request
      const job = await rpc<WorkbenchJob>('start', request)
      pending.current = undefined
      setSelectedKind(kind)
      if (kind === 'resume_import') setActivityOpen(true)
      setSelected(previous => ({ ...previous, [job.kind]: job.id })); setState(await rpc('state'))
    })
  }

  function reconcileTask() {
    void act('核对任务', async () => {
      const value = await rpc<WorkbenchState>('state'); setState(value)
      const job = value.jobs.find(job => job.id === pending.current?.id)
      if (job) { setSelected(previous => ({ ...previous, [job.kind]: job.id })); pending.current = undefined }
      else {
        const same = await rpc<WorkbenchJob>('start', pending.current)
        pending.current = undefined; setSelected(previous => ({ ...previous, [same.kind]: same.id }))
      }
    })
  }

  function copyTaskLog(id: string) {
    void act(`复制操作日志:${id}`, async () => {
      const logs = await rpc<DeveloperLogs>('developerLogs', { id })
      const job = knownJobs.find(row => row.id === id) ?? (inspectedTask?.id === id ? inspectedTask : undefined)
      await navigator.clipboard.writeText([
        `dsh-ai-recruiter developer logs | taskId=${id}`,
        `directory=${logs.directory} | level=${logs.level} | truncated=${logs.truncated} | dropped=${logs.dropped} | writeFailed=${logs.writeFailed}`,
        ...(job ? [JSON.stringify({ taskId: id, taskResult: job.detail, diagnosis: job.diagnosis,
          ...(job.kind === 'talent_sourcing' ? { channels: (job as import('../shared/sourcing.js').SourcingJob).channels,
            scanned: (job as import('../shared/sourcing.js').SourcingJob).scanned,
            skippedLowScore: (job as import('../shared/sourcing.js').SourcingJob).skippedLowScore } : {}) }, null, 2)] : []),
        logs.lines.length ? logs.lines.join('\n') : '该任务没有可用的开发日志（旧任务、日志关闭或记录已轮转）。',
      ].join('\n'))
      if (mounted.current) setCopiedLogTask(id)
    })
  }
  function inspectTask(job: WorkbenchJob) {
    if (job.kind === 'talent_sourcing') { const source = job as import('../shared/sourcing.js').SourcingJob; setPosition({ id: source.jobId, name: source.position?.name || source.jobName || '职位招聘', label: source.jobName || '', city: source.position?.city, department: source.position?.department, platforms: source.position?.platforms, publishedChannels: source.position?.publishedChannels }); setActivityOpen(false) }
    else setActivityOpen(true)
    setInspectedTask(job); setSelectedKind(job.kind); setSelected(previous => ({ ...previous, [job.kind]: job.id }))
  }

  return <div className="air-plugin-surface"><div className="air-workbench">
    <style>{styles}</style>
    <header className="air-header">
      <div className="air-header-inner">
        <div className="air-job-page-title">{position && <button type="button" className="air-sourcing-icon-button" aria-label="返回职位管理" onClick={() => { navigation?.clear(); setPosition(undefined); setInspectedTask(undefined) }}><ArrowLeftIcon aria-hidden="true" /></button>}<div><h1>{position?.name || '职位管理'}</h1>{position && <div className="air-job-page-meta"><p>{[position.department, position.city].filter(Boolean).join(' · ') || '职位招聘'}</p>{positionPlatforms.length > 0 && <span className="air-job-page-platforms" aria-label="关联招聘平台">{positionPlatforms.map(({ platform, title }) => renderPlatformTag(platform, { key: platform, title, className: 'air-position-platform-tag' }))}</span>}</div>}</div></div>
        <div className="air-header-actions"><button type="button" className="air-text-button air-records-trigger" onClick={() => setDataOpen(true)}><DesktopIcon aria-hidden="true" />数据管理</button><button type="button" className="air-text-button air-records-trigger" onClick={() => setRecordsOpen(true)}><CounterClockwiseClockIcon aria-hidden="true" />任务记录</button><BrowserConnectionPopover status={connectionStatus}>
          <section id="air-browser-connection" className="air-connection-panel" aria-labelledby="air-connection-title" aria-busy={!state && !connectionError}>
            <div className="air-connection-top">
              <div className="air-connection-heading">
                <span className="air-connection-icon"><Link2Icon aria-hidden="true" /></span>
                <h2 id="air-connection-title">浏览器扩展</h2>
              </div>
              <div className="air-connection-actions">
                {(setup.required || installation?.status === 'unknown') && <button type="button" className="air-button air-button-outline air-button-small" onClick={setup.show}>{installation?.status === 'outdated' ? '升级指引' : '安装指引'}</button>}
                <button type="button" className="air-button air-button-outline air-button-small" disabled={locked || ready || !installation} onClick={() => {
                  if (setup.required) { setup.show(); return }
                  void act('连接中', async () => { await rpc('connect'); setState(await rpc('state')) })
                }}>
                  <Link2Icon aria-hidden="true" />{connecting ? '连接中…' : ready ? '已连接' : '连接浏览器'}
                </button>
              </div>
            </div>
            {!state && connectionError ? <p className="air-connection-help">连接状态读取失败，请点击重试读取。</p> : !state ? <div className="air-connection-loading" aria-label="正在读取连接状态"><span className="air-skeleton" /><span className="air-skeleton" /><span className="air-skeleton" /></div> : <div className="air-connection-path">
              <Connection label="安装扩展" good={extensionInstalled} detail={installationLabel} showDetail tag />
              <ChevronRightIcon className="air-path-arrow" aria-hidden="true" />
              <Connection label="连接浏览器" good={extensionInstalled && ready} pending={connecting && !ready} detail={setup.required ? installation?.status === 'outdated' ? '请先升级' : '请先安装' : ready ? '已连接' : '未连接'} />
            </div>}
            {connecting && <p className="air-connection-help" role="status">正在连接浏览器…</p>}
            {setup.required && <p className="air-connection-help">{setup.message}</p>}
          </section>
        </BrowserConnectionPopover></div>
      </div>
    </header>

    <div className="air-page">
      {setup.banner}
      {(error || connectionError) && <div className="air-alert" role="alert">
        <ExclamationTriangleIcon aria-hidden="true" />
        <div><strong>{error ? '操作未完成' : '连接状态暂时无法更新'}</strong><p>{error || connectionError}</p></div>
        {connectionError && <button type="button" className="air-button air-button-outline" disabled={!!busy} onClick={() => void act('重试读取', async () => { const value = await rpc<WorkbenchState>('state'); if (mounted.current) { setState(value); setConnectionError('') } })}><ReloadIcon aria-hidden="true" />{busy === '重试读取' ? '读取中…' : '重试读取'}</button>}
        {error && <button type="button" className="air-icon-button" aria-label="关闭操作提示" onClick={() => setError('')}><Cross2Icon aria-hidden="true" /></button>}
      </div>}

      {position && knownJobs.some(job => job.id === state?.activeJobId && job.kind === 'resume_import' && (job as WorkbenchJob & {jobId?: string}).jobId === position.id) && <div className="air-resume-live"><span><span className="air-status-dot" />简历正在入库到当前职位</span><button className="air-text-button" type="button" onClick={() => { setSelectedKind('resume_import'); setSelected(previous => ({...previous,resume_import:state?.activeJobId || ''})); setActivityOpen(true) }}>查看入库进度<ArrowRightIcon aria-hidden="true" /></button></div>}
      {position ? <SourcingPanel key={`${position.id}:${dataRevision}`} positionId={position.id} rpc={rpc} state={state} locked={locked} pending={needsReconcile} busy={busy} blockingReason={blockingReason} onStart={settings => startTask(settings, 'talent_sourcing')} onReconcile={reconcileTask} onRequireExtension={setup.show} selectedTaskId={selected.talent_sourcing} selectedRecord={inspectedTask?.kind === 'talent_sourcing' ? inspectedTask : undefined} /> : <PositionHome key={dataRevision} rpc={rpc} onRecruit={job => { setPosition(job); setInspectedTask(undefined); setSelectedKind('talent_sourcing') }} />}
    </div>
    {activityOpen && <SidePanel title={current?.kind === 'resume_import' ? '简历入库进度' : '任务详情'} onClose={() => setActivityOpen(false)} className="air-task-activity-panel">
        <section className="air-activity" aria-labelledby="air-activity-title">
          <div className="air-section-heading air-activity-heading"><div><h2 id="air-activity-title">执行进度</h2>{current && <p className="air-task-meta">{resultFeature.label} · {PLATFORMS[current.platform].label}<time dateTime={current.createdAt}>{formatTime(current.createdAt)}</time></p>}</div>
            {current && <div className="air-task-actions"><JobStatus status={current.status === 'unknown' && current.kind === 'greeting' ? 'stopped' : current.status} />{isActiveJob && <button type="button" className="air-button air-button-outline air-button-small" disabled={!!busy} onClick={() => void act('停止任务', async () => { await rpc('stop', { id: current.id }) })}><StopIcon aria-hidden="true" />{busy === '停止任务' ? '停止中…' : '停止任务'}</button>}</div>}
          </div>
          {!state && connectionError ? <div className="air-result-empty"><p>任务记录暂时无法读取。</p></div> : !state ? <ActivitySkeleton /> : current ? <>
            <div className={`air-progress-overview ${current.events?.length ? 'has-events' : ''}`}>
              <div className="air-progress-card">
                <div className="air-summary">
                  <div className="air-summary-primary"><span className="air-summary-label">{current.kind === 'greeting' && results.some(item => item.stage === 'succeeded' && !item.confirmedAt && !item.clickedAt) ? '已触发沟通（旧记录）' : resultFeature.progressLabel}</span><div className="air-total"><strong>{success}</strong><span>/ {sourcingTotalTarget(current)}<small>{resultFeature.unit}</small></span></div></div>
                </div>
                {current.kind === 'resume_import' && <p className="air-progress-context"><span>计划最多 <b>{current.limit}</b> 份</span><span>已处理 <b>{current.results.length}</b> 份</span><span>处理失败 <b>{current.results.filter(item => item.stage === 'failed').length}</b> 份</span></p>}
                <progress className="air-progress-track" max={sourcingTotalTarget(current)} value={success} aria-label={resultFeature.progressLabel} />
                {isActiveJob && current.nextActionAt && <p className="air-countdown" aria-live="off">距下一步 {Math.max(0, Math.ceil((new Date(current.nextActionAt).getTime() - now) / 1000))} 秒</p>}
              </div>
              {!!current.events?.length && <ExecutionLog key={current.id} events={current.kind === 'greeting' ? current.events.map(event => ({ ...event, message: greetingNotice(event.message) })) : current.events} />}
            </div>
            <div className="air-result-toolbar"><div className="air-result-heading">全部记录<span>{results.length}</span></div><span className="air-section-meta">{current.kind === 'greeting' ? '每位候选人的最终结果' : '按操作顺序'}</span></div>
            {results.length ? <ul className="air-results" aria-label={current.kind === 'resume_import' ? '简历入库记录' : '候选人处理结果'}>{results.map((item, index) => {
              const Icon = current.kind === 'resume_import' ? FileTextIcon : resultIcon[item.stage]
              return <li className={`air-result is-${item.stage}`} key={`${item.key}-${index}`}><span className="air-result-symbol"><Icon aria-hidden="true" /></span><div className="air-result-body"><div className="air-result-title"><b title={item.name}>{item.name}</b><span className="air-result-state">{current.kind === 'greeting' ? greetingLabel(item) : current.kind === 'resume_import' && item.stage === 'succeeded' ? '已入库' : current.kind === 'resume_import' && item.stage === 'sending' ? '处理中' : item.stage === 'skipped' && item.retryable ? '已取消' : resultNames[item.stage]}</span></div><p>{item.attemptedAt && <><time dateTime={item.attemptedAt}>{new Date(item.attemptedAt).toLocaleTimeString('zh-CN', { hour12: false })}</time>{' · '}</>}{current.kind === 'greeting' ? greetingDetail(item) : item.detail}</p></div></li>
            })}</ul> : <div className="air-result-empty">{needsResumeHelp ? <ExclamationTriangleIcon aria-hidden="true" /> : <CheckCircledIcon aria-hidden="true" />}<p>{isActiveJob ? '任务正在执行，结果会显示在这里。' : needsResumeHelp ? '尚未处理任何简历，可在最近任务中复制操作日志反馈。' : '本次任务没有处理记录。'}</p></div>}
          </> : <div className="air-empty"><div className="air-empty-symbol"><ChatBubbleIcon aria-hidden="true" /></div><h3>开始你的第一个{feature.label}任务</h3><p>选择功能并设置参数，点击开始。<br />执行步骤与处理结果都会显示在这里。</p><div className="air-empty-guide"><span>选择功能</span><ChevronRightIcon aria-hidden="true" /><span>自动执行</span><ChevronRightIcon aria-hidden="true" /><span>实时查看结果</span></div></div>}
          <footer className="air-activity-footer"><span><DesktopIcon aria-hidden="true" />记录保存在本机</span><span>结果不确定时自动停止</span></footer>
        </section></SidePanel>}
    {recordsOpen && <TaskRecords rpc={rpc} onClose={() => setRecordsOpen(false)} onSelect={inspectTask} onCopyLog={copyTaskLog} busy={busy} copiedId={copiedLogTask} selectedId={current?.id} />}
    {dataOpen && <DataManagement rpc={rpc} locked={occupied || !!busy} onClose={() => setDataOpen(false)} onCleared={() => { setInspectedTask(undefined); setActivityOpen(false); setSelected({}); setDataRevision(value => value + 1); void rpc<WorkbenchState>('state').then(setState).catch(() => {}) }} />}
  </div>{setup.guide}</div>
}

function BrowserConnectionPopover({ status, children }: { status: ReturnType<typeof browserConnectionStatus>; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  return <div className="air-browser-popover" ref={root}>
    <button type="button" className="air-browser-trigger" ref={trigger} aria-expanded={open} aria-controls="air-browser-connection" onClick={() => setOpen(value => !value)}>
      <Link2Icon aria-hidden="true" /><span>浏览器扩展</span>
      <span className={`air-connection-status ${status === '已连接' ? 'is-ready' : ''}`}><span className="air-status-dot" aria-hidden="true" />{status}</span>
    </button>
    {open && children}
  </div>
}

function Connection({ label, good, pending = false, detail, showDetail = false, tag = false }: { label: string; good?: boolean; pending?: boolean; detail: string; showDetail?: boolean; tag?: boolean }) {
  return <div className={`air-connection-item ${good ? 'is-ready' : ''} ${pending ? 'is-pending' : ''} ${showDetail ? 'has-detail' : ''}`} aria-current={pending ? 'step' : undefined}><span className="air-connection-check">{pending ? <span className="air-connection-spinner" aria-hidden="true" /> : good ? <CheckIcon aria-hidden="true" /> : <span />}</span><span>{label}</span>{tag ? <small className="air-connection-tag">{detail}</small> : <small>{detail}</small>}</div>
}
function ExecutionLog({ events }: { events: NonNullable<WorkbenchJob['events']> }) {
  const log = useRef<HTMLOListElement>(null)
  const followLatest = useRef(true)
  useEffect(() => {
    if (log.current && followLatest.current) log.current.scrollTop = log.current.scrollHeight
  }, [events])
  return <div className="air-event-panel"><ol ref={log} className="air-event-log" aria-label="执行动态" aria-live="polite" tabIndex={0} onScroll={event => {
    const element = event.currentTarget
    followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8
  }}>{events.map((event, index) => <li key={`${event.at}-${index}`}><time>{new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>{event.message}</span></li>)}</ol></div>
}
function JobStatus({ status }: { status: WorkbenchJob['status'] }) {
  const Icon = status === 'completed' ? CheckCircledIcon : ['unknown', 'failed'].includes(status) ? ExclamationTriangleIcon : status === 'stopped' ? MinusCircledIcon : ClockIcon
  return <span className={`air-job-status is-${status}`}><Icon aria-hidden="true" />{statusNames[status]}</span>
}
function ActivitySkeleton() {
  return <div className="air-activity-skeleton" role="status" aria-label="正在读取任务记录"><div className="air-skeleton air-skeleton-number" /><div className="air-skeleton air-skeleton-caption" />{[0, 1, 2].map(index => <div className="air-skeleton-row" key={index}><span className="air-skeleton air-skeleton-icon" /><div><span className="air-skeleton air-skeleton-name" /><span className="air-skeleton air-skeleton-detail" /></div></div>)}<span className="air-sr-only">正在读取任务记录</span></div>
}
