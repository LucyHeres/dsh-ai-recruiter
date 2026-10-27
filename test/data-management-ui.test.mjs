import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
const require = createRequire(import.meta.url)
const source = buildSync({ entryPoints: ['src/client/features/data-management.tsx'], bundle: true, write: false,
  format: 'cjs', platform: 'node', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, external: ['react', 'react/*'] }).outputFiles[0].text
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : tree == null || typeof tree === 'boolean' ? [] : [tree]
const text = tree => nodes(tree).filter(item => typeof item !== 'object').join(' ')
const tick = () => new Promise(resolve => setImmediate(resolve))
const usage = { tasks: { bytes: 1.3 * 1024 ** 3 }, talents: { bytes: .5 * 1024 ** 3 } }
function fixture(rpc) {
  const state = [], refs = [], requests = []; let index = 0, refIndex = 0, effects = [], locked = false, refreshes = 0
  const react = { ...require('react'), useState(initial) {
    const i = index++; if (!(i in state)) state[i] = initial
    return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }]
  }, useRef(initial) { return refs[refIndex++] ??= { current: initial } }, useEffect(effect) { effects.push(effect) } }
  const module = { exports: {} }
  runInNewContext(source, { module, exports: module.exports, require: name => name === 'react' ? react : require(name), AbortController })
  const render = () => { index = 0; refIndex = 0; effects = []; return module.exports.DataManagement({ rpc: async (...args) => { requests.push(args); return rpc(...args) }, locked, onClose() {}, onCleared() { refreshes++ } }) }
  const button = label => nodes(render()).find(node => node?.type === 'button' && (node.props['aria-label'] === label || text(node) === label))
  return { render, requests, button, refreshes: () => refreshes, mount: () => { render(); effects.forEach(effect => effect()) }, lock: () => { locked = true } }
}
test('the drawer contains only the two data groups, real sizes and two clear buttons', async () => {
  const view = fixture(async method => { assert.equal(method, 'dataStorage'); return usage })
  assert.equal(view.button('清理任务记录数据').props.disabled, true)
  view.mount(); await tick()
  const tree = view.render()
  assert.equal(nodes(tree).filter(node => node?.type === 'li').length, 2)
  assert.match(text(tree), /任务记录数据.*1.3 GB.*清理.*人才列表数据.*512.0 MB.*清理/)
  assert.doesNotMatch(text(tree), /旧附件缓存|附件按需获取|保留天数/)
  assert.equal(view.requests.length, 1); assert.equal(view.button('清理任务记录数据').props.disabled, false)
})
test('both groups require a second confirmation and cancellation never deletes data', async () => {
  const view = fixture(async method => { assert.equal(method, 'dataStorage'); return usage })
  view.mount(); await tick()
  for (const label of ['任务记录数据', '人才列表数据']) {
    view.button('清理' + label).props.onClick()
    const tree = view.render(), dialog = nodes(tree).find(node => node?.type === 'dialog')
    assert.equal(dialog.props.role, 'alertdialog'); assert.match(text(dialog), new RegExp('确认清理\\s*' + label))
    assert.match(text(dialog), /此操作不可恢复/); assert.match(text(dialog), /薪人薪事中已入库的简历不受影响/)
    assert.equal(view.requests.length, 1)
    view.button('取消').props.onClick()
    assert.equal(nodes(view.render()).some(node => node?.type === 'dialog'), false)
  }
  assert.equal(view.requests.length, 1)
})
test('confirmation submits only the selected group once, updates usage and refreshes visible data', async () => {
  let resolveClear
  const view = fixture(async (method, request) => {
    if (method === 'dataStorage') return usage
    assert.equal(method, 'clearData'); assert.equal(request.group, 'talents'); assert.equal(request.confirmed, true)
    return new Promise(resolve => { resolveClear = resolve })
  })
  view.mount(); await tick(); view.button('清理人才列表数据').props.onClick()
  const handler = view.button('确认清理').props.onClick
  handler(); handler()
  assert.equal(view.requests.filter(row => row[0] === 'clearData').length, 1)
  assert.equal(view.button('正在清理…').props.disabled, true); assert.equal(view.button('取消').props.disabled, true)
  resolveClear({ usage: { tasks: usage.tasks, talents: { bytes: 0 } }, bytes: usage.talents.bytes }); await tick()
  assert.match(text(view.render()), /人才列表数据已清理，释放 512.0 MB/)
  assert.equal(view.button('清理人才列表数据').props.disabled, true); assert.equal(view.refreshes(), 1)
  assert.equal(nodes(view.render()).some(node => node?.type === 'dialog'), false)
})
test('a failed cleanup remains in the confirmation dialog and active tasks block confirmation', async () => {
  const view = fixture(async method => { if (method === 'dataStorage') return usage; throw Error('数据正在使用，请稍后重试') })
  view.mount(); await tick(); view.button('清理任务记录数据').props.onClick(); view.button('确认清理').props.onClick(); await tick()
  assert.match(text(view.render()), /数据正在使用/); assert.ok(view.button('确认清理'))
  const requests = view.requests.length
  view.lock(); assert.equal(view.button('确认清理').props.disabled, true)
  view.button('确认清理').props.onClick(); await tick(); assert.equal(view.requests.length, requests)
})
