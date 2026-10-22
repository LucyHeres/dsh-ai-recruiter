import React, { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { PLATFORMS, taskFeature, type WorkbenchJob, type DeveloperLogs } from '../shared/workbench.js'
import { ArrowTopRightIcon, ChevronDownIcon, ChevronRightIcon, IdCardIcon } from '@radix-ui/react-icons'
import type { JobOption, WorkbenchState } from '../shared/workbench.js'
import type { SourcingJob } from '../shared/sourcing.js'
import { SelectMenu } from './components/select-menu.js'
import { SourcingPanel } from './features/sourcing-panel.js'
import { taskResultRows } from '../shared/greeting-results.js'
import { greetingLabel, greetingDetail, hasGreeted } from '../shared/communication.js'
import styles from './style.css'
import panelStyles from './session-panel.css'
import entryStyles from './session-entry.css'

type Rpc = <T>(method: string, request?: unknown, signal?: AbortSignal) => Promise<T>
type SessionCall = { at: string; tool: string; summary: string; ok: boolean; code?: string; durationMs: number; jobId?: string }
type SessionTasks = { jobs: WorkbenchJob[]; activeJobId: string | null; calls?: SessionCall[]; latestPositionId?: string }
type PanelFace = { rpc: Rpc; open: (sessionId: string) => void; openWorkbench: (position: JobOption) => void }
const panelKind = 'ai-recruiter-progress'
const active = (job: WorkbenchJob) => ['queued', 'running', 'stopping'].includes(job.status)
const statusLabels: Record<WorkbenchJob['status'], string> = { queued: '等待执行', running: '进行中', stopping: '停止中', completed: '已完成', stopped: '已停止', failed: '执行失败', unknown: '结果待核对' }
const phases: Record<string, string> = { searching: '按职位搜索人才', connecting: '连接浏览器', preparing: '准备任务', reading: '定位下一位候选人', sending: '点击沟通', cooldown: '点击间隔', capturing: '采集附件', importing: '上传与保存', finished: '执行结束' }


function useSessionTasks(sessionId: string, rpc: Rpc) {
  const [snapshot, setSnapshot] = useState<SessionTasks & { sessionId: string }>()
  const [failure, setFailure] = useState<{ sessionId: string; message: string }>()
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      let running = false
      try {
        const state = await rpc<SessionTasks>('sessionTasks', { sessionId }, controller.signal)
        if (controller.signal.aborted) return
        setSnapshot({ ...state, sessionId }); setFailure(undefined)
        running = state.jobs.some(active)
      } catch (error) {
        if (controller.signal.aborted) return
        setFailure({ sessionId, message: error instanceof Error ? error.message : '任务进度读取失败' })
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), running ? 800 : 1800)
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [sessionId, rpc])
  return { state: snapshot?.sessionId === sessionId ? snapshot : undefined, error: failure?.sessionId === sessionId ? failure.message : '' }
}

function SessionRecruitmentEntry({ sessionId, rpc, open }: PropsRuntime<'conversation.session.header.actions'> & PanelFace) {
  const { state, error } = useSessionTasks(sessionId, rpc)
  const opened = useRef(new Set<string>())
  const [openError, setOpenError] = useState('')
  const reveal = () => {
    try { open(sessionId); setOpenError('') } catch (failure) { setOpenError(failure instanceof Error ? failure.message : '无法打开招聘进度面板') }
  }
  const latest = state?.jobs[0]
  useEffect(() => {
    if (!latest || opened.current.has(latest.id)) return
    opened.current.add(latest.id)
    if (active(latest) || Date.now() - Date.parse(latest.createdAt) < 60000) reveal()
  }, [sessionId, latest?.id])
  if (!latest && !state?.calls?.length && !error) return null
  const task = state?.jobs.find(job => job.id === state.activeJobId && active(job)) ?? state?.jobs.find(active) ?? latest
  const status = error || openError ? 'error' : task?.status
  const label = openError ? '打开失败' : error ? '状态异常' : task ? task.status === 'unknown' && task.kind !== 'resume_import' ? '已停止' : statusLabels[task.status] : ''
  return <span className="air-session-entry"><style>{entryStyles}</style><button type="button" className="air-session-entry-trigger" data-state={status || 'idle'} onClick={reveal} title={error || openError || '查看当前会话招聘任务进度'} aria-label={`查看招聘进度${label ? `，${label}` : ''}`}>
    <IdCardIcon aria-hidden="true" /><span>招聘进度</span>{label && <span className="air-session-entry-state">{label}</span>}<ChevronRightIcon className="air-session-entry-chevron" aria-hidden="true" />
  </button>{openError && <span className="air-session-entry-error" role="alert">{openError}</span>}</span>
}

