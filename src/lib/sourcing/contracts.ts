import { z } from 'zod'
import { SOURCING_MAX_CRITERIA } from '../../shared/sourcing-score.js'

export const listFieldSpec = z.enum(['age', 'education', 'experience', 'city', 'company', 'salary'])
export const listCriterionSpec = z.object({ field: listFieldSpec, requirement: z.string().trim().min(1).max(1000), quote: z.string().trim().min(2).max(4000) }).strict()
export const listAssessmentsSpec = z.array(z.object({ field: listFieldSpec, state: z.enum(['match', 'mismatch', 'unknown']), quote: z.string().max(1000), reason: z.string().min(1).max(140) }).strict()).max(6)
export const pageSpec = { tabId: z.number().int().positive(), snapshotId: z.string().min(1).max(200) }
export const refs = z.array(z.string().min(1).max(200)).min(1).max(40)
export const requirementsSpec = z.object({ keyword: z.string().trim().min(1).max(100), criteria: z.array(z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,30}$/), label: z.string().min(1).max(100), quote: z.string().min(2).max(400),
  must: z.boolean(), weight: z.number().int().min(0).max(100), tier: z.enum(['must', 'core', 'bonus', 'verify']).optional(),
}).strict()).min(1).max(SOURCING_MAX_CRITERIA), listCriteria: z.array(listCriterionSpec).max(6) }).strict()
export const rubricRequirementsSpec = requirementsSpec.extend({
  criteria: z.array(requirementsSpec.shape.criteria.element.extend({ tier: z.enum(['must', 'core', 'bonus', 'verify']) })).min(1).max(SOURCING_MAX_CRITERIA),
  supplementCoverage: z.array(z.object({ quote: z.string().min(1).max(4000), criterionIds: z.array(z.string()).max(SOURCING_MAX_CRITERIA), listFields: z.array(listFieldSpec).max(6), reason: z.string().max(400).optional() }).strict()).max(100).default([]),
}).strict()
export const assessmentsSpec = z.array(z.object({ criterionId: z.string(), state: z.enum(['match', 'partial', 'mismatch', 'unknown']), quote: z.string().max(1000), reason: z.string().min(1).max(400),
  evidenceKind: z.enum(['direct', 'inferred']).optional(), confidence: z.enum(['high', 'medium', 'low']).optional(),
  evidenceQuotes: z.array(z.string().min(1).max(1000)).max(4).optional(), verificationQuestion: z.string().max(400).optional(),
}).strict()).min(1).max(SOURCING_MAX_CRITERIA)
export const filterAssessmentsSpec = z.array(z.object({ field: z.enum(['city', 'experience', 'education']), state: z.enum(['match', 'mismatch', 'unknown']), quote: z.string().max(1000), reason: z.string().min(1).max(140) }).strict()).max(3)
export const selectionSpec = z.object({ ...pageSpec, name: z.string().trim().min(1).max(60), ref: z.string().min(1),
  evidenceRefs: z.array(z.string()).max(6).default([]), profileRef: z.string().optional(), listAssessments: listAssessmentsSpec }).strict()
export const readResumeSpec = z.object({ ...pageSpec, identityRef: z.string().min(1), resumeRefs: refs }).strict()
export const recordSpec = z.object({ ...pageSpec, identityRef: z.string().min(1), resumeRefs: refs,
  scope: z.enum(['summary', 'online']), fields: z.array(z.object({
    label: z.enum(['当前职位', '公司', '城市', '工作经验', '学历', '期望薪资']), value: z.string().min(1).max(200),
  }).strict()).max(6),
  assessments: assessmentsSpec, filterAssessments: filterAssessmentsSpec.default([]), analysis: z.string().min(1).max(1200),
}).strict()
