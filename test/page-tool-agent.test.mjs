import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostGreetingPlanner, greetingActionSpec } from '../dist/lib/greeting-planner.js'
import { nativePagePlanner } from '../dist/lib/page-tool-agent.js'
import { pageInspector } from '../dist/lib/page-inspection.js'
import { pageObservation } from '../dist/lib/page-actions.js'
import { modelPageObservation } from '../dist/lib/model-observation.js'

const route = { provider: 'host', model: 'default' }
const signal = () => new AbortController().signal
const call = (id, name, args = {}) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
function model(turns) {
  const requests = []
  return { requests, async *stream(options) {
    requests.push(structuredClone({ ...options, signal: undefined }))
    const blocks = turns.shift()
    assert.ok(blocks, 'unexpected model turn')
    if (blocks instanceof Error) throw blocks
    for (let i = 0; i < blocks.length; i++) {
      yield { type: 'block-start', index: i, blockType: blocks[i].type }
      yield { type: 'block-end', index: i, block: blocks[i] }
    }
    yield { type: 'finish', reason: { kind: blocks.some(b => b.type === 'tool-call') ? 'tool-calls' : 'stop' } }
  } }
}
const observation = id => ({ page: { snapshotId: id, items: [{ ref: 'menu', role: 'button', name: '职位菜单' }] }, processed: [], recentActions: [] })
const results = request => request.messages.flatMap(m => m.content.filter(b => b.type === 'tool-result'))

test('native planner inspects DOM then selects an action; subsequent decisions retain real call/result history', async () => {
  const llm = model([[call('inspect-1', 'inspect_element', { ref: 'menu' })], [call('hover-1', 'page_hover', { ref: 'menu', reason: '检查发现关联菜单，先悬停' })], [call('done-1', 'page_finish', { reason: '任务完成' })]])
  const planner = nativePagePlanner(llm, route, greetingActionSpec, 'system', 'greeting')
  const inspections = []
  const action = await planner.decide(observation('s1'), signal(), async (name, args) => { inspections.push({ name, args }); return { html: '<button aria-controls="jobs">职位菜单</button>' } })
  assert.equal(action.action, 'hover')
  assert.deepEqual(inspections, [{ name: 'inspect_element', args: { ref: 'menu' } }])
  assert.ok(llm.requests[0].tools.some(tool => tool.name === 'page_greet'))
  assert.ok(llm.requests[0].tools.some(tool => tool.name === 'inspect_element'))
  assert.ok(!llm.requests[0].tools.some(tool => /execute_js|upload|token/.test(tool.name)))
  assert.equal(results(llm.requests[1])[0].toolCallId, 'inspect-1')
  planner.recordResult({ status: 'executed', receipt: { dispatched: true, changed: false } })
  assert.equal((await planner.decide(observation('s2'), signal())).action, 'finish')
  const history = results(llm.requests[2])
  assert.ok(history.some(r => r.toolCallId === 'inspect-1'))
  const ack = history.find(r => r.toolCallId === 'hover-1')
  assert.equal(JSON.parse(ack.content[0].text).execution.receipt.changed, false)
  assert.ok(llm.requests[2].messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('s2'))))
})

test('greeting factory uses host tools, not JSON action text', async () => {
  const llm = model([[call('finish', 'page_finish', { reason: '处理完毕' })]])
  const ctx = { get: key => key === 'llm' ? llm : { currentSelection: () => route } }
  assert.equal((await hostGreetingPlanner(ctx)().decide(observation('s1'), signal())).action, 'finish')
  assert.ok(llm.requests[0].tools.length > 10)
})

test('native tools expose workflow-neutral result and submission without modal assumptions', async () => {
  const llm = model([[call('receipt', 'page_record_result', { outcome: 'completed', evidenceRefs: ['receipt'], reason: '平台显示发送成功' })]])
  const planner = nativePagePlanner(llm, route, greetingActionSpec, 'system', 'greeting')
  assert.equal((await planner.decide({ ...observation('after'), pendingGreeting: { name: '候选人' } }, signal())).action, 'record_result')
  const confirmation = llm.requests[0].tools.find(tool => tool.name === 'page_submit')
  assert.deepEqual(confirmation.parameters.required.sort(), ['reason', 'ref'])
  assert.equal(confirmation.parameters.properties.dialogRef, undefined)
  assert.equal(confirmation.parameters.properties.cost, undefined)
})

