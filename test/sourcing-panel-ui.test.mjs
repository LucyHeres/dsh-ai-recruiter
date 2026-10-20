import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
const require = createRequire(import.meta.url)
const source = buildSync({entryPoints:['src/client/features/sourcing-panel.tsx'],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},external:['react','react/*']}).outputFiles[0].text
const position = {id:'java',name:'Java 工程师',platforms:['liepin','boss'],city:'武汉',department:'研发',description:'具备 Java 项目经验'}
const person = (key,score) => ({key,name:key,platform:'liepin',profileUrl:'',scope:'online',collectedAt:'2026-10-17T10:00:00Z',coverage:30,fields:[{label:'公司',value:'示例公司'}],analysis:`完整分析-${key}`,resumeText:`已读原文-${key}`,score,assessments:[{criterionId:'java',state:'unknown',reason:'项目经历需要核实',quote:'Java'}]})
const people = [person('较早候选人',65),person('本轮候选人',70)]
const current = {id:'new',jobId:'java',status:'running',phase:'reading',createdAt:'2026-10-17T10:00:00Z',updatedAt:'latest',limit:10,candidateCount:1,detail:'Internal model progress',channels:[{platform:'liepin',status:'running',detail:'尚未开始'}],requirements:{criteria:[{id:'java',label:'新轮要求',must:true,quote:'新的要求',weight:100}]}}
const rounds = [{...current,number:2},{...current,id:'old',number:1,candidateCount:1}]
const summaries = people.map((person,i)=>({...person,roundId:i?'new':'old',roundNumber:i?2:1,roundCreatedAt:current.createdAt,resultKey:`${i?'new':'old'}:${person.key}`}))
const results = {jobId:'java',roundId:'all',rounds,current,candidates:summaries}
const details = (i) => ({jobId:'java',roundId:i?'new':'old',candidate:people[i],requirements:{criteria:[{id:'java',label:i?'新轮要求':'旧轮要求',must:true,quote:i?'新的要求':'旧的要求',weight:100}]}})
const indexes = {jobId:2,position:3,platforms:6,results:8,roundId:9,detailData:10,view:11,selectedKey:12,filter:13,detail:14,error:15,reload:16,loading:17,stopping:18,mobile:19,sort:20,detailLoading:21,autoGreet:22,expanded:23}
function fixture(overrides={}, locked=true, compact=false, options={}) {
  const states=[[],false,'java',position,false,'',['liepin'],10,results,'all',details(1),'results','',{score:'all',communication:'all',platform:'all'},'analysis','',0,false,false,false,'score-desc',false,undefined,true]
  Object.entries(overrides).forEach(([name,value])=>states[indexes[name]]=value)
  const refs=[],starts=[],requests=[];let index=0,refIndex=0,effects=[]
  const react={...require('react'),useState:initial=>{const i=index++;if(states[i]===undefined)states[i]=typeof initial==='function'?initial():initial;return [states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v}]},useRef:value=>{const i=refIndex++;return refs[i]??={current:value}},useEffect:(effect,deps)=>effects.push({effect,deps})}
  const module={exports:{}}
  runInNewContext(source,{module,exports:module.exports,require:name=>name==='react'?react:require(name),AbortController,setTimeout,clearTimeout})
  const render=()=>{index=0;refIndex=0;effects=[];return module.exports.SourcingPanel({compact,executionId:options.executionId,rpc:async(...args)=>{requests.push(args);return options.rpc ? options.rpc(...args) : details(1)},state:options.state??{activeJobId:'new',jobs:[{...current,kind:'talent_sourcing'}]},locked,pending:options.pending??false,busy:options.busy??'',onStart:request=>starts.push(request),onReconcile(){}})}
  return {render,states,starts,requests,effects:()=>effects,set:(name,value)=>states[indexes[name]]=value,get:name=>states[indexes[name]]}
}
function elements(element){if(Array.isArray(element))return element.flatMap(elements);if(element==null||typeof element==='boolean')return [];return typeof element==='object'?[element,...elements(element.props?.children)]:[element]}
const text=element=>elements(element).filter(item=>typeof item!=='object').join(' ')
const find=(tree,predicate)=>elements(tree).find(row=>row?.props&&predicate(row))
const button=(tree,label)=>find(tree,row=>row.type==='button'&&(text(row)===label||row.props['aria-label']===label))
const cards=tree=>elements(tree).filter(row=>row?.props?.className?.startsWith('air-sourcing-person '))

