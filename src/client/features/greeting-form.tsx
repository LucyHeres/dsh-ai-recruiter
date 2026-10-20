import React, { useEffect, useRef, useState } from 'react'
import { ArrowRightIcon, ChevronDownIcon, PlayIcon } from '@radix-ui/react-icons'
import { PLATFORMS, type Platform, type JobOption } from '../../shared/workbench.js'
import type { TaskFormProps } from '../task-forms.js'
import { usePlatformLogin } from '../use-platform-login.js'
import { FieldLabel } from '../field-label.js'

export function GreetingForm({ state, locked, busy, pending, blockingReason, loadJobOptions, checkLogin, onStart }: TaskFormProps) {
  const [platform, setPlatform] = useState<Platform>('liepin')
  const [jobs, setJobs] = useState<JobOption[]>()
  const [jobId, setJobId] = useState('')
  const [loadingJobs, setLoadingJobs] = useState(true)
  const [jobError, setJobError] = useState('')
  const jobLoad = useRef(0)
  async function refreshJobs() {
    const request = ++jobLoad.current
    setLoadingJobs(true); setJobError('')
    try {
      const options = await loadJobOptions()
      if (request !== jobLoad.current) return
      setJobs(options)
      // 保留已有选择；否则默认选中列表第一项，减少一次手动操作。
      setJobId(previous => options.some(job => job.id === previous) ? previous : options[0]?.id ?? '')
    } catch (error) {
      if (request !== jobLoad.current) return
      setJobs(undefined); setJobId('')
      setJobError(error instanceof Error ? error.message : '职位列表读取失败，请重试')
    } finally { if (request === jobLoad.current) setLoadingJobs(false) }
  }
  useEffect(() => { void refreshJobs(); return () => { jobLoad.current++ } }, [])
  const [limit, setLimit] = useState(5)
  const [mode, setMode] = useState<'recommend' | 'search'>('recommend')
  const [searchKeyword, setSearchKeyword] = useState('')
  const [city, setCity] = useState('')
  const [ageUnder, setAgeUnder] = useState('')
  const [experienceMin, setExperienceMin] = useState('')
  const [experienceMax, setExperienceMax] = useState('')
  useEffect(() => { if (platform !== 'liepin') setMode('recommend') }, [platform])
  const optionalNumber = (value: string) => value.trim() ? Number(value) : undefined
  const validNumber = (value: string, min: number, max: number) => !value.trim() || Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max
  const validSearch = mode !== 'search' || platform === 'liepin' && !!searchKeyword.trim()
    && validNumber(ageUnder, 18, 100) && validNumber(experienceMin, 0, 60) && validNumber(experienceMax, 0, 60)
    && (!experienceMin || !experienceMax || Number(experienceMin) <= Number(experienceMax))
  const login = usePlatformLogin(platform, !!state?.connection.ready, locked, checkLogin)
  const { checking, refreshLogin } = login
  const validLimit = Number.isInteger(limit) && limit >= 1 && limit <= 100
  const validJob = jobs?.some(job => job.id === jobId) === true
  const usedToday = state?.dailyUsage?.[platform] ?? 0
  const quota = state?.dailyLimit ?? 100
  const canStart = !locked && !checking && !loadingJobs && !jobError && validJob && login.status === 'logged_in' && validLimit && validSearch && usedToday < quota && !pending
  const startHint = blockingReason || (usedToday >= quota ? `${PLATFORMS[platform].label}今日额度已用完，明天可继续`
    : !validLimit ? '请输入 1 至 100 之间的整数'
    : !validJob ? '请选择职位'
    : '点击后自动打开平台并开始沟通')
  return <>
          <div className="air-platform-field">
            <label className="air-label" htmlFor="air-platform">招聘平台</label>
            <details className="air-platform-picker" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false }} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
              <summary id="air-platform" aria-disabled={locked || checking} onClick={event => { if (locked || checking) event.preventDefault() }}><span>{PLATFORMS[platform].label}</span><ChevronDownIcon aria-hidden="true" /></summary>
              <div className="air-platform-options" aria-label="选择招聘平台">
                {(Object.keys(PLATFORMS) as Platform[]).map(key => <button type="button" key={key} aria-pressed={platform === key} disabled={locked || checking} onClick={event => { setPlatform(key); const details = event.currentTarget.closest('details'); if (details) { details.open = false; details.querySelector('summary')?.focus() } }}>
                  <span>{PLATFORMS[key].label}</span>
                </button>)}
              </div>
            </details>
            <div className="air-login-status" aria-live="polite"><span className={`air-field-hint ${login.status === 'logged_in' ? 'air-login-ok' : 'air-login-muted'}`} title={login.detail}>{login.label}</span><span>{login.showDetail && <button type="button" className="air-text-button" disabled={locked || checking} onClick={() => void refreshLogin(false)}>重试</button>}{login.status !== 'logged_in' && <button type="button" className="air-text-button" disabled={locked || checking} onClick={() => void refreshLogin(true)}>去登录</button>}</span></div>
            {login.showDetail && <p className="air-field-hint" role="status">{login.detail}</p>}
          </div>

          <div className="air-field" aria-busy={loadingJobs}>
            <FieldLabel htmlFor="air-job" hintId="air-job-hint" invalid={!!jobError} hint={jobError || (loadingJobs ? '正在读取薪人薪事职位列表。' : jobs?.length === 0 ? '当前账号没有可用的在招职位。' : '来自薪人薪事系统的在招职位，默认选中第一个，可自行更改。')}>职位</FieldLabel>
            <div className="air-select-wrap"><select id="air-job" value={jobId} disabled={locked || loadingJobs || !jobs?.length} aria-describedby="air-job-hint" onChange={event => setJobId(event.target.value)}>
              <option value="">{loadingJobs ? '正在读取职位…' : jobError ? '职位读取失败' : jobs?.length === 0 ? '暂无在招职位' : '请选择职位'}</option>
              {jobs?.map(job => <option key={job.id} value={job.id}>{job.label}{jobs.filter(other => other.label === job.label).length > 1 ? `（${job.id}）` : ''}</option>)}
            </select><ChevronDownIcon aria-hidden="true" /></div>
          </div>

          <div className="air-field">
            <FieldLabel htmlFor="air-limit" hintId="air-limit-hint" invalid={!validLimit} hint={validLimit ? `${PLATFORMS[platform].label}今日已用 ${usedToday} / ${quota} 次（每个平台各自计算），达到上限自动停止。` : '请输入 1 至 100 之间的整数。'}>本次沟通人数</FieldLabel>
            <div className={`air-number-field ${!validLimit ? 'is-invalid' : ''}`}><input id="air-limit" type="number" min={1} max={100} step={1} value={Number.isNaN(limit) ? '' : limit} disabled={locked || checking} aria-invalid={!validLimit} aria-describedby="air-limit-hint" onChange={event => setLimit(event.target.value === '' ? NaN : Number(event.target.value))} /><span>人</span></div>
          </div>

          {platform === 'liepin' && <div className="air-field">
            {mode === 'search' ? <FieldLabel htmlFor="air-greeting-mode" hintId="air-search-hint" invalid={!validSearch} hint={validSearch ? 'AI 设置并核对筛选条件后，由平台预设连续处理；无法准确设置的条件不会静默忽略。' : '请填写搜索关键词，并核对年龄和工作经验范围。'}>候选人来源</FieldLabel> : <label className="air-label" htmlFor="air-greeting-mode">候选人来源</label>}
            <div className="air-select-wrap"><select id="air-greeting-mode" value={mode} disabled={locked || checking} onChange={event => setMode(event.target.value as 'recommend' | 'search')}><option value="recommend">人才推荐</option><option value="search">搜索人才并筛选</option></select><ChevronDownIcon aria-hidden="true" /></div>
            {mode === 'search' && <>
              <label className="air-label" htmlFor="air-search-keyword">搜索关键词</label><input id="air-search-keyword" className="air-job-search" value={searchKeyword} maxLength={200} disabled={locked} placeholder="如 java 开发工程师" onChange={event => setSearchKeyword(event.target.value)} />
              <label className="air-label" htmlFor="air-search-city">城市（可选）</label><input id="air-search-city" className="air-job-search" value={city} maxLength={80} disabled={locked} placeholder="如 北京" onChange={event => setCity(event.target.value)} />
              <label className="air-label" htmlFor="air-search-age">年龄上限：岁以下（可选）</label><input id="air-search-age" className="air-job-search" type="number" min={18} max={100} value={ageUnder} disabled={locked} onChange={event => setAgeUnder(event.target.value)} />
              <label className="air-label" htmlFor="air-search-experience-min">工作经验：最低年数（可选）</label><input id="air-search-experience-min" className="air-job-search" type="number" min={0} max={60} value={experienceMin} disabled={locked} onChange={event => setExperienceMin(event.target.value)} />
              <label className="air-label" htmlFor="air-search-experience-max">工作经验：最高年数（可选）</label><input id="air-search-experience-max" className="air-job-search" type="number" min={0} max={60} value={experienceMax} disabled={locked} onChange={event => setExperienceMax(event.target.value)} />
            </>}
          </div>}

          <div className="air-launch">
            <button type="button" className="air-button air-button-primary" disabled={!canStart} title={login.status !== 'logged_in' ? '请先登录平台并刷新登录状态' : startHint} onClick={() => onStart({ platform, jobId, limit, mode, ...(mode === 'search' ? { search: { keyword: searchKeyword.trim(), ...(city.trim() ? { city: city.trim() } : {}), ageUnder: optionalNumber(ageUnder), experienceMin: optionalNumber(experienceMin), experienceMax: optionalNumber(experienceMax) } } : {}), confirmed: true })}><PlayIcon aria-hidden="true" />{busy === '启动任务' ? '正在启动…' : '开始打招呼'}<ArrowRightIcon className="air-start-arrow" aria-hidden="true" /></button>
          </div>
  </>
}
