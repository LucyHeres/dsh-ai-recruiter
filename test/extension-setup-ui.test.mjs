import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
const require = createRequire(import.meta.url)
const source = buildSync({ entryPoints: ['src/client/index.tsx'], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'text' }, external: ['react', 'react/*'] }).outputFiles[0].text
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree == null || typeof tree === 'boolean' ? [] : typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [tree]
const find = (tree, test) => nodes(tree).find(node => node?.props && test(node))
const text = tree => nodes(tree).filter(node => typeof node !== 'object').join(' ')
const guide = tree => find(tree, node => node.type?.name === 'ExtensionInstallGuide')
const sourcing = tree => find(tree, node => typeof node.props.onReconcile === 'function')
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(status = 'not_installed', responder) {
  const snapshot = { jobs: [], activeJobId: null, extensionInstallation: { status, detail: '未检测到薪招扩展', checkedAt: '', source: 'browser_profile' },
    connection: { ready: false, gateway: true, connected: false, connecting: true, busy: false } }
  const states = [snapshot, 'talent_sourcing', Date.now(), '', '', '', {}, '', false, undefined, { id: 'java', name: 'Java' }, false]
  const refs = [], requests = []; let index = 0, refIndex = 0, effects = [], Page
  const react = { ...require('react'), useEffect: (effect, deps) => effects.push({ effect, deps }),
    useState: initial => { const i = index++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }] },
    useRef: initial => refs[refIndex++] ??= { current: initial } }
  const module = { exports: {} }
  runInNewContext(source, { module, exports: module.exports, require: name => name === 'react' ? react : require(name), AbortController, AbortSignal, crypto: require('node:crypto').webcrypto })
  module.exports.apply({ effect() {}, slots: { inject: (_slot, install) => install(), register: (definition, component) => { if (definition.name === 'main') Page = component; return () => {} } }, sidebarRightTabs: { register: () => () => {} }, sidebarRight: { openTabIn() {} } })
  const rpc = async (method, args) => {
    requests.push({ method, args })
    if (responder) return responder(method, args)
    if (method === 'state') return states[0]
    if (method === 'checkExtension') return { ...snapshot.extensionInstallation, status: 'installed' }
    if (method === 'start') return { ...args, kind: 'talent_sourcing' }
    throw Error(`Unexpected RPC ${method}`)
  }
  return { requests, render: () => { index = 0; refIndex = 0; effects = []; return Page({ rpc }) },
    autoPrompt: () => effects.find(row => row.deps?.[0] === states[0].extensionInstallation.status)?.effect(), state: () => states[0] }
}

test('missing extension opens setup once, keeps a persistent reminder, and has no downstream success or loading', () => {
  const view = fixture()
  view.render(); view.autoPrompt()
  let tree = view.render()
  assert.ok(guide(tree)); assert.match(text(tree), /尚未安装【薪招】浏览器扩展/)
  assert.match(text(guide(tree).type(guide(tree).props)), /尚未安装【薪招】浏览器扩展/)
  assert.doesNotMatch(text(tree), /本机网关|扩展授权|最长等待|正在连接浏览器/)
  const steps = nodes(tree).filter(node => node?.type?.name === 'Connection')
  assert.deepEqual(steps.map(node => node.props.label), ['安装扩展', '连接浏览器'])
  assert.ok(steps.every(node => !node.props.good && !node.props.pending))
  const connect = find(tree, node => node.type === 'button' && text(node) === '连接浏览器')
  assert.equal(connect.props.disabled, false)
  guide(tree).props.onClose(); tree = view.render(); view.autoPrompt()
  assert.equal(guide(view.render()), undefined, 'ordinary status polling does not reopen a dismissed modal')
  assert.match(text(tree), /尚未安装【薪招】浏览器扩展/)
  connect.props.onClick()
  assert.ok(guide(view.render()), 'connecting also explains the missing installation before doing any work')
  guide(view.render()).props.onClose()
  sourcing(tree).props.onStart({ jobId: 'java' })
  assert.ok(guide(view.render()), 'a browser action reopens the guide')
  assert.equal(sourcing(view.render()).props.pending, false)
  assert.equal(view.requests.length, 0, 'no start, connect or ensure is sent while installation is missing')
})

test('rechecking installation closes setup without starting the previously rejected action', async () => {
  const view = fixture(); view.render(); view.autoPrompt()
  sourcing(view.render()).props.onStart({ jobId: 'java' })
  guide(view.render()).props.onCheck(); await tick()
  assert.equal(view.state().extensionInstallation.status, 'installed')
  assert.equal(guide(view.render()), undefined)
  assert.deepEqual(view.requests.map(row => row.method), ['checkExtension'])
  assert.equal(sourcing(view.render()).props.pending, false)
  sourcing(view.render()).props.onStart({ jobId: 'java' }); await tick()
  assert.deepEqual(view.requests.map(row => row.method), ['checkExtension', 'start', 'state'])
})

test('an uninstall detected by the server clears the rejected start instead of retaining a pending task', async () => {
  const view = fixture('installed', async method => {
    if (method === 'start') throw Error('BROWSER_EXTENSION_NOT_INSTALLED: 请先安装')
    if (method === 'checkExtension') return { status: 'not_installed', detail: '请先安装' }
    throw Error(`Unexpected ${method}`)
  })
  sourcing(view.render()).props.onStart({ jobId: 'java' }); await tick()
  assert.ok(guide(view.render()))
  assert.equal(sourcing(view.render()).props.pending, false)
  assert.deepEqual(view.requests.map(row => row.method), ['start', 'checkExtension'])
})
