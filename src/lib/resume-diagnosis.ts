import { readCandidates } from './candidate-entry.js'
import type { ResumeDiagnosis } from '../shared/workbench.js'

// 仅留定位页面所需的路径；查询串可能含登录信息或候选人标识。
const pageUrl = (value: unknown) => {
  try { const url = new URL(String(value)); return url.protocol === 'https:' ? url.origin + url.pathname : '' } catch { return '' }
}
const sampleText = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱]')
  .replace(/\d[\d\s-]{6,}\d/g, '[号码]').trim().slice(0, 100)

export function resumeDiagnosis(page: any, purpose: 'no_candidates' | 'execution_error' | 'page_check' = 'no_candidates'): ResumeDiagnosis {
  const { candidates, audit } = readCandidates(page?.items)
  const text = String(page?.text ?? '')
  const login = page?.isLoginPage || /扫码登录|验证码登录|请先登录|请完成.*验证/.test(text)
  const empty = /尚未收到简历|暂无简历|没有收到简历/.test(text)
  const hasIdentityText = /\d{2}\s*岁/.test(text) && /博士|硕士|本科|大专|中专|高中/.test(text)
  const blocked = audit.reasons.find(row => row.reason === '条目被标记为遮挡或不可见，不能点击')?.count ?? 0
  const allBlocked = audit.elementCount > 0 && blocked === audit.elementCount
  const title = purpose === 'execution_error' ? '任务中断时的页面检查'
    : candidates.length ? '当前页面可以识别候选人'
    : login ? '页面需要登录或验证' : allBlocked ? '页面元素被标记为遮挡，暂时无法操作' : empty ? '页面显示暂无简历' : '未能从页面识别候选人'
  const summary = purpose === 'execution_error' ? '这是中断时的页面信息，具体停止原因见上方任务结果。'
    : candidates.length ? `本次检查识别到 ${candidates.length} 位候选人；能否采集附件还需在执行时确认。`
    : login ? '浏览器当前显示登录或验证提示，无法读取已收简历。'
    : allBlocked ? '快照中所有页面元素均被标记为遮挡或不可见。即使文字中有候选人，当前也不能安全点击；这不表示没有收到简历。'
    : empty ? '当前页面出现“暂无简历”提示，请检查职位和筛选条件。'
    : hasIdentityText ? '页面文字中有年龄和学历，但可操作条目未通过身份校验。候选人信息可能被拆成多个元素，或姓名格式尚未适配；需要对照下方样本确认。'
    : '当前可操作条目中，没有同时读到姓名及学历、年龄、经历中的至少两项。仅凭这些信息，不能断定平台没有简历。'
  const steps = purpose === 'execution_error' ? [
    '先查看上方任务结果及操作记录，确认停止在 AI 页面理解、附件采集、上传还是入库阶段。',
    '此处是中断后的页面快照；详情弹窗会遮挡列表，候选人数为 0 不代表列表没有简历，也不是本次错误的原因。',
    '需要排查时复制操作日志，关联 AI 决策、浏览器动作及文件上传记录。',
  ] : login ? ['在原招聘页面完成登录或验证，再点击“重新检查原页面”。']
    : candidates.length ? ['如需继续入库，请返回任务设置重新启动；页面检查本身不会下载或入库。']
    : [allBlocked ? '切回该任务的招聘标签页，检查是否有弹窗、浮层或验证提示，确保候选人列表可见。' : '切回该任务的招聘页面，确认位于“已收简历”，并能看到具体候选人；检查职位、筛选条件和加载状态。',
      '保持候选人列表可见，点击“重新检查原页面”；此操作只读取页面。',
      '若页面明明有候选人却仍识别为 0，复制排查信息反馈，需检查插件对该页面的识别适配。']
  return {
    at: new Date().toISOString(), url: pageUrl(page?.url), title, summary, steps,
    elementCount: audit.elementCount, candidateCount: candidates.length,
    reasons: audit.reasons,
    samples: audit.samples.map(sample => ({ role: sample.role, text: sampleText(sample.text), reason: sample.reason })),
  }
}
