import type { CandidateHistorySummary, CandidateListProfile } from '../../../shared/sourcing.js'

const date = '(?:19|20)\\d{2}(?:[./年-]\\d{1,2}月?)?'
// BOSS renders the two dates in separate spans; DOM card text can omit the dash.
const periodSource = `(${date})(?:\\s*[-~～至到—–]\\s*|\\s+)(${date}|至今|现在)`
const periodPattern = new RegExp(periodSource)
const clean = (text: string) => text.replace(/^[•·●\s]+/, '').replace(/\s+/g, ' ').trim()
const school = /(?:大学|学院|学校|中学)(?:[（(][^）)]{1,20}[）)])?$/
const heading = (line: string): 'work' | 'education' | 'other' | undefined => {
  const title = line.replace(/\s+/g, '').replace(/[:：]$/, '')
  if (/^工作(?:经历|经验|履历)(?:[（(]\d+[^）)]*[）)])?$/.test(title)) return 'work'
  if (/^教育(?:经历|背景)(?:[（(]\d+[^）)]*[）)])?$/.test(title)) return 'education'
  if (/^(?:求职期望|求职意向|个人优势|项目经历|项目经验|在校经历|专业技能|自我评价|资格证书|社交主页|牛人分析器|附件简历)/.test(title)) return 'other'
}
const periodText = (match: RegExpMatchArray) => `${match[1]} - ${match[2]}`
const append = (rows: CandidateHistorySummary[], row: CandidateHistorySummary) => {
  if (!rows.some(old => old.organization === row.organization && old.period === row.period)) rows.push(row)
}
function columns(text: string) {
  const parts = text.split(/\s*[|｜·]\s*/).map(clean).filter(Boolean)
  if (parts.length > 1) return parts
  // In the observed card, organization and role/major are distinct DOM text
  // fields, joined by whitespace. Keep the remaining role text intact.
  const pair = text.match(/^(\S+)\s+(.+)$/)
  return pair ? [pair[1]!, pair[2]!] : [text]
}
function rowFrom(body: string, period: string): CandidateHistorySummary | undefined {
  const [organization, ...details] = columns(clean(body))
  if (!organization || organization.length > 90 || /[:：。；]/.test(organization)) return
  const description = details.join(' / ')
  return { organization, ...(description && description.length <= 100 ? { description } : {}), period }
}

function cardHistory(text: string): Pick<CandidateListProfile, 'work' | 'education'> {
  const rows: Pick<CandidateListProfile, 'work' | 'education'> = { work: [], education: [] }
  const source = text.slice(0, 30000).replace(/\s+/g, ' ')
  const periods = [...source.matchAll(new RegExp(periodSource, 'g'))]
  for (let index = 0; index < periods.length; index++) {
    const period = periods[index]!
    const body = source.slice(period.index! + period[0].length, periods[index + 1]?.index ?? source.length)
      .replace(/\s+(?:打招呼|立即沟通|继续沟通|已沟通|感兴趣|不合适)(?:\s|$)[\s\S]*$/, '').trim()
    const row = rowFrom(body, periodText(period))
    if (!row) continue
    const kind = school.test(row.organization) ? 'education' : /[./年-]\d/.test(period[1]!) ? 'work' : undefined
    if (kind) append(rows[kind], row)
  }
  return rows
}

function resumeHistory(text: string): Pick<CandidateListProfile, 'work' | 'education'> {
  const rows: Pick<CandidateListProfile, 'work' | 'education'> = { work: [], education: [] }
  const lines = text.slice(0, 30000).split(/\r?\n/).map(clean).filter(Boolean)
  let section: ReturnType<typeof heading>
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!, title = heading(line)
    if (title) { section = title; continue }
    if (section !== 'work' && section !== 'education' || line.length > 200 || /[:：。；]/.test(line)) continue
    let source = line, period = source.match(periodPattern), consumed = 0
    if (!period) {
      // Only consume the immediately adjacent role/date lines. Do not cross
      // descriptions, another section, or an unrelated school/company block.
      const next = lines[index + 1], after = lines[index + 2]
      if (next && !heading(next) && periodPattern.test(next)) { source += ` | ${next}`; consumed = 1 }
      else if (next && after && !heading(next) && !heading(after) && next.length <= 60
        && !/[:：。；]/.test(next) && periodPattern.test(after)) { source += ` | ${next} | ${after}`; consumed = 2 }
      else continue
      period = source.match(periodPattern)
    }
    if (!period) continue
    const body = (source.slice(0, period.index) + source.slice(period.index! + period[0].length)).replace(/[|｜·\s]+$/, '').trim()
    const row = rowFrom(body, periodText(period))
    if (row) { append(rows[section], row); index += consumed }
  }
  return rows
}

function expectation(text: string): CandidateListProfile['expectation'] {
  const lines = text.slice(0, 30000).split(/\r?\n/).map(clean).filter(Boolean)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const labelled = line.match(/^(?:求职期望|期望)\s*[:：]?\s*(.*)$/)
      ?? line.match(/(?:^|\s)期望\s*[:：]?\s+(.+)$/)
    if (!labelled) continue
    let value = labelled[1] || lines[index + 1] || ''
    if (heading(value)) continue
    const dates = value.match(periodPattern)
    if (dates) value = value.slice(0, dates.index)
    value = value.split(/\s+(?:优势|个人优势|工作经历|教育经历|行业不限|面议|打招呼|继续沟通)(?:\s|$)/)[0]!
      .replace(/\s+\d+(?:[.\d]*)?\s*[-~～]\s*\d+(?:[.\d]*)?\s*[kKwW万千].*$/, '').trim()
    const parts = columns(value)
    const city = parts[0], role = parts[1]
    if (city && role && city.length <= 40 && role.length <= 60 && !/[:：。；]/.test(city + role)) return { city, role }
  }
  return undefined
}

/** BOSS-only display extraction; the assessment/identity source stays intact. */
export function bossListProfile(resumeText: string, listText: string): Pick<CandidateListProfile, 'work' | 'education' | 'expectation'> {
  const card = cardHistory(listText), resume = resumeHistory(resumeText)
  const intent = expectation(listText) ?? expectation(resumeText)
  return { ...(intent ? { expectation: intent } : {}), work: (card.work.length ? card.work : resume.work).slice(0, 2), education: (card.education.length ? card.education : resume.education).slice(0, 2) }
}
