import assert from 'node:assert/strict'
import { test } from 'node:test'
import { liepinCandidateIdentity } from '../dist/lib/platforms/liepin/candidate-identity.js'
import { greetingOutcome, sameGreetingIdentity, platformIdentityKey } from '../dist/lib/candidate-identity.js'
const identity = id => ({kind:'resume',id,source:'card_class'})
const wrapper = id => ({attributes:{class:`newResumeItemWrap--YmIxZ xpath-resume-item-wrap xpath-resume-item-wrap-${id}`}})
const page = {url:'https://lpt.liepin.com/recommend'}

test('Liepin reads opaque resume identity from the inspected card or its ancestor only',()=>{
 const id='f3d525d884Eda01bf03e19e'
 const broker={getInspection:(_p,ref)=>ref==='name'?{ancestors:[{},wrapper(id)]}:{element:wrapper(id)}}
 assert.deepEqual(liepinCandidateIdentity(page,['name','send'],broker),identity(id))
 assert.equal(liepinCandidateIdentity(page,['missing'],{getInspection:()=>({html:`<div class="xpath-resume-item-wrap-${id}"></div>`,element:{attributes:{id:'unrelated-id'}}})}),undefined)
 assert.equal(liepinCandidateIdentity({...page,url:'https://example.com'},['name'],broker),undefined)
 assert.throws(()=>liepinCandidateIdentity(page,['a','b'],{getInspection:(_p,ref)=>({element:wrapper(ref.repeat(12))})}),/不同简历ID/)
})
test('different platform identities remain distinct despite identical names or old summary hashes',()=>{
 const a={key:'new-a',name:'张先生',platformIdentity:identity('aaaaaaaaaa'),identityAliases:['same-summary']}
 const b={key:'new-b',name:'张先生',platformIdentity:identity('bbbbbbbbbb'),identityAliases:['same-summary']}
 assert.equal(sameGreetingIdentity(a,b),false)
 assert.equal(sameGreetingIdentity(a,{...b,platformIdentity:identity('aaaaaaaaaa')}),true)
 assert.equal(sameGreetingIdentity(a,{key:'same-summary',name:'张先生'}),true)
 assert.equal(sameGreetingIdentity(a,{key:'unrelated',name:'张先生'}),false)
 assert.notEqual(platformIdentityKey('liepin',a.platformIdentity),platformIdentityKey('boss',a.platformIdentity))
})
test('legacy success is recorded; explicit unknown and dispatched failures remain uncertain',()=>{
 assert.equal(greetingOutcome({stage:'succeeded',attemptedAt:'past'}),'recorded')
 assert.equal(greetingOutcome({stage:'unknown',clickedAt:'past'}),'uncertain')
 assert.equal(greetingOutcome({stage:'failed',attemptedAt:'past'}),'uncertain')
 assert.equal(greetingOutcome({stage:'sending',candidateKey:'queued'}),undefined)
 assert.equal(greetingOutcome({stage:'sending',candidateKey:'queued',attemptedAt:'past'}),'uncertain')
})
