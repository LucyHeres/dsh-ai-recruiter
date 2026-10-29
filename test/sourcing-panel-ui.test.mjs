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
const indexes = {jobId:2,position:3,positionLoading:4,supplement:5,platforms:6,limit:7,results:8,roundId:9,detailData:10,view:11,selectedKey:12,filter:13,detail:14,error:15,reload:16,loading:17,stopping:18,mobile:19,sort:20,detailLoading:21,expanded:22,minimumScore:23,syncing:24,communicationNotice:25,jobDescription:28}
function fixture(overrides={}, locked=true, compact=false, options={}) {
  const states=[[],false,'java',position,false,'',['liepin'],10,results,'all',details(1),'results','',{score:'all',communication:'all',platform:'all'},'analysis','',0,false,false,false,'score-desc',false,true]
  Object.entries(overrides).forEach(([name,value])=>states[indexes[name]]=value)
  const refs=[],starts=[],requests=[];let index=0,refIndex=0,effects=[]
  const react={...require('react'),useState:initial=>{const i=index++;if(states[i]===undefined)states[i]=typeof initial==='function'?initial():initial;return [states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v}]},useRef:value=>{const i=refIndex++;return refs[i]??={current:value}},useEffect:(effect,deps)=>effects.push({effect,deps})}
  const module={exports:{}}
  runInNewContext(source,{module,exports:module.exports,require:name=>name==='react'?react:require(name),AbortController,setTimeout:options.setTimeout??setTimeout,clearTimeout:options.clearTimeout??clearTimeout,crypto:require('node:crypto').webcrypto})
  const render=()=>{index=0;refIndex=0;effects=[];return module.exports.SourcingPanel({compact,positionId:options.positionId,executionId:options.executionId,onRequireExtension:options.onRequireExtension,rpc:async(...args)=>{requests.push(args);return options.rpc ? options.rpc(...args) : details(1)},state:options.state??{activeJobId:'new',jobs:[{...current,kind:'talent_sourcing'}]},locked,pending:options.pending??false,busy:options.busy??'',onStart:request=>starts.push(request),onReconcile(){}})}
  return {render,states,starts,requests,effects:()=>effects,set:(name,value)=>states[indexes[name]]=value,get:name=>states[indexes[name]]}
}
function elements(element){if(Array.isArray(element))return element.flatMap(elements);if(element==null||typeof element==='boolean')return [];return typeof element==='object'?[element,...elements(element.props?.children)]:[element]}
const text=element=>elements(element).filter(item=>typeof item!=='object').join(' ')
const find=(tree,predicate)=>elements(tree).find(row=>row?.props&&predicate(row))
const button=(tree,label)=>find(tree,row=>row.type==='button'&&(text(row)===label||row.props['aria-label']===label))
const cards=tree=>elements(tree).filter(row=>row?.props?.className?.startsWith('air-sourcing-person '))

test('sync opens setup without making a request when the extension is missing or outdated',async()=>{
 for(const status of ['not_installed','outdated']){
 let prompts=0
 const view=fixture({},false,false,{state:{jobs:[],extensionInstallation:{status}},onRequireExtension:()=>prompts++})
 button(view.render(),'同步平台简历').props.onClick();await new Promise(resolve=>setImmediate(resolve))
 assert.equal(prompts,1);assert.equal(view.requests.length,0);assert.equal(view.get('syncing'),false)
 }
})

test('both sourcing buttons explain missing installation before validating settings in either layout',()=>{
 for(const status of ['not_installed','outdated'])for(const compact of [false,true])for(const settings of [false,true]){
  let prompts=0
  const view=fixture({view:settings?'requirements':'results',platforms:[],limit:0},false,compact,{
   state:{jobs:[],extensionInstallation:{status}},onRequireExtension:()=>prompts++})
  const tree=view.render(),scope=settings?find(tree,row=>row.props.title==='寻聘设置'):tree
  const start=button(scope,'开始寻聘')
  assert.equal(start.props.disabled,false,'installation guidance must be reachable even with unfinished settings')
  start.props.onClick()
  assert.equal(prompts,1);assert.equal(view.starts.length,0);assert.equal(view.requests.length,0)
  assert.equal(view.get('view'),settings?'requirements':'results','the missing-extension prompt comes before configuration navigation')
 }
})

