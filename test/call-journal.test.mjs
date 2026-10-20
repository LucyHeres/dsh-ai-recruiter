import assert from 'node:assert/strict'
import { test } from 'node:test'
import { journaledTool, listCalls, recordCall, summarizeCall } from '../dist/lib/call-journal.js'

test('call journal keeps recent calls per session, newest first, without page content', () => {
  recordCall('s1', 'ai_recruit_context', { tool: 'recruitment_getMyJobList', args: { keyword: '前端' } }, { ok: true, durationMs: 120 })
  recordCall('s1', 'ai_recruit_task_start', { kind: 'greeting', platform: 'liepin', limit: 5 }, { ok: true, durationMs: 64 })
  recordCall('s2', 'ai_recruit_capture', {}, { ok: true, durationMs: 3 })
  const first = listCalls('s1')
  assert.equal(first.length, 2)
  assert.equal(first[0].summary, '打招呼 · liepin · 5 人')
  assert.equal(first[1].summary, '职位列表 · 关键词「前端」')
  assert.equal(listCalls('s2').length, 1)
  assert.deepEqual(listCalls('missing'), [])
})

test('a failing call records its error code and the wrapped tool still throws', async () => {
  const wrapped = journaledTool({ name: 'ai_recruit_browser_click', execute: async () => { throw Object.assign(new Error('blocked'), { code: 'BROWSER_AGENT_BUSY' }) } })
  await assert.rejects(wrapped.execute({ tool: 'browser_click' }, { agent: { id: 's3' } }), /blocked/)
  const [entry] = listCalls('s3')
  assert.equal(entry.ok, false)
  assert.equal(entry.code, 'BROWSER_AGENT_BUSY')
  assert.equal(entry.summary, '点击页面元素')
})

test('summaries stay readable and never leak result bodies', () => {
  assert.equal(summarizeCall('ai_recruit_context', { tool: 'recruitment_getJobDetail' }), '职位详情')
  assert.equal(summarizeCall('ai_recruit_task_status', {}), '当前会话任务')
  assert.equal(summarizeCall('ai_recruit_help', {}), '能力与连接状态')
})

test('latest position metadata accepts real nested task and context inputs without retaining their bodies', () => {
  recordCall('position-metadata', 'ai_recruit_context', { tool: 'recruitment_getJobDetail', args: JSON.stringify({ jobId: 'job-product', secret: 'not-retained' }) }, { ok: true, durationMs: 1 })
  assert.equal(listCalls('position-metadata')[0].jobId, 'job-product')
  recordCall('position-metadata', 'ai_recruit_task_start', { request: JSON.stringify({ kind: 'talent_sourcing', jobId: 'job-java', platforms: ['liepin'], limit: 5, supplement: 'private-requirements' }) }, { ok: true, durationMs: 1 })
  const latest = listCalls('position-metadata')[0]
  assert.equal(latest.jobId, 'job-java'); assert.match(latest.summary, /人才寻聘/)
  assert.doesNotMatch(JSON.stringify(listCalls('position-metadata')), /private-requirements|not-retained/)
  recordCall('position-metadata', 'ai_recruit_context', { tool: 'recruitment_getJobDetail', args: { jobId: 'bad-position' } }, { ok: false, durationMs: 1 })
  assert.equal(listCalls('position-metadata')[0].jobId, undefined)
})