test('all rounds are the default, cards keep percentage scores, and no favorites controls remain',()=>{
 const view=fixture(),tree=view.render();assert.equal(view.get('roundId'),'all');assert.equal(cards(tree).length,2)
 assert.match(text(cards(tree)[0]),/70/);assert.match(text(cards(tree)[1]),/65/)
 assert.doesNotMatch(text(tree),/收藏|摘要初评/)
 assert.doesNotMatch(text(cards(tree)[0]),/待核实|完整分析/)
 assert.equal(find(tree,row=>row.props.id==='air-filter-round'),undefined)
 const progress=find(tree,row=>row.type==='progress');assert.equal(progress.props.value,1);assert.equal(progress.props.max,10)
})
test('platform settings and submitted tasks only include the selected job connected platforms',()=>{
 const view=fixture({view:'requirements',position:{...position,platforms:['liepin']},platforms:['liepin','boss']},false,false,{state:{jobs:[]}})
 const settings=()=>find(view.render(),row=>row.type==='fieldset')
 assert.match(text(settings()),/猎聘/);assert.doesNotMatch(text(settings()),/BOSS/)
 button(view.render(),'开始寻聘').props.onClick()
 assert.deepEqual(Array.from(view.starts[0].platforms),['liepin'])
 const none=fixture({view:'requirements',position:{...position,platforms:[]}},false,false,{state:{jobs:[]}})
 assert.doesNotMatch(text(find(none.render(),row=>row.type==='fieldset')),/猎聘|BOSS/)
 assert.equal(button(none.render(),'开始寻聘').props.disabled,true)
 assert.match(text(none.render()),/发布渠道信息尚未读取/)
})
test('switching a job platform association clears unavailable selections and defaults to its connected platform',()=>{
 const view=fixture({view:'requirements',position:{...position,platforms:['boss']},platforms:['liepin']},false,false,{state:{jobs:[]}})
 view.render()
 const platformEffect=view.effects().find(row=>row.deps?.length===3&&row.deps[0]==='java'&&row.deps[2]==='boss')
 platformEffect.effect()
 assert.deepEqual(Array.from(view.get('platforms')),['boss'])
 const fieldset=find(view.render(),row=>row.type==='fieldset')
 assert.doesNotMatch(text(fieldset),/猎聘/);assert.match(text(fieldset),/BOSS/)
 button(view.render(),'开始寻聘').props.onClick()
 assert.deepEqual(Array.from(view.starts[0].platforms),['boss'])
})
test('settings derive executable platforms from the current job and hide channels outside the five-site scope',()=>{
 const job={...position,platforms:['liepin','boss'],publishedChannels:[{id:'4',name:'猎聘'},{id:'34',name:'猎头'}]}
 const view=fixture({view:'requirements',position:job,platforms:['liepin','boss']},false,false,{state:{jobs:[]}})
 const fieldset=find(view.render(),row=>row.type==='fieldset')
 assert.match(text(fieldset),/猎聘/);assert.doesNotMatch(text(fieldset),/BOSS/)
 assert.match(text(find(view.render(),row=>row.props.className==='air-sourcing-published-platforms')),/已关联平台 猎聘/)
 assert.doesNotMatch(text(view.render()),/猎头/)
 button(view.render(),'开始寻聘').props.onClick();assert.deepEqual(Array.from(view.starts[0].platforms),['liepin'])
 const internal=fixture({view:'requirements',position:{...job,publishedChannels:[{id:'20',name:'内部推荐'},{id:'21',name:'招聘门户'},{id:'34',name:'猎头'}]}},false,false,{state:{jobs:[]}})
 assert.doesNotMatch(text(internal.render()),/内推|门户|猎头/)
 assert.match(text(internal.render()),/当前发布渠道暂不支持自动寻聘/)
 assert.doesNotMatch(text(internal.render()),/尚未对接可寻聘平台/)
 assert.equal(button(internal.render(),'开始寻聘').props.disabled,true)
})
test('new progress totals sum independent platform targets and keep per-channel counts visible',()=>{
 const run={...current,limit:5,limitScope:'per_platform',platforms:['liepin','boss'],channels:[{platform:'liepin',status:'completed',limit:5,candidateCount:5,detail:'完成'},{platform:'boss',status:'running',limit:5,candidateCount:1,detail:'搜索中'}],candidateCount:6}
 const view=fixture({results:{...results,current:run}}),tree=view.render()
 const progress=find(tree,row=>row.type==='progress')
 assert.equal(progress.props.max,10);assert.equal(progress.props.value,6)
 const channels=find(tree,row=>row.props.className==='air-sourcing-channel-status')
 assert.match(text(channels),/5 \/ 5/);assert.match(text(channels),/1 \/ 5/)
 const settings=fixture({view:'requirements'},false,false,{state:{jobs:[]}})
 assert.match(text(settings.render()),/每个平台目标人数/)
})
test('settings remains visible and readable while execution is locked, with duplicate starts disabled',()=>{
 const view=fixture();const tree=view.render();const settings=button(tree,'寻聘设置')
 assert.equal(settings.props.disabled,false);assert.equal(button(tree,'开始寻聘'),undefined);assert.equal(button(tree,'停止寻聘').props.disabled,false)
 settings.props.onClick();const opened=view.render();assert.equal(view.get('view'),'requirements')
 assert.ok(find(opened,row=>row.props.title==='寻聘设置'))
 assert.equal(button(opened,'开始寻聘'),undefined);assert.equal(button(opened,'停止寻聘').props.disabled,false)
 assert.match(text(opened),/具备 Java 项目经验/)
})
test('changing the round cannot flash the old list or details and reset returns to all rounds',()=>{
 const view=fixture();view.set('roundId','old')
 assert.equal(view.get('roundId'),'old');const loading=view.render();assert.equal(cards(loading).length,0)
 assert.equal(find(loading,row=>row.type==='article'),undefined)
 view.set('results',{...results,roundId:'old',candidates:[summaries[0]],current:{...current,id:'old'}});view.set('detailData',details(0))
 const tree=view.render();assert.equal(cards(tree).length,1);assert.match(text(tree),/旧轮要求/);assert.doesNotMatch(text(tree),/新轮要求/)
 button(tree,'重置').props.onClick();assert.equal(view.get('roundId'),'all')
})
test('same candidate identity in another round never receives the wrong resume or scoring criteria',()=>{
 const same={...summaries[0],key:people[1].key,resultKey:`old:${people[1].key}`}
 const view=fixture({results:{...results,candidates:[same]},selectedKey:same.resultKey})
 assert.equal(find(view.render(),row=>row.type==='article'),undefined)
 view.set('detailData',{...details(0),candidate:{...people[0],key:people[1].key}})
 assert.match(text(view.render()),/旧轮要求|已读原文/)
 assert.doesNotMatch(text(view.render()),/新轮要求/)
})
test('combination filters and preset sorting apply to candidates from all rounds',()=>{
 const view=fixture({results:{...results,candidates:[{...summaries[0],communication:'unknown'},{...summaries[1],communication:'recorded'}]}})
 const select=(id,value)=>find(view.render(),row=>row.props.id===id).props.onChange(value)
 select('air-candidate-sort','score-asc');assert.match(text(cards(view.render())[0]),/较早候选人/)
 select('air-filter-score','70');assert.equal(cards(view.render()).length,1)
 select('air-filter-platform','boss');assert.equal(cards(view.render()).length,0);assert.match(text(view.render()),/暂无符合筛选/)
 button(view.render(),'查看全部').props.onClick();assert.equal(cards(view.render()).length,2)
})
test('switching positions cannot display cached results and candidate navigation uses evaluation identity',()=>{
 const switched=fixture({jobId:'different'}).render();assert.equal(cards(switched).length,0);assert.equal(find(switched,row=>row.type==='article'),undefined)
 const view=fixture();button(view.render(),'下一位候选人').props.onClick();assert.equal(view.get('selectedKey'),summaries[0].resultKey);assert.equal(view.get('mobile'),true)
})