test('edits restore per position after leaving the panel without starting a task',async()=>{
 const {Store}=await import('../dist/lib/store.js')
 const {Workbench}=await import('../dist/lib/workbench.js')
 const {mkdtemp,rm}=await import('node:fs/promises')
 const {tmpdir}=await import('node:os');const {join}=await import('node:path')
 const directory=await mkdtemp(join(tmpdir(),'sourcing-settings-ui-'))
 try {
  const store=new Store(directory,'company');await store.init()
  await store.put('sourcing-previous',{id:'previous',kind:'talent_sourcing',jobId:'java',createdAt:'2026-10-23',
   limit:2,minimumScore:6,platforms:['boss'],supplement:'软件销售经验优先',autoGreet:false,candidates:[],results:[]})
  const service=Object.create(Workbench.prototype);service.store=store
  service.sourcing={loadPosition:async id=>({...position,id,name:id,description:'当前职位最新描述'})}
  await service.saveSourcingSettings({jobId:'sales',settings:{limit:4,minimumScore:80,supplement:'销售职位要求',autoGreet:true,platforms:['liepin']}})
  const pending=[]
  const options={state:{jobs:[]},rpc:(method,request,signal)=>{
   assert.ok(['sourcingPosition','saveSourcingSettings'].includes(method),'editing settings cannot start recruitment')
   const task=service[method](request,signal);pending.push(task);return task
  }}
  const drain=async()=>{await Promise.all(pending.splice(0));await new Promise(resolve=>setImmediate(resolve))}
  const load=async view=>{
   view.render()
   const effect=view.effects().find(row=>row.deps?.length===3&&row.deps[0]===view.get('jobId')&&typeof row.deps[1]==='function')
   effect.effect();await drain();view.render()
  }
  const view=fixture({view:'requirements'},false,false,options)
  await load(view)
  assert.equal(view.get('limit'),2);assert.equal(view.get('minimumScore'),6)
  assert.equal(find(view.render(),row=>row.props.id==='air-sourcing-auto-greet'),undefined);assert.equal(view.get('supplement'),'软件销售经验优先')
  button(view.render(),'开始寻聘').props.onClick();assert.equal(view.starts.at(-1).autoGreet,true)
  view.starts.length=0;view.set('view','requirements')
  assert.deepEqual(Array.from(view.get('platforms')),['boss'])
  const input=(id,value)=>find(view.render(),row=>row.props.id===id).props.onChange({target:{value}})
  input('air-sourcing-limit','7');input('air-sourcing-minimum-score','0');input('air-sourcing-supplement','')
  input('air-sourcing-job-description','负责新的 Java 核心模块\n熟悉 SQL')
  find(find(view.render(),row=>row.type==='fieldset'),row=>row.type==='input'&&row.props.checked).props.onChange({target:{checked:false}})
  await drain();assert.equal(view.starts.length,0)
  const remounted=fixture({view:'requirements',position:undefined},false,true,options)
  await load(remounted)
  assert.equal(remounted.get('limit'),7);assert.equal(remounted.get('minimumScore'),0)
  assert.equal(remounted.get('supplement'),'')
  assert.equal(find(remounted.render(),row=>row.props.id==='air-sourcing-job-description').props.value,'负责新的 Java 核心模块\n熟悉 SQL')
  assert.deepEqual(Array.from(remounted.get('platforms')),[],'an intentionally empty platform selection survives re-entry')
  const switchTo=async id=>{
   options.positionId=id;remounted.render()
   remounted.effects().find(row=>row.deps?.length===1&&row.deps[0]===id).effect()
   remounted.set('view','requirements');await load(remounted)
  }
  await switchTo('sales')
  assert.equal(remounted.get('limit'),4);assert.equal(remounted.get('minimumScore'),80)
  assert.equal(remounted.get('supplement'),'销售职位要求');assert.deepEqual(Array.from(remounted.get('platforms')),['liepin'])
  assert.equal(find(remounted.render(),row=>row.props.id==='air-sourcing-job-description').props.value,'当前职位最新描述')
  await switchTo('java')
  assert.equal(remounted.get('limit'),7);assert.equal(remounted.get('minimumScore'),0)
  assert.equal(find(remounted.render(),row=>row.props.id==='air-sourcing-job-description').props.value,'负责新的 Java 核心模块\n熟悉 SQL')
  const platformEffect=remounted.effects().find(row=>row.deps?.length===3&&row.deps[0]==='java'&&row.deps[1]==='java')
  platformEffect.effect();assert.deepEqual(Array.from(remounted.get('platforms')),[])
  const settingsPane=find(remounted.render(),row=>row.props.title==='寻聘设置')
  assert.equal(button(settingsPane,'开始寻聘').props.disabled,true,'a saved empty selection must not silently enable all platforms')
  assert.equal((await store.list('sourcing-')).length,1)
 } finally {await rm(directory,{recursive:true,force:true})}
})

test('transient invalid numbers do not overwrite settings and persistence failures are visible',async()=>{
 const view=fixture({view:'requirements'},false,false,{state:{jobs:[]},rpc:async()=>{throw new Error('磁盘不可写')}})
 const change=value=>find(view.render(),row=>row.props.id==='air-sourcing-minimum-score').props.onChange({target:{value}})
 change('');change('6.5');change('101');assert.equal(view.requests.length,0)
 change('0');await new Promise(resolve=>setImmediate(resolve))
 assert.equal(view.requests.length,1);assert.equal(view.requests[0][0],'saveSourcingSettings')
 assert.equal(view.requests[0][1].settings.minimumScore,0)
 assert.match(text(view.render()),/寻聘设置保存失败.*磁盘不可写/)
 const loading=fixture({view:'requirements',positionLoading:true},false,false,{state:{jobs:[]}}).render()
 for(const id of ['air-sourcing-limit','air-sourcing-minimum-score','air-sourcing-supplement','air-sourcing-job-description'])assert.equal(find(loading,row=>row.props.id===id).props.disabled,true)
 assert.equal(find(loading,row=>row.props.id==='air-sourcing-auto-greet'),undefined)
})

