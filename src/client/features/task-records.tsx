import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeftIcon, ArrowRightIcon, ChatBubbleIcon, CheckIcon, CopyIcon, FileTextIcon, MagnifyingGlassIcon } from '@radix-ui/react-icons'
import { PLATFORMS, TASK_FEATURES, taskFeature, type TaskKind, type WorkbenchJob } from '../../shared/workbench.js'
import type { TaskHistoryPage } from '../../shared/task-history.js'
import { SidePanel } from '../components/side-panel.js'
import { SelectMenu } from '../components/select-menu.js'
type Rpc = <T>(method: string, request?: unknown, signal?: AbortSignal) => Promise<T>
const states = { queued: '等待执行', running: '进行中', stopping: '停止中', completed: '已完成', stopped: '已停止', failed: '未完成', unknown: '待核对' }
const stamp = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
export function TaskRecords({ rpc, onClose, onSelect, onCopyLog, busy, copiedId, selectedId }: {
  rpc: Rpc; onClose: () => void; onSelect: (job: WorkbenchJob) => void; onCopyLog: (id: string) => void
  busy: string; copiedId: string; selectedId?: string
}) {
  const [kind, setKind] = useState(''), [page, setPage] = useState(1), [data, setData] = useState<TaskHistoryPage>()
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [opening, setOpening] = useState(''), [reload, setReload] = useState(0)
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>
    setLoading(true); setData(undefined); setError('')
    const poll = async () => {
      try {
        const value = await rpc<TaskHistoryPage>('taskHistory', { page, ...(kind ? { kind } : {}) }, abort.signal)
        if (!abort.signal.aborted) { setData(value); setError('') }
      } catch (error) { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error)) }
      finally { if (!abort.signal.aborted) { setLoading(false); timer = setTimeout(poll, 5000) } }
    }
    void poll(); return () => { abort.abort(); clearTimeout(timer) }
  }, [rpc, kind, page, reload])
  const selectionAbort = useRef<AbortController>()
  useEffect(() => { const abort = new AbortController(); selectionAbort.current = abort; return () => abort.abort() }, [])
  async function open(id: string) {
    if (opening) return
    setOpening(id); setError('')
    const signal = selectionAbort.current!.signal
    try { const job = await rpc<WorkbenchJob>('taskDetail', { id }, signal); if (!signal.aborted) { onSelect(job); onClose() } }
    catch (error) { if (!signal.aborted) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (!signal.aborted) setOpening('') }
  }
  return <SidePanel title="任务记录" onClose={onClose} className="air-records-panel">
    <div className="air-records-controls"><SelectMenu id="air-record-kind" label="任务类型" value={kind} options={[{ value: '', label: '全部任务' }, ...TASK_FEATURES.map(feature => ({ value: feature.kind, label: feature.label }))]} onChange={value => { setKind(value as TaskKind); setPage(1) }} /><span>{data ? `共 ${data.total} 条` : '正在读取…'}</span></div>
    {error && <div className="air-alert" role="alert">{error}<button type="button" className="air-text-button" onClick={() => setReload(value => value + 1)}>重试</button></div>}
    <div className="air-records-body" aria-busy={loading}>
      {loading ? <p className="air-records-empty">正在读取任务记录…</p> : !data?.records.length ? <div className="air-records-empty"><h3>暂无任务记录</h3><p>寻聘、打招呼和简历入库任务都会保存在这里。</p></div> : <ul>{data.records.map(record => {
        const Icon = record.kind === 'talent_sourcing' ? MagnifyingGlassIcon : record.kind === 'resume_import' ? FileTextIcon : ChatBubbleIcon
        return <li className={selectedId === record.id ? 'is-selected' : ''} key={record.id}>
          <button type="button" className="air-record-open" disabled={!!opening} onClick={() => void open(record.id)}>
            <span className="air-record-icon"><Icon aria-hidden="true" /></span>
            <span className="air-record-copy">
              <span className="air-record-title"><b title={record.jobName || taskFeature(record.kind).label}>{record.jobName || taskFeature(record.kind).label}</b></span>
              <span className="air-record-meta"><small>{taskFeature(record.kind).label} · {PLATFORMS[record.platform].label}</small><time dateTime={record.createdAt}>{stamp(record.createdAt)}</time><small className="air-record-progress" title={taskFeature(record.kind).progressLabel}>{opening === record.id ? '正在打开…' : `${record.completed} / ${record.limit} ${taskFeature(record.kind).unit}`}</small></span>
            </span>
            <span className={`air-record-status is-${record.status}`}>{states[record.status]}</span>
          </button>
          <button type="button" className="air-record-copy-log" title="复制该任务的开发日志和排查详情；内容可能包含候选人信息" disabled={!!busy || !!opening} onClick={() => onCopyLog(record.id)}>{copiedId === record.id ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}{busy === `复制操作日志:${record.id}` ? '读取中…' : copiedId === record.id ? '已复制' : '复制操作日志'}</button>
        </li>
      })}</ul>}
    </div>
    <footer className="air-records-footer"><span>{data ? `第 ${data.page} / ${Math.max(1, Math.ceil(data.total / data.pageSize))} 页` : ''}</span><div><button type="button" className="air-sourcing-icon-button" aria-label="上一页任务记录" disabled={loading || !data || data.page <= 1} onClick={() => setPage((data?.page || 1) - 1)}><ArrowLeftIcon aria-hidden="true" /></button><button type="button" className="air-sourcing-icon-button" aria-label="下一页任务记录" disabled={loading || !data || data.page * data.pageSize >= data.total} onClick={() => setPage((data?.page || 1) + 1)}><ArrowRightIcon aria-hidden="true" /></button></div></footer>
  </SidePanel>
}
