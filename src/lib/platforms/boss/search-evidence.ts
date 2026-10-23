import { itemText, normalized, readableIdentityRef } from '../../page-actions.js'
import { distinctPositionControls, positionBusinessIds, positionControl, samePositionComponent } from '../../position-controls.js'
import type { PositionEvidence, PositionOutcome } from '../../position-evidence.js'
import type { GreetingJob } from '../../../shared/workbench.js'
import { StandardSearchEvidence } from '../types.js'

const documentPath = '/web/frame/recommend'
/** 推荐文档顶部只显示一行「职位名 _ 城市 薪资」，不是可选择的控件。
 *  候选人卡片的期望职位同样可能出现职位名，因此只接受以职位名开头且
 *  带标题分隔符的短文本。 */
const titleSeparator = /^(?:$|[\s_·|｜/\\-—–])/
const candidateText = /\d{2}\s*岁|期望|优势|打招呼|工作经历|项目经历|最近关注/
const matchesTitle = (title: unknown, name: unknown) => {
  const value = normalized(title), target = normalized(name)
  if (!target || value.split(/\s_\s/).length > 2 || !value.startsWith(target) || !titleSeparator.test(value.slice(target.length)) || candidateText.test(value)) return false
  return true
}
/** 职位 tab/按钮走通用选中核验，不能当作推荐文档顶部的静态标题。 */
const controlRoles = new Set(['tab', 'option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'radio', 'checkbox', 'treeitem', 'switch', 'button', 'combobox', 'listbox', 'link', 'textbox', 'searchbox', 'slider', 'spinbutton'])
const textNode = (item: any) => !controlRoles.has(String(item?.role))
  && !['a', 'button', 'input', 'select', 'textarea'].includes(String(item?.tagName).toLowerCase())
// Title evidence is read, never clicked by verification. An advisory hit-test
// occlusion must not erase readable identity; hidden/background text stays invalid.
const readableTitle = (page: any, item: any) => {
  try { return readableIdentityRef(page, item.ref) === item } catch { return false }
}

const ancestors = (page: any, item: any): any[] => {
  const result: any[] = [], seen = new Set<string>()
  for (let node = item; node?.ref && !seen.has(node.ref); node = page.items?.find((row: any) => row.ref === node.parentRef)) {
    seen.add(node.ref); result.push(node)
  }
  return result
}
const inMenu = (page: any, item: any) => ancestors(page, item).some(node => ['li', 'listitem', 'ul', 'listbox', 'menu', 'option', 'menuitem'].includes(node.role))
export function bossDocumentUrl(page: any): string {
  try {
    if (page.frameId && page.frameInteraction === 'same-origin' && page.frameUrl
      && new URL(page.frameUrl).origin === new URL(page.url).origin) return page.frameUrl
  } catch { /* Fall back to the observed document URL. */ }
  return page.url
}

export function isBossRecommendationDocument(page: any): boolean {
  try { return new URL(bossDocumentUrl(page)).pathname.replace(/\/$/, '') === documentPath } catch { return false }
}

/** 文档级职位标题的唯一可读节点；嵌套的重复文本只保留最外层。 */
export function bossDocumentTitle(page: any, names: readonly string[]): any | undefined {
  const items = (page?.items ?? []).filter((item: any) => item?.ref && textNode(item) && !inMenu(page, item) && readableTitle(page, item) && positionControl(page, item)
    && (!item.bounds || item.bounds.width > 0 && item.bounds.height > 0)
    && names.some(name => matchesTitle(item.name, name)))
  const distinct = distinctPositionControls(page, items)
  return distinct.length === 1 ? distinct[0] : undefined
}

/** 当前职位可能与目标职位不同。只把唯一的顶部职位标题作为下拉入口；
 *  发送职位证明仍必须使用 bossDocumentTitle 的目标名称与 jobid 双重核验。 */
export function bossDocumentSelector(page: any): any | undefined {
  const names = (page.items ?? []).filter((item: any) => {
    const name = normalized(item.name)
    return name.length <= 140 && /\s_\s/.test(name) && !candidateText.test(name)
  }).map((item: any) => normalized(item.name).split(/\s_\s/)[0])
  return bossDocumentTitle(page, names)
}

/** Real BOSS dropdowns use ul/li with "职位 _ 城市 薪资", without ARIA expanded/option.
 * Only rows belonging to the compact header component are job choices. */
export function bossPositionMenu(page: any): { selector: any; options: any[] } | undefined {
  const selector = bossDocumentSelector(page)
  if (!selector) return undefined
  const owners = ancestors(page, selector).filter(node => node.bounds && node.bounds.height <= 80
    && node.bounds.y <= selector.bounds?.y && node.bounds.y + node.bounds.height >= selector.bounds.y)
  const lists = (page.items ?? []).filter((item: any) => ['ul', 'listbox', 'menu'].includes(item.role) && readableTitle(page, item)
    && ancestors(page, item).some(node => owners.some(owner => owner.ref === node.ref)))
  if (lists.length !== 1) return undefined
  const options = (page.items ?? []).filter((item: any) => ['li', 'listitem', 'option', 'menuitem'].includes(item.role)
    && item.parentRef === lists[0].ref && readableTitle(page, item) && positionControl(page, item)
    && normalized(item.name).split(/\s_\s/).length === 2 && !candidateText.test(normalized(item.name)))
  return { selector, options }
}

export function bossPositionChoices(page: any, names: readonly string[]): any[] {
  return (bossPositionMenu(page)?.options ?? []).filter(item => names.filter(name => normalized(name) === normalized(item.name).split(/\s_\s/)[0]).length === 1)
}

/** BOSS 推荐文档以 URL jobid 确定发送职位；页面标题用于核对没有跳错文档。
 *  返回 undefined 表示这不是文档标题证据，调用方仍可走通用控件核验。 */
export function verifyBossDocumentPosition(page: any, job: Pick<GreetingJob, 'jobId' | 'jobName' | 'platformJobs'>,
  evidence?: PositionEvidence): PositionOutcome | undefined {
  if (!isBossRecommendationDocument(page)) return undefined
  const targets = job.platformJobs?.length ? job.platformJobs : [{ id: '', name: job.jobName }]
  if (!evidence?.ref) return { ok: false, error: '缺少推荐文档职位标题引用' }
  let item: any
  try { item = readableIdentityRef(page, evidence.ref) } catch { return undefined }
  if (!textNode(item) || !targets.some(target => matchesTitle(item.name, target.name))) return undefined
  const text = itemText(item), quote = normalized(evidence.quote ?? text)
  if (!quote || !text.includes(quote)) return { ok: false, error: 'position.quote 未在推荐文档职位标题中逐字出现' }
  const known = targets.filter(target => target.id)
  const ids = positionBusinessIds({ ...page, url: bossDocumentUrl(page) })
  const foreign = ids.filter(id => !known.some(target => target.id === id))
  if (known.length && foreign.length) return { ok: false, error: `推荐文档 URL 的招聘职位 ID (${foreign.join(', ')}) 不属于目标职位` }
  const identified = known.filter(target => ids.includes(target.id))
  if (known.length && !identified.length) return { ok: false, error: '推荐文档 URL 未包含目标平台职位 ID，无法确认发送职位' }
  if (identified.length > 1) return { ok: false, error: '推荐文档 URL 同时包含多个目标平台职位 ID' }
  if (inMenu(page, item)) return { ok: false, error: '下拉选项不是当前已选职位' }
  const claimants = (page.items ?? []).filter((row: any) => row?.ref && textNode(row) && !inMenu(page, row) && readableTitle(page, row) && positionControl(page, row)
    && (!row.bounds || row.bounds.width > 0 && row.bounds.height > 0)
    && targets.some(target => matchesTitle(row.name, target.name)))
  const distinct = distinctPositionControls(page, claimants)
  if (distinct.length !== 1 || !samePositionComponent(page, distinct[0], item)) {
    return { ok: false, error: `推荐文档有 ${distinct.length} 个职位标题控件，无法确定发送职位` }
  }
  const platformJobId = identified[0]?.id
  return { ok: true, verification: { ref: evidence.ref, quote, ...(platformJobId ? { platformJobId } : {}),
    level: platformJobId ? 'exact' : 'degraded',
    reason: platformJobId ? '推荐文档 URL jobid 与页面显示职位一致' : '推荐文档职位标题唯一；URL 未暴露可核对的业务 ID' } }
}

export class BossSearchEvidence extends StandardSearchEvidence {
  position(page: any, job: Pick<GreetingJob, 'jobId' | 'jobName' | 'platformJobs'>, proof: PositionEvidence) {
    return verifyBossDocumentPosition(page, job, proof)
  }
}
