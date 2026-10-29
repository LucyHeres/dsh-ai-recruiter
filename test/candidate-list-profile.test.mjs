import assert from 'node:assert/strict'
import { test } from 'node:test'
import { candidateListProfile } from '../dist/lib/candidate-list-profile.js'
import { sourcingResults } from '../dist/lib/sourcing-review.js'

const resume = `周先生
29 岁
工作经历
东风物流集团
软件开发工程师
2025.04-至今(1年6个月)
工作内容：负责系统开发，客户为其他公司，不是任职经历。
江苏国光信息产业股份有限公司
软件开发工程师
2024.01-2025.04(1年3个月)
教育经历
华中师范大学
统招
2019.09-2022.07(2年10个月)
软件工程
硕士
武汉轻工大学
信息与计算科学
本科
统招
2015.09-2019.07(3年10个月)
项目经历
某客户有限公司
项目合作方
2020.01-2020.12
语言能力
普通话`

test('historical resumes expose bounded work and education rows without guessing age or treating project clients as employers', () => {
 const profile=candidateListProfile(resume)
 assert.equal(profile.age,'29岁')
 assert.deepEqual(profile.work,[
  {organization:'东风物流集团',description:'软件开发工程师',period:'2025.04-至今(1年6个月)'},
  {organization:'江苏国光信息产业股份有限公司',description:'软件开发工程师',period:'2024.01-2025.04(1年3个月)'},
 ])
 assert.equal(profile.education.length,2)
 assert.equal(profile.education[0].organization,'华中师范大学')
 assert.equal(profile.education[0].description,'统招 / 软件工程 / 硕士')
 assert.equal(profile.education[1].period,'2015.09-2019.07(3年10个月)')
 assert.doesNotMatch(JSON.stringify(profile),/某客户|项目合作方|负责系统开发|普通话/)
})

test('dated platform-card rows supply summary data without sending extra model requests or assuming a missing history',()=>{
 const card=`周先生 29岁 4年 硕士 北京
东风物流集团 软件开发工程师 2025.04-至今(1年6个月)
江苏国光信息产业股份有限公司 软件开发工程师 2024.01-2025.04(1年3个月)
华中师范大学 · 软件工程 · 硕士 · 统招 2019.09-2022.07(2年10个月)`
 const profile=candidateListProfile('',card)
 assert.equal(profile.age,'29岁')
 assert.equal(profile.work.length,2);assert.equal(profile.work[0].organization,'东风物流集团')
 assert.equal(profile.work[0].description,'软件开发工程师')
 assert.equal(profile.education[0].organization,'华中师范大学')
 assert.deepEqual(candidateListProfile('工作经历\n某公司\n未展示任职时间\n教育经历\n某大学'),{work:[],education:[]})
 assert.equal(candidateListProfile('2015年入学，2019年毕业').age,undefined)
})

test('card work and resume education are merged independently and repeated captured sections do not duplicate records',()=>{
 const profile=candidateListProfile(resume+'\n'+resume,'东风物流集团 软件开发工程师 2025.04-至今(1年6个月)')
 assert.equal(profile.work.length,1)
 assert.equal(profile.education.length,2)
 assert.equal(candidateListProfile(resume+'\n'+resume).work.length,2)
})

test('list projection enriches older records without including their full resume or private project narratives',()=>{
 const source={id:'run',kind:'talent_sourcing',jobId:'java',createdAt:'2026-10-29',updatedAt:'now',status:'completed',limit:1,detail:'done',channels:[],supplement:'',candidates:[{key:'person',name:'周先生',platform:'liepin',fields:[],score:90,coverage:100,collectedAt:'now',resumeText:resume}]}
 const candidate=sourcingResults([source],'java','all',new Map()).candidates[0]
 assert.equal(candidate.listProfile.work.length,2)
 assert.equal(candidate.resumeText,undefined)
 assert.doesNotMatch(JSON.stringify(candidate),/工作内容|某客户|项目合作方/)
})

test('intended city and role come from the intent block, never the current city or position',()=>{
 const source='当前职位：Java工程师\n现居城市：北京\n求职意向\n查看全部2个\nJava\n12-15k×13薪\n武汉\n全部行业\n工作经历\n某公司'
 assert.deepEqual(candidateListProfile(source).expectation,{role:'Java',city:'武汉'})
 assert.equal(candidateListProfile('当前职位：Java工程师\n城市：北京').expectation,undefined)
 assert.deepEqual(candidateListProfile('', '期望城市：上海\n期望岗位：技术主管').expectation,{city:'上海',role:'技术主管'})
})

