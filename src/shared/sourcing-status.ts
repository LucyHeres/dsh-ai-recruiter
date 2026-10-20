import { PLATFORMS } from './workbench.js'
import type { SourcingRun } from './sourcing.js'

export function sourcingChannelReason(detail: string): string {
  if (/BROWSER_AGENT_REPEATED_FAILURE/.test(detail) && /SOURCING_ASSESSMENT_EVIDENCE_MISSING/.test(detail)) {
    return '候选人评分引用连续未通过原文核验，已停止该渠道，本次候选人未保存。'
  }
  return detail
}

/** Older tasks stored a generic summary; their channel records retain the cause. */
export function sourcingRunNotice(run: Pick<SourcingRun, 'detail' | 'channels'>): string {
  if (!/请查看渠道停止原因/.test(run.detail)) return run.detail
  const reasons = run.channels.filter(channel => ['stopped', 'failed'].includes(channel.status))
    .map(channel => `${PLATFORMS[channel.platform].label}：${sourcingChannelReason(channel.detail)}`)
  return reasons.join('；') || run.detail
}
