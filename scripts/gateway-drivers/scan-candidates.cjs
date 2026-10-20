#!/usr/bin/env node
'use strict'

// 滚动采集猎聘搜索结果里的候选人，解析成结构化记录并按条件筛选。
//
//   node scripts/gateway-drivers/scan-candidates.cjs <tabId> [滚动次数]
//
// 只看命中结果，不把整页文本读进上下文。

const PORT = require('../../browser-agent-gateway/config.cjs').port()
const BASE = `http://127.0.0.1:${PORT}`
const ORIGINS = [
  'https://lpt.liepin.com',
  'https://www.liepin.com',
  'https://c.liepin.com',
  'https://passport.liepin.com',
  'https://safe.liepin.com',
  'http://127.0.0.1:5030'
]

const TAB_ID = Number(process.argv[2])
const ROUNDS = Number(process.argv[3] || 8)

// 期望条件：上海 · 3-5年 · 本科 · React/Vue
const WANT_CITY = '上海'
const WANT_EXP = [3, 5]
const WANT_EDU = '本科'
const SKILL_TOKENS = [
  ['react', /\breact\b|react框架|react\.js|reactjs/i],
  ['vue', /\bvue\b|vue\.js|vuejs|vue3|vue2/i],
  ['typescript', /typescript|\bts\b/i],
  ['javascript', /javascript|\bjs\b|es6/i],
  ['webpack', /webpack/i],
  ['vite', /vite/i],
  ['node', /\bnode\.?js\b|\bnode\b/i],
  ['uniapp', /uniapp|uni-app/i],
  ['小程序', /小程序/],
  ['echarts', /echarts/i],
  ['next.js', /next\.js|nextjs/i],
  ['angular', /angular/i],
  ['flutter', /flutter/i],
  ['html5', /html5/i],
  ['css3', /css3/i]
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const call = async (capability, input, risk) => {
  const response = await fetch(`${BASE}/api/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      capability,
      input,
      policy: { allowedOrigins: ORIGINS, ...(risk ? { riskLevel: risk } : {}) },
      timeoutMs: 45000
    })
  })
  const body = await response.json()
  if (!body.ok) throw new Error(`${capability}: ${body.error?.code} ${body.error?.message || ''}`)
  if (body.data.status !== 'succeeded') throw new Error(`${capability}: ${JSON.stringify(body.data.error)}`)
  return body.data.output
}

const parseCandidates = (text) => {
  const lines = String(text || '').split('\n').map((line) => line.trim())
  const records = []
  for (let i = 1; i < lines.length; i += 1) {
    if (!/^\d+岁$/.test(lines[i])) continue
    const name = lines[i - 1]
    // 姓名形如「郭**」「李先生」「王荣鑫」，避免把公司名/职位名误当姓名。
    if (!/^([\u4e00-\u9fa5]{1,4}\*{0,2}|[\u4e00-\u9fa5]{1,3}先生|[\u4e00-\u9fa5]{1,3}女士|[A-Za-z][A-Za-z .]{0,15})$/.test(name)) continue
    const age = Number(lines[i].replace('岁', ''))
    const expRaw = lines[i + 1] || ''
    const edu = lines[i + 2] || ''
    const city = lines[i + 3] || ''
    if (!/^(本科|硕士|大专|博士|中专|高中|MBA)/.test(edu)) continue

    let end = i
    while (end < lines.length && lines[end] !== '立即沟通' && lines[end] !== '隐藏') end += 1
    const block = lines.slice(i - 1, end).join('\n')

    const expectIdx = lines.indexOf('期望：', i)
    const expectLine = expectIdx > -1 && expectIdx < end ? lines[expectIdx + 1] || '' : ''
    const industry = expectIdx > -1 && expectIdx + 2 < end ? lines[expectIdx + 2] || '' : ''

    // 技能行：期望职位行之后、第一段工作经历之前的内容
    const afterExpect = lines.slice(expectIdx + 3, Math.min(end, expectIdx + 10))
    const skillsShown = afterExpect.filter((line) =>
      line && !/\d{4}\.\d{2}/.test(line) && !/^(在线|今天活跃|昨日活跃|本周活跃)$/.test(line) && line.length <= 30)

    const expYears = /^(\d+)年$/.exec(expRaw) ? Number(RegExp.$1) : (/毕业/.test(expRaw) ? 0 : NaN)

    const skills = SKILL_TOKENS.filter(([, pattern]) => pattern.test(block)).map(([label]) => label)
    records.push({ name, age, expRaw, expYears, edu, city, expectLine, industry, skillsShown, skills, block })
  }
  return records
}

// 翻页：快照里找页码链接，取最靠下的那个（分页在页面底部）。
const gotoPage = async (pageNumber) => {
  const output = await call('browser.snapshot', { tabId: TAB_ID })
  const candidates = output.items
    .filter((item) => String(item.name || '').trim() === String(pageNumber))
    .sort((a, b) => (b.bounds?.y || 0) - (a.bounds?.y || 0))
  const target = candidates[0]
  if (!target) throw new Error(`找不到第 ${pageNumber} 页的翻页入口`)
  await call('browser.click', {
    tabId: TAB_ID,
    snapshotId: output.snapshotId,
    documentId: output.documentId,
    ref: target.ref
  }, 'browser_mutation')
  await sleep(2200)
}

const main = async () => {
  if (!TAB_ID) {
    console.error('用法： node scripts/gateway-drivers/scan-candidates.cjs <tabId> [每页屏数] [页数]')
    process.exit(1)
  }

  const VIEWPORTS = ROUNDS
  const PAGES = Number(process.argv[4] || 1)

  const byKey = new Map()
  for (let page = 1; page <= PAGES; page += 1) {
    if (page > 1) await gotoPage(page)
    await call('browser.scroll', { tabId: TAB_ID, deltaY: -30000 }, 'browser_mutation')
    await sleep(1500)

    for (let round = 0; round < VIEWPORTS; round += 1) {
      // viewportOnly: 整页 innerText 会被扩展截断在 ~4600 字（约 20 位候选人），
      // 而且不随滚动变化；只有视口文本才能靠滚动逐屏取到新内容。
      const output = await call('browser.snapshot', { tabId: TAB_ID, includeText: true, viewportOnly: true })
      for (const record of parseCandidates(output.text)) {
        const key = `${record.name}|${record.age}|${record.city}`
        if (!byKey.has(key)) byKey.set(key, record)
      }
      process.stdout.write(`\r第 ${page}/${PAGES} 页 · 第 ${round + 1}/${VIEWPORTS} 屏 · 已采集 ${byKey.size} 位…`)
      if (round < VIEWPORTS - 1) {
        await call('browser.scroll', { tabId: TAB_ID, deltaY: 700 }, 'browser_mutation')
        await sleep(1300)
      }
    }
  }
  process.stdout.write('\n\n')

  const all = [...byKey.values()]
  const cityOk = all.filter((r) => r.city.startsWith(WANT_CITY) || r.expectLine.startsWith(WANT_CITY))
  const eduOk = cityOk.filter((r) => r.edu === WANT_EDU)
  const expOk = eduOk.filter((r) => Number.isFinite(r.expYears) && r.expYears >= WANT_EXP[0] && r.expYears <= WANT_EXP[1])
  const matches = expOk

  console.log(`采集总数: ${all.length}`)
  console.log(`筛选漏斗: 上海 ${cityOk.length} → 本科 ${eduOk.length} → 3-5年 ${expOk.length}`)
  console.log(`命中: ${matches.length}\n`)

  // 落盘，避免重跑（一次扫描要 2-3 分钟，而且会消耗页面的翻页状态）。
  const fs = require('fs')
  const outPath = process.env.SCAN_OUT || `/tmp/scan-${Date.now()}.json`
  fs.writeFileSync(outPath, JSON.stringify({
    collectedAt: new Date().toISOString(),
    keyword: process.env.SCAN_KEYWORD || '',
    funnel: { total: all.length, city: cityOk.length, edu: eduOk.length, exp: expOk.length },
    all,
    matches
  }, null, 2))
  console.log(`结果已写入 ${outPath}`)

  const firstJob = (block) => {
    const lines = block.split('\n')
    const idx = lines.findIndex((line) => /\d{4}\.\d{2}/.test(line))
    return idx > 0 ? `${lines[idx - 1]} / ${lines[idx].replace(/\(.*/, '')}` : ''
  }

  matches.forEach((record, index) => {
    console.log(`${String(index + 1).padStart(2)}. ${record.name}  ${record.age}岁  ${record.expRaw}  ${record.edu}  ${record.city}`)
    console.log(`    期望: ${record.expectLine}   [${record.industry}]`)
    console.log(`    技能: ${record.skills.join(', ') || '-'}`)
    if (record.skillsShown.length) console.log(`    标签: ${record.skillsShown.join(' / ')}`)
    console.log(`    最近: ${firstJob(record.block)}`)
    console.log('')
  })

  console.log('--- 分布参考 ---')
  const cityCount = {}
  for (const record of all) cityCount[record.city] = (cityCount[record.city] || 0) + 1
  console.log('城市 Top: ' + Object.entries(cityCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join('  '))
  const eduCount = {}
  for (const record of all) eduCount[record.edu] = (eduCount[record.edu] || 0) + 1
  console.log('学历: ' + Object.entries(eduCount).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join('  '))
  const expCount = {}
  for (const record of all) {
    const label = Number.isFinite(record.expYears) ? `${record.expYears}年` : record.expRaw
    expCount[label] = (expCount[label] || 0) + 1
  }
  console.log('经验: ' + Object.entries(expCount).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join('  '))
}

main().catch((error) => {
  console.error(`\n失败: ${error.message}`)
  process.exit(1)
})
