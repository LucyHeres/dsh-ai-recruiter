import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORMS, PLATFORM_KEYS } from '../dist/shared/workbench.js'
import { platformDefinition } from '../dist/lib/platforms/catalog.js'
import { recruitmentPlatform } from '../dist/lib/platforms/registry.js'

const sourceRoot = fileURLToPath(new URL('../src', import.meta.url))

async function sourceFiles(directory) {
  const rows = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) rows.push(...await sourceFiles(path))
    else if (/\.tsx?$/.test(entry.name)) rows.push(path)
  }
  return rows
}

/** 平台词表（域名、标题后缀）只允许出现在注册表与平台目录：
 *  注册表是唯一事实来源，平台目录是唯一实现地。 */
const PLATFORM_VOCABULARY_FILES = new Set(['shared/workbench.ts'])
const platformVocabulary = [
  { name: '平台域名', pattern: /(?:liepin|zhipin)\.com/i },
  { name: '平台标题后缀', pattern: /高交付/ },
]

/** 平台分支只允许出现在 src/lib/platforms/ 内。通用流程（寻聘、评分、同步、
 *  入库、招呼、UI）通过能力契约取值，避免新增平台时在调用侧补 if。 */
test('平台判断只出现在 src/lib/platforms，通用代码按能力契约取值', async () => {
  // 只匹配「拿平台身份和平台名比较」；filter.platform === 'all' 这类数据筛选不算。
  const patterns = [
    { name: 'platform 相等判断', pattern: /(?<![.\w])(?:job\.)?platform\s*(?:===|!==)\s*['"](?:liepin|boss)['"]/ },
    { name: '平台名 case 分支', pattern: /\bcase\s+['"](?:liepin|boss)['"]\s*:/ },
  ]
  const offenders = []
  for (const file of await sourceFiles(sourceRoot)) {
    const path = relative(sourceRoot, file).split('\\').join('/')
    if (path.startsWith('lib/platforms/')) continue
    const lines = (await readFile(file, 'utf8')).split('\n')
    lines.forEach((line, index) => {
      for (const { name, pattern } of patterns) if (pattern.test(line)) offenders.push(`${path}:${index + 1} ${name}`)
      if (PLATFORM_VOCABULARY_FILES.has(path)) return
      for (const { name, pattern } of platformVocabulary) if (pattern.test(line)) offenders.push(`${path}:${index + 1} ${name}`)
    })
  }
  assert.deepEqual(offenders, [], `通用代码出现平台分支：\n${offenders.join('\n')}`)
})

/** 新增平台需要在注册表补齐定义与驱动；缺失会在构建期或这里失败。 */
test('每个平台都有 definition、寻聘驱动与沟通列表语义', async () => {
  assert.deepEqual([...PLATFORM_KEYS].sort(), ['boss', 'liepin'], '词表顺序稳定')
  assert.deepEqual(Object.keys(PLATFORMS).sort(), [...PLATFORM_KEYS].sort())
  for (const platform of PLATFORM_KEYS) {
    const definition = platformDefinition(platform)
    assert.ok(definition, `${platform} 缺少 definition`)
    assert.match(definition.sourcingEntry, /^https:\/\//, `${platform} 入口必须是 HTTPS`)
    assert.match(definition.receivedEntry, /^https:\/\//, `${platform} 收到简历入口必须是 HTTPS`)
    assert.ok(definition.greetingLabels.size, `${platform} 缺少招呼按钮文案`)
    assert.ok(definition.communication?.entries.length, `${platform} 缺少沟通列表入口`)
    assert.equal(typeof definition.communication?.scope, 'function', `${platform} 缺少沟通列表页面语义`)
    const adapter = recruitmentPlatform(platform)
    assert.equal(adapter.sourcingEntry, definition.sourcingEntry, `${platform} 入口不一致`)
    assert.ok(adapter.createSourcingDriver, `${platform} 缺少寻聘驱动`)
    assert.equal(adapter.greeting, definition.greeting, `${platform} 打招呼能力未从 definition 组装`)
    assert.equal(adapter.receivedResumes, definition.receivedResumes, `${platform} 入库能力未从 definition 组装`)
    assert.equal(recruitmentPlatform(platform), adapter, `${platform} 适配器必须是稳定实例`)
  }
})

/** 网络响应型同步是可选能力：省略时通用 DOM 读取兜底，新增平台无需补分支。 */
test('沟通同步按能力选择实现，未声明专有同步的平台仍走通用读取', async () => {
  assert.equal(typeof recruitmentPlatform('liepin').communicationSync?.sync, 'function')
  assert.equal(typeof recruitmentPlatform('liepin').communicationSync?.hostTools?.[0], 'string')
  assert.equal(recruitmentPlatform('boss').communicationSync, undefined)
  for (const platform of PLATFORM_KEYS) {
    assert.ok(platformDefinition(platform).communication, `${platform} 必须有通用读取所需的页面语义`)
  }
  assert.deepEqual(platformDefinition('liepin').communication.entries, ['https://lpt.liepin.com/chat/im'])
  assert.deepEqual(platformDefinition('liepin').communication.filters.resume_received, ['有简历'])
  assert.deepEqual(platformDefinition('boss').communication.entries, ['https://www.zhipin.com/web/chat/index'])
  assert.deepEqual(platformDefinition('boss').communication.filters.resume_received, ['已获取简历'])
})
