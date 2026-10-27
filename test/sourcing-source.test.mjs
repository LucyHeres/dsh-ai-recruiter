import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sourcingStartSpec } from '../dist/lib/sourcing-policy.js'
import { recruitmentPlatform } from '../dist/lib/platforms/registry.js'
import { sourcingMode, sourcingEntry, isSourcingEntry, assertRecommendationPage, assertRecommendationNavigation, bootstrapSourcing } from '../dist/lib/sourcing/source.js'
import { sourcingSystem } from '../dist/lib/sourcing/prompts.js'

const signal = new AbortController().signal
const entry = 'https://lpt.liepin.com/recommend'
test('omitted source defaults to recommendation on both platforms; search requires an explicit supported mode', () => {
  const input = { id: '32cfb184-78bc-4817-aa0b-4f6da48fc942', jobId: 'job', platforms: ['liepin', 'boss'], limit: 5, confirmed: true }
  const job = sourcingStartSpec.parse(input)
  assert.equal(job.sourceMode, 'recommend')
  assert.equal(sourcingMode({}), 'recommend')
  assert.equal(sourcingEntry(recruitmentPlatform('liepin'), job), entry)
  assert.equal(sourcingEntry(recruitmentPlatform('boss'), job), 'https://www.zhipin.com/web/chat/recommend')
  assert.equal(sourcingEntry(recruitmentPlatform('liepin'), { sourceMode: 'search' }), 'https://lpt.liepin.com/search')
  assert.throws(() => sourcingEntry(recruitmentPlatform('boss'), { sourceMode: 'search' }), /SOURCING_SEARCH_UNSUPPORTED/)
  assert.equal(sourcingStartSpec.safeParse({ ...input, sourceMode: 'auto' }).success, false)
})

test('startup restores a directly opened iframe document to its outer recommendation page', async () => {
  const boss = recruitmentPlatform('boss')
  const alias = 'https://www.zhipin.com/web/frame/recommend/?jobid=job123'
  assert.deepEqual(boss.sourcingEntryAliases, ['https://www.zhipin.com/web/frame/recommend'])
  assert.doesNotThrow(() => assertRecommendationPage({ url: alias }, boss.sourcingEntry, boss.sourcingEntryAliases))
  assert.throws(() => assertRecommendationPage({ url: alias }, boss.sourcingEntry), /SOURCING_RECOMMENDATION_REQUIRED/)
  for (const url of ['https://www.zhipin.com/web/chat/index', 'https://www.zhipin.com/web/frame/other']) {
    assert.throws(() => assertRecommendationPage({ url }, boss.sourcingEntry, boss.sourcingEntryAliases), /SOURCING_RECOMMENDATION_REQUIRED/)
  }
  let called = 0
  const seeds = await bootstrapSourcing({
    bootstrap: async () => [{ name: 'browser_list_tabs', value: { tabs: [{ tabId: 1, url: alias }] } }],
    currentPage: () => ({ tabId: 1, url: alias }),
    tools: [{ name: 'browser_navigate', execute: async () => { called++; return {} } }],
  }, boss.sourcingEntry, true, signal, boss.sourcingEntryAliases)
  assert.deepEqual(seeds.map(seed => seed.name), ['browser_list_tabs', 'browser_navigate'])
  assert.equal(called, 1)
})

test('BOSS iframe navigation is blocked for both direct tools and observed links', () => {
  const boss = recruitmentPlatform('boss'), url = boss.sourcingEntryAliases[0] + '/?jobid=job123'
  const page = { url: boss.sourcingEntry, items: [{ ref: 'frame-link', href: url }] }
  for (const [name, args] of [['browser_navigate', { url }], ['browser_open_tab', { url }], ['browser_click', { ref: 'frame-link' }]]) {
    assert.throws(() => assertRecommendationNavigation({ name, args, readOnly: false }, page, boss.sourcingEntry, boss.sourcingEntryAliases), /SOURCING_FRAME_NAVIGATION_FORBIDDEN/)
  }
  assert.doesNotThrow(() => assertRecommendationNavigation({ name: 'browser_snapshot', args: { frameId: 1 }, readOnly: true }, page, boss.sourcingEntry, boss.sourcingEntryAliases))
})

test('recommendation proof checks the actual source, not a model-declared source or selected job alone', () => {
  assert.equal(isSourcingEntry(entry + '?jobId=123', entry), true)
  assert.equal(isSourcingEntry(entry + '/', entry), true)
  for (const url of ['https://lpt.liepin.com/search', 'https://lpt.liepin.com/resume/apply', 'https://other.test/recommend']) {
    assert.throws(() => assertRecommendationPage({ url, items: [{ role: 'tab', states: ['selected'] }] }, entry), /SOURCING_RECOMMENDATION_REQUIRED/)
  }
  assert.throws(() => assertRecommendationPage({ url: entry, isLoginPage: true }, entry), /RECOMMENDATION_REQUIRED/)
})