test('saved display profiles from older versions still receive intended city and role from their resume',()=>{
 const source={id:'run',kind:'talent_sourcing',jobId:'java',createdAt:'2026-10-29',updatedAt:'now',status:'completed',limit:1,detail:'done',channels:[],supplement:'',candidates:[{key:'person',name:'周先生',platform:'liepin',fields:[],score:90,coverage:100,collectedAt:'now',listProfile:{age:'29 岁',work:[],education:[]},resumeText:'求职意向\nJava\n12-15k×13薪\n武汉\n全部行业\n工作经历'}]}
 assert.deepEqual(sourcingResults([source],'java','all',new Map()).candidates[0].listProfile.expectation,{role:'Java',city:'武汉'})
})

const bossResume = `林先生\n25岁\n求职期望\n深圳 | 销售专员 | 行业不限 | 面议\n工作经历\n智海软件有限公司 | 区域销售经理·销售部 2025.11 - 2026.09\n工作内容：服务客户甲公司，负责项目交付。\n敏华控股有限公司 | 销售经理/主管 2023.07 - 2025.04\n教育经历\n黑龙江八一农垦大学 | 种子科学与工程 | 本科 2019 - 2023\n在校经历：\n在校第三学期担任学院学生干部\n项目经历\n另一所大学 | 交流项目 2021 - 2022`
const bossCard = '林先生 在线 25岁 3年 本科 离职-随时到岗 期望 深圳 销售专员 优势 有企业市场管理经验 2025.11 2026.09 智海软件 粤东区域销售经理 2023.07 2025.04 敏华控股 销售经理/主管 2021.12 2022.10 怀任文化创意发展 副总裁/副总经理/VP 2019 2023 黑龙江八一农垦大学 种子科学与工程 本科 继续沟通'

test('BOSS date-first flattened cards supply intent, short employer names and year-only education rows',()=>{
 const profile=candidateListProfile(bossResume,bossCard,'boss')
 assert.deepEqual(profile.expectation,{city:'深圳',role:'销售专员'})
 assert.deepEqual(profile.work,[
  {organization:'智海软件',description:'粤东区域销售经理',period:'2025.11 - 2026.09'},
  {organization:'敏华控股',description:'销售经理/主管',period:'2023.07 - 2025.04'},
 ])
 assert.deepEqual(profile.education,[{organization:'黑龙江八一农垦大学',description:'种子科学与工程 本科',period:'2019 - 2023'}])
 assert.doesNotMatch(JSON.stringify(profile),/继续沟通|优势|另一所大学|工作内容/)
 assert.equal(candidateListProfile('',bossCard,'liepin').expectation,undefined,'BOSS rules must not reinterpret Liepin text')
})

test('BOSS resume sections recover intent and education without crossing project or student narratives',()=>{
 const profile=candidateListProfile(bossResume,'','boss')
 assert.deepEqual(profile.expectation,{city:'深圳',role:'销售专员'})
 assert.deepEqual(profile.education,[{organization:'黑龙江八一农垦大学',description:'种子科学与工程 / 本科',period:'2019 - 2023'}])
 assert.equal(profile.work[0].organization,'智海软件有限公司')
 assert.equal(profile.work.length,2)
 assert.doesNotMatch(JSON.stringify(profile),/另一所大学|学生干部|客户甲公司/)
 const multiline=candidateListProfile('工作经历\n某公司\nJava 工程师\n2020.01 - 2024.03\n教育经历\n某大学\n软件工程 本科\n2016 - 2020','','boss')
 assert.deepEqual(multiline.work,[{organization:'某公司',description:'Java 工程师',period:'2020.01 - 2024.03'}])
 assert.equal(multiline.education.length,1)
})

test('BOSS list projection fills empty saved fields from existing resume text and preserves populated card history',()=>{
 const work=[{organization:'已保存任职公司',description:'区域销售',period:'2025.11 - 2026.09'}]
 const source={id:'run',kind:'talent_sourcing',jobId:'sales',createdAt:'2026-10-29',updatedAt:'now',status:'completed',limit:1,detail:'done',channels:[],supplement:'',candidates:[{key:'person',name:'林先生',platform:'boss',fields:[],score:90,coverage:100,collectedAt:'now',listProfile:{age:'25岁',work,education:[]},resumeText:bossResume}]}
 const before=JSON.stringify(source)
 const candidate=sourcingResults([source],'sales','all',new Map()).candidates[0]
 assert.deepEqual(candidate.listProfile.expectation,{city:'深圳',role:'销售专员'})
 assert.equal(candidate.listProfile.education[0].organization,'黑龙江八一农垦大学')
 assert.deepEqual(candidate.listProfile.work,work)
 assert.equal(JSON.stringify(source),before,'display backfill does not rewrite or rescore the stored candidate')
 assert.equal(candidate.resumeText,undefined)
})
