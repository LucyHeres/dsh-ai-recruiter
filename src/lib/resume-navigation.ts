import { createHash } from 'node:crypto'
import { resumeActionSpec, type ResumePlanner } from './resume-planner.js'
import { frameUrl, allowedFrame, identityEvidence, itemText, recoverablePageError, safePageUrl } from './page-actions.js'
import { resumePageObservation } from './resume-planner.js'
import type { WorkbenchJob, TaskResult } from '../shared/workbench.js'
import type { DeveloperLog } from './developer-log.js'
import { safeError } from './task-error.js'
import { pageInspector } from './page-inspection.js'
import { PageProgress, rememberPageAction, type PageActionRecord } from './page-progress.js'
import { readCandidates } from './candidate-entry.js'
import { PageRecovery } from './page-operation.js'

interface NavigationDeps {
  job: WorkbenchJob
  planner: ResumePlanner
  listTabId: number
  listUrl: string
  origins: readonly string[]
  signal: AbortSignal
  priorJobs: WorkbenchJob[]
  snapshot(frameId?: number): Promise<any>
  call(tool: string, args: Record<string, unknown>): Promise<any>
  progress(phase: string, message: string): Promise<void>
  ingest(ref: string, page: any, result: TaskResult): Promise<void>
  logger?: DeveloperLog
}
const normalized = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim()
const keyFor = (platform: string, text: string) => createHash('sha256').update(`${platform}:${text}`).digest('hex').slice(0, 32)
const allowedTab = (tab: any, origins: readonly string[]) => {
  try { return Number.isInteger(tab.tabId) && origins.includes(new URL(tab.url).origin) } catch { return false }
}

