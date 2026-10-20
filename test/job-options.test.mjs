import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jobPublishedChannels, jobSourcingPlatforms, readJobOptions } from '../dist/lib/job-options.js'
import { readSourcingPosition } from '../dist/lib/sourcing-position.js'

test('job channel metadata determines supported sourcing platforms without adding platform requests', async () => {
  const calls = []
  const rows = [
    { jobId: 'liepin', name: 'Java', hireStatus: 0, channelType: [{ 4: '猎聘' }, { 34: '猎头' }] },
    { jobId: 'boss', name: '设计师', hireStatus: 0, channelType: [{ 11: 'BOSS直聘' }] },
    { jobId: 'both', name: '产品经理', hireStatus: 0, channelType: [{ 11: 'BOSS直聘' }, { 4: '猎聘' }, { 4: '猎聘' }] },
    { jobId: 'none', name: '未对接', hireStatus: 0, channelType: [] },
    { jobId: 'unknown', name: '缺少渠道', hireStatus: 0 },
  ]
  const options = await readJobOptions({ call: async (...args) => { calls.push(args); return { ok: true, data: { p: 1, count: rows.length, data: rows } } } })
  assert.deepEqual(options.map(job => job.platforms), [['liepin'], ['boss'], ['liepin', 'boss'], [], []])
  assert.deepEqual(options[0].publishedChannels, [{ id: '4', name: '猎聘' }, { id: '34', name: '猎头' }])
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'jobList'); assert.deepEqual(calls[0][1], { p: 1, pn: 100, hireStatus: 0 })
  const position = await readSourcingPosition({ call: async () => ({ ok: true, data: { jobId: 'boss', jobDesc: '设计工作' } }) }, 'boss', options)
  assert.deepEqual(position.platforms, ['boss'])
  assert.deepEqual(position.publishedChannels, [{ id: '11', name: 'BOSS直聘' }])
})

test('published channels retain the main-system column including internal, portal, agency and custom channels', async () => {
  const channels = [{ 20: '内部推荐' }, { 21: '招聘门户' }, { 34: '猎头' }, { 10: '脉脉' }, { 31214: '自定义发布渠道' }]
  const published = jobPublishedChannels(channels)
  assert.deepEqual(published, [{ id: '20', name: '内部推荐' }, { id: '21', name: '招聘门户' }, { id: '34', name: '猎头' }, { id: '10', name: '脉脉' }, { id: '31214', name: '自定义发布渠道' }])
  assert.deepEqual(jobSourcingPlatforms(channels), [], 'displayed publishing channels do not grant browser automation capability')
  const position = await readSourcingPosition({ call: async () => ({ ok: true, data: { jobId: 'one', jobDesc: '职位描述' } }) }, 'one', [{ id: 'one', name: 'Java', publishedChannels: [{ id: '4', name: '猎聘' }], platforms: ['boss'] }])
  assert.deepEqual(position.platforms, ['liepin'], 'the current main-system column takes precedence over a stale platform projection')
})

test('invalid or unrelated channel metadata never grants sourcing access', () => {
  for (const channels of [undefined, null, {}, [4, 11], [{ 4: null }], [{ 34: '猎头' }, { 20: '内部推荐' }]]) assert.deepEqual(jobSourcingPlatforms(channels), [])
  assert.deepEqual(jobSourcingPlatforms([{ 11: 'BOSS直聘' }, null, '4', { 4: '猎聘' }]), ['liepin', 'boss'])
})