test('large observations preserve foreground relations and allow reading every omitted ref and covered context', async () => {
  const p = { snapshotId: 'same-snapshot', url: 'https://lpt.liepin.com/list', format: 'semantic',
    dialogs: [{ ref: 'dialog', text: '说明'.repeat(400) + '最后一步的限制和操作说明', closeRef: 'cancel' }],
    items: [...Array.from({ length: 1200 }, (_, i) => ({ ref: `background-${i}`, role: 'button', name: `背景内容${i}`.repeat(15), states: ['blocked_by_dialog'],
      context: { text: i === 1199 ? '目标候选人的完整关联内容' : '' } })),
      { ref: 'dialog', role: 'dialog', name: '当前操作' }, { ref: 'cancel', role: 'button', name: '返回上一步', dialogRef: 'dialog', description: '恢复原操作' } ] }
  const first = modelPageObservation(p)
  assert.ok(first.tree.indexOf('[ref=cancel]') < first.tree.indexOf('[ref=background-0]'))
  assert.match(first.tree, /dialog=dialog/); assert.match(first.tree, /恢复原操作/)
  assert.ok(first.coverage.nextOffset > 0); assert.equal(first.coverage.totalElements, 1202)
  assert.match(first.dialogs[0].text, /最后一步的限制/)
  const inspect = pageInspector({ page: p, tabId: 1, tabs: [], frames: [], origins: ['https://lpt.liepin.com'], call: async () => { throw new Error('read_page must not issue browser calls') } })
  const found = await inspect('read_page', { query: '完整关联内容' })
  assert.match(found.tree, /background-1199/); assert.match(found.tree, /blocked_by_dialog/)
  assert.match(JSON.stringify(found.contexts), /完整关联内容/)
  const seen = new Set(); let offset = 0
  do {
    const part = await inspect('read_page', { offset, limit: 100 })
    assert.equal(part.snapshotId, p.snapshotId); assert.ok(JSON.stringify(part).length < 50000)
    for (const match of part.tree.matchAll(/\[ref=([^\]]+)\]/g)) seen.add(match[1])
    offset = part.coverage.nextOffset
  } while (offset !== null)
  assert.equal(seen.size, p.items.length)
})

test('refresh can request the next source slice and binds subsequent actions to that snapshot only', async () => {
  const p = { snapshotId: 'first', items: [{ ref: 'old', role: 'button', name: '旧区域' }] }, requests = []
  const inspect = pageInspector({ page: p, tabId: 1, tabs: [], frames: [], origins: ['https://lpt.liepin.com'], call: async (tool, args) => {
    requests.push({ tool, args }); return { snapshotId: 'next', url: 'https://lpt.liepin.com/list', format: 'semantic', items: [{ ref: 'e777', role: 'button', name: '后续区域' }] }
  } })
  const output = await inspect('refresh_page', { format: 'semantic', offset: 600, maxItems: 200 })
  assert.equal(requests[0].args.offset, 600); assert.equal(requests[0].args.maxItems, 200)
  assert.equal(output.snapshotId, 'next'); assert.equal(p.snapshotId, 'next')
  assert.deepEqual(p.items.map(item => item.ref), ['e777'])
})

test('multiple side-effect actions in one response are all rejected before any dispatch', async () => {
  const llm = model([[call('a', 'page_click', { ref: 'menu', reason: '打开' }), call('b', 'page_hover', { ref: 'menu', reason: '悬停' })], [call('c', 'page_stop', { reason: '无法确定' })]])
  const planner = nativePagePlanner(llm, route, greetingActionSpec, 'system', 'greeting')
  let inspected = false
  const action = await planner.decide(observation('s1'), signal(), async () => { inspected = true })
  assert.equal(action.action, 'stop'); assert.equal(inspected, false)
  assert.equal(results(llm.requests[1]).length, 2)
  assert.ok(results(llm.requests[1]).every(r => r.isError))
})

test('readonly inspection batch results preserve every tool correlation and failures return to model', async () => {
  const llm = model([[call('a', 'inspect_element', { ref: 'menu' }), call('b', 'read_accessibility'), call('c', 'network_requests')], [call('d', 'page_stop', { reason: '检查后无法确认' })]])
  const seen = []
  await nativePagePlanner(llm, route, greetingActionSpec, 'system', 'greeting').decide(observation('s1'), signal(), async name => {
    seen.push(name)
    if (name === 'read_accessibility') throw new Error('FRAME_ACCESSIBILITY_UNSUPPORTED')
    return { kind: name }
  })
  assert.equal(seen.length, 3)
  assert.deepEqual(results(llm.requests[1]).map(r => r.toolCallId), ['a', 'b', 'c'])
  assert.equal(results(llm.requests[1])[1].isError, true)
})

