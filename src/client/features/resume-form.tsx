import React, { useEffect, useRef, useState } from 'react'
import { ChevronDownIcon, PlayIcon, ReloadIcon } from '@radix-ui/react-icons'
import { PLATFORMS, RESUME_DEFAULTS, type Platform, type ResumeOptions } from '../../shared/workbench.js'
import type { TaskFormProps } from '../task-forms.js'
import { usePlatformLogin } from '../use-platform-login.js'
import { FieldLabel } from '../field-label.js'

export function ResumeForm({ positionId, state, locked, busy, pending, blockingReason, loadResumeOptions, checkLogin, onStart }: TaskFormProps) {
  const [platform, setPlatform] = useState<Platform>('liepin')
  const [options, setOptions] = useState<ResumeOptions>()
  const [jobId, setJobId] = useState(positionId || '')
  useEffect(() => { if (positionId) setJobId(positionId) }, [positionId])
  const [destination, setDestination] = useState<string>(RESUME_DEFAULTS.destination)
  const [channel, setChannel] = useState<string>(RESUME_DEFAULTS.channel)
  const [delivery, setDelivery] = useState<string>(RESUME_DEFAULTS.delivery)
  const [recommenderId, setRecommenderId] = useState('')
  const [headhunterSupplierId, setHeadhunterSupplierId] = useState('')
  const [limit, setLimit] = useState(10)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const login = usePlatformLogin(platform, !!state?.connection.ready, locked, checkLogin)
  const { checking, refreshLogin } = login
  // 默认值只在首次读到选项时应用一次，之后不再覆盖用户已经做出的选择。
  const seeded = useRef(false)
  async function load() {
    setLoading(true); setError('')
    try {
      const next = await loadResumeOptions()
      setOptions(next)
      if (!seeded.current) {
        seeded.current = true
        setDestination(next.defaults.destination)
        setChannel(next.defaults.channel)
        setDelivery(next.defaults.delivery)
      }
    }
    catch (error) { setOptions(undefined); seeded.current = false; setError(error instanceof Error ? error.message : '读取失败') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const disabled = locked || loading || checking
  const valid = Number.isInteger(limit) && limit >= 1 && limit <= 50
  const selectedChannel = options?.channels.find(c => c.id === channel)
  const needsRecommender = selectedChannel?.requires === 'recommenderId'
  const needsSupplier = selectedChannel?.requires === 'headhunterSupplierId'
  // 内推/猎头的身份字段是渠道的硬性前置条件，留空时不允许启动。
  const identityReady = (!needsRecommender || recommenderId.trim().length > 0) && (!needsSupplier || headhunterSupplierId.trim().length > 0)
  const identityHint = identityReady ? '' : needsRecommender ? '内推渠道需要填写内推人员工ID' : '猎头渠道需要填写猎头供应商ID'
  const canStart = !disabled && !pending && login.status === 'logged_in' && valid && identityReady
    && options?.jobs.some(j => j.id === jobId)
    && options.destinations.some(d => d.id === destination)
    && options.channels.some(c => c.id === channel)
    && options.deliveries.some(d => d.id === delivery)
  const jobs = options?.jobs ?? []
  const channelLabel = selectedChannel?.label
  const deliveryLabel = options?.deliveries.find(d => d.id === delivery)?.label
  const destinationLabel = options?.destinations.find(d => d.id === destination)?.label
  const advancedSummary = [channelLabel, deliveryLabel, destinationLabel].filter(Boolean).join(' · ')
  return <>
    <div className="air-platform-field">
      <label className="air-label" htmlFor="air-resume-platform">招聘平台</label>
      <div className="air-select-wrap"><select id="air-resume-platform" disabled={disabled} value={platform} onChange={event => setPlatform(event.target.value as Platform)}>{(Object.keys(PLATFORMS) as Platform[]).map(key => <option key={key} value={key}>{PLATFORMS[key].label}</option>)}</select><ChevronDownIcon aria-hidden="true" /></div>
      <div className="air-login-status" aria-live="polite"><span className={`air-field-hint ${login.status === 'logged_in' ? 'air-login-ok' : 'air-login-muted'}`} title={login.detail}>{login.label}</span><span>{login.showDetail && <button type="button" className="air-text-button" disabled={disabled} onClick={() => void refreshLogin(false)}>重试</button>}{login.status !== 'logged_in' && <button type="button" className="air-text-button" disabled={disabled} onClick={() => void refreshLogin(true)}>去登录</button>}</span></div>
      {login.showDetail && <p className="air-field-hint" role="status">{login.detail}</p>}
    </div>
    {!positionId && <div className="air-field">
      <div className="air-label-row"><label className="air-label" htmlFor="air-resume-job">薪人薪事目标职位</label><button type="button" className="air-text-button" disabled={disabled} onClick={() => void load()}><ReloadIcon aria-hidden="true" />刷新</button></div>
      <div className="air-select-wrap"><select id="air-resume-job" value={jobId} disabled={disabled || !options} onChange={event => setJobId(event.target.value)}><option value="">{loading ? '正在读取职位…' : options && !options.jobs.length ? '没有可用的在招职位' : '请选择目标职位'}</option>{jobs.map(j => <option key={j.id} value={j.id}>{j.label}{options!.jobs.filter(other => other.label === j.label).length > 1 ? `（${j.id}）` : ''}</option>)}</select><ChevronDownIcon aria-hidden="true" /></div>
    </div>}
    <div className="air-field">
      <FieldLabel htmlFor="air-resume-limit" hintId="air-resume-limit-hint" invalid={!valid} hint={valid ? '从已收简历列表采集附件，重复简历和无附件记录跳过。' : '请输入 1 至 50 之间的整数。'}>本次处理简历</FieldLabel>
      <div className={`air-number-field ${valid ? '' : 'is-invalid'}`}><input id="air-resume-limit" type="number" min={1} max={50} step={1} value={Number.isNaN(limit) ? '' : limit} disabled={disabled} aria-invalid={!valid} aria-describedby="air-resume-limit-hint" onChange={event => setLimit(event.target.value === '' ? NaN : Number(event.target.value))} /><span>份</span></div>
    </div>
    <details className="air-advanced">
      <summary>
        <span>高级选项</span>
        {advancedSummary && <span className="air-advanced-summary" title={advancedSummary}>{advancedSummary}</span>}
      </summary>
      <div className="air-field">
        <label className="air-label" htmlFor="air-resume-channel">来源渠道</label>
        <div className="air-select-wrap"><select id="air-resume-channel" value={channel} disabled={disabled || !options} onChange={event => setChannel(event.target.value)}>{!options && <option value={RESUME_DEFAULTS.channel}>正在读取来源渠道…</option>}{options?.channels.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select><ChevronDownIcon aria-hidden="true" /></div>
      </div>
      {needsRecommender && <div className="air-field">
        <FieldLabel htmlFor="air-resume-recommender" hintId="air-resume-recommender-hint" invalid={!recommenderId.trim()} hint="内推渠道必填；留空时无法开始。">内推人员工ID</FieldLabel>
        <input className="air-job-search" id="air-resume-recommender" placeholder="请输入内推人员工ID" value={recommenderId} disabled={disabled} maxLength={64} aria-invalid={!recommenderId.trim()} aria-describedby="air-resume-recommender-hint" onChange={event => setRecommenderId(event.target.value)} />
      </div>}
      {needsSupplier && <div className="air-field">
        <FieldLabel htmlFor="air-resume-headhunter" hintId="air-resume-headhunter-hint" invalid={!headhunterSupplierId.trim()} hint="猎头渠道必填；留空时无法开始。">猎头供应商ID</FieldLabel>
        <input className="air-job-search" id="air-resume-headhunter" placeholder="请输入猎头供应商ID" value={headhunterSupplierId} disabled={disabled} maxLength={64} aria-invalid={!headhunterSupplierId.trim()} aria-describedby="air-resume-headhunter-hint" onChange={event => setHeadhunterSupplierId(event.target.value)} />
      </div>}
      <div className="air-field">
        <label className="air-label" htmlFor="air-resume-delivery">投递类型</label>
        <div className="air-select-wrap"><select id="air-resume-delivery" value={delivery} disabled={disabled || !options} onChange={event => setDelivery(event.target.value)}>{!options && <option value={RESUME_DEFAULTS.delivery}>正在读取投递类型…</option>}{options?.deliveries.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}</select><ChevronDownIcon aria-hidden="true" /></div>
      </div>
      <div className="air-field">
        <label className="air-label" htmlFor="air-resume-destination">上传位置</label>
        <div className="air-select-wrap"><select id="air-resume-destination" value={destination} disabled={disabled || !options} onChange={event => setDestination(event.target.value)}>{!options && <option value="1:10">正在读取上传位置…</option>}{options?.destinations.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}</select><ChevronDownIcon aria-hidden="true" /></div>
      </div>
    </details>
    {error && <div className="air-form-error" role="alert">{error}</div>}
    <div className="air-launch"><button type="button" className="air-button air-button-primary" disabled={!canStart} title={blockingReason || identityHint || '采集所选平台已收简历并上传到薪人薪事'} onClick={() => onStart({ platform, jobId, destination, channel, delivery, recommenderId: recommenderId.trim(), headhunterSupplierId: headhunterSupplierId.trim(), limit, confirmed: true })}><PlayIcon aria-hidden="true" />{busy === '启动任务' ? '正在启动…' : '开始批量入库'}</button></div>
  </>
}