export function SessionRecruitmentPanel({ sessionId, rpc, openWorkbench }: PropsRuntime<'sidebar.right.pane.tab'> & PanelFace) {
  const { state, error } = useSessionTasks(sessionId, rpc)
  const [selected, setSelected] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState('')
  const [copied, setCopied] = useState('')
  const [positions, setPositions] = useState<JobOption[]>([])
  const [workbench, setWorkbench] = useState<WorkbenchState>()
  const [positionError, setPositionError] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [reloadPositions, setReloadPositions] = useState(0)
  const pending = useRef<{ sessionId: string; task: Record<string, unknown> & { id: string } }>()
  const actionLock = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    const abort = new AbortController()
    rpc<JobOption[]>('greetingJobOptions', {}, abort.signal).then(value => { if (!abort.signal.aborted) { setPositions(value); setPositionError('') } })
      .catch(failure => { if (!abort.signal.aborted) setPositionError(failure instanceof Error ? failure.message : '职位读取失败') })
    return () => abort.abort()
  }, [sessionId, rpc, reloadPositions])
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { const value = await rpc<WorkbenchState>('state', undefined, abort.signal); if (!abort.signal.aborted) { setWorkbench(value); setConnectionError('') } }
      catch (failure) { if (!abort.signal.aborted) { setWorkbench(undefined); setConnectionError(failure instanceof Error ? failure.message : '连接状态读取失败') } }
      finally { if (!abort.signal.aborted) timer = setTimeout(poll, 1500) }
    }
    void poll(); return () => { abort.abort(); clearTimeout(timer) }
  }, [sessionId, rpc])
  const options = positions.slice()
  for (const job of state?.jobs ?? []) if (job.jobId && !options.some(option => option.id === job.jobId)) {
    const source = job as SourcingJob
    options.push({ id: job.jobId, name: job.jobName || source.position?.name || '历史招聘职位', label: job.jobName || source.position?.name || '历史招聘职位', city: source.position?.city, department: source.position?.department })
  }
  const preferred = selected || state?.latestPositionId || state?.jobs.find(job => job.jobId)?.jobId
  const position = state ? preferred ? options.find(option => option.id === preferred) : options[0] : undefined
  const latest = state?.jobs.find(job => job.jobId === position?.id || !job.jobId)
  const sourcingTasks = [...(state?.jobs ?? []), ...(workbench?.jobs ?? []).filter(job => job.source === 'chat' && job.sessionId === sessionId)]
    .filter(job => job.kind === 'talent_sourcing' && job.jobId === position?.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const requested = pending.current?.task.jobId === position?.id ? pending.current : undefined
  const execution = requested ? sourcingTasks.find(job => job.id === requested.task.id)
    : sourcingTasks.find(job => job.id === workbench?.activeJobId) ?? sourcingTasks[0]
  const executionId = execution?.id ?? null
  const occupiedElsewhere = !!position && !!workbench?.activeJobId && workbench.activeJobId !== executionId
  const legacy = latest && latest.kind !== 'talent_sourcing' ? latest : undefined
  const locked = !workbench || !!busy || !!pending.current || !!workbench.activeJobId || !!workbench.connection.busy || !!workbench.connection.activeWorkflow
  async function perform(label: string, action: () => Promise<void>) {
    if (actionLock.current) return
    actionLock.current = true; setBusy(label); setActionError('')
    try { await action() } catch (failure) { if (mounted.current) setActionError(failure instanceof Error ? failure.message : '操作失败') }
    finally { actionLock.current = false; if (mounted.current) setBusy('') }
  }
  function start(settings: Record<string, unknown>) {
    void perform('启动任务', async () => {
      const request = { sessionId, task: { ...settings, kind: 'talent_sourcing', id: crypto.randomUUID() } }
      pending.current = request
      await rpc('startSessionTask', request)
      const value = await rpc<WorkbenchState>('state')
      pending.current = undefined
      if (mounted.current) setWorkbench(value)
    })
  }
  function reconcile() {
    void perform('刷新任务状态', async () => {
      const request = pending.current; if (!request) return
      const value = await rpc<SessionTasks>('sessionTasks', { sessionId })
      if (!value.jobs.some(job => job.id === request.task.id)) await rpc('startSessionTask', request)
      const next = await rpc<WorkbenchState>('state')
      pending.current = undefined
      if (mounted.current) setWorkbench(next)
    })
  }
  function copyLog(job: WorkbenchJob) {
    void perform('复制操作日志', async () => {
      const logs = await rpc<DeveloperLogs>('developerLogs', { id: job.id, limit: 300 })
      await navigator.clipboard.writeText([`dsh-ai-recruiter | taskId=${job.id} | ${job.detail}`, ...logs.lines].join('\n'))
      if (mounted.current) setCopied(job.id)
    })
  }
  return <section className="air-workbench air-session-panel">
    <style>{styles}{panelStyles}</style>
    <header className="air-session-heading">
      <label htmlFor="air-session-position">职位</label>
      <div className="air-session-position" title={position && [position.name, position.department, position.city].filter(Boolean).join(' · ')}><SelectMenu id="air-session-position" label="职位" value={position?.id || ''} options={options.map(option => ({ value: option.id, label: option.name, description: [option.department, option.city, option.code].filter(Boolean).join(' · ') }))} searchable disabled={!state || !!busy || !!pending.current} placeholder={state ? '选择招聘职位' : '正在读取…'} onChange={id => { setSelected(id); setActionError('') }} /></div>
      <button type="button" className="air-text-button air-session-workbench" disabled={!position} onClick={() => { if (position) void perform('打开工作台', async () => openWorkbench(position)) }}>去工作台<ArrowTopRightIcon aria-hidden="true" /></button>
    </header>
    {(error || actionError || positionError || connectionError) && <p role="alert" className="air-session-error">{error || actionError || positionError || connectionError}{positionError && <button type="button" className="air-text-button" onClick={() => setReloadPositions(value => value + 1)}>重试职位读取</button>}</p>}
    <div className="air-session-content">
      {occupiedElsewhere && <p className="air-session-occupied" role="status">另一个招聘任务正在执行，结束后可开始当前职位的寻聘。</p>}
      {legacy && <LegacyTask job={legacy} busy={!!busy} copied={copied} onStop={() => void perform('停止任务', async () => { await rpc('stop', { id: legacy.id }) })} onCopy={() => copyLog(legacy)} />}
      {!state && !error ? <p className="air-session-empty" role="status">正在读取当前会话任务…</p> : position ? <SourcingPanel key={sessionId + ':' + position.id} compact positions={options} positionId={position.id} executionId={executionId} rpc={rpc} state={workbench} locked={locked} pending={!!pending.current && !busy} busy={busy} onStart={start} onReconcile={reconcile} /> : <div className="air-session-empty"><h3>从一个职位开始招聘</h3><p>{preferred ? '最近涉及的职位暂不可用，请从上方重新选择。' : '选择上方职位，或在对话里说明要招聘的职位。'}</p></div>}
    </div>
    {(!!state?.calls?.length || !!latest) && <details className="air-session-diagnostics"><summary>执行记录 <span>{state?.calls?.length || 0}</span><ChevronDownIcon aria-hidden="true" /></summary>{latest && <div className="air-session-log-action"><span>{taskFeature(latest.kind).label} · {latest.status === 'unknown' && latest.kind !== 'resume_import' ? '已停止' : statusLabels[latest.status]}</span><button type="button" className="air-text-button" disabled={!!busy} onClick={() => copyLog(latest)}>{copied === latest.id ? '日志已复制' : '复制操作日志'}</button></div>}<h3 className="air-session-diagnostic-label">工具调用记录</h3><ol className="air-session-calls">{(state?.calls || []).slice(0, 8).map((call, index) => <li key={call.at + index}><time>{new Date(call.at).toLocaleTimeString('zh-CN', { hour12: false })}</time><strong>{call.summary}</strong><span>{call.ok ? `${call.durationMs} ms` : `失败${call.code ? ` · ${call.code}` : ''}`}</span></li>)}</ol></details>}
  </section>
}

