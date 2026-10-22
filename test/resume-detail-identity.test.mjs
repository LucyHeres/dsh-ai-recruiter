import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bindResumeDetail, matchesResumeDetail } from '../dist/lib/resume-detail-identity.js'
import { LiepinSearchEvidence } from '../dist/lib/platforms/liepin/search-evidence.js'
const text='陈先生 Java开发 工作经历：负责订单系统研发及数据库优化。'.repeat(8)
const candidate={key:'candidate',name:'陈先生',resumeText:text,sourceUrl:'https://lpt.liepin.com/recommend'}
const page=()=>({tabId:1,snapshotId:'old',documentId:'doc',url:candidate.sourceUrl,items:[{ref:'dialog',role:'dialog',name:'推荐职位： Java开发',states:[]},{ref:'identity',role:'text',name:'陈先生',dialogRef:'dialog'},{ref:'send',role:'button',name:'立即沟通',dialogRef:'dialog'},{ref:'outside',role:'button',name:'立即沟通'}],dialogs:[{ref:'dialog',text:'推荐职位：\nJava开发\n'+text}]})

test('the saved full resume binds fresh refs in the same foreground document without requiring list summary equality',()=>{
 const p=page(),binding=bindResumeDetail(p,candidate)
 assert.ok(binding)
 const fresh=structuredClone(p);fresh.snapshotId='fresh';fresh.items[2].ref='new-send'
 assert.equal(matchesResumeDetail(binding,fresh,candidate.key,['new-send','identity']),true)
 const parentOwned=structuredClone(fresh);delete parentOwned.items[2].dialogRef;parentOwned.items[2].parentRef='dialog'
 assert.equal(matchesResumeDetail(binding,parentOwned,candidate.key,['new-send','identity']),true)
})
test('a saved resume never authorizes another document, person, background button or conflicting foreground',()=>{
 const p=page(),binding=bindResumeDetail(p,candidate)
 assert.equal(matchesResumeDetail(binding,p,candidate.key,['outside','identity']),false)
 for(const change of [q=>{q.documentId='other'},q=>{q.tabId=2},q=>{q.dialogs[0].text='陈先生 其他人的不同工作项目'.repeat(20)},q=>{q.dialogs.push({ref:'other',text})},q=>{q.items[0].states=['hidden']}]){
  const next=structuredClone(p);change(next);assert.equal(matchesResumeDetail(binding,next,candidate.key,['send','identity']),false)
 }
 assert.equal(matchesResumeDetail(undefined,p,candidate.key,['send']),false)
 assert.equal(matchesResumeDetail(binding,p,'other-candidate',['send']),false)
 assert.equal(bindResumeDetail(p,{...candidate,resumeText:'陈先生'}),undefined)
})
test('the current foreground source binds separately from accumulated sections, and only the activity hint is ignored',()=>{
 const p=page(),saved={...candidate,resumeText:p.dialogs[0].text+'\n项目经历：另行读取的订单迁移、上线及维护职责。'}
 assert.equal(bindResumeDetail(p,saved),undefined,'accumulated text cannot silently become a foreground grant')
 const binding=bindResumeDetail(p,saved,p.dialogs[0].text)
 assert.ok(binding)
 const fresh=structuredClone(p)
 fresh.dialogs[0].text=fresh.dialogs[0].text.replace('Java开发','Java开发\nTa在线，回复更快～')
 assert.equal(matchesResumeDetail(binding,fresh,candidate.key,['send','identity']),true)
 fresh.dialogs[0].text=fresh.dialogs[0].text.replace('数据库优化','市场推广')
 assert.equal(matchesResumeDetail(binding,fresh,candidate.key,['send','identity']),false)
 const other=page();other.dialogs[0].text='陈先生 工作经历：另一家公司的不同项目。'.repeat(20)
 assert.equal(bindResumeDetail(other,saved,p.dialogs[0].text),undefined)
 const blockedParent=structuredClone(p)
 blockedParent.items.push({ref:'hidden-parent',role:'group',parentRef:'dialog',states:['hidden']})
 delete blockedParent.items[2].dialogRef;blockedParent.items[2].parentRef='hidden-parent'
 assert.equal(matchesResumeDetail(binding,blockedParent,candidate.key,['send']),false)
})
test('foreground recommended-job header is evidence; a resume job mention or same-name association ambiguity is not',()=>{
 const evidence=new LiepinSearchEvidence({getInspection:()=>undefined}),p=page()
 const job={jobId:'host-job',jobName:'Java开发',platformJobs:[{id:'linked-job',name:'Java开发'}]}
 assert.equal(evidence.position(p,job,{ref:'dialog'}).ok,true)
 assert.equal(evidence.position(p,{...job,jobName:'产品',platformJobs:[{id:'product',name:'产品'}]},{ref:'dialog'}).ok,false)
 assert.equal(evidence.position(p,{...job,platformJobs:[...job.platformJobs,{id:'other-linked-job',name:'Java开发'}]},{ref:'dialog'}).ok,false)
 assert.equal(evidence.position({...p,dialogs:[{ref:'dialog',text:'工作经历：推荐职位：Java开发'}]},job,{ref:'dialog'}),undefined)
 assert.throws(()=>evidence.position({...p,items:p.items.map(i=>i.ref==='dialog'?{...i,states:['blocked_by_dialog']}:i)},job,{ref:'dialog'}),/UNREADABLE/)
})