test('plain JSON is never dispatched as a native tool action, and inspection loops have a finite budget', async () => {
  const text = { type: 'text', text: JSON.stringify({ action: 'click', ref: 'menu', reason: '点击' }) }
  const llm = model([[text], [text], [text]])
  await assert.rejects(nativePagePlanner(llm, route, greetingActionSpec, 'system', 'greeting').decide(observation('s1'), signal()), /TOOL_CALL_REQUIRED/)
  const looping = model(Array.from({ length: 7 }, (_, i) => [call(`i${i}`, 'inspect_element', { ref: 'menu' })]))
  let inspected = 0
  await assert.rejects(nativePagePlanner(looping, route, greetingActionSpec, 'system', 'greeting').decide(observation('s1'), signal(), async () => { inspected++; return {} }), /INSPECTION_BUDGET/)
  assert.equal(inspected, 7)
})

test('inspection errors log a specific code without raw page or credential details', async () => {
  const llm = model([[call('bad-read', 'inspect_element', { ref: 'menu' })], [call('stop', 'page_stop', { reason: '检查失败，停止' })]])
  const logs = []
  const logger = { write: (level, event, fields) => logs.push({ level, event, fields }) }
  await nativePagePlanner(llm, route, greetingActionSpec, 'system', 'greeting', logger).decide(observation('s1'), signal(), async () => {
    throw new Error('PAGE_INSPECTION_TOO_LARGE token=private raw-page-content')
  })
  const failed = logs.find(row => row.event === 'greeting.inspection_failed')
  assert.equal(failed.fields.errorCode, 'PAGE_INSPECTION_TOO_LARGE')
  assert.ok(!JSON.stringify(failed).includes('private') && !JSON.stringify(failed).includes('raw-page-content'))
})

test('conversation trimming never retains orphan tool results; task planners do not share state', async () => {
  const llm = model(Array.from({ length: 24 }, (_, i) => [call(`c${i}`, 'page_wait', { reason: '等待实际页面' })]))
  const planner = nativePagePlanner(llm, route, greetingActionSpec, 'system', 'greeting')
  for (let i = 0; i < 24; i++) { await planner.decide(observation(`s${i}`), signal()); planner.recordResult({ status: 'executed' }) }
  const last = llm.requests.at(-1)
  const ids = new Set(last.messages.flatMap(m => m.content.filter(b => b.type === 'tool-call').map(b => b.id)))
  assert.equal(results(last).length, 18)
  assert.ok(results(last).every(r => ids.has(r.toolCallId)))
  const other = model([[call('new', 'page_stop', { reason: '新任务' })]])
  await nativePagePlanner(other, route, greetingActionSpec, 'system', 'greeting').decide(observation('other'), signal())
  assert.equal(results(other.requests[0]).length, 0)
})

test('inspection adapter binds refs, frame, origin and tab rather than accepting model-supplied targets', async () => {
  const calls = [], origins = ['https://lpt.liepin.com']
  const view = { page: { snapshotId: 's1', documentId: 'doc', items: [{ ref: 'menu' }] }, tabId: 7, frameId: 9, tabs: [], frames: [], origins,
    call: async (tool, args) => { calls.push({ tool, args }); return {} } }
  const inspect = pageInspector(view)
  await inspect('inspect_element', { ref: 'menu' }); await inspect('read_accessibility', {}); await inspect('network_requests', { urlPattern: '/jobs' })
  assert.equal(calls[0].args.snapshotId, 's1'); assert.equal(calls[0].args.tabId, 7)
  assert.equal(calls[1].args.frameId, 9)
  assert.equal(calls[0].args.policy.riskLevel, 'read')
  await assert.rejects(inspect('inspect_element', { ref: 'missing' }), /ELEMENT_NOT_FOUND/)
  await assert.rejects(inspect('inspect_element', { ref: 'menu', tabId: 100 }))
  assert.equal(calls.length, 3)
})

test('DOM observation preserves hierarchy, controls, popup affordance and current values', () => {
  const p = pageObservation({ snapshotId: 's1', items: [{ ref: 'parent', role: 'combobox', name: '职位', controls: 'jobs', hasPopup: 'listbox', value: '研发' },
    { ref: 'child', role: 'button', name: '展开', parentRef: 'parent', tagName: 'button' }] })
  assert.equal(p.items[0].controls, 'jobs'); assert.equal(p.items[0].value, '研发')
  assert.match(p.tree, /\n  button/)
})

test('refresh tool replaces the executor snapshot and preserves current frame and origin checks', async () => {
  const old = { snapshotId: 'old', documentId: 'old-doc', url: 'https://lpt.liepin.com/list', items: [{ ref: 'old-ref' }], stale: true }
  const seen = []
  const inspect = pageInspector({ page: old, tabId: 7, frameId: 9, tabs: [], frames: [], origins: ['https://lpt.liepin.com'],
    call: async (tool, args) => { seen.push(args); return { snapshotId: 'new', documentId: 'new-doc', url: 'https://lpt.liepin.com/list', items: [{ ref: 'new-ref' }] } } })
  const output = await inspect('refresh_page', {})
  assert.equal(old.snapshotId, 'new'); assert.equal(old.stale, undefined)
  assert.equal(output.snapshotId, 'new'); assert.equal(seen[0].frameId, 9)
  await assert.rejects(inspect('inspect_element', { ref: 'old-ref' }), /ELEMENT_NOT_FOUND/)
})

