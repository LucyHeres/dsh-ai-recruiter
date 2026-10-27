import React, { useEffect, useRef, useState } from 'react'
import type { DataGroup, DataStorageUsage } from '../../shared/sourcing.js'
import { SidePanel } from '../components/side-panel.js'

type Rpc = <T>(method: string, request?: unknown, signal?: AbortSignal) => Promise<T>
const labels: Record<DataGroup, string> = { tasks: '任务记录数据', talents: '人才列表数据' }
const descriptions: Record<DataGroup, string> = {
  tasks: '将删除本机任务历史和操作日志，人才列表会保留。',
  talents: '将删除本机人才列表、简历分析、附件链接和旧附件副本，任务历史会保留。',
}
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
  : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`

export function DataManagement({ rpc, locked, onClose, onCleared }: { rpc: Rpc; locked: boolean; onClose: () => void; onCleared?: () => void }) {
  const [usage, setUsage] = useState<DataStorageUsage>(), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true), [clearing, setClearing] = useState(false), [reload, setReload] = useState(0)
  const [pending, setPending] = useState<DataGroup>()
  const inFlight = useRef(false), mounted = useRef(false), confirmation = useRef<HTMLDialogElement>(null), cancelButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void rpc<DataStorageUsage>('dataStorage', undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) setUsage(value)
    }).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [rpc, reload])
  useEffect(() => { if (pending) { confirmation.current?.showModal(); cancelButton.current?.focus() } }, [pending])
  function cancel() { if (!inFlight.current) { confirmation.current?.close(); setPending(undefined); setError('') } }
  async function clear() {
    if (!pending || locked || loading || inFlight.current || !usage?.[pending].bytes) return
    inFlight.current = true; setClearing(true); setError(''); setNotice('')
    try {
      const result = await rpc<{ usage: DataStorageUsage; bytes: number }>('clearData', { group: pending, confirmed: true })
      if (mounted.current) {
        setUsage(result.usage); setNotice(`${labels[pending]}已清理，释放 ${size(result.bytes)}。`)
        confirmation.current?.close(); setPending(undefined); onCleared?.()
      }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { inFlight.current = false; if (mounted.current) setClearing(false) }
  }
  return <SidePanel title="数据管理" onClose={onClose} className="air-data-management">
    <div className="air-data-body">
      <ul className="air-data-groups" aria-label="本机数据占用" aria-busy={loading}>{(['tasks', 'talents'] as const).map(group => <li key={group}>
        <span>{labels[group]}</span><strong>{loading ? '统计中…' : usage ? size(usage[group].bytes) : '—'}</strong>
        <button type="button" className="air-button air-button-outline air-button-small" aria-label={`清理${labels[group]}`} disabled={locked || loading || clearing || !usage?.[group].bytes} onClick={() => { setPending(group); setError(''); setNotice('') }}>清理</button>
      </li>)}</ul>
      {locked && <p className="air-data-hint">请等待当前操作结束后清理。</p>}
      {notice && <p className="air-storage-notice" role="status">{notice}</p>}
      {error && !pending && <div className="air-alert" role="alert">{error}<button type="button" className="air-text-button" onClick={() => setReload(value => value + 1)}>重新统计</button></div>}
    </div>
    {pending && <dialog ref={confirmation} className="air-data-confirm" role="alertdialog" aria-modal="true" aria-labelledby="air-data-confirm-title" aria-describedby="air-data-confirm-description" onCancel={event => { event.preventDefault(); cancel() }}>
      <h3 id="air-data-confirm-title">确认清理{labels[pending]}？</h3>
      <div id="air-data-confirm-description"><p>{descriptions[pending]}</p><p>此操作不可恢复，薪人薪事中已入库的简历不受影响。</p></div>
      {error && <p className="air-alert" role="alert">{error}</p>}
      <div className="air-data-confirm-actions"><button ref={cancelButton} type="button" className="air-button air-button-outline" disabled={clearing} onClick={cancel}>取消</button><button type="button" className="air-button air-button-danger" disabled={locked || loading || clearing} onClick={() => void clear()}>{clearing ? '正在清理…' : '确认清理'}</button></div>
    </dialog>}
  </SidePanel>
}
