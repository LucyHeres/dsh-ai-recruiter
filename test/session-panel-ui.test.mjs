import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')

function fixture() {
  let factory, states = [], effects = [], index = 0, refs = [], refIndex = 0, responder = () => ({})
  const navigated = []
  const opened = [], registrations = [], definitions = [], requests = []
  const react = { ...require('react'), useState: initial => { const i=index++; if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value}] }, useEffect: effect => effects.push(effect), useRef: value => refs[refIndex++] ??= { current: value } }
  runInNewContext(source, { AbortController, AbortSignal, crypto: require('node:crypto').webcrypto, window: { __ModuleLoader__: { load: value => { factory = value.factory } } } })
  const client = factory(name => name === 'react' ? react : require(name))
  const ctx = {
    effect: effect => effect(),
    get: () => ({ rpc: { call: async (...args) => { requests.push(args); return { ok: true, value: await responder(...args) } } } }),
    slots: { inject: (_name, register) => register(), register: (definition, component) => { registrations.push({ definition, component }); return () => {} } },
    sidebarRightTabs: { register: definition => { definitions.push(definition); return () => {} } },
    layout: { selectPanel: id => navigated.push(id), closeRightbar: () => {} },
    sidebarRight: { isExpanded: () => true, toggleExpanded: () => {}, openTabIn: (...args) => opened.push(args) },
  }
  client.apply(ctx)
  const render = (slot, sessionId, values) => {
    if(values) { states = [...values]; refs=[] } effects = []; index = 0; refIndex = 0
    const registration = registrations.find(entry => entry.definition.name === slot)
    let element = registration.component({ sessionId, ...registration.definition.inject() })
    if(element?.type?.name === 'SessionRecruitmentPanel')element=element.type(element.props)
    const expand = node => { if(Array.isArray(node))return node.map(expand); if(!node || typeof node!=='object')return node; if(node.type?.name==='LegacyTask')return expand(node.type(node.props));return {...node,props:{...node.props,children:expand(node.props?.children)}} }; element=expand(element)
    return { element, effects: [...effects] }
  }
  return { opened, registrations, definitions, requests, navigated, render, states:()=>states, respond:fn=>{responder=fn} }
}

function elements(element) {
  if (Array.isArray(element)) return element.flatMap(elements)
  if (element === undefined || element === null || typeof element === 'boolean') return []
  if (typeof element !== 'object') return [element]
  return [element, ...elements(element.props?.children)]
}
const textOf = element => elements(element).filter(item => typeof item !== 'object').join(' ')
const job = { id: 'task-one', kind: 'greeting', platform: 'liepin', source: 'chat', sessionId: 'session-one', limit: 5,
  status: 'running', phase: 'reading', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  results: [{ key: 'person-one', name: '林先生', stage: 'succeeded', clickedAt: new Date().toISOString(), detail: '已点击平台单人沟通按钮', updatedAt: new Date().toISOString() }], events: [] }
const snapshot = { sessionId: 'session-one', jobs: [job], activeJobId: job.id }

test('packaged client registers a session sidebar tab and opens only the originating session without starting another task', () => {
  const view = fixture()
  assert.equal(view.definitions[0].kind, 'ai-recruiter-progress')
  const rendered = view.render('conversation.session.header.actions', 'session-one', [snapshot, undefined, ''])
  rendered.effects.at(-1)()
  assert.deepEqual(view.opened.map(args => [...args]), [['session-one', 'ai-recruiter-progress']])
  assert.deepEqual(view.requests, [])
})

test('conversation entry carries its own styles and announces the actual task state before the drawer opens', () => {
  for (const [status,label] of [['queued','等待执行'],['running','进行中'],['stopping','停止中'],['completed','已完成'],['stopped','已停止'],['failed','执行失败'],['unknown','已停止']]) {
    const view=fixture()
    const {element}=view.render('conversation.session.header.actions','session-one',[{...snapshot,jobs:[{...job,status}]},undefined,''])
    const button=elements(element).find(row=>row?.type==='button')
    assert.equal(button.props['data-state'],status)
    assert.equal(button.props['aria-label'],`查看招聘进度，${label}`)
    assert.ok(elements(element).some(row=>row?.type==='style'))
    button.props.onClick();assert.deepEqual(view.opened.map(args=>[...args]),[['session-one','ai-recruiter-progress']])
    assert.equal(view.requests.length,0)
  }
  const view=fixture()
  const snapshotWithActive={...snapshot,jobs:[{...job,id:'newer',status:'completed'},job]}
  const {element}=view.render('conversation.session.header.actions','session-one',[snapshotWithActive,undefined,''])
  assert.equal(elements(element).find(row=>row?.type==='button').props['data-state'],'running')
  const failed=view.render('conversation.session.header.actions','session-one',[snapshot,{sessionId:'session-one',message:'读取失败'},'']).element
  assert.equal(elements(failed).find(row=>row?.type==='button').props['data-state'],'error')
  assert.match(textOf(failed),/状态异常/)
})

