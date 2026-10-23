import { normalized } from '../page-actions.js'
import type { SourcingListAssessment, SourcingListCriterion, SourcingListField } from '../../shared/sourcing.js'

export const listFieldLabels: Record<SourcingListField, string> = {
  age: '年龄', education: '学历', experience: '工作经验年限', city: '期望工作城市', company: '工作经历就职公司', salary: '薪资',
}

export function listAssessmentFailure(criteria: SourcingListCriterion[], rows: SourcingListAssessment[]) {
  return rows.filter(row => row.state !== 'match').map(row =>
    `${listFieldLabels[row.field]}${row.state === 'mismatch' ? '不符合' : '尚无法确认'}（要求：${criteria.find(criterion => criterion.field === row.field)?.requirement}；${row.reason}）`).join('；')
}

export const LIST_REQUIREMENTS_PROMPT = '另行提炼listCriteria作为列表初筛条件，仅允许年龄(age)、学历(education)、工作经验年限(experience)、期望工作城市(city)、工作经历就职公司(company)、薪资(salary)六类。只提取JD或补充要求明确提出的硬性条件，不自行添加条件；优先/加分/最好等偏好不得放入列表硬过滤，应进入详情bonus；上一段任职时长不等于总工龄，不是列表experience条件。不限/无要求不提取，没有条件填空数组。同一维度合并为一项，requirement保留具体范围、上下限、是否包含边界、最低学历或精确学历等限制，quote逐字引用原文；不能遗漏明确硬条件。公司指要求的候选人任职公司背景，不能把招聘公司或服务客户当成任职要求；薪资区分期望薪资与当前薪资并保留单位和周期。补充要求明确修改同类条件时以补充要求为准。列表条件独立于详情技能评分，年龄只核验明确年龄要求，不进入详情能力评分。'

export function validateListCriteria(criteria: SourcingListCriterion[], source: string) {
  if (criteria.length > 6 || new Set(criteria.map(row => row.field)).size !== criteria.length) throw new Error('SOURCING_LIST_REQUIREMENTS_INVALID: 列表初筛维度须唯一且不超过六项')
  for (const row of criteria) {
    if (!Object.hasOwn(listFieldLabels, row.field) || !normalized(row.requirement) || normalized(row.quote).length < 2 || !normalized(source).includes(normalized(row.quote))) {
      throw new Error('SOURCING_LIST_REQUIREMENTS_INVALID: 初筛条件必须属于六类维度并引用JD或补充要求原文')
    }
    if (/优先|加分|最好|倾向|nice.to.have|preferred/i.test(row.quote)) throw new Error('SOURCING_LIST_PREFERENCE_NOT_FILTER: 优先或加分项不能作为列表硬过滤，请保留为bonus')
  }
}

/** All explicitly required conditions must have affirmative, source-bound evidence.
 * No skill weights or final minimum score take part in this decision. */
export function assessListCandidate(criteria: SourcingListCriterion[] | undefined, rows: SourcingListAssessment[], text: string) {
  if (!criteria) throw new Error('SOURCING_LIST_REQUIREMENTS_REQUIRED: 请先明确本轮列表初筛条件')
  if (rows.length !== criteria.length || new Set(rows.map(row => row.field)).size !== criteria.length
    || rows.some(row => !criteria.some(criterion => criterion.field === row.field))) {
    throw new Error('SOURCING_LIST_ASSESSMENT_REQUIRED: 必须逐项核验全部初筛条件，不得添加未要求的维度')
  }
  for (const row of rows) {
    if (!['match', 'mismatch', 'unknown'].includes(row.state)) throw new Error('SOURCING_LIST_ASSESSMENT_REQUIRED: 初筛只接受完全符合、不符合或未知')
    if (row.state !== 'unknown' && (!normalized(row.quote) || !normalized(text).includes(normalized(row.quote)))) {
      throw new Error('SOURCING_ASSESSMENT_EVIDENCE_MISSING: 列表初筛必须引用当前候选人卡片原文，缺少信息请标记unknown')
    }
  }
  const matchedCount = rows.filter(row => row.state === 'match').length, requiredCount = criteria.length
  return { qualified: matchedCount === requiredCount, score: requiredCount ? Math.round(matchedCount / requiredCount * 100) : null,
    matchedCount, requiredCount, mismatch: rows.some(row => row.state === 'mismatch'), unknown: rows.some(row => row.state === 'unknown') }
}
