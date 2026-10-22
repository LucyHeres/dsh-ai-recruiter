import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hash } from '../dist/lib/store.js'
import { positionOverview } from '../dist/lib/position-overview.js'
import { dailyUsage } from '../dist/lib/greeting-policy.js'
import { communicationIndex, candidateCommunication } from '../dist/lib/sourcing-review.js'
const now = new Date().toISOString()
const candidate={key:'person',name:'候选人',platform:'liepin',score:80,scope:'online',profileUrl:''}
const greeting={key:'contact',candidateKey:'person',platform:'liepin',name:'候选人',stage:'succeeded',clickedAt:now,attemptedAt:now,updatedAt:now}
const source={id:'source',kind:'talent_sourcing',jobId:'job',createdAt:now,candidates:[candidate,{...candidate,key:'low',score:59}],results:[],greetings:[greeting]}
test('position cards count unique qualified candidates, actual greetings and successful imports only for that job',()=>{
 const result=positionOverview([{id:'job',name:'工程师',platforms:['liepin']},{id:'other',name:'工程师',platforms:[]}],[source,{...source,id:'old'}, {kind:'resume_import',jobId:'job',results:[{stage:'succeeded'},{stage:'failed'}]}, {kind:'greeting',jobId:'other',results:[{key:'unrelated',clickedAt:now}]}],'source')
 assert.equal(result[0].candidateCount,1);assert.equal(result[0].resumeCount,1);assert.equal(result[0].greetedCount,1);assert.equal(result[0].importedCount,1);assert.equal(result[0].activeKind,'talent_sourcing')
 assert.equal(result[1].candidateCount,0);assert.equal(result[1].greetedCount,1)
 assert.deepEqual(result[0].platforms,['liepin']);assert.deepEqual(result[1].platforms,[])
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