test('packaged session panel shows click-based progress and candidate records without claiming delivery', () => {
  const view = fixture()
  const { element } = view.render('sidebar.right.pane.tab', 'session-one', [snapshot, undefined, '', '', false, ''])
  assert.match(textOf(element), /林先生/)
  assert.match(textOf(element), /已打招呼/)
  assert.ok(!textOf(element).includes('已确认沟通'))
  const progress = elements(element).find(item => item?.type === 'progress')
  assert.equal(progress.props.value, 1); assert.equal(progress.props.max, 5)
  assert.deepEqual(view.requests, [])
})

test('switching sessions cannot briefly render cached progress from another session', () => {
  const view = fixture()
  const { element } = view.render('sidebar.right.pane.tab', 'session-two', [snapshot, undefined, '', '', false, ''])
  assert.ok(!textOf(element).includes('林先生'))
  assert.match(textOf(element), /正在读取当前会话任务/)
  assert.deepEqual(view.opened, [])
})

test('packaged right sidebar lists recent plugin calls including query tools', () => {
  const view = fixture()
  const calls = [
    { at: '2026-10-17T02:10:00.000Z', tool: 'ai_recruit_context', summary: '职位列表 · 关键词「前端」', ok: true, durationMs: 128 },
    { at: '2026-10-17T02:11:00.000Z', tool: 'ai_recruit_task_start', summary: '打招呼 · liepin · 5 人', ok: true, durationMs: 64 },
    { at: '2026-10-17T02:12:00.000Z', tool: 'ai_recruit_context', summary: '职位详情', ok: false, code: 'BROWSER_AGENT_BUSY', durationMs: 12 },
  ]
  // 没有任务、只有查询时，面板仍必须给出调用记录——这正是原先完全看不到的部分。
  const { element } = view.render('sidebar.right.pane.tab', 'session-one',
    [{ sessionId: 'session-one', jobs: [], activeJobId: null, calls }])
  const text = textOf(element)
  assert.match(text, /职位/)
  assert.match(text, /工具调用记录/)
  assert.match(text, /职位列表 · 关键词「前端」/)
  assert.match(text, /打招呼 · liepin · 5 人/)
  assert.match(text, /128 ms/)
  assert.match(text, /失败 · BROWSER_AGENT_BUSY/)
  const diagnostics = elements(element).find(row => row?.props?.className === 'air-session-diagnostics')
  assert.equal(diagnostics.props.open, undefined, 'diagnostics are collapsed so they do not displace candidates')
})

const positions = [{ id: 'java', name: 'Java 工程师', label: 'Java 工程师', city: '武汉' }, { id: 'product', name: '产品经理', label: '产品经理', city: '上海' }]
const workbench = { jobs: [], activeJobId: null, connection: { ready: true, available: true, busy: false, activeWorkflow: false } }
const session = { ...snapshot, latestPositionId: 'product', jobs: [{ ...job, kind: 'talent_sourcing', jobId: 'java', jobName: 'Java 工程师' }] }
const sourceProps = tree => elements(tree).find(row => row?.type?.name === 'SourcingPanel').props

test('drawer defaults to the latest conversation position, allows switching, and opens that exact workbench position', async () => {
  const view = fixture()
  let { element } = view.render('sidebar.right.pane.tab', 'session-one', [session, undefined, '', '', '', '', positions, workbench])
  assert.equal(sourceProps(element).positionId, 'product'); assert.equal(sourceProps(element).compact, true)
  assert.equal(sourceProps(element).executionId,null)
  const picker = elements(element).find(row => row?.props?.id === 'air-session-position')
  picker.props.onChange('java')
  element = view.render('sidebar.right.pane.tab', 'session-one').element
  assert.equal(sourceProps(element).positionId, 'java')
  assert.equal(sourceProps(element).executionId,'task-one')
  elements(element).find(row => row?.type === 'button' && textOf(row) === '去工作台').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(view.navigated, ['ai-recruiter'])
  const main = view.render('main', '', []).element
  assert.equal(sourceProps(main).positionId, 'java')
  assert.match(textOf(main), /Java 工程师/)
  assert.equal(view.requests.length, 0, 'navigation cannot start another recruitment task')
})

