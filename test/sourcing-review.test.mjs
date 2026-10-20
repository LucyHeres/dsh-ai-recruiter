import assert from 'node:assert/strict'
import { test } from 'node:test'
import { communicationIndex, candidateCommunication, sourcingResults, taskHistoryPage } from '../dist/lib/sourcing-review.js'
import { hash } from '../dist/lib/store.js'
const url = 'https://www.liepin.com/resume/known'
const candidate = { profileUrl: url, platform: 'liepin' }
const greeting = result => ({ kind:'greeting', platform:'liepin', results: [{ key:hash(['liepin',url]),name:'同名人',identityKind:'url',...result }] })

test('task history and rounds use the full per-platform target and preserve historical totals',()=>{
 const base={id:'new',kind:'talent_sourcing',jobId:'java',platform:'liepin',createdAt:'2026-10-19',updatedAt:'now',status:'running',limit:5,channels:[],supplement:'',candidates:[],results:[],platforms:['liepin','boss']}
 const jobs=[{...base,limitScope:'per_platform'},{...base,id:'old',createdAt:'2026-10-18'}]
 assert.deepEqual(taskHistoryPage(jobs,1).records.map(row=>row.limit),[10,5])
 const all=sourcingResults(jobs,'java','all',new Map())
 assert.deepEqual(all.rounds.map(row=>row.limit),[10,5]);assert.equal(all.current.limit,5)
 assert.equal(all.current.limitScope,'per_platform');assert.deepEqual(all.current.platforms,['liepin','boss'])
})

test('historical and configured executions apply their own thresholds to results and position counts',async()=>{
 const {positionOverview}=await import('../dist/lib/position-overview.js')
 const jobs=[{id:'legacy',score:55},{id:'lower',score:35,minimumScore:30},{id:'higher',score:75,minimumScore:80},{id:'zero',score:0,minimumScore:0}].map((row,i)=>({...row,kind:'talent_sourcing',jobId:'java',createdAt:`2026-10-${10+i}`,updatedAt:'now',status:'completed',limit:10,detail:'',channels:[],supplement:'',candidates:[{...candidate,key:row.id,name:'示例',score:row.score,scope:'online',fields:[],collectedAt:'now'}],results:[]}))
 const all=sourcingResults(jobs,'java','all',new Map())
 assert.deepEqual(all.candidates.map(row=>row.key),['zero','lower'])
 assert.equal(all.current.minimumScore,0);assert.equal(all.current.candidateCount,1)
 assert.equal(sourcingResults(jobs,'java','lower',new Map()).candidates[0].minimumScore,30)
 assert.equal(sourcingResults(jobs,'java','legacy',new Map()).candidates.length,0)
 assert.equal(positionOverview([{id:'java',name:'Java'}],jobs)[0].candidateCount,2)
})

test('communication filter joins exact platform profile identities without guessing from names', () => {
  const records = communicationIndex([greeting({ stage:'succeeded',clickedAt:'now' })])
  assert.equal(candidateCommunication(candidate, records),'recorded')
  assert.equal(candidateCommunication({...candidate,platform:'boss'},records),'none')
  assert.equal(candidateCommunication({...candidate,profileUrl:''},records),'unknown')
  assert.equal(candidateCommunication({...candidate,profileUrl:url+'-other'},records),'none')
  assert.equal(candidateCommunication(candidate,communicationIndex([greeting({identityKind:'text',stage:'succeeded',clickedAt:'now'})])),'none')
})
test('uncertain attempts remain uncertain and a dispatched click is represented as a record, not delivery proof', () => {
  assert.equal(candidateCommunication(candidate,communicationIndex([greeting({stage:'unknown'})])),'uncertain')
  assert.equal(candidateCommunication(candidate,communicationIndex([greeting({stage:'failed',attemptedAt:'now'})])),'uncertain')
  assert.equal(candidateCommunication(candidate,communicationIndex([greeting({stage:'failed'})])),'none')
  assert.equal(candidateCommunication(candidate,communicationIndex([greeting({stage:'succeeded',clickedAt:'past'}),greeting({stage:'unknown'})])),'recorded')
})
test('unified task history paginates across all three task types without leaking candidate content', () => {
  const jobs = Array.from({length:43},(_,i)=>({id:String(i).padStart(3,'0'),kind:['talent_sourcing','greeting','resume_import'][i%3],platform:'liepin',createdAt:'2026-10-17T10:00:00Z',status:'completed',limit:10,jobName:'职位',position:{name:'后端开发'},jobId:'job-1',candidates:[{resumeText:'PRIVATE RESUME'}],results:[{key:'one',name:'示例',stage:'succeeded',updatedAt:'2026-10-17T10:00:00Z'}],events:[{message:'PRIVATE LOG'}]}))
  const first = taskHistoryPage(jobs,1), second = taskHistoryPage(jobs,2)
  assert.equal(first.total,43); assert.equal(first.records.length,20); assert.equal(second.records.length,20)
  assert.ok(first.records.every(row => !second.records.some(other=>other.id===row.id)))
  assert.deepEqual(new Set(first.records.map(row=>row.kind)),new Set(['talent_sourcing','greeting','resume_import']))
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE|resumeText|events|candidates/)
  assert.equal(first.records.find(row=>row.kind==='talent_sourcing').jobName,'后端开发')
  const filtered = taskHistoryPage(jobs,500,'resume_import')
  assert.equal(filtered.page,1); assert.equal(filtered.total,14)
  assert.ok(filtered.records.every(row=>row.kind==='resume_import'))
})