test('progress collapse preserves settings and the current task action; low scores never appear',()=>{
 const view=fixture({results:{...results,candidates:[...summaries,{...summaries[0],resultKey:'below',score:59}]}}),tree=view.render()
 assert.equal(cards(tree).length,2)
 find(tree,row=>row.props['aria-controls']==='air-hunt-progress-body').props.onClick()
 const collapsed=view.render();assert.equal(find(collapsed,row=>row.props.id==='air-hunt-progress-body'),undefined)
 assert.ok(button(collapsed,'寻聘设置'));assert.ok(button(collapsed,'停止寻聘'));assert.equal(button(collapsed,'开始寻聘'),undefined)
 assert.equal(cards(collapsed).length,2)
})

test('workbench greeting defaults on and an explicit opt-out is sent unchanged when starting',()=>{
 const view=fixture({view:'requirements'},false,false,{state:{jobs:[]}})
 const setting=find(view.render(),row=>row.props.className==='air-auto-greet')
 const checkbox=find(setting,row=>row.type==='input')
 assert.equal(checkbox.props.checked,true)
 checkbox.props.onChange({target:{checked:false}})
 button(view.render(),'开始寻聘').props.onClick()
 assert.equal(view.starts[0].autoGreet,false)
 const enabled=fixture({},false,false,{state:{jobs:[]}});button(enabled.render(),'开始寻聘').props.onClick()
 assert.equal(enabled.starts[0].autoGreet,true)
})

