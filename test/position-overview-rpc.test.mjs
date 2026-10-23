import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { randomUUID } from 'node:crypto'
import { Workbench } from '../dist/lib/workbench.js'
const require = createRequire(import.meta.url)
function moduleOf(entry, react) {
  const source = buildSync({ entryPoints:[entry], bundle:true, write:false, format:'cjs', platform:'node', jsx:'automatic', define:{'process.env.NODE_ENV':'"production"'}, loader:{'.css':'text'}, external:['react','react/*'] }).outputFiles[0].text
  const module = {exports:{}}
  runInNewContext(source, {module,exports:module.exports,require:name=>name==='react'?react:require(name),AbortController,AbortSignal,setTimeout,clearTimeout,crypto:{randomUUID}})
  return module.exports
}

test('position cards show only the five recruitment platforms, all inline without collapsing after three',()=>{
 const metrics={candidateCount:0,greetedCount:0,resumeCount:0,importedCount:0}
 const state=[[{...metrics,id:'internal',name:'部门职位',platforms:[],publishedChannels:[{id:'20',name:'内部推荐'},{id:'21',name:'招聘门户'},{id:'34',name:'猎头'}]},{...metrics,id:'java',name:'Java',platforms:['liepin'],publishedChannels:[{id:'4',name:'猎聘'}]},{...metrics,id:'sales',name:'销售',platforms:['boss'],publishedChannels:[{id:'11',name:'BOSS直聘'}]},{...metrics,id:'all',name:'全平台职位',publishedChannels:[{id:'1',name:'拉勾'},{id:'11',name:'BOSS'},{id:'2',name:'智联'},{id:'3',name:'51job'},{id:'4',name:'猎聘'},{id:'34',name:'猎头'},{id:'10',name:'脉脉'}]},{...metrics,id:'none',name:'未发布',platforms:[],publishedChannels:[]}],false,'','',0]
 let index=0
 const react={...require('react'),useEffect(){},useState:()=>[state[index++],()=>{}]}
 const {PositionHome}=moduleOf('src/client/features/position-home.tsx',react)
 const nodes=tree=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children)]:tree==null||typeof tree==='boolean'?[]:[tree]
 const tree=PositionHome({rpc:async()=>[],onRecruit(){}})
 const cards=nodes(tree).filter(node=>node?.type==='article')
 const labels=cards.map(card=>nodes(card).filter(node=>node?.props?.['aria-label']==='发布渠道').flatMap(nodes).filter(node=>typeof node==='string').join(' '))
 assert.deepEqual(labels,['未关联招聘平台','猎聘','BOSS直聘','拉勾 BOSS直聘 智联招聘 前程无忧 猎聘','未关联招聘平台'])
 const tags=nodes(cards[3]).filter(node=>node?.props?.className?.includes('air-position-platform-tag'))
 assert.equal(tags.length,5);assert.ok(tags.every(node=>node.type==='span'))
 assert.equal(nodes(cards[3]).filter(node=>node?.type==='button').length,1,'the only card button is the recruit action')
})

test('position homepage uses the real RPC envelope with empty args for its no-argument Remote endpoint', async () => {
  const state = [], effects = []; let index = 0, registration, received
  const react = {...require('react'),useEffect:effect=>effects.push(effect),useState:initial=>{
    const i=index++;state[i]=initial;return [state[i],value=>{state[i]=typeof value==='function'?value(state[i]):value}]
  }}
  const service=Object.create(Workbench.prototype)
  service.initialize=async()=>{}
  service.loadJobOptions=async()=>[{id:'job',name:'Java 工程师',platforms:['liepin'],publishedChannels:[{id:'4',name:'猎聘'},{id:'34',name:'猎头'}]}]
  service.listJobs=async()=>[]
  assert.equal(Workbench.prototype.positionOverview.length,0)
  const client=moduleOf('src/client/index.tsx',react)
  client.apply({effect:()=>{},get:()=>({rpc:{call:async(path,endpoint,payload,signal)=>{
    received={path,endpoint,payload,signal}
    assert.equal(path,'/api');assert.equal(endpoint,'aiRecruitWorkbench/positionOverview')
    // Typert rejects extra named arguments before invoking a no-argument method.
    assert.deepEqual(Object.keys(payload),['args'])
    assert.deepEqual(Object.keys(payload.args),[])
    return {ok:true,value:await service.positionOverview()}
  }}}),slots:{inject:(_name,install)=>install(),register:(definition)=>{
    if(definition.name==='main')registration=definition
    return ()=>{}
  }},sidebarRightTabs:{register:()=>()=>{}},sidebarRight:{openTabIn:()=>{}}})
  const {rpc}=registration.inject()
  const {PositionHome}=moduleOf('src/client/features/position-home.tsx',react)
  PositionHome({rpc,onRecruit:()=>{}})
  const cleanup=effects[0]()
  try {
    await new Promise(resolve=>setImmediate(resolve))
    assert.ok(received)
    assert.equal(state[0][0].id,'job');assert.equal(state[0][0].candidateCount,0)
    assert.deepEqual(state[0][0].publishedChannels,[{id:'4',name:'猎聘'},{id:'34',name:'猎头'}])
    assert.equal(state[1],false);assert.equal(state[2],'')
    assert.equal(received.signal.aborted,false)
  } finally { cleanup() }
  assert.equal(received.signal.aborted,true)
})

test('normal startup never shows reconciliation; a lost response retains the same request id', async () => {
  const workbench = { jobs: [], activeJobId: null, connection: { ready: true, available: true, busy: false } }
  const state = [workbench, 'talent_sourcing', Date.now(), '', '', '', {}, '', false, undefined, { id: 'java', name: 'Java' }, false]
  const refs = []; let index = 0, refIndex = 0, page, rejectStart
  const calls = []
  const job = { id: 'returned', kind: 'talent_sourcing', status: 'running' }
  const react = { ...require('react'), useEffect() {}, useState: initial => {
    const i = index++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
    return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }]
  }, useRef: initial => refs[refIndex++] ??= { current: initial } }
  const client = moduleOf('src/client/index.tsx', react)
  client.apply({ effect() {}, slots: { inject: (_name, install) => install(), register: (definition, component) => {
    if (definition.name === 'main') page = component
    return () => {}
  } }, sidebarRightTabs: { register: () => () => {} }, sidebarRight: { openTabIn() {} } })
  const rpc = async (method, request) => {
    if (method === 'state') return workbench
    assert.equal(method, 'start'); calls.push(request)
    if (calls.length === 1) return new Promise((_resolve, reject) => { rejectStart = reject })
    return { ...job, id: request.id }
  }
  const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : []
  const render = () => {
    index = 0; refIndex = 0
    const tree = nodes(page({ rpc }))
    assert.equal(tree.some(node => node.type === 'button' && [].concat(node.props.children).includes('简历入库')), false)
    assert.equal(tree.some(node => node.props?.title === '简历入库'), false)
    return tree.find(node => typeof node.props?.onReconcile === 'function').props
  }
  render().onStart({ jobId: 'java' })
  const starting = render()
  assert.equal(starting.busy, '启动任务'); assert.equal(starting.pending, false); assert.equal(starting.locked, true)
  starting.onStart({ jobId: 'java' }); assert.equal(calls.length, 1)
  rejectStart(new Error('TIMEOUT'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(render().pending, true)
  render().onReconcile()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 2); assert.equal(calls[0].id, calls[1].id)
  assert.equal(render().pending, false)
})
