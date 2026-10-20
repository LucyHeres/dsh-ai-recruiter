#!/usr/bin/env node
'use strict'

// 合并两份扫描结果，去重后输出候选人清单（markdown）。
// 解析全部基于落盘的原始块，所以调整解析规则不需要重新扫描猎聘。
//
//   node scripts/gateway-drivers/report-candidates.cjs [输出路径]
//   输入可用 SCAN_VUE / SCAN_REACT 环境变量覆盖（默认 /tmp/vue.json、/tmp/react.json）

const fs = require('fs')

const SOURCES = [
  { path: process.env.SCAN_VUE || '/tmp/vue.json', skill: 'Vue' },
  { path: process.env.SCAN_REACT || '/tmp/react.json', skill: 'React' }
]
const OUT_PATH = process.argv[2] || '猎聘前端候选人.md'

const NOT_A_NAME = new Set(['今天活跃', '3天内活跃', '本周活跃', '昨日活跃', '在线', '立即沟通', '隐藏'])

const SALARY_RE = /\d+(?:\.\d+)?-\d+(?:\.\d+)?[Kk](?:·\d+薪)?/
const ROLE_RE = /前端|后端|全栈|开发|工程师|算法|测试|产品|设计|运营|架构|WEB|web|Node|U3D|HTML|大数据|数据分析/
const CITY_RE = /^[\u4e00-\u9fa5]{2,4}(?:-[\u4e00-\u9fa5]{2,6})?$/

// 期望信息在两类文本里形态不同：
//   整页文本：  「上海WEB前端开发20-30K·14薪」一行
//   视口文本：  「上海」/「WEB前端开发」/「9-12K」/「计算机软件」多行
const parseExpect = (lines, startIndex, endIndex) => {
  const parts = []
  for (let i = startIndex + 1; i < endIndex && parts.length < 4; i += 1) {
    const line = lines[i]
    if (!line) continue
    if (/^\d{4}\.\d{2}/.test(line)) break
    parts.push(line)
  }
  if (!parts.length) return { expectCity: '', expectRole: '', expectSalary: '', expectIndustry: '' }
  if (parts.length === 1) {
    const single = parts[0]
    const salary = (single.match(SALARY_RE) || [])[0] || ''
    const rest = single.replace(salary, '')
    const match = rest.match(/^([\u4e00-\u9fa5]{2,4})(.+)$/)
    if (match && ROLE_RE.test(match[2])) return { expectCity: match[1], expectRole: match[2].trim(), expectSalary: salary, expectIndustry: '' }
    return { expectCity: CITY_RE.test(rest) ? rest : '', expectRole: CITY_RE.test(rest) ? '' : rest, expectSalary: salary, expectIndustry: '' }
  }
  const salary = parts.find((part) => SALARY_RE.test(part)) || ''
  const city = parts.find((part) => CITY_RE.test(part) && !SALARY_RE.test(part)) || ''
  const role = parts.find((part) => part !== city && part !== salary && ROLE_RE.test(part)) || ''
  const industry = parts.find((part) => part !== city && part !== salary && part !== role) || ''
  return { expectCity: city, expectRole: role, expectSalary: salary, expectIndustry: industry }
}

const extract = (record) => {
  const lines = String(record.block || '').split('\n').map((line) => line.trim()).filter(Boolean)
  const expectIdx = lines.indexOf('期望：')
  const expect = expectIdx > -1 ? parseExpect(lines, expectIdx, lines.length) : { expectCity: '', expectRole: '', expectSalary: '', expectIndustry: '' }

  const dateIdx = lines.findIndex((line) => /^\d{4}\.\d{2}\s*-\s*/.test(line))
  let recent = ''
  let recentPeriod = ''
  if (dateIdx > 0) {
    recentPeriod = lines[dateIdx]
    // 日期行之前若干行是公司名与职位名（DOM 把它们拆成了多行），拼起来读。
    const before = lines.slice(Math.max(0, dateIdx - 4), dateIdx)
      .filter((line) => !SALARY_RE.test(line) && !/^期望：/.test(line) && line.length > 1)
    recent = before.join('')
  }

  const schoolLine = lines.find((line) => /(大学|学院|学校)/.test(line) && line.length <= 20 && !NOT_A_NAME.has(line)) || ''
  return { ...expect, recent, recentPeriod, schoolLine }
}

