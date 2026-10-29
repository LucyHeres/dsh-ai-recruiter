import type { CandidateHistorySummary, CandidateListProfile } from '../shared/sourcing.js'
import type { Platform } from '../shared/workbench.js'
import { recruitmentPlatform } from './platforms/registry.js'

// Display only explicitly bounded source rows. No model call or inference from
// dates, age, project clients, school names in descriptions, or matching scores.
const periodPattern = /(?:19|20)\d{2}[./年-]\d{1,2}月?\s*(?:-|~|～|至|到|—|–)\s*(?:(?:19|20)\d{2}[./年-]\d{1,2}月?|至今|现在)(?:\s*[（(][^）)\n]{1,24}[）)])?/
const workOrganization = /(?:公司|集团|银行|事务所|研究院|研究所|工作室|有限公司)(?:[（(][^）)]{1,20}[）)])?$/
const schoolOrganization = /(?:大学|学院|学校|中学|研究院|研究所)(?:[（(][^）)]{1,20}[）)])?$/
const sectionKind = (line: string): 'work' | 'education' | 'other' | undefined => {
  const title = line.replace(/\s+/g, '')
  if (/^(?:工作经历|工作经验|工作履历)(?:[（(]\d+[^）)]*[）)])?$/.test(title)) return 'work'
  if (/^教育(?:经历|背景)(?:[（(]\d+[^）)]*[）)])?$/.test(title)) return 'education'
  if (/^(?:项目经历|项目经验|求职意向|个人优势|自我评价|专业技能|技能标签|语言能力|附件简历|资格证书|培训经历|在校经历|荣誉奖项|社交主页|附加信息|作品展示|简历编号|操作记录|简历备注|人才招聘记录)$/.test(title)) return 'other'
}
const clean = (line: string) => line.replace(/^[•·●\s]+/, '').replace(/\s+/g, ' ').trim()
const key = (row: CandidateHistorySummary) => [row.organization, row.period ?? ''].join('|')

function sourceHistory(text: string) {
  const lines = text.slice(0, 30000).split(/\r?\n/).map(clean).filter(Boolean)
  const rows: CandidateListProfile = { work: [], education: [] }
  let section: ReturnType<typeof sectionKind>
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!, heading = sectionKind(line)
    if (heading) { section = heading; continue }
    if (line.length > 200 || /^[*＊]|[:：。；]/.test(line)) continue
    const period = line.match(periodPattern)
    // Platform list cards may omit section titles, but each history row has an
    // organization and its own explicit date range. Never parse undated prose.
    const prefix = (period ? line.slice(0, period.index) : line).trim()
    const columns = prefix.split(/\s*[·|｜]\s*/).filter(Boolean)
    const inline = columns.length === 1 ? prefix.match(/^(.{2,90}?(?:有限公司|公司|集团|银行|事务所|工作室|大学|学院|学校|中学|研究院|研究所))(?:\s+(.+))?$/) : undefined
    const organization = inline?.[1] ?? columns[0] ?? ''
    const education = schoolOrganization.test(organization)
    const work = workOrganization.test(organization)
    const kind = section === 'education' && education ? 'education' : section === 'work' && work ? 'work'
      : !section && period && (education || work) ? education ? 'education' : 'work' : undefined
    if (!kind || !organization || organization.length > 90) continue
    const following: string[] = []
    for (let next = index + 1; next < Math.min(index + 8, lines.length); next++) {
      const value = lines[next]!
      if (sectionKind(value) || /^[*＊]/.test(value) || workOrganization.test(value) || schoolOrganization.test(value)) break
      following.push(value)
      // Work descriptions start after the position and its dates. Education's
      // major/degree can follow its dates, so continue a little further there.
      if (kind === 'work' && periodPattern.test(value)) break
    }
    const date = period?.[0] ?? following.map(value => value.match(periodPattern)?.[0]).find(Boolean)
    if (!date) continue
    const details = [...(inline?.[2] ? [inline[2]] : columns.slice(1)), ...following].filter(value => !periodPattern.test(value) && value.length <= 60 && !/[:：。；]|^\d+[、.)]/.test(value))
    // Preserve row boundaries. Skip ambiguous blocks rather than choosing a
    // company or school from a paragraph mentioning someone else's history.
    const description = (kind === 'work' ? details.slice(0, 1) : details.slice(0, 3)).join(' / ')
    const row = { organization, ...(description ? { description } : {}), period: date }
    if (!rows[kind].some(existing => key(existing) === key(row))) rows[kind].push(row)
  }
  return rows
}

export function candidateListProfile(resumeText = '', listText = '', platform?: Platform): CandidateListProfile {
  const card = sourceHistory(listText), resume = sourceHistory(resumeText)
  const age = [listText, resumeText].map(text => text.slice(0, 30000).match(/(?:^|\s)(\d{2}\s*岁)(?=\s|$|[，,·|])/m)?.[1]).find(Boolean)
  const expectation = sourceExpectation(listText) ?? sourceExpectation(resumeText)
  const profile: CandidateListProfile = { ...(age ? { age: age.replace(/\s+/g, '') } : {}), ...(expectation ? { expectation } : {}), work: (card.work.length ? card.work : resume.work).slice(0, 2), education: (card.education.length ? card.education : resume.education).slice(0, 2) }
  const adapted = platform && recruitmentPlatform(platform).listProfile?.(resumeText, listText)
  if (adapted) {
    if (adapted.expectation) profile.expectation = adapted.expectation
    if (adapted.work.length) profile.work = adapted.work
    if (adapted.education.length) profile.education = adapted.education
  }
  return profile
}

function sourceExpectation(text: string): CandidateListProfile['expectation'] {
  const lines = text.slice(0, 30000).split(/\r?\n/).map(clean).filter(Boolean)
  const header = lines.findIndex(line => /^求职意向\s*[:：]?$/.test(line))
  if (header >= 0) {
    const section: string[] = []
    for (const line of lines.slice(header + 1, header + 16)) {
      if (sectionKind(line)) break
      if (!/^查看全部|^全部行业$/.test(line)) section.push(line)
    }
    // Liepin's observed intent block: role, salary, city, industry. Require
    // this boundary; a current job/city is never an intended job/city fallback.
    const salary = section.findIndex(line => /(?:\d\s*(?:-|~|至)\s*\d|\d+(?:\.\d+)?)\s*(?:[kKwW万千]|元)|^面议$/.test(line))
    if (salary > 0) {
      const role = section[salary - 1], city = section[salary + 1]
      if (role && city && role.length <= 60 && city.length <= 40 && !/[：:。；]/.test(role + city)) return { role, city }
    }
  }
  // Explicitly labelled list-card values can be read independently.
  const city = lines.map(line => line.match(/^(?:期望|意向)(?:城市|工作地)\s*[:：]\s*(.{1,40})$/)?.[1]).find(Boolean)
  const role = lines.map(line => line.match(/^(?:期望|意向)(?:岗位|职位)\s*[:：]\s*(.{1,60})$/)?.[1]).find(Boolean)
  return city || role ? { ...(city ? { city } : {}), ...(role ? { role } : {}) } : undefined
}