test('settings accept a minimum score and candidate lists retain results accepted under each execution threshold',()=>{
 const view=fixture({view:'requirements'},false,false,{state:{jobs:[]}})
 const input=()=>find(view.render(),row=>row.props.id==='air-sourcing-minimum-score')
 assert.equal(input().props.value,60)
 input().props.onChange({target:{value:'30'}});button(view.render(),'开始寻聘').props.onClick()
 assert.equal(view.starts[0].minimumScore,30)
 view.set('view','requirements');input().props.onChange({target:{value:''}})
 const settings=find(view.render(),row=>row.props.title==='寻聘设置')
 assert.equal(button(settings,'开始寻聘').props.disabled,true)
 input().props.onChange({target:{value:'0'}});button(view.render(),'开始寻聘').props.onClick();assert.equal(view.starts.at(-1).minimumScore,0)
 const result=fixture({results:{...results,candidates:[{...summaries[0],score:35,minimumScore:30},{...summaries[1],score:0,minimumScore:0}]}})
 assert.equal(cards(result.render()).length,2)
 find(result.render(),row=>row.props.id==='air-filter-score').props.onChange('30')
 assert.equal(cards(result.render()).length,1)
})

test('drawer defers resume detail reads until a candidate is opened, then preserves the return-to-list action',async()=>{
 const view=fixture({},true,true);let tree=view.render()
 const detailEffect=()=>view.effects().find(row=>row.deps?.length===7&&row.deps[1]==='java')
 detailEffect().effect();await new Promise(resolve=>setImmediate(resolve))
 assert.equal(view.requests.length,0)
 cards(tree)[0].props.onClick();tree=view.render()
 const cleanup=detailEffect().effect();await new Promise(resolve=>setImmediate(resolve))
 assert.equal(view.requests.length,1);assert.equal(view.requests[0][0],'sourcingCandidate')
 button(tree,'候选名单').props.onClick();assert.equal(view.get('mobile'),false)
 cleanup()
})

test('one primary action switches between start, stop, and stopping in both layouts',async()=>{
 for (const compact of [false,true]) {
  const options={state:{jobs:[]}},view=fixture({},false,compact,options)
  let tree=view.render()
  assert.equal(button(tree,'开始寻聘').props.disabled,false)
  assert.equal(button(tree,'停止寻聘'),undefined)
  button(tree,'开始寻聘').props.onClick();assert.equal(view.starts.length,1)
  for (const status of ['queued','running']) {
   options.state={activeJobId:'new',jobs:[{...current,kind:'talent_sourcing',status}]}
   tree=view.render();assert.equal(button(tree,'开始寻聘'),undefined)
   assert.equal(button(tree,'停止寻聘').props.disabled,false)
  }
  let release
  options.rpc=()=>new Promise(resolve=>{release=resolve})
  button(tree,'停止寻聘').props.onClick()
  tree=view.render();assert.equal(button(tree,'正在停止…').props.disabled,true)
  button(tree,'正在停止…').props.onClick()
  assert.equal(view.requests.length,1);assert.deepEqual(Array.from(view.requests[0].slice(0,2),value=>JSON.parse(JSON.stringify(value))),['stop',{id:'new'}])
  release({});await new Promise(resolve=>setImmediate(resolve))
  options.state.jobs[0].status='stopping';assert.equal(button(view.render(),'正在停止…').props.disabled,true)
  options.state.jobs[0].status='stopped';tree=view.render()
  assert.ok(button(tree,'开始寻聘'));assert.equal(button(tree,'停止寻聘'),undefined)
 }
})

