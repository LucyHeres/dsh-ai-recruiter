import { logKey, logPageUrl } from './developer-log.js'
import { itemText, normalized, statesOf } from './page-actions.js'
import { sourcingCriterionScore } from '../shared/sourcing-score.js'
import type { SourcingAssessment, SourcingCriterion } from '../shared/sourcing.js'

// UI vocabulary only. Unknown labels, names, contexts and evidence never enter logs.
const controlTerms = ['搜索', '筛选', '清空', '重置', '查看简历', '在线简历', '详情', '工作经历', '项目经历', '教育经历', '头像', '关闭', '返回', '下一页', '上一页', '更多', '确定', '立即沟通', '继续沟通', '打招呼', '发送', '索要', '交换', '购买', '付费', '解锁', '下载', '导出', '收藏', '邀请', '删除', '保存', '投递', '申请', '屏蔽', '举报']

export function sourcingTargetDiagnostic(page: any, ref: unknown, selectedName?: string) {
  const target = page?.items?.find((item: any) => item.ref === ref)
  const label = normalized(target?.name), selected = normalized(selectedName)
  const relation = !selected ? 'unselected' : label === selected ? 'exact-label'
    : label.includes(selected) ? 'label-contains' : itemText(target).includes(selected) ? 'context-contains' : 'not-observed'
  return {
    snapshotId: page?.snapshotId, pageUrl: logPageUrl(page?.url), format: page?.format,
    ref, targetFound: !!target, targetRole: target?.role, targetTag: target?.tagName,
    targetLabelKey: target ? logKey(label) : undefined, targetLabelCharacters: label.length,
    controlTerms: controlTerms.filter(term => label.includes(term)), candidateRelation: relation,
    inDialog: !!target?.dialogRef || target?.role === 'dialog',
    targetStates: statesOf(target).filter(state => ['visible', 'hidden', 'invisible', 'disabled', 'occluded', 'blocked_by_dialog', 'selected', 'checked', 'offscreen'].includes(state)),
    ancestorControls: Array.isArray(target?.ancestorControls) ? target.ancestorControls.slice(0, 5).map((control: any) => ({ tag: control.tagName, role: control.role })) : undefined,
  }
}

export function sourcingAssessmentDiagnostic(criteria: SourcingCriterion[], assessments: unknown, evidence: string) {
  const rows: SourcingAssessment[] = Array.isArray(assessments) ? assessments : []
  const source = normalized(evidence)
  return criteria.slice(0, 8).map(criterion => {
    const row = rows.find(row => row?.criterionId === criterion.id)
    const state = row && ['match', 'partial', 'mismatch', 'unknown'].includes(row.state) ? row.state : undefined
    const quote = normalized(row?.quote)
    return { criterionId: criterion.id, weight: criterion.weight, state, points: state ? sourcingCriterionScore(criterion.weight, state) : undefined,
      quoteProvided: !!quote, quoteFound: !!quote && source.includes(quote) }
  })
}
