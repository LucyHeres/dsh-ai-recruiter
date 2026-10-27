import React, { useEffect, useState } from 'react'
import { ArrowRightIcon, ReloadIcon, MagnifyingGlassIcon } from '@radix-ui/react-icons'
import type { PositionOverview } from '../../shared/sourcing.js'
import type { JobOption } from '../../shared/workbench.js'
import { recruitmentPlatformForChannel, recruitmentPublishedChannels } from '../../shared/published-channels.js'
import { renderPlatformTag } from '../components/platform-tag.js'
type Rpc = <T>(method: string, request?: unknown, signal?: AbortSignal) => Promise<T>
export function PositionHome({ rpc, onRecruit }: { rpc: Rpc; onRecruit: (position: JobOption) => void }) {
  const [positions, setPositions] = useState<PositionOverview[]>([])
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [query, setQuery] = useState(''), [revision, setRevision] = useState(0)
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try { const value = await rpc<PositionOverview[]>('positionOverview', undefined, abort.signal); if (!abort.signal.aborted) { setPositions(value); setError('') } }
      catch (error) { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error)) }
      finally { if (!abort.signal.aborted) { setLoading(false); timer = setTimeout(load, 2000) } }
    }
    void load(); return () => { abort.abort(); clearTimeout(timer) }
  }, [rpc, revision])
  const filtered = positions.filter(job => [job.name, job.city, job.department, job.code].join(' ').toLowerCase().includes(query.trim().toLowerCase()))
  return <section className="air-position-home" aria-label="在招职位">
    <div className="air-position-toolbar">
      <h2>在招职位 <span className="air-position-count">{positions.length}</span></h2>
      <div className="air-position-tools">
        <div className="air-position-search"><MagnifyingGlassIcon aria-hidden="true" /><input aria-label="搜索在招职位" placeholder="搜索职位、部门或城市" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <button className="air-button air-button-outline" type="button" disabled={loading} onClick={() => { setLoading(true); setRevision(v => v + 1) }}><ReloadIcon aria-hidden="true" />刷新</button>
      </div>
    </div>
    {error && <div className="air-position-error" role="alert"><b>职位读取失败</b><details><summary>查看原因</summary><p>{error}</p></details><button className="air-text-button" type="button" onClick={() => setRevision(v => v + 1)}>重试</button></div>}
    {!error && (filtered.length > 0 || loading) && <div className="air-position-columns" aria-hidden="true"><span>职位信息</span><span>已浏览</span><span>已沟通</span><span>已有简历</span><span /></div>}
    <div className="air-position-list" aria-busy={loading}>
      {loading && !positions.length && !error && <div className="air-position-loading" role="status" aria-label="正在读取在招职位">{[0,1,2,3].map(i => <div className="air-position-skeleton" key={i}><div><span className="air-skeleton" /><span className="air-skeleton" /></div>{[0,1,2].map(n => <span className="air-skeleton" key={n} />)}<span className="air-skeleton" /></div>)}</div>}
      {filtered.map(job => <article className="air-position-card" key={job.id}>
        <div className="air-position-identity">
          <div><h3>{job.name}</h3>{publishedChannels(job)}{job.activeKind && <span className="air-position-running">{job.activeKind === 'resume_import' ? '简历入库中' : '寻聘进行中'}</span>}</div>
          <p>{job.department && <span>{job.department}</span>}{job.city && <span>{job.city}</span>}{job.code && <span className="air-position-code" title="职位编号">{job.code}</span>}{!job.department && !job.city && <span>部门与城市未填写</span>}</p>
        </div>
        <dl className="air-position-metrics">{[{label:'已浏览',value:job.viewedCount},{label:'已沟通',value:job.greetedCount},{label:'已有简历',value:job.resumeCount}].map(item => <div key={item.label}><dt>{item.label}</dt><dd className={item.value ? undefined : 'is-zero'}>{item.value}</dd></div>)}</dl>
        <div className="air-position-action"><button className="air-button air-button-primary" type="button" onClick={() => onRecruit(job)}>去招聘<ArrowRightIcon aria-hidden="true" /></button></div>
      </article>)}
    </div>
    {!filtered.length && !loading && !error && <div className="air-sourcing-empty"><h3>{query ? '没有找到匹配的职位' : '暂无可用的在招职位'}</h3><p>{query ? '试试职位名称、部门或工作城市。' : '在薪人薪事创建在招职位后，刷新列表。'}</p></div>}
  </section>
}

function publishedChannels(job: PositionOverview) {
  const channels = recruitmentPublishedChannels(job.publishedChannels ?? [])
  return <span className="air-position-platforms" aria-label="发布渠道">{channels.length
    ? channels.map(channel => renderPlatformTag(recruitmentPlatformForChannel(channel)!, { key: channel.id, className: 'air-position-platform-tag', title: channel.name }))
    : <span className="air-position-platform-empty">{job.publishedChannels ? '未关联招聘平台' : '发布渠道尚未读取，请重启薪灵后刷新'}</span>}</span>
}