test('observed search links, menu commands, direct navigation and keyword input cannot widen a recommendation task', () => {
  const page = { url: entry, items: [
    { ref: 'search-link', role: 'link', name: '高级筛选', href: '/search?keyword=Java' },
    { ref: 'search-tab', role: 'tab', name: '人才搜索' },
    { ref: 'keyword', role: 'searchbox', name: '关键词' },
    { ref: 'job', role: 'tab', name: 'Java开发' },
    { ref: 'filter', role: 'button', name: '学历：本科及以上' },
    { ref: 'detail', role: 'link', name: '候选人详情', href: '/resume/123' },
  ] }
  const call = (name, args) => ({ name, args, readOnly: false, purpose: 'navigation', signal })
  for (const name of ['browser_click', 'browser_hover']) for (const ref of ['search-link', 'search-tab']) {
    assert.throws(() => assertRecommendationNavigation(call(name, { ref }), page, entry), /RECOMMENDATION_REQUIRED/)
  }
  for (const name of ['browser_open_tab', 'browser_navigate']) {
    assert.throws(() => assertRecommendationNavigation(call(name, { url: 'https://lpt.liepin.com/search' }), page, entry), /RECOMMENDATION_REQUIRED/)
  }
  assert.throws(() => assertRecommendationNavigation(call('browser_type', { ref: 'keyword', text: 'Java' }), page, entry), /RECOMMENDATION_REQUIRED/)
  for (const ref of ['job', 'filter', 'detail']) assert.doesNotThrow(() => assertRecommendationNavigation(call('browser_click', { ref }), page, entry))
})

test('known startup returns a unique search tab to recommendations once, without a navigation-model call', async () => {
  const calls = []
  const broker = {
    bootstrap: async () => [{ name: 'browser_list_tabs', value: { tabs: [{ tabId: 1, url: 'https://lpt.liepin.com/search' }] } }],
    currentPage: () => ({ tabId: 1, url: 'https://lpt.liepin.com/search' }),
    tools: [{ name: 'browser_navigate', execute: async args => { calls.push(args); return { tabId: 1, snapshot: { url: entry } } } }],
  }
  const seeds = await bootstrapSourcing(broker, entry, true, signal)
  assert.deepEqual(calls, [{ tabId: 1, url: entry, purpose: 'navigation' }])
  assert.deepEqual(seeds.map(s => s.name), ['browser_list_tabs', 'browser_navigate'])
  await bootstrapSourcing({ ...broker, currentPage: () => ({ tabId: 1, url: entry }) }, entry, true, signal)
  for (const recommendation of [true, false]) await assert.rejects(bootstrapSourcing({ ...broker,
    currentPage: () => ({ tabId: 1, url: 'https://lpt.liepin.com/login', isLoginPage: true }) }, entry, recommendation, signal), error => error.code === 'PLATFORM_LOGIN_REQUIRED')
  assert.equal(calls.length, 1)
  await assert.rejects(bootstrapSourcing({ ...broker, tools: [{ name: 'browser_navigate', execute: async () => { throw Error('BROWSER_WRITE_OUTCOME_UNKNOWN') } }] }, entry, true, signal), /OUTCOME_UNKNOWN/)
})

test('startup opens only when no platform tab exists and leaves ambiguous platform tabs to the agent', async () => {
  let opened = 0
  const broker = {
    bootstrap: async () => [{ name: 'browser_list_tabs', value: { tabs: [] } }], currentPage: () => undefined,
    tools: [{ name: 'browser_open_tab', execute: async args => { assert.equal(args.url, entry); opened++; return {} } }],
  }
  await bootstrapSourcing(broker, entry, true, signal)
  const tabs = [1, 2].map(tabId => ({ tabId, url: 'https://lpt.liepin.com/search' }))
  await bootstrapSourcing({ ...broker, bootstrap: async () => [{ name: 'browser_list_tabs', value: { tabs } }] }, entry, true, signal)
  assert.equal(opened, 1)
})

test('opening a sourcing page that redirects to login ends the attempt and preserves that tab', async () => {
  const calls = []; let page
  const broker = { bootstrap: async () => [{ name: 'browser_list_tabs', value: { tabs: [] } }], currentPage: () => page,
    tools: [{ name: 'browser_open_tab', execute: async () => { calls.push('open'); page = { tabId: 1, url: 'https://passport.liepin.com/login', isLoginPage: true }; return { tabId: 1 } } }] }
  await assert.rejects(bootstrapSourcing(broker, entry, true, signal), error => error.code === 'PLATFORM_LOGIN_REQUIRED')
  page = { tabId: 1, url: entry }
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, ['open'])
  const uncached = { ...broker, currentPage: () => undefined,
    tools: [{ name: 'browser_open_tab', execute: async () => ({ tabId: 2, url: 'https://passport.liepin.com/login' }) }] }
  await assert.rejects(bootstrapSourcing(uncached, entry, true, signal), error => error.code === 'PLATFORM_LOGIN_REQUIRED')
})

test('recommendation recovery instructions have no search-entry fallback; explicit search retains its own preparation', () => {
  assert.match(sourcingSystem('recommend'), /禁止调用 sourcing_search/)
  assert.doesNotMatch(sourcingSystem('recommend'), /然后从已有平台页的实际搜索入口进入人才搜索|只有页面没有职位选择器时才按关键词搜索/)
  assert.match(sourcingSystem('search'), /只有页面没有职位选择器时才按关键词搜索/)
})