test('other-position tasks and uncertain starts cannot be stopped or restarted from this position',()=>{
 for (const job of [{...current,jobId:'another',kind:'talent_sourcing'},{...current,kind:'greeting'}]) {
  const view=fixture({},true,false,{state:{activeJobId:'new',jobs:[job]}}),tree=view.render()
  assert.equal(button(tree,'停止寻聘'),undefined)
  assert.equal(button(tree,'开始寻聘').props.disabled,true)
  button(tree,'开始寻聘').props.onClick();assert.equal(view.starts.length,0);assert.equal(view.requests.length,0)
 }
 const pending=fixture({},false,false,{state:{jobs:[]},pending:true})
 assert.equal(button(pending.render(),'开始寻聘').props.disabled,true)
})

test('criterion summaries expose earned points and full points, including half-points and missing evidence',()=>{
 const criteria=[{id:'full',weight:60},{id:'half',weight:15},{id:'none',weight:15},{id:'unknown',weight:10}].map(row=>({...row,label:row.id,must:false}))
 const candidate={...people[1],score:68,assessments:criteria.map((row,i)=>({criterionId:row.id,state:['match','partial','mismatch','unknown'][i],quote:'Java',reason:'对应证据'}))}
 const view=fixture({detailData:{...details(1),candidate,requirements:{criteria}}}),tree=view.render()
 const rows=elements(tree).filter(row=>row?.props?.className==='air-sourcing-assessment')
 assert.equal(rows.length,4)
 for (const [i,label] of ['本项得分 60，满分 60 分','本项得分 7.5，满分 15 分','本项得分 0，满分 15 分','本项得分 0，满分 10 分'].entries()) {
  const summary=find(rows[i],row=>row.type==='summary')
  assert.ok(find(summary,row=>row.props['aria-label']===label))
 }
 assert.match(text(rows[1]),/部分符合按一半计分/)
 assert.match(text(find(rows[3],row=>row.type==='summary')),/未计分/)
 view.set('detailData',{...details(1),candidate,requirements:undefined})
 assert.match(text(view.render()),/分值未保存/)
 assert.equal(find(view.render(),row=>row.props['aria-label']?.startsWith('本项得分')),undefined)
})

test('conversation results stay pinned to one execution through filters, refreshes, and execution changes',async()=>{
 const options={executionId:'new',rpc:async()=>({...results,roundId:'new'})}
 const view=fixture({},true,true,options)
 assert.equal(cards(view.render()).length,0,'cached all-round results must not flash in the drawer')
 const poll=()=>view.effects().find(row=>row.deps?.length===4&&row.deps[0]==='java'&&row.deps[1]===options.executionId)
 const cleanup=poll().effect()
 try {
  await new Promise(resolve=>setImmediate(resolve))
  let tree=view.render()
  assert.equal(view.requests[0][1].roundId,'new')
  assert.equal(cards(tree).length,1);assert.match(text(cards(tree)[0]),/本轮候选人/)
  assert.doesNotMatch(text(tree),/较早候选人|查看全部轮次/)
  find(tree,row=>row.props.id==='air-filter-score').props.onChange('90')
  tree=view.render();assert.equal(cards(tree).length,0)
  button(tree,'查看全部').props.onClick()
  tree=view.render();assert.equal(cards(tree).length,1)
  assert.equal(button(tree,'重置'),undefined,'execution scope is not a removable filter')
  button(tree,'刷新结果').props.onClick();view.render()
  const refreshCleanup=poll().effect()
  try {await new Promise(resolve=>setImmediate(resolve));assert.equal(view.requests.at(-1)[1].roundId,'new')}
  finally {refreshCleanup()}
  options.executionId='next';view.set('mobile',true)
  tree=view.render();assert.equal(cards(tree).length,0);assert.equal(find(tree,row=>row.type==='article'),undefined)
  assert.doesNotMatch(text(tree),/较早候选人|本轮候选人|查看全部轮次/)
  options.executionId=null;view.render()
  const before=view.requests.length;poll().effect();assert.equal(view.requests.length,before)
  assert.equal(cards(view.render()).length,0)
 } finally {cleanup()}
})
