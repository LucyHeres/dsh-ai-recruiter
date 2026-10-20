import type { XinClient } from './xin-client.js'
import type { JobOption } from '../shared/workbench.js'
import type { SourcingPosition } from '../shared/sourcing.js'
import { sourcingPlatformsForChannels } from '../shared/published-channels.js'

function decodeEntities(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, n: string) => {
    const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  }).replace(/&(?:nbsp|amp|lt|gt|quot|apos);/g, v => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[v]!))
}
/** Some job APIs entity-encode the whole rich-text document. Keep it untrusted. */
export function jobRichText(value: unknown): string {
  if (typeof value !== 'string') return ''
  let html = value.slice(0, 100000)
  for (let depth = 0; depth < 2; depth++) {
    if (/<\/?(?:p|div|br|ul|ol|li|strong|b|em|span|h[1-6]|table)\b/i.test(html)) break
    const decoded = decodeEntities(html)
    if (decoded === html) break
    html = decoded
  }
  return html
}
/** Plain scoring input is separate from the HTML displayed after client sanitization. */
export function plainJobText(value: unknown): string {
  return decodeEntities(jobRichText(value).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/(?:p|div|li|h[1-6])\s*>|<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    )
    .replace(/[\t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000)
}
export async function readSourcingPosition(xin: XinClient | null, id: string, jobs: JobOption[], signal?: AbortSignal): Promise<SourcingPosition> {
  if (!xin) throw new Error('请先在薪灵完成薪人薪事授权')
  const selected = jobs.find(job => job.id === id)
  if (!selected) throw new Error('所选职位已失效或无权限，请刷新职位列表')
  const result = await xin.call('jobDetail', { jobId: id }, signal)
  if (!result.ok) throw new Error(`职位详情读取失败：${result.failure.message}`)
  const row = result.data
  if (!row || typeof row !== 'object' || Array.isArray(row) || (row.jobId != null && String(row.jobId) !== id)) throw new Error('职位详情格式不可识别或职位不一致')
  // Enum labels match the business frontend's job-management/detail/constant/const-data.ts.
  const experience: Record<string, string> = { 0: '1年以下', 1: '1–3年', 2: '3–5年', 3: '5–10年', 4: '10年以上', 5: '无经验', 6: '经验不限' }
  // Job eduGrade uses jobDegreeEnum from recruitment/constant/const-data.ts,
  // not the unrelated channel resume-filter degree codes.
  const degree: Record<string, string> = { 9: '小学', 1: '初中', 3: '中专', 10: '中职', 11: '中技', 2: '高中', 4: '大专', 5: '本科', 6: '硕士', 7: '博士', 8: '不限' }
  const salary: Record<string, string> = { 0: '3000及以内', 1: '3000–5000', 2: '5000–10000', 3: '10000–15000', 4: '15000–30000', 5: '30000及以上', 6: '面议' }
  const salaryText = String(row.salaryType) === '1'
    ? [row.minSalary, row.maxSalary].every(v => v != null && String(v).trim() !== '' && /^\d+$/.test(String(v))) ? `${row.minSalary}–${row.maxSalary}` : ''
    : row.salaryRange != null && row.salaryRange !== '' ? salary[String(row.salaryRange)] || '' : ''
  const rich = jobRichText(row.jobDesc || row.filterDesc)
  const text = plainJobText(row.jobDesc || row.filterDesc)
  const requirements = [row.workAge != null && row.workAge !== '' && experience[String(row.workAge)] ? `工作经验：${experience[String(row.workAge)]}` : '',
    row.eduGrade != null && row.eduGrade !== '' && degree[String(row.eduGrade)] ? `学历要求：${degree[String(row.eduGrade)]}` : '',
    plainJobText(row.workCity) ? `工作地点：${plainJobText(row.workCity)}` : '', salaryText ? `薪酬范围：${salaryText}` : ''].filter(Boolean)
  return { id, name: selected.name, department: plainJobText(row.department), city: plainJobText(row.workCity),
    publishedChannels: selected.publishedChannels,
    platforms: selected.publishedChannels ? sourcingPlatformsForChannels(selected.publishedChannels) : selected.platforms ?? [],
    searchFields: { city: plainJobText(row.workCity), experience: experience[String(row.workAge)] || '', education: degree[String(row.eduGrade)] || '' },
    description: [text, ...requirements].filter(Boolean).join('\n'),
    descriptionHtml: (/<\/?[a-z][^>]*>/i.test(rich) ? rich : escapeHtml(rich).replace(/\n/g, '<br>'))
      + requirements.map(line => `<p>${escapeHtml(line)}</p>`).join(''), fetchedAt: new Date().toISOString() }
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