const seen = new Map()
for (const source of SOURCES) {
  if (!fs.existsSync(source.path)) continue
  const data = JSON.parse(fs.readFileSync(source.path, 'utf8'))
  for (const record of data.matches) {
    const name = String(record.name || '').trim()
    if (!name || NOT_A_NAME.has(name)) continue
    const key = `${name}|${record.age}|${String(record.city || '').trim()}`
    if (seen.has(key)) {
      const existing = seen.get(key)
      if (!existing.skills.includes(source.skill)) existing.skills.push(source.skill)
      continue
    }
    seen.set(key, { ...record, name, ...extract(record), skills: [source.skill] })
  }
}

const all = [...seen.values()].sort((a, b) => {
  const cityA = a.city.startsWith('上海') ? 0 : 1
  const cityB = b.city.startsWith('上海') ? 0 : 1
  if (cityA !== cityB) return cityA - cityB
  return (a.expYears || 0) - (b.expYears || 0) || String(a.name).localeCompare(String(b.name))
})

const inShanghai = all.filter((r) => r.city.startsWith('上海'))
const wantShanghai = all.filter((r) => r.expectCity === '上海')

const md = []
md.push('# 猎聘前端开发候选人清单')
md.push('')
md.push('**检索条件**：期望/目前城市含「上海」· 经验 3-5 年 · 本科 · 关键词含「前端」+ React 或 Vue')
md.push('')
md.push(`**采集时间**：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}　|　**共 ${all.length} 位**（目前在上海 ${inShanghai.length} 位，期望上海 ${wantShanghai.length} 位）`)
md.push('')
md.push('| # | 姓名 | 年龄 | 经验 | 目前城市 | 期望城市 | 期望职位 | 期望薪资 | 期望行业 | 毕业院校 | 最近一段经历 | 技能 |')
md.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
all.forEach((record, index) => {
  const cells = [
    index + 1,
    record.name,
    record.age,
    record.expRaw,
    record.city,
    record.expectCity || '-',
    record.expectRole || '-',
    record.expectSalary || '-',
    record.expectIndustry || '-',
    record.schoolLine || '-',
    record.recent ? `${record.recent} ${record.recentPeriod}`.trim() : '-',
    record.skills.join('/')
  ]
  md.push('| ' + cells.map((cell) => String(cell).replace(/\|/g, '/').trim()).join(' | ') + ' |')
})
md.push('')
md.push('> 说明：姓名由猎聘脱敏（`李**`）。技能列表示该候选人是在 Vue 还是 React 关键词检索中命中的，')
md.push('> 具体技术栈仍需打开简历确认。数据由薪招扩展经本地网关驱动用户浏览器实时检索所得。')
md.push('')

fs.writeFileSync(OUT_PATH, md.join('\n'))

console.log(`共 ${all.length} 位候选人（目前在上海 ${inShanghai.length}，期望上海 ${wantShanghai.length}）`)
console.log(`已写入 ${OUT_PATH}\n`)
all.forEach((record, index) => {
  console.log(`${String(index + 1).padStart(2)}. ${record.name}  ${record.age}岁  ${record.expRaw}  ${record.city}  期望:${record.expectCity}${record.expectRole}${record.expectSalary ? ' ' + record.expectSalary : ''}  [${record.expectIndustry}]  ${record.schoolLine || ''}  ${record.recent}${record.recentPeriod ? ' ' + record.recentPeriod : ''}  (${record.skills.join('/')})`)
})