function LegacyTask({ job, busy, copied, onStop, onCopy }: { job: WorkbenchJob; busy: boolean; copied: string; onStop: () => void; onCopy: () => void }) {
  const rows = taskResultRows(job), completed = rows.filter(row => job.kind === 'greeting' ? hasGreeted(row) : row.stage === 'succeeded').length
  return <details className="air-session-legacy" open={active(job)}><summary><b>{taskFeature(job.kind).label}进度</b><span>{job.status === 'unknown' && job.kind !== 'resume_import' ? '已停止' : statusLabels[job.status]}</span><strong>{completed} / {job.limit} {taskFeature(job.kind).unit}</strong><ChevronDownIcon aria-hidden="true" /></summary><div>
    <p>{job.jobName || PLATFORMS[job.platform].label}{job.destinationLabel && ` · ${job.destinationLabel}`}</p>
    <progress max={job.limit} value={completed} aria-label={taskFeature(job.kind).progressLabel} />
    <p className="air-session-phase">{phases[job.phase ?? ''] || '等待执行'}</p>
    <div className="air-session-actions">{active(job) && <button type="button" className="air-button air-button-outline" disabled={busy} onClick={onStop}>停止任务</button>}<button type="button" className="air-text-button" disabled={busy} onClick={onCopy}>{copied === job.id ? '日志已复制' : '复制操作日志'}</button></div>
    <ol className="air-session-results">{rows.map(item => <li key={item.key}><div><strong>{item.name}</strong><span>{job.kind === 'greeting' ? greetingLabel(item) : item.stage === 'succeeded' ? '已入库' : item.stage === 'unknown' ? '待核对' : item.stage === 'sending' ? '处理中' : item.stage === 'skipped' ? '已跳过' : '失败'}</span></div><p>{job.kind === 'greeting' ? greetingDetail(item) : item.detail}</p></li>)}</ol>
  </div></details>
}

export function registerSessionPanel(ctx: Context, rpc: Rpc, openWorkbench: (position: JobOption) => void) {
  const face: PanelFace = { rpc, openWorkbench, open: sessionId => ctx.sidebarRight.openTabIn(sessionId as SessionId, panelKind) }
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: panelKind, kind: panelKind, title: () => '招聘进度' }))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: panelKind, inject: () => face }, props => <SessionRecruitmentPanel key={props.sessionId} {...props} />))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: panelKind, order: 70, inject: () => face }, SessionRecruitmentEntry))
}