test('editable job descriptions are saved and submitted without changing the read-only fixed conditions',()=>{
 const view=fixture({view:'requirements'},false,false,{state:{jobs:[]}})
 const description=()=>find(view.render(),row=>row.props.id==='air-sourcing-job-description')
 const basic=find(view.render(),row=>row.props.id==='air-sourcing-basic-requirements')
 assert.equal(description().props.disabled,false);assert.notEqual(description().props.readOnly,true)
 assert.equal(basic.props.disabled,true);assert.equal(basic.props.readOnly,true)
 description().props.onChange({target:{value:'负责数据平台开发\n熟悉 SQL'}})
 assert.equal(description().props.value,'负责数据平台开发\n熟悉 SQL')
 assert.equal(view.requests[0][1].settings.jobDescription,'负责数据平台开发\n熟悉 SQL')
 button(view.render(),'开始寻聘').props.onClick()
 assert.equal(view.starts[0].jobDescription,'负责数据平台开发\n熟悉 SQL')
 view.set('view','requirements');description().props.onChange({target:{value:''}})
 assert.equal(description().props.value,'','clearing the JD cannot restore the source description')
 button(view.render(),'开始寻聘').props.onClick()
 assert.equal(view.starts[1].jobDescription,'','fixed conditions still permit sourcing with an explicitly empty JD')
 const locked=fixture({view:'requirements'}).render()
 assert.equal(find(locked,row=>row.props.id==='air-sourcing-job-description').props.disabled,true)
})

test('a late position-settings response cannot replace the next selected position',async()=>{
 let finish
 const options={state:{jobs:[]},positionId:'java',rpc:async(method,{jobId})=>jobId==='java'?new Promise(resolve=>{finish=resolve}):{...position,id:jobId,settings:{limit:4,minimumScore:80,supplement:'另一个职位',autoGreet:false,platforms:['boss']}}}
 const view=fixture({view:'requirements'},false,false,options)
 view.render();const old=view.effects().find(row=>row.deps?.length===3&&typeof row.deps[1]==='function').effect()
 options.positionId='sales';view.render();view.effects().find(row=>row.deps?.length===1&&row.deps[0]==='sales').effect()
 old();view.render();view.effects().find(row=>row.deps?.length===3&&typeof row.deps[1]==='function').effect()
 await new Promise(resolve=>setImmediate(resolve))
 finish({...position,settings:{limit:50,minimumScore:0,supplement:'旧职位',autoGreet:true}})
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(view.get('jobId'),'sales');assert.equal(view.get('position').id,'sales')
 assert.equal(view.get('limit'),4);assert.equal(view.get('minimumScore'),80)
 button(view.render(),'开始寻聘').props.onClick();assert.equal(view.starts.at(-1).autoGreet,true)
 assert.equal(view.get('supplement'),'另一个职位')
})