/** Model selects page actions; code owns refs, limits, file transfer and write receipts. */
export async function navigateResumes(d: NavigationDeps) {
  const { job, signal } = d
  const prior = d.priorJobs.flatMap(other => other.results.filter(result => ['succeeded', 'sending', 'unknown'].includes(result.stage)))
  const attempted = new Set<string>(), failures = new Set<string>()
  const history: PageActionRecord[] = []
  const navigation = new PageProgress(history, 'resume', d.logger)
  const recovery = new PageRecovery()
  let current: TaskResult | undefined, frameId: number | undefined
  const snapshot = () => d.snapshot(frameId)
  let page = await snapshot()
  const validateRef = (ref: string) => {
    if (!page.snapshotId) throw new Error('RESUME_PAGE_WITHOUT_SNAPSHOT')
    const item = (Array.isArray(page.items) ? page.items : []).find((item: any) => item.ref === ref)
    if (!item) throw new Error('RESUME_ACTION_REF_INVALID')
    const states = Array.isArray(item.states) ? item.states : Object.keys(item.states ?? {}).filter(key => item.states[key])
    if (states.some((state: string) => ['disabled', 'hidden', 'invisible', 'occluded', 'blocked_by_dialog'].includes(state))) throw new Error('RESUME_ACTION_REF_BLOCKED')
    return item
  }
  const remember = (action: string, outcome: string, ref?: string) => {
    rememberPageAction(history, { action, ref, outcome })
  }
  for (let step = 0; step < 40 + job.limit * 20; step++) {
    signal.throwIfAborted()
    if (job.results.length >= job.limit && !current) {
      job.status = job.results.some(result => result.stage === 'failed') ? 'failed' : 'completed'
      break
    }
    const tabs = ((await d.call('browser_list_tabs', {})).tabs ?? []).filter((tab: any) => allowedTab(tab, d.origins))
    if (!tabs.some((tab: any) => tab.tabId === job.tabId) || !allowedTab({ tabId: job.tabId, url: page.url }, d.origins)) throw new Error('当前页面不属于所选招聘平台')
    const frames = ((await d.call('browser_list_frames', { tabId: job.tabId }).catch(() => ({ frames: [] }))).frames ?? []).filter((frame: any) => allowedFrame(frame, d.origins))
    navigation.observe({ tabId: job.tabId!, frameId, page, tabs })
    const pageText = normalized(page.text) + ' ' + (page.items ?? []).map((item: any) => normalized(item.name)).join(' ')
    await d.progress(current ? 'capturing' : 'reading', current ? `AI 正在查找 ${current.name} 的简历附件` : 'AI 正在阅读已收简历页面')
    const action = resumeActionSpec.parse(await d.planner.decide({
      platform: job.platform, limit: job.limit, currentTabId: job.tabId, page: resumePageObservation(page),
      tabs: tabs.map((tab: any) => ({ tabId: tab.tabId, title: tab.title, url: safePageUrl(tab.url) })),
      currentFrameId: frameId, frames: frames.map((frame: any) => ({ frameId: frame.frameId, url: frameUrl(frame) })),
      currentCandidate: current ? { name: current.name, key: current.key } : null,
      processed: job.results.map(result => ({ name: result.name, key: result.key, stage: result.stage, detail: result.detail })),
      previousImports: prior.filter(result => pageText.includes(result.name)).slice(-100)
        .map(result => ({ name: result.name, key: result.key, stage: result.stage })),
      recentActions: history,
    }, signal, pageInspector({ tabId: job.tabId!, frameId, page, tabs, frames, origins: d.origins, call: d.call }, message => d.progress(current ? 'capturing' : 'reading', message))))
    signal.throwIfAborted()
    d.logger?.write('info', 'resume.action_selected', { step, action: action.action, ref: 'ref' in action ? action.ref : undefined })
    await d.progress(current ? 'capturing' : 'reading', `AI：${safeError(action.reason)}`)
    let fingerprint = ''
    try {
      const item = 'ref' in action && action.ref ? validateRef(action.ref) : undefined
      if (item && ['click', 'select_candidate', 'download'].includes(action.action)) {
        fingerprint = `${current?.key ?? 'list'}:${page.documentId ?? page.url}:${action.action}:${item.role}:${normalized(item.name)}:${JSON.stringify(item.bounds)}`
        if (failures.has(fingerprint)) throw new Error('RESUME_FAILED_ENTRY_ALREADY_ATTEMPTED')
      }
      switch (action.action) {
        case 'select_candidate': {
          if (current) throw new Error('RESUME_CURRENT_CANDIDATE_UNFINISHED')
          const name = normalized(action.name)
          identityEvidence(page, action.ref, name, action.evidenceRefs)
          // Reuse old identities when available solely to recognize prior receipts.
          // The model may select any observed element; legacy parsing never gates selection.
          const identity = readCandidates(page.items).candidates.find(candidate => candidate.ref === action.ref)?.identity
            ?? normalized([name, itemText(item), ...(action.evidenceRefs ?? []).map(ref => itemText(validateRef(ref)))].join(' '))
          const key = keyFor(job.platform, identity)
          if (attempted.has(key) || job.results.some(result => result.key === key) || prior.some(result => result.key === key
            || (result.name === name && ['sending', 'unknown'].includes(result.stage)))) throw new Error('RESUME_CANDIDATE_ALREADY_PROCESSED')
          attempted.add(key)
          current = { key, name, stage: 'sending', detail: 'AI 正在打开候选人简历', updatedAt: new Date().toISOString() }
          job.results.push(current)
          d.logger?.updateContext({ candidateKey: key })
          d.logger?.write('info', 'resume.candidate_selected', { candidateKey: key, ref: action.ref, tabId: job.tabId, snapshotId: page.snapshotId })
          await d.progress('capturing', `正在打开 ${name} 的简历`)
          await d.call('browser_click', { tabId: job.tabId, snapshotId: page.snapshotId, ref: action.ref, documentId: page.documentId })
          break
        }
        case 'download': {
          if (!current) throw new Error('RESUME_SELECT_CANDIDATE_FIRST')
          const text = normalized(page.text) + ' ' + (page.items ?? []).map((item: any) => normalized(item.name)).join(' ')
          if (action.evidenceRefs?.length || !text.replace(/\s/g, '').includes(current.name.replace(/\s/g, ''))) identityEvidence(page, action.ref, current.name, action.evidenceRefs)
          d.logger?.write('info', 'resume.download_entry', { matched: true, ref: action.ref, snapshotId: page.snapshotId, tabId: job.tabId, mode: 'download' })
          await d.ingest(action.ref, page, current)
          if (current.stage === 'unknown') { job.status = 'unknown'; return }
          d.planner.recordResult?.({ status: current.stage, detail: current.detail })
          navigation.checkpoint()
          remember(action.action, `候选人${current.name}：${current.detail}`, action.ref)
          current = undefined
          d.logger?.updateContext({ candidateKey: undefined })
          page = await snapshot()
          continue
        }
        case 'return_to_list':
          if (current) throw new Error('RESUME_CURRENT_CANDIDATE_UNFINISHED')
          job.tabId = d.listTabId; frameId = undefined
          await d.call('browser_navigate', { tabId: job.tabId, url: d.listUrl })
          break
        case 'skip_candidate':
          if (!current) throw new Error('RESUME_SELECT_CANDIDATE_FIRST')
          current.stage = 'skipped'; current.detail = safeError(action.reason); current.updatedAt = new Date().toISOString()
          current = undefined
          navigation.checkpoint()
          d.logger?.updateContext({ candidateKey: undefined })
          await d.progress('reading', '当前候选人无法采集，已记录原因')
          break
        case 'finish':
          if (current) throw new Error('RESUME_CURRENT_CANDIDATE_UNFINISHED')
          job.status = job.results.some(result => result.stage === 'failed') ? 'failed' : job.results.length ? 'completed' : 'stopped'
          await d.progress('finished', safeError(action.reason))
          return
        case 'stop':
          throw new Error(`AI 已停止：${safeError(action.reason)}`)
        default: {
          const view = { tabId: job.tabId!, frameId, page, tabs, frames, origins: d.origins, call: d.call }
          await navigation.execute(action, view)
          d.planner.recordResult?.({ status: 'executed', receipt: navigation.lastReceipt })
          job.tabId = view.tabId; frameId = view.frameId
        }
      }
      if (['select_candidate', 'return_to_list', 'skip_candidate'].includes(action.action)) d.planner.recordResult?.({ status: 'executed', action: action.action })
      recovery.reset()
      if (['select_candidate', 'return_to_list', 'skip_candidate'].includes(action.action)) remember(action.action, '动作已执行，请根据最新页面确认结果', 'ref' in action ? action.ref : undefined)
      // A detail may open in a new tab. Only a single observed platform tab is unambiguous.
      const afterTabs = ((await d.call('browser_list_tabs', {})).tabs ?? []).filter((tab: any) => allowedTab(tab, d.origins))
      const opened = afterTabs.filter((tab: any) => !tabs.some((before: any) => before.tabId === tab.tabId))
      if (opened.length === 1 && ['click', 'select_candidate'].includes(action.action)) { job.tabId = opened[0].tabId; frameId = undefined }
    } catch (error) {
      d.planner.recordResult?.({ status: 'error', error: safeError(error) })
      signal.throwIfAborted()
      if (job.phase === 'importing') throw error
      // Upload/write uncertainty and dispatched-action uncertainty always leave this loop.
      // Only page/reference failures and confirmed non-file results are offered back for interpretation.
      const message = safeError(error)
      if ((!recoverablePageError(error) && !/\b(?:RESUME_(?:ACTION_REF_INVALID|ACTION_REF_BLOCKED|FAILED_ENTRY_ALREADY_ATTEMPTED|CURRENT_CANDIDATE_UNFINISHED|CANDIDATE_NAME_NOT_IN_ELEMENT|CANDIDATE_ALREADY_PROCESSED|SELECT_CANDIDATE_FIRST|CANDIDATE_NOT_IN_CURRENT_PAGE|TAB_NOT_OBSERVED)|FILE_RESPONSE_NOT_ATTACHMENT|FILE_LINK_UNAVAILABLE|FILE_DOWNLOAD_TIMEOUT|FILE_DOWNLOAD_CAPTURE_FAILED|FILE_FETCH_FAILED|FILE_ACCESS_DENIED|PREVIEW_URL_INVALID|ELEMENT_NOT_FOUND|ELEMENT_OCCLUDED|ELEMENT_NOT_IN_VIEWPORT|SNAPSHOT_EXPIRED|PAGE_CHANGED)\b/.test(message)) || /RESULT_UNKNOWN|OUTCOME_UNKNOWN/.test(message)) throw error
      if (fingerprint && !message.includes('PAGE_ACTION_REPEAT_BLOCKED')) failures.add(fingerprint)
      if (recovery.failed(error, action, page).exhausted) throw new Error(`AI 恢复操作未能推进，已停止：${message}`)
      d.logger?.write('warn', 'resume.action_observation', { action: action.action, errorCode: /\b[A-Z][A-Z_]+\b/.exec(message)?.[0] })
      remember(action.action, message, 'ref' in action ? action.ref : undefined)
      // Selecting a stale/blocked card did not open a detail; roll back only that failed selection.
      if (action.action === 'select_candidate' && current) {
        current.stage = 'failed'; current.detail = '候选人详情未打开，未提交入库'; current.updatedAt = new Date().toISOString()
        current = undefined
      }
    }
    page = await snapshot()
  }
  if (job.status === 'running') throw new Error('AI 页面操作已达到本次数量对应的上限，已停止；已完成的入库结果已保留')
  await d.progress('finished', `处理 ${job.results.length} 份，成功入库 ${job.results.filter(result => result.stage === 'succeeded').length} 份`)
}
