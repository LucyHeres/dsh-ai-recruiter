import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BOSS_RESUME_IMPORT_ROUTE, BOSS_SOURCING_ROUTE } from '../dist/lib/platforms/boss/ai-route.js'
import { bossDefinition } from '../dist/lib/platforms/boss/definition.js'
import { recruitmentPlatform } from '../dist/lib/platforms/registry.js'
import { resumeAgentSystem } from '../dist/lib/resume-agent.js'

test('BOSS 寻聘路径包含真实详情读取与图片正文核验', () => {
  const boss = recruitmentPlatform('boss')
  const liepin = recruitmentPlatform('liepin')
  assert.equal(boss.sourcingHints, BOSS_SOURCING_ROUTE)
  assert.notEqual(boss.sourcingHints, liepin.sourcingHints)
  for (const landmark of ['推荐牛人', '职位下拉', 'platformJobs', 'span.name', 'context.text', '打招呼',
    '打开实际简历', 'Canvas', '图片姓名', '下一页', '没有更多']) {
    assert.ok(BOSS_SOURCING_ROUTE.includes(landmark), `缺少 BOSS 寻聘路径：${landmark}`)
  }
  assert.ok(!BOSS_SOURCING_ROUTE.includes('不限职位'))
  assert.ok(!BOSS_SOURCING_ROUTE.includes('顶部大搜索框'))
})

test('BOSS 通过卡片主体打开详情，禁止把列表或经历概览当作正文', () => {
  assert.ok(BOSS_SOURCING_ROUTE.includes('姓名，不是链接'))
  assert.ok(BOSS_SOURCING_ROUTE.includes('点击唯一的 .card-inner'))
  assert.ok(BOSS_SOURCING_ROUTE.includes('不能保存列表摘要'))
  assert.ok(!BOSS_SOURCING_ROUTE.includes('不要打开详情'))
  assert.ok(BOSS_SOURCING_ROUTE.includes('没有可用的主动人才搜索入口'))
  assert.ok(BOSS_SOURCING_ROUTE.includes('sourcing_finish(status=stopped'))
  assert.ok(BOSS_SOURCING_ROUTE.includes('禁止用 browser_navigate'))
  assert.ok(BOSS_SOURCING_ROUTE.includes('frameInteraction=same-origin'))
  assert.ok(BOSS_SOURCING_ROUTE.includes('上次任务残留的简历弹窗'))
  assert.ok(BOSS_SOURCING_ROUTE.includes('不能直接归属本轮新选人选'))
  assert.ok(BOSS_SOURCING_ROUTE.includes('sourcing_skip_candidate 放弃本位'))
  assert.ok(!BOSS_SOURCING_ROUTE.includes('找到该文档并导航过去'))
})

test('BOSS 入库路径是沟通 → 已获取简历，并接入平台定义', () => {
  const received = bossDefinition.receivedResumes
  assert.equal(bossDefinition.receivedTab, '已获取简历')
  assert.equal(received?.receivedPath, '/web/chat/index')
  assert.equal(received?.requiredTab, '已获取简历')
  assert.equal(received?.guidance, BOSS_RESUME_IMPORT_ROUTE)
  for (const landmark of ['「沟通」', '已获取简历', 'task_import_attachment', '人才管理', '不能只按姓名合并']) {
    assert.ok(BOSS_RESUME_IMPORT_ROUTE.includes(landmark), `缺少 BOSS 入库路径：${landmark}`)
  }
  assert.notEqual(BOSS_RESUME_IMPORT_ROUTE, BOSS_SOURCING_ROUTE)
})

test('猎聘入库路径仍描述人才管理的收到简历 tab', () => {
  const received = recruitmentPlatform('liepin').receivedResumes
  assert.equal(received?.requiredTab, '收到简历')
  assert.match(received?.guidance ?? '', /人才管理.*收到简历/)
})

test('入库 Agent 的 system 按平台选择路径：BOSS 用沟通/已获取简历，猎聘用人才管理', () => {
  const boss = resumeAgentSystem('boss')
  const liepin = resumeAgentSystem('liepin')
  assert.ok(boss.includes('「沟通」'))
  assert.ok(boss.includes('已获取简历'))
  assert.ok(boss.includes('/web/chat/index'))
  assert.ok(!boss.includes('猎聘从人才管理'))
  assert.ok(liepin.includes('人才管理'))
  assert.ok(liepin.includes('收到简历'))
  assert.ok(!liepin.includes('已获取简历'))
})
