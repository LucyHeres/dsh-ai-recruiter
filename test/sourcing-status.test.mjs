import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sourcingRunNotice } from '../dist/shared/sourcing-status.js'

test('legacy generic stopped tasks explain the retained channel failure without rewriting history', () => {
  const run = { detail: '本轮已评估 0 人；尚无已完成评估，请查看渠道停止原因', channels: [{ platform: 'liepin', status: 'stopped', detail: 'BROWSER_AGENT_REPEATED_FAILURE: sourcing_select_candidate SOURCING_ASSESSMENT_EVIDENCE_MISSING' }] }
  assert.match(sourcingRunNotice(run), /猎聘：候选人评分引用连续未通过原文核验/)
  assert.match(run.detail, /请查看渠道停止原因/)
  const timeout = { ...run, detail: 'BOSS 页面操作超时，请检查连接' }
  assert.equal(sourcingRunNotice(timeout), timeout.detail)
})
