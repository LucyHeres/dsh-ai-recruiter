import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bossDocumentSelector, bossDocumentTitle, bossPositionChoices, verifyBossDocumentPosition } from '../dist/lib/platforms/boss/search-evidence.js'
import { BossPositionRoute } from '../dist/lib/platforms/boss/position-route.js'

const name = '高级销售经理（上海）'
const page = (open, revision = 1) => ({ tabId: 1, snapshotId: `s${revision}`, frameId: 3, frameInteraction: 'same-origin',
  url: 'https://www.zhipin.com/web/chat/recommend', frameUrl: 'https://www.zhipin.com/web/frame/recommend/?jobid=current', items: [
    { ref: `root${revision}`, role: 'div', name: `渠道经理 _ 深圳 10-15K${open ? ` ${name} _ 上海 13-20K 调整顺序` : ''}`, bounds: { x: 840, y: 12, width: 230, height: 36 } },
    { ref: `title${revision}`, role: 'div', name: '渠道经理 _ 深圳 10-15K', parentRef: `root${revision}`, bounds: { x: 841, y: 13, width: 228, height: 34 } },
    ...(open ? [{ ref: 'list', role: 'ul', parentRef: `root${revision}`, name: `${name} _ 上海 13-20K` },
      { ref: 'job', role: 'li', parentRef: 'list', name: `${name} _ 上海 13-20K` },
      { ref: 'job-text', role: 'span', parentRef: 'job', name: `${name} _ 上海 13-20K` }] : []),
    { ref: 'card', role: 'article', name: '候选人 30岁 求职意向' }, { ref: 'fake-job', role: 'li', parentRef: 'card', name: `${name} _ 上海 13-20K` },
  ] })

test('menu options are scoped, decorated, unique and never current-position evidence', () => {
  const p = page(true), job = { jobId: 'host', jobName: name, platformJobs: [{ id: 'current', name }] }
  assert.equal(bossDocumentSelector(p).ref, 'title1')
  assert.deepEqual(bossPositionChoices(p, [name]).map(x => x.ref), ['job'])
  assert.deepEqual(bossPositionChoices(p, [name, name]), [])
  assert.equal(bossDocumentTitle(p, [name]), undefined)
  assert.equal(verifyBossDocumentPosition(p, job, { ref: 'job-text' }).ok, false)
})

test('AI and preset share a guard against open-menu toggles and unchanged reopened state', async () => {
  const route = new BossPositionRoute(); let clicks = 0
  const call = ref => ({ name: 'browser_click', args: { tabId: 1, ref } })
  await route.dispatch(call('root1'), page(false), async () => { clicks++ })
  await assert.rejects(route.dispatch(call('root2'), page(true, 2), async () => { clicks++ }), /MENU_OPEN/)
  await assert.rejects(route.dispatch(call('title3'), page(false, 3), async () => { clicks++ }), /SELECTION_STALLED/)
  await route.dispatch(call('job'), page(true), async () => { clicks++ })
  assert.equal(clicks, 2)
})