test('large refresh stays within tool budget and supplies usable refs rather than an inspection error', async () => {
  const old = { snapshotId: 'old', url: 'https://lpt.liepin.com/list', items: [] }
  const fresh = { snapshotId: 'new', documentId: 'doc', url: old.url, text: '推荐人才'.repeat(5000),
    items: Array.from({ length: 434 }, (_, i) => ({ ref: `ref_${i}`, role: 'button', name: `候选人入口${i}`,
      context: { text: '姓名及候选人的完整工作经历与作品资料'.repeat(50) } })) }
  assert.ok(JSON.stringify(pageObservation(fresh)).length > 50000)
  const llm = model([[call('refresh', 'refresh_page')], [call('hover', 'page_hover', { ref: 'ref_0', reason: '使用新快照引用' })]])
  const inspect = pageInspector({ page: old, tabId: 1, tabs: [], frames: [], origins: ['https://lpt.liepin.com'], call: async () => fresh })
  const action = await nativePagePlanner(llm, route, greetingActionSpec, 'system', 'greeting').decide(observation('old'), signal(), inspect)
  const refreshed = results(llm.requests[1])[0]
  assert.equal(refreshed.isError, false)
  const output = JSON.parse(refreshed.content[0].text)
  assert.ok(JSON.stringify(output).length < 50000); assert.equal(output.snapshotId, 'new')
  assert.equal(output.truncated, false); assert.equal(output.omittedElementCount, 0)
  assert.equal(old.items.length, 434, 'host retains full refreshed snapshot')
  for (const match of output.tree.matchAll(/\[ref=([^\]]+)\]/g)) assert.ok(old.items.some(actual => actual.ref === match[1]))
  assert.equal(action.ref, 'ref_0'); assert.equal(old.snapshotId, 'new')
})

test('model receives a single compact tree with shared contexts and simpler greeting arguments', async () => {
  const page = pageObservation({snapshotId:'s',items:Array.from({length:200},(_,i)=>({ref:`r${i}`,role:'button',name:'操作',
    context:{text:'林先生 数据工程师 多年工作经历和作品资料'.repeat(20)},bounds:{x:i,y:10,width:100,height:20}}))})
  const compact=modelPageObservation(page)
  assert.ok(JSON.stringify(compact).length<JSON.stringify(page).length*.6)
  assert.equal(Object.keys(compact.contexts).length,1);assert.equal(compact.items,undefined)
  const llm=model([[call('g','page_greet',{ref:'r1',name:'林先生',position:{ref:'job'},reason:'联系'})]])
  llm.resolveModelInfo=async()=>({reasoning:{efforts:[{id:'low',name:'低'},{id:'high',name:'高'}]}})
  const logs=[]
  const action=await nativePagePlanner(llm,{...route,reasoningEffort:'high'},greetingActionSpec,'system','greeting',
    {write:(level,event,fields)=>logs.push({event,fields})}).decide({page},signal())
  assert.equal(action.identityQuote,undefined);assert.equal(action.position.quote,undefined)
  const schema=llm.requests[0].tools.find(tool=>tool.name==='page_greet').parameters
  assert.equal(schema.properties.identityQuote,undefined);assert.equal(schema.properties.profileRef,undefined)
  assert.deepEqual(Object.keys(schema.properties.position.properties),['ref'])
  assert.equal(llm.requests[0].reasoningEffort,'high');assert.equal(llm.requests[0].model,route.model)
  const metric=logs.find(row=>row.event==='greeting.model_decision').fields
  assert.ok(metric.inputCharacters>0);assert.ok(metric.firstChunkMs>=0)
})

test('refresh failure does not replace the executor snapshot with an unreported result', async () => {
  const old = { snapshotId: 'old', url: 'https://lpt.liepin.com/list', items: [{ ref: 'valid' }] }
  const inspect = pageInspector({ page: old, tabId: 1, tabs: [], frames: [], origins: ['https://lpt.liepin.com'],
    call: async () => ({ snapshotId: 'foreign', url: 'https://foreign.example', items: [] }) })
  await assert.rejects(inspect('refresh_page', {}), /ORIGIN_NOT_ALLOWED/)
  assert.equal(old.snapshotId, 'old'); assert.equal(old.items[0].ref, 'valid')
})
