import React from 'react'
import type { ResumeDiagnosis } from '../../shared/workbench.js'

export function ResumeDiagnosisPanel({ diagnosis, rechecked, busy, disabled, copied, onCheck, onCopy }: {
  diagnosis?: ResumeDiagnosis; rechecked: boolean; busy: boolean; disabled: boolean; copied: boolean
  onCheck: () => void; onCopy: () => void
}) {
  return <aside className="air-diagnosis" aria-label="简历识别排查">
    <div className="air-diagnosis-heading"><h3>{diagnosis?.title ?? '停在候选人识别阶段'}</h3><span>{rechecked ? '重新检查结果' : '任务停止时的记录'}</span></div>
    <p>{diagnosis?.summary ?? '本次未处理任何简历。旧版任务没有保存页面现场，仅凭“未识别到”无法判断具体原因。可先切回原招聘页面，再重新检查。'}</p>
    {diagnosis && <p className="air-diagnosis-counts">页面元素 {diagnosis.elementCount} 个 · 识别到候选人 {diagnosis.candidateCount} 位<span>页面元素包括导航和按钮，不等于简历份数。</span></p>}
    <ol>{(diagnosis?.steps ?? ['在原招聘页面确认“已收简历”列表中有具体候选人，并等待加载完成。', '点击“重新检查原页面”查看当前识别结果；不会下载或提交简历。']).map(step => <li key={step}>{step}</li>)}</ol>
    <div className="air-diagnosis-actions"><button type="button" className="air-button air-button-outline air-button-small" disabled={disabled} onClick={onCheck}>{busy ? '正在检查…' : '重新检查原页面'}</button>{diagnosis && <button type="button" className="air-text-button" onClick={onCopy}>{copied ? '已复制排查信息' : '复制排查信息'}</button>}</div>
    {diagnosis && <details><summary>查看排查详情</summary>
      <dl><div><dt>检查时间</dt><dd>{new Date(diagnosis.at).toLocaleString('zh-CN', { hour12: false })}</dd></div><div><dt>实际页面</dt><dd>{diagnosis.url || '未提供地址'}</dd></div></dl>
      {!!diagnosis.reasons.length && <><h4>页面元素未被当作候选人的原因</h4><ul>{diagnosis.reasons.map(row => <li key={row.reason}>{row.reason}：{row.count} 个元素</li>)}</ul></>}
      {!!diagnosis.samples.length && <><h4>插件读到的条目样本（最多 5 条，文字截取）</h4><p>反馈前请检查是否含个人信息；复制内容包含这些样本。</p><ul className="air-diagnosis-samples">{diagnosis.samples.map((sample, index) => <li key={index}><q>{sample.text || '无文字'}</q><span>{sample.reason} · {sample.role}</span></li>)}</ul></>}
    </details>}
  </aside>
}