test('records API opens tasks beyond the recent state window and enriches only the requested sourcing batch', async () => {
  const { Workbench } = await import('../dist/lib/workbench.js')
  const { Store } = await import('../dist/lib/store.js')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { randomUUID } = await import('node:crypto')
  const dir = await mkdtemp(join(tmpdir(),'recruit-records-'))
  try {
    const store = new Store(dir,'test-company'); await store.init()
    const source = {id:randomUUID(),kind:'talent_sourcing',jobId:'java',position:{name:'Java 开发'},platform:'liepin',limit:10,status:'completed',createdAt:'2020-01-01',results:[],candidates:[{key:hash('candidate'),...candidate,resumeText:'PRIVATE RESUME'}]}
    await store.put('sourcing-'+source.id,source)
    const recent = Array.from({length:35},(_,i)=>({...greeting({stage:'succeeded',clickedAt:'now'}),id:randomUUID(),status:'completed',limit:1,createdAt:`2026-10-${String((i%17)+1).padStart(2,'0')}`}))
    await Promise.all(recent.map(job=>store.put('greeting-'+job.id,job)))
    const service = Object.create(Workbench.prototype)
    Object.assign(service,{store,initialized:Promise.resolve(),executors:new Map(['greeting','resume_import','talent_sourcing'].map(kind=>[kind,{kind,storagePrefix:kind==='talent_sourcing'?'sourcing-':kind==='resume_import'?'resume-':'greeting-'}]))})
    const records = await service.taskHistory({page:2})
    assert.equal(records.total,36); assert.ok(records.records.some(row=>row.id===source.id))
    assert.doesNotMatch(JSON.stringify(records),/PRIVATE RESUME/)
    const detail = await service.taskDetail({id:source.id})
    assert.equal(detail.id,source.id); assert.deepEqual(detail.candidates,[])
    const batch = await service.sourcingBatch({id:source.id,jobId:'java'})
    assert.equal(batch.candidates[0].communication,'recorded')
    assert.equal(batch.candidates[0].resumeText,'PRIVATE RESUME')
    await assert.rejects(service.sourcingBatch({id:source.id,jobId:'wrong-job'}),/没有这轮/)
    await assert.rejects(service.taskDetail({id:randomUUID()}),/任务不存在/)
    assert.equal((await store.get('sourcing-'+source.id)).candidates[0].communication,undefined)
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test('all-round results include rounds older than the former 50-round window without shipping resumes',()=>{
 const key=hash('same-candidate')
 const jobs=Array.from({length:53},(_,i)=>({id:`round-${String(i).padStart(2,'0')}`,kind:'talent_sourcing',jobId:'java',createdAt:`2026-${String(1+Math.floor(i/28)).padStart(2,'0')}-${String(1+i%28).padStart(2,'0')}`,updatedAt:String(i),status:'completed',limit:10,detail:'done',channels:[],supplement:'',candidates:[{key:hash('candidate-'+i),name:'候选人'+i,platform:'liepin',profileUrl:url,fields:[],score:60+i%41,coverage:90,collectedAt:String(i),resumeText:'PRIVATE_RESUME',analysis:'PRIVATE_ANALYSIS',assessments:[]}]}))
 const foreign={...jobs[0],id:'foreign',jobId:'other',candidates:[{...jobs[0].candidates[0],name:'other-company-position'}]}
 const all=sourcingResults([...jobs,foreign],'java','all',new Map())
 assert.equal(all.rounds.length,53);assert.equal(all.candidates.length,53)
 assert.equal(new Set(all.candidates.map(row=>row.resultKey)).size,53)
 assert.doesNotMatch(JSON.stringify(all),/PRIVATE_RESUME|PRIVATE_ANALYSIS|other-company-position/)
 const one=sourcingResults(jobs,'java',jobs[0].id,new Map())
 assert.equal(one.candidates.length,1);assert.equal(one.candidates[0].score,60);assert.equal(one.current.id,jobs[0].id)
 assert.equal(one.current.candidateCount,1)
 assert.throws(()=>sourcingResults([...jobs,foreign],'java','foreign',new Map()),/没有这轮/)
})
test('result and detail APIs preserve per-round scoring evidence and cannot cross positions',async()=>{
 const {Workbench}=await import('../dist/lib/workbench.js')
 const {Store}=await import('../dist/lib/store.js')
 const {mkdtemp,rm}=await import('node:fs/promises')
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {randomUUID}=await import('node:crypto')
 const dir=await mkdtemp(join(tmpdir(),'sourcing-rounds-'))
 try{
  const store=new Store(dir,'company');await store.init()
  const key=hash('candidate')
  const old={id:randomUUID(),kind:'talent_sourcing',jobId:'java',createdAt:'2025-01-01',updatedAt:'old',status:'completed',limit:10,results:[],channels:[],detail:'done',supplement:'old',requirements:{criteria:[{id:'criterion',label:'旧标准'}]},candidates:[{key,name:'候选人',platform:'liepin',profileUrl:url,score:64,fields:[],coverage:50,collectedAt:'2025-01-01',resumeText:'旧轮原文',assessments:[{criterionId:'criterion',reason:'旧评估'}]}]}
  const fresh={...old,id:randomUUID(),createdAt:'2026-01-01',updatedAt:'new',requirements:{criteria:[{id:'criterion',label:'新标准'}]},candidates:[{...old.candidates[0],score:90,resumeText:'新轮原文'}]}
  await Promise.all([old,fresh].map(job=>store.put('sourcing-'+job.id,job)))
  const service=Object.create(Workbench.prototype);Object.assign(service,{store,initialized:Promise.resolve()})
  const all=await service.sourcingResults({jobId:'java'})
  assert.equal(all.roundId,'all');assert.equal(all.candidates.length,1);assert.equal(all.candidates[0].score,90);assert.doesNotMatch(JSON.stringify(all),/旧轮原文|新轮原文/)
  const detail=await service.sourcingCandidate({jobId:'java',id:old.id,key})
  assert.equal(detail.candidate.score,64);assert.equal(detail.candidate.resumeText,'旧轮原文');assert.equal(detail.requirements.criteria[0].label,'旧标准')
  await assert.rejects(service.sourcingCandidate({jobId:'other',id:old.id,key}),/没有这轮/)
  await assert.rejects(service.sourcingCandidate({jobId:'java',id:old.id,key:hash('not-there')}),/没有这位/)
  assert.equal(service.sourcingSaveCandidate,undefined)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('communication status follows the observed resume ID across tasks without matching masked names',()=>{
 const platformIdentity={kind:'resume',id:'resumeId123',source:'card_class'}
 const records=communicationIndex([{kind:'talent_sourcing',platform:'liepin',greetings:[{key:'old-key',candidateKey:'old-candidate',platform:'liepin',name:'张先生',platformIdentity,identityKind:'platform_id',stage:'succeeded',attemptedAt:'past'}]}])
 assert.equal(candidateCommunication({key:'new-key',platform:'liepin',profileUrl:'',platformIdentity},records),'recorded')
 assert.equal(candidateCommunication({key:'new-key',platform:'liepin',profileUrl:'',platformIdentity:{...platformIdentity,id:'anotherResume456'}},records),'none')
 assert.equal(candidateCommunication({key:'new-key',platform:'boss',profileUrl:'',platformIdentity},records),'none')
})
