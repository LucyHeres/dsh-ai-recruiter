import assert from 'node:assert/strict'
import { test } from 'node:test'
import { liepinCandidateIdentity } from '../dist/lib/platforms/liepin/candidate-identity.js'
import { greetingOutcome, sameGreetingIdentity, platformIdentityKey } from '../dist/lib/candidate-identity.js'
import { bossCandidateTextIdentity } from '../dist/lib/platforms/boss/candidate-identity.js'
import { hash } from '../dist/lib/store.js'
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

test('BOSS full-card text identity excludes trailing contact state and retains exact legacy hashes', () => {
 const body='8-10K 李哲 24岁 1年经验 本科 期望 上海 客户经理 优势 熟悉客户维护 2025.01 至今 甲公司 客户经理 2020 2024 某大学 本科'
 const before=bossCandidateTextIdentity(body+' 打招呼'), after=bossCandidateTextIdentity(body+' 继续沟通')
 assert.equal(before.canonical,body);assert.equal(after.canonical,body)
 assert.equal(bossCandidateTextIdentity(body+' 刚刚活跃 打招呼').canonical,body)
 for(const legacy of [body+' 打招呼',body+' 继续沟通']) {
  assert.ok(before.aliases.includes(legacy));assert.ok(after.aliases.includes(legacy))
 }
 const candidateKeys=after.aliases.map(identity=>hash({platform:'boss',identity}))
 assert.ok(candidateKeys.includes(hash({platform:'boss',identity:body+' 打招呼'})))
 assert.ok(candidateKeys.includes(hash({platform:'boss',identity:body+' 继续沟通'})))
 const row={key:hash(['boss',after.canonical]),identityAliases:after.aliases.map(text=>hash(['boss',text]))}
 assert.equal(sameGreetingIdentity(row,{key:hash(['boss',body+' 打招呼']),stage:'unknown'}),true)
 assert.equal(greetingOutcome({stage:'unknown'}),'uncertain')
 assert.notEqual(bossCandidateTextIdentity(body.replace('甲公司','乙公司')+' 打招呼').canonical,before.canonical)
 assert.notEqual(bossCandidateTextIdentity(body.replace('1年经验','3年经验')+' 打招呼').canonical,before.canonical)
 assert.equal(bossCandidateTextIdentity(body+' 负责打招呼和继续沟通模块开发').canonical,body+' 负责打招呼和继续沟通模块开发')
})