test('drawer selects only the latest sourcing execution for its session and position',()=>{
  const own={...job,kind:'talent_sourcing',jobId:'java',createdAt:'2026-10-19T01:00:00Z',status:'completed'}
  const newer={...own,id:'own-new',createdAt:'2026-10-19T02:00:00Z'}
  const foreign={...newer,id:'foreign',sessionId:'another-session',createdAt:'2026-10-19T03:00:00Z',status:'running'}
  const global={...workbench,activeJobId:foreign.id,jobs:[foreign,{...newer,id:'workbench',source:'workbench'}]}
  const state={...session,latestPositionId:'java',jobs:[newer,own]}
  const view=fixture()
  const render=(snapshot=state,globalState=global)=>view.render('sidebar.right.pane.tab','session-one',[snapshot,undefined,'','','','',positions,globalState]).element
  const tree=render()
  assert.equal(sourceProps(tree).executionId,'own-new')
  assert.match(textOf(tree),/另一个招聘任务正在执行/)
  assert.equal(sourceProps(render({...state,jobs:[]})).executionId,null)
  const running={...newer,id:'just-started',status:'running',createdAt:'2026-10-19T04:00:00Z'}
  assert.equal(sourceProps(render(state,{...workbench,activeJobId:running.id,jobs:[running]})).executionId,'just-started','global polling may confirm the new session task before session polling')
})

test('finished login-required attempts allow a fresh start once browser execution is released', () => {
  const failed = { ...job, kind: 'talent_sourcing', jobId: 'java', status: 'failed', phase: 'finished', detail: '猎聘需要登录或验证，请在保留的页面中完成后，手动再次点击“开始寻聘”。' }
  const state = { ...session, latestPositionId: 'java', jobs: [failed], activeJobId: null }
  const view = fixture()
  const render = connection => view.render('sidebar.right.pane.tab', 'session-one', [state, undefined, '', '', '', '', positions, { ...workbench, jobs: [failed], connection }]).element
  assert.equal(sourceProps(render({ ...workbench.connection, activeWorkflow: true })).locked, true)
  const released = render({ ...workbench.connection, available: false, requiresBegin: true })
  assert.equal(sourceProps(released).locked, false, 'an expired workflow needs a new begin, not a permanent disabled button')
  assert.equal(sourceProps(released).executionId, failed.id, 'login does not rewrite or automatically resume a finished attempt')
  assert.equal(view.requests.length, 0)
})

test('drawer startup hides reconciliation until a response is lost and retries the same session/task identity', async () => {
  const view = fixture(); let rejectStart, starts = 0
  view.respond(async (_path, endpoint) => {
    if (endpoint.endsWith('/startSessionTask')) { starts++; if (starts === 1) return new Promise((_resolve, reject) => { rejectStart = reject }); return { id: 'accepted' } }
    if (endpoint.endsWith('/sessionTasks')) return { jobs: [], activeJobId: null }
    if (endpoint.endsWith('/state')) return workbench
    throw new Error(endpoint)
  })
  const initial = view.render('sidebar.right.pane.tab', 'session-one', [session, undefined, '', '', '', '', positions, workbench]).element
  sourceProps(initial).onStart({ jobId: 'product', platforms: ['liepin'], limit: 5, confirmed: true })
  let props = sourceProps(view.render('sidebar.right.pane.tab', 'session-one').element)
  assert.equal(props.busy, '启动任务'); assert.equal(props.pending, false); assert.equal(props.locked, true)
  assert.equal(props.executionId,null,'an unconfirmed start cannot fall back to historical execution results')
  props.onStart({ jobId: 'product' }); assert.equal(starts, 1)
  rejectStart(new Error('TIMEOUT')); await new Promise(resolve => setImmediate(resolve))
  props = sourceProps(view.render('sidebar.right.pane.tab', 'session-one').element)
  assert.equal(props.pending, true)
  props.onReconcile(); await new Promise(resolve => setImmediate(resolve))
  const requests = view.requests.filter(row => row[1].endsWith('/startSessionTask')).map(row => row[2].args.request)
  assert.equal(requests.length, 2); assert.equal(requests[0].sessionId, 'session-one'); assert.equal(requests[0].task.id, requests[1].task.id)
  assert.equal(sourceProps(view.render('sidebar.right.pane.tab', 'session-one').element).pending, false)
})