test('all rounds are the default, cards keep percentage scores, and no favorites controls remain',()=>{
 const view=fixture(),tree=view.render();assert.equal(view.get('roundId'),'all');assert.equal(cards(tree).length,2)
 assert.match(text(cards(tree)[0]),/70/);assert.match(text(cards(tree)[1]),/65/)
 assert.doesNotMatch(text(tree),/收藏|摘要初评/)
 assert.doesNotMatch(text(cards(tree)[0]),/待核实|完整分析/)
 const roundFilter=find(tree,row=>row.props.id==='air-filter-round');assert.ok(roundFilter);assert.equal(roundFilter.props.label,'寻聘轮次');assert.ok(roundFilter.props.options.slice(1).every(option=>/2026/.test(option.label)&&!/[第轮]/.test(option.label)))
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
 assert.equal(find(fieldset,row=>row.props.className?.includes('air-platform-tag')),undefined,'platform choices use plain text')
 assert.equal(find(view.render(),row=>row.props.className==='air-sourcing-published-platforms'),undefined,'connected platforms are shown once in the selection field')
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
 assert.match(text(settings.render()),/目标打招呼人数/)
})
test('settings remains visible and readable while execution is locked, with duplicate starts disabled',()=>{
 const view=fixture();const tree=view.render();const settings=button(tree,'寻聘设置')
 assert.equal(settings.props.disabled,false);assert.equal(button(tree,'开始寻聘'),undefined);assert.equal(button(tree,'停止寻聘').props.disabled,false)
 settings.props.onClick();const opened=view.render();assert.equal(view.get('view'),'requirements')
 assert.ok(find(opened,row=>row.props.title==='寻聘设置'))
 assert.equal(button(opened,'开始寻聘'),undefined);assert.equal(button(opened,'停止寻聘').props.disabled,false)
 assert.equal(find(opened,row=>row.props.id==='air-sourcing-job-description').props.value,'具备 Java 项目经验')
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
test('talent search matches visible profile data, composes with filters and sorting, and can be cleared',()=>{
 const candidates=[
  {...summaries[0],name:'张三',fields:[{label:'公司',value:'星河科技'}],listProfile:{work:[{organization:'星河科技',description:'Java 开发'}],education:[{organization:'武汉大学'}]}},
  {...summaries[1],name:'李四',fields:[{label:'公司',value:'星河科技'}],listProfile:{expectation:{city:'武汉',role:'Java 工程师'},work:[],education:[]}},
 ]
 const view=fixture({results:{...results,candidates}})
 const search=value=>find(view.render(),row=>row.props['aria-label']==='搜索人才').props.onChange({target:{value}})
 for(const [query,names] of [['张三',['张三']],['武汉大学',['张三']],['星河 ＪＡＶＡ',['李四','张三']],['  武汉  工程师  ',['李四']],['   ',['李四','张三']]]){
  search(query);assert.deepEqual(cards(view.render()).map(card=>text(card).match(/张三|李四/)[0]),names)
 }
 search('星河 java')
 find(view.render(),row=>row.props.id==='air-candidate-sort').props.onChange('score-asc')
 assert.match(text(cards(view.render())[0]),/张三/)
 find(view.render(),row=>row.props.id==='air-filter-score').props.onChange('70')
 assert.equal(cards(view.render()).length,1);assert.match(text(cards(view.render())[0]),/李四/)
 search('武汉大学');assert.equal(cards(view.render()).length,0);assert.match(text(view.render()),/暂无符合搜索条件/)
 button(view.render(),'清空搜索').props.onClick();assert.equal(cards(view.render()).length,1,'clear keeps the score filter')
 search('不存在');button(view.render(),'查看全部').props.onClick();assert.equal(cards(view.render()).length,2)
 search('张三');find(view.render(),row=>row.props['aria-label']==='搜索人才').props.onKeyDown({key:'Escape',stopPropagation(){}})
 assert.equal(cards(view.render()).length,2)
})
test('communication has only greeted/not-greeted and receipt filtering stays independent',()=>{
 const view=fixture({results:{...results,candidates:[{...summaries[0],communication:'uncertain',resumeReceived:true},{...summaries[1],communication:'recorded',resumeReceived:false}]}})
 const filter=(id,value)=>find(view.render(),row=>row.props.id===id).props.onChange(value)
 const communication=find(view.render(),row=>row.props.id==='air-filter-communication')
 assert.deepEqual(Array.from(communication.props.options,row=>row.label),['不限','已打招呼','未打招呼'])
 assert.doesNotMatch(text(view.render()),/招呼结果待确认|招呼待确认|无招呼记录/)
 filter('air-filter-resume-received','received');assert.equal(cards(view.render()).length,1)
 assert.ok(find(cards(view.render())[0],row=>row.props['aria-label']==='未打招呼'))
 assert.ok(find(cards(view.render())[0],row=>row.props['aria-label']==='获取简历已完成'))
 filter('air-filter-communication','recorded');assert.equal(cards(view.render()).length,0)
 button(view.render(),'查看全部').props.onClick();assert.equal(cards(view.render()).length,2)
 filter('air-filter-resume-received','not_received')
 assert.ok(find(cards(view.render())[0],row=>row.props['aria-label']==='打招呼已完成'))
 assert.ok(find(cards(view.render())[0],row=>row.props['aria-label']==='未获取简历'))
})
test('resume progress uses observed independent states and only a successful attachment import lights the last node',()=>{
 const cases=[
  [{},[false,false,false]],
  [{communication:'recorded'},[true,false,false]],
  [{resumeReceived:true},[false,true,false]],
  [{communication:'recorded',resumeReceived:true,resumeAttachments:[{id:'pending',fileName:'resume.pdf'}]},[true,true,false]],
  [{resumeAttachments:[{id:'failed',fileName:'resume.pdf',uploadError:'提交失败'}]},[false,true,false]],
  [{resumeAttachments:[{id:'stopped',fileName:'resume.pdf',uploadStopped:true}]},[false,true,false]],
  [{resumeAttachments:[{id:'pending',fileName:'first.pdf'},{id:'saved',fileName:'saved.pdf',uploadedAt:'2026-10-29T08:00:00Z'}]},[false,true,true]],
 ]
 for(const [state,expected] of cases){
  const person={...summaries[1],...state}
  const view=fixture({results:{...results,candidates:[person]},detailData:{...details(1),candidate:{...people[1],...state}}})
  const tree=view.render()
  for(const scope of [cards(tree)[0],find(tree,row=>row.type==='article')]){
   const flow=find(scope,row=>row.props.className==='air-resume-progress')
   const steps=elements(flow).filter(row=>row?.type==='li')
   assert.deepEqual(steps.map(step=>step.props.className.includes('is-complete')),expected)
   assert.equal(steps.filter(step=>step.props.className.includes('is-connected')).length,expected.slice(1).filter((done,i)=>done&&expected[i]).length)
   assert.equal(elements(flow).filter(row=>row?.type==='button').length,0,'status nodes cannot trigger a download or import')
  }
  const download=button(cards(tree)[0],'下载')
  assert.equal(!!download,!!state.resumeAttachments?.length)
  if(download)assert.match(download.props['aria-label'],new RegExp(person.resumeAttachments[0].fileName.replace('.', '\\.')))
 }
})
test('candidate cards put identity, platform, progress and score together above basic facts and bounded history summaries',()=>{
 const profile={age:'29 岁',expectation:{city:'武汉',role:'Java'},work:[{organization:'东风物流集团',description:'软件开发工程师',period:'2025.04-至今'},{organization:'江苏国光信息产业股份有限公司',description:'开发工程师',period:'2024.01-2025.04'}],education:[{organization:'华中师范大学',description:'软件工程 / 硕士 / 统招',period:'2019.09-2022.07'}]}
 const candidate={...summaries[1],listProfile:profile,fields:[{label:'城市',value:'北京'},{label:'工作经验',value:'工作 4 年'},{label:'学历',value:'硕士'},{label:'当前职位',value:'软件开发工程师'},{label:'期望薪资',value:'16-17K'}]}
 const card=cards(fixture({results:{...results,candidates:[candidate]}}).render())[0]
 const heading=find(card,row=>row.props.className==='air-sourcing-person-heading')
 assert.match(text(heading),/本轮候选人.*猎聘.*打招呼.*获取简历.*简历入库.*70/)
 assert.doesNotMatch(text(heading),/东风物流|29岁|北京/)
 const basics=find(card,row=>row.props['aria-label']==='基础信息')
 assert.match(text(basics),/29岁.*4年.*硕士.*期望：.*武汉 · Java/)
 assert.doesNotMatch(text(basics),/29 岁|工作|北京|软件开发工程师|16-17K/)
 const work=find(card,row=>row.props['aria-label']==='工作经历'),education=find(card,row=>row.props['aria-label']==='教育经历')
 assert.match(text(work),/东风物流集团.*软件开发工程师.*2025.04-至今.*江苏国光/)
 assert.match(text(education),/华中师范大学.*软件工程 \/ 硕士 \/ 统招.*2019.09-2022.07/)
 const empty=cards(fixture().render())[0]
 assert.match(text(empty),/未展示\s*工作经历.*未展示\s*教育经历/)
})
test('narrow desktop panes retain the split interaction while only the compact drawer moves focus into detail',()=>{
 for(const compact of [false,true]){
  let focused=0,scrolled=0
  const view=fixture({mobile:true},true,compact),tree=view.render()
  const article=find(tree,row=>row.type==='article')
  article.ref.current={closest:()=>({clientWidth:700}),focus:()=>focused++,scrollIntoView:()=>scrolled++}
  view.effects().find(row=>row.deps?.length===2&&row.deps[0]===summaries[1].resultKey&&row.deps[1]===true).effect()
  assert.equal(focused,compact?1:0)
  assert.equal(scrolled,compact?1:0)
  assert.equal(view.get('mobile'),true,'viewport width cannot clear the selected candidate')
 }
})
test('the workbench exposes a keyboard-accessible drag separator and the conversation drawer does not',()=>{
 const desktop=fixture().render(),separator=find(desktop,row=>row.props.role==='separator')
 assert.equal(separator.props['aria-orientation'],'vertical')
 assert.equal(separator.props.tabIndex,0)
 assert.equal(find(fixture({},true,true).render(),row=>row.props.role==='separator'),undefined)
})
test('sync reads the selected position, disables reentry and refreshes result/detail data',async()=>{
 let finish
 const view=fixture({},false,false,{rpc:()=>new Promise(resolve=>{finish=resolve})})
 const sync=button(view.render(),'同步平台简历');assert.equal(sync.props.disabled,false)
 sync.props.onClick();sync.props.onClick();assert.equal(view.requests.length,1)
 assert.equal(view.requests[0][0],'syncCommunication');assert.equal(view.requests[0][1].jobId,'java')
 assert.equal(view.requests[0][1].roundId,'all')
 assert.equal(button(view.render(),'正在同步…').props.disabled,true)
 finish({checked:2,matched:1,updated:1,platforms:[{platform:'liepin',matched:1,detail:'已同步'}]})
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(view.get('syncing'),false);assert.equal(view.get('reload'),1)
 assert.match(text(view.render()),/本次核对 2 位候选人，匹配 1 人，更新 1 人/)
 assert.equal(button(fixture().render(),'同步平台简历').props.disabled,true,'browser task lock also protects the sync action')
})
test('failed/aborted sync preserves received data and changing position aborts obsolete requests',async()=>{
 const received={...results,candidates:summaries.map(row=>({...row,resumeReceived:true}))}
 const failed=fixture({results:received},false,false,{rpc:async()=>{throw new Error('请先登录平台')}})
 button(failed.render(),'同步平台简历').props.onClick();await new Promise(resolve=>setImmediate(resolve))
 assert.match(text(failed.render()),/请先登录平台/);assert.equal(failed.get('syncing'),false)
 assert.equal(find(failed.render(),row=>row.props.className==='air-feedback-toast is-error').props.role,'alert')
 assert.equal(failed.get('error'),'','sync failure also uses a transient toast')
 assert.ok(cards(failed.render()).every(row=>find(row,item=>item.props['aria-label']==='获取简历已完成')))
 let finish
 const view=fixture({},false,false,{rpc:()=>new Promise(resolve=>{finish=resolve})})
 view.render();const cleanup=view.effects().find(row=>row.deps?.length===1&&row.deps[0]==='java').effect()
 button(view.render(),'同步平台简历').props.onClick();const requestSignal=view.requests[0][2]
 cleanup();assert.equal(requestSignal.aborted,true)
 view.set('jobId','another');view.render();view.effects().find(row=>row.deps?.length===1&&row.deps[0]==='another').effect()
 finish({checked:2,matched:1,updated:1,platforms:[]});await new Promise(resolve=>setImmediate(resolve))
 assert.equal(view.get('syncing'),false);assert.equal(view.get('communicationNotice'),undefined);assert.equal(view.get('reload'),0)
})
test('an incomplete platform sync shows a warning instead of a successful no-op summary',async()=>{
 const view=fixture({},false,false,{rpc:async()=>({checked:2,matched:0,updated:0,platforms:[{platform:'boss',matched:0,status:'partial',scanned:21,unidentified:2,detail:'历史候选人的身份信息不完整'}]})})
 button(view.render(),'同步平台简历').props.onClick();await new Promise(resolve=>setImmediate(resolve))
 const toast=feedbackToast(view.render());assert.equal(toast.props.role,'alert')
 assert.match(text(toast),/同步尚未完成/);assert.match(text(toast),/已读取 21 条平台记录/)
 assert.doesNotMatch(text(toast),/本次核对 2 位候选人/)
 assert.equal(view.get('reload'),1)
})
test('sync passes the displayed round and reports legacy skips separately from execution errors',async()=>{
 const view=fixture({roundId:'chosen-round'},false,false,{rpc:async()=>({checked:5,matched:1,updated:0,platforms:[{platform:'liepin',matched:1,status:'completed',scanned:100,unidentified:3,detail:'已跳过 3 条缺少平台 ID 的历史记录'}]})})
 button(view.render(),'同步平台简历').props.onClick();await new Promise(resolve=>setImmediate(resolve))
 assert.equal(view.requests[0][1].roundId,'chosen-round')
 const toast=feedbackToast(view.render());assert.equal(toast.props.role,'status')
 assert.match(text(toast),/可关联记录同步完成.*核对 2 位候选人.*另跳过 3 条/)
 assert.doesNotMatch(text(toast),/同步尚未完成/)
})
function noticeClock(){
 let now=0,sequence=0;const timers=new Map()
 return {setTimeout(callback,delay){const id=++sequence;timers.set(id,{at:now+delay,callback});return id},clearTimeout(id){timers.delete(id)},advance(ms){now+=ms;for(const[id,timer]of timers)if(timer.at<=now){timers.delete(id);timer.callback()}},pending:()=>timers.size}
}
const feedbackToast=tree=>find(tree,row=>row.props.className?.startsWith('air-feedback-toast'))
function mountNoticeTimer(view){view.render();return view.effects().find(row=>row.deps?.length===1&&row.deps[0]===view.get('communicationNotice')).effect()}
test('sync shows a result toast only after completion and removes it after exactly six seconds',async()=>{
 let finish;const clock=noticeClock()
 const view=fixture({},false,false,{...clock,rpc:()=>new Promise(resolve=>{finish=resolve})})
 button(view.render(),'同步平台简历').props.onClick()
 assert.equal(feedbackToast(view.render()),undefined)
 finish({checked:2,matched:1,updated:1,platforms:[]});await new Promise(resolve=>setImmediate(resolve))
 const toast=feedbackToast(view.render());assert.equal(toast.props.role,'status');assert.match(text(toast),/本次核对 2 位候选人/)
 assert.equal(find(view.render(),row=>row.props.className==='air-talent-feedback'),undefined,'finished results do not occupy the toolbar')
 mountNoticeTimer(view);clock.advance(5999);assert.ok(feedbackToast(view.render()))
 clock.advance(1);assert.equal(feedbackToast(view.render()),undefined);assert.equal(clock.pending(),0)
})
test('identical sync results receive a fresh six-second lifetime and cleanup cancels the timer',async()=>{
 const clock=noticeClock(),result={checked:2,matched:1,updated:1,platforms:[]}
 const view=fixture({},false,false,{...clock,rpc:async()=>result})
 button(view.render(),'同步平台简历').props.onClick();await new Promise(resolve=>setImmediate(resolve))
 const first=view.get('communicationNotice'),cleanup=mountNoticeTimer(view)
 clock.advance(5000)
 button(view.render(),'同步平台简历').props.onClick();await new Promise(resolve=>setImmediate(resolve))
 assert.notEqual(view.get('communicationNotice'),first)
 cleanup();mountNoticeTimer(view);clock.advance(5999);assert.ok(feedbackToast(view.render()))
 clock.advance(1);assert.equal(feedbackToast(view.render()),undefined)
 button(view.render(),'同步平台简历').props.onClick();await new Promise(resolve=>setImmediate(resolve))
 const onUnmount=mountNoticeTimer(view),notice=view.get('communicationNotice')
 onUnmount();assert.equal(clock.pending(),0);clock.advance(6000);assert.equal(view.get('communicationNotice'),notice,'an unmounted component is not updated')
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

test('workbench always enables greetings and settings expose the greeting target without a switch in both layouts',()=>{
 for(const compact of [false,true]){
  const view=fixture({view:'requirements'},false,compact,{state:{jobs:[]}})
  const tree=view.render()
  assert.equal(find(tree,row=>row.props.role==='switch'),undefined)
  assert.equal(find(tree,row=>row.props.htmlFor==='air-sourcing-limit').props.children,'目标打招呼人数')
  assert.match(text(find(tree,row=>row.props.id==='air-sourcing-limit-help')),/每个平台分别计算/)
  button(tree,'开始寻聘').props.onClick()
  assert.equal(view.starts[0].autoGreet,true)
 }
 const enabled=fixture({},false,false,{state:{jobs:[]}});button(enabled.render(),'开始寻聘').props.onClick()
 assert.equal(enabled.starts[0].autoGreet,true)
})

test('per-platform targets accept 100 in both layouts and reject values outside 1 to 100',()=>{
 for(const compact of [false,true]){
  const view=fixture({view:'requirements'},false,compact,{state:{jobs:[]}})
  const input=()=>find(view.render(),row=>row.props.id==='air-sourcing-limit')
  assert.equal(input().props.min,1);assert.equal(input().props.max,100)
  for(const limit of [1,51,100]){
   input().props.onChange({target:{value:String(limit)}})
   assert.equal(input().props['aria-invalid'],false)
   assert.equal(view.requests.at(-1)[1].settings.limit,limit)
   button(view.render(),'开始寻聘').props.onClick()
   assert.equal(view.starts.at(-1).limit,limit)
   view.set('view','requirements')
  }
  assert.match(text(view.render()),/100 人.*账号封控/)
  const saved=view.requests.length
  for(const value of ['0','101','1.5','']){
   input().props.onChange({target:{value}})
   assert.equal(input().props['aria-invalid'],true)
   assert.equal(button(find(view.render(),row=>row.props.title==='寻聘设置'),'开始寻聘').props.disabled,true)
  }
  assert.equal(view.requests.length,saved,'invalid input must not overwrite the saved target')
 }
})

test('settings accept a minimum score and candidate lists retain results accepted under each execution threshold',()=>{
 const view=fixture({view:'requirements'},false,false,{state:{jobs:[]}})
 const input=()=>find(view.render(),row=>row.props.id==='air-sourcing-minimum-score')
 assert.equal(input().props.value,80)
 assert.match(text(find(view.render(),row=>row.props.id==='air-sourcing-minimum-score-help')),/百分制（0–100 分）/)
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
 find(cards(tree)[0],row=>row.props.className==='air-sourcing-person-select').props.onClick();tree=view.render()
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
  assert.equal(button(tree,'刷新结果'),undefined);assert.equal(find(tree,row=>row.props.id==='air-filter-round'),undefined);view.render()
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

test('talent toolbar uploads only unimported attachments in the current filtered round and never nests download buttons',async()=>{
 const ids=['a'.repeat(64),'b'.repeat(64),'c'.repeat(64),'d'.repeat(64)]
 const withFiles={...results,candidates:[{...summaries[0],resumeReceived:true,resumeAttachments:[{id:ids[0],fileName:'first.pdf'},{id:ids[1],fileName:'saved.pdf',uploadedAt:'now'},{id:ids[2],fileName:'stopped.pdf',uploadStopped:true}]},{...summaries[1],resumeReceived:true,resumeAttachments:[{id:ids[3],fileName:'latest.pdf'}]}]}
 let finish
 const view=fixture({results:withFiles},false,false,{state:{jobs:[]},rpc:()=>new Promise(resolve=>{finish=resolve})})
 let tree=view.render()
 assert.ok(button(tree,'同步平台简历'));assert.equal(button(tree,'刷新结果'),undefined)
 assert.ok(button(tree,'简历入库（2）'))
 for(const control of elements(tree).filter(row=>row?.type==='button'))assert.equal(elements(control.props.children).filter(row=>row?.type==='button').length,0)
 find(tree,row=>row.props.id==='air-filter-score').props.onChange('70')
 tree=view.render();const upload=button(tree,'简历入库（1）');assert.equal(upload.props.disabled,false)
 upload.props.onClick();upload.props.onClick();assert.equal(view.requests.length,1,'double click cannot start two batch tasks')
 assert.equal(view.requests[0][0],'uploadReceivedResumes');assert.equal(view.requests[0][1].jobId,'java');assert.equal(view.requests[0][1].roundId,'all')
 assert.deepEqual(Array.from(view.requests[0][1].attachmentIds),[ids[3]])
 assert.equal(button(view.render(),'正在启动入库…').props.disabled,true)
 finish({id:'upload-task'});await new Promise(resolve=>setImmediate(resolve))
 assert.match(text(view.render()),/当前职位 · 新简历 · 未处理/)
 view.set('roundId','old');view.set('results',{...withFiles,roundId:'old',candidates:[withFiles.candidates[0]]})
 find(view.render(),row=>row.props.id==='air-filter-score').props.onChange('all')
 assert.ok(button(view.render(),'简历入库（1）'))
})
test('active attachment upload exposes progress and stop within the same talent list',async()=>{
 const task={id:'upload',kind:'resume_import',resumeSource:'platform_received',jobId:'java',status:'running',detail:'1/2：正在提交入库'}
 const view=fixture({},true,false,{state:{activeJobId:task.id,jobs:[task]},rpc:async()=>({stopping:true})})
 const tree=view.render();assert.match(text(tree),/1\/2：正在提交入库/)
 button(tree,'停止上传').props.onClick();assert.equal(view.requests[0][0],'stop');assert.equal(view.requests[0][1].id,'upload')
 assert.equal(button(tree,'同步平台简历').props.disabled,true)
})


test('tiered rubrics show preferences, unknown facts, inference and interview questions without zero-point penalties', () => {
 const criteria=[{id:'core',tier:'core',label:'核心开发能力',weight:30},{id:'bonus',tier:'bonus',label:'上一段任职超过2年',weight:10},{id:'verify',tier:'verify',label:'编码习惯与规范',weight:0},{id:'known',tier:'core',label:'项目实现',weight:70}].map(row=>({...row,must:false,quote:row.label}))
 const scoring={version:2,baseScore:100,bonusScore:0,assessedWeight:70,needsReview:false}
 const candidate={...people[1],score:100,coverage:70,scoring,assessments:criteria.map(c=>({criterionId:c.id,state:c.id==='known'?'match':'unknown',quote:c.id==='known'?'项目实现':'',reason:'材料不足',verificationQuestion:'请说明相关实际工作。'}))}
 const requirements={rubricVersion:2,criteria,supplementCoverage:[{quote:'优先上一段工作经历超过2年',criterionIds:['bonus'],listFields:[]}]}
 const result={...results,candidates:[{...summaries[1],score:100,scoring}]}
 const view=fixture({results:result,detailData:{...details(1),candidate,requirements}}),tree=view.render()
 assert.equal(cards(tree).length,1,'qualified candidates can retain individual unknown facts')
 assert.match(text(tree),/材料未说明/);assert.doesNotMatch(text(tree),/待核实|暂评分|保留待核实/)
 const rows=elements(tree).filter(row=>row?.props?.className==='air-sourcing-assessment')
 assert.match(text(rows[0]),/不计入分母/)
 assert.match(text(rows[1]),/加分项/);assert.match(text(rows[1]),/暂未加分/)
 assert.match(text(rows[2]),/面试核实/);assert.match(text(rows[2]),/不影响评分/)
 assert.match(text(tree),/优先上一段工作经历超过2年/)
 assert.equal(find(rows[1],row=>row.props['aria-label']?.startsWith('本项得分')),undefined)
 candidate.assessments[0]={criterionId:'core',state:'partial',quote:'接口规范',evidenceQuotes:['接口规范','优化重构'],evidenceKind:'inferred',confidence:'medium',reason:'项目实践间接支持',verificationQuestion:'请说明评审流程。'}
 const updated=view.render()
 assert.match(text(updated),/间接证据/);assert.match(text(updated),/中置信度/);assert.match(text(updated),/请说明评审流程/)
 assert.ok(find(updated,row=>row.type==='blockquote'&&text(row).includes('优化重构')))
})
