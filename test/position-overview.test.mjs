import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hash } from '../dist/lib/store.js'
import { positionOverview } from '../dist/lib/position-overview.js'
import { dailyUsage } from '../dist/lib/greeting-policy.js'
import { communicationIndex, candidateCommunication } from '../dist/lib/sourcing-review.js'
import { candidateContactKeys } from '../dist/lib/candidate-contact.js'
const now = new Date().toISOString()
const candidate={key:'person',name:'候选人',platform:'liepin',score:80,scope:'online',profileUrl:''}
const greeting={key:'contact',candidateKey:'person',platform:'liepin',name:'候选人',stage:'succeeded',clickedAt:now,attemptedAt:now,updatedAt:now}
const source={id:'source',kind:'talent_sourcing',jobId:'job',createdAt:now,candidates:[candidate,{...candidate,key:'low',score:59}],results:[],greetings:[greeting]}
test('position cards count browsed people and actual greetings without treating online text or imports as received resumes',()=>{
 const result=positionOverview([{id:'job',name:'工程师',platforms:['liepin']},{id:'other',name:'工程师',platforms:[]}],[source,{...source,id:'old'}, {kind:'resume_import',jobId:'job',results:[{stage:'succeeded'},{stage:'failed'}]}, {kind:'greeting',jobId:'other',results:[{key:'unrelated',clickedAt:now}]}],'source')
 assert.equal(result[0].viewedCount,2);assert.equal(result[0].candidateCount,1);assert.equal(result[0].resumeCount,0);assert.equal(result[0].greetedCount,1);assert.equal(result[0].importedCount,1);assert.equal(result[0].activeKind,'talent_sourcing')
 assert.equal(result[1].candidateCount,0);assert.equal(result[1].greetedCount,1)
 assert.deepEqual(result[0].platforms,['liepin']);assert.deepEqual(result[1].platforms,[])
})

test('list rejects and repeated detail reads count once across rounds and verified aliases',()=>{
 const viewed=[{key:'person',platform:'liepin'},{key:'list-reject',platform:'liepin'},{key:'detail-reject',platform:'liepin'}]
 const first={...source,candidates:[candidate],viewedCandidates:viewed,scanned:2}
 const second={...source,id:'round2',candidates:[{...candidate,key:'person-v2',identityAliases:['person']}],viewedCandidates:[{key:'person-v2',identityAliases:['person'],platform:'liepin'},viewed[1]]}
 const [result]=positionOverview([{id:'job'}],[first,second])
 assert.equal(result.viewedCount,3);assert.equal(result.greetedCount,1)
 const [legacy]=positionOverview([{id:'job'}],[{...source,scanned:12}])
 assert.equal(legacy.viewedCount,12,'legacy scans include people rejected before a saved resume')
})

test('received resumes join platform receipt and attachment data and count people rather than files',()=>{
 const second={...candidate,key:'second',score:90}
 const tasks=[{...source,candidates:[candidate,second]}, {...source,id:'again',candidates:[candidate,second]}]
 const contacts=[{platform:'liepin',identityKeys:candidateContactKeys(candidate),resumeReceivedAt:now,source:'chat'}]
 const resumes=[{id:'file1',platform:'liepin',identityKeys:candidateContactKeys(second),resumeId:'r2'}, {id:'file2',platform:'liepin',identityKeys:candidateContactKeys(second),resumeId:'r2'}]
 const [result]=positionOverview([{id:'job'}],tasks,undefined,contacts,resumes)
 assert.equal(result.resumeCount,2)
 assert.equal(positionOverview([{id:'other'}],tasks,undefined,contacts,resumes)[0].resumeCount,0)
})

test('cleared talents reset all live counts even when older write receipts survive',()=>{
 const cleared={...source,talentCleared:true,candidates:[],scanned:90,greetings:[greeting],viewedCandidates:[{key:'person',platform:'liepin'}]}
 const standalone={id:'old-greeting',kind:'greeting',jobId:'job',platform:'liepin',results:[{...greeting,key:'old-contact'}]}
 const contacts=[{platform:'liepin',identityKeys:candidateContactKeys(candidate),greetedAt:now,resumeReceivedAt:now}]
 const [result]=positionOverview([{id:'job'}],[cleared,standalone],undefined,contacts)
 assert.equal(result.viewedCount,0);assert.equal(result.greetedCount,0);assert.equal(result.resumeCount,0)
 const [fresh]=positionOverview([{id:'job'}],[cleared,{...source,id:'new',greetings:[],viewedCandidates:[{key:'fresh',platform:'liepin'}],candidates:[]}])
 assert.equal(fresh.viewedCount,1);assert.equal(fresh.greetedCount,0);assert.equal(fresh.resumeCount,0)
})
test('queued sourcing greetings do not consume daily quota or fabricate a contact state',()=>{
 const pending={...source,greetings:[{...greeting,clickedAt:undefined,attemptedAt:undefined,stage:'sending'}]}
 const linkedCandidate={...candidate,profileUrl:'https://lpt.liepin.com/profile/one'}
 const linkedPending={...pending,greetings:pending.greetings.map(row=>({...row,key:hash(['liepin',linkedCandidate.profileUrl]),identityKind:'url'}))}
 assert.equal(candidateCommunication(linkedCandidate,communicationIndex([linkedPending])),'none')
 assert.equal(dailyUsage([pending]).liepin,0);assert.equal(candidateCommunication(candidate,communicationIndex([pending])),'none')
 const clicked={...source,greetings:[greeting,{...greeting,key:'boss',candidateKey:'boss',platform:'boss'}]}
 assert.deepEqual(dailyUsage([clicked]),{liepin:1,boss:1})
 assert.equal(candidateCommunication(candidate,communicationIndex([clicked])),'recorded')
 const uncertain={...source,greetings:[{...greeting,stage:'unknown',clickedAt:undefined}]}
 assert.equal(candidateCommunication(candidate,communicationIndex([uncertain])),'none')
})
