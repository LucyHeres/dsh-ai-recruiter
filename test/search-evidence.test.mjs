import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertSearchEvidence } from '../dist/lib/search-evidence.js'
import { createGreetingJob } from '../dist/lib/greeting-policy.js'
import { greetingEntry } from '../dist/shared/workbench.js'

const query = { keyword: 'java开发工程师', city: '北京', ageUnder: 35, experienceMin: 5, experienceMax: 10 }
const page = () => ({ url: 'https://lpt.liepin.com/search', snapshotId: 'search', items: [
  { ref: 'keyword', role: 'textbox', name: '关键词', value: query.keyword },
  { ref: 'city', role: 'option', name: '北京', states: ['selected'] },
  { ref: 'age', role: 'option', name: '35岁以下', states: ['selected'] },
  { ref: 'experience', role: 'option', name: '5-10年', states: ['selected'] },
] })
const evidence = [
  { field: 'keyword', ref: 'keyword', quote: query.keyword },
  { field: 'city', ref: 'city', quote: '北京' },
  { field: 'ageUnder', ref: 'age', quote: '35岁以下' },
  { field: 'experienceMin', ref: 'experience', quote: '5-10年' },
  { field: 'experienceMax', ref: 'experience', quote: '5-10年' },
]

test('search requires evidence for every requested active condition', () => {
  assert.doesNotThrow(() => assertSearchEvidence(page(), query, evidence))
  for (const field of Object.keys(query)) assert.throws(() => assertSearchEvidence(page(), query, evidence.filter(item => item.field !== field)), /SEARCH_CONDITIONS_UNVERIFIED/)
})

test('unselected options, wrong age bounds, broadened experience and recommendation pages cannot authorize search greetings', () => {
  const cases = [
    observed => { observed.items[1].states = [] },
    observed => { observed.items[2].name = '35岁以上' },
    observed => { observed.items[3].name = '3-10年' },
    observed => { observed.url = 'https://lpt.liepin.com/recommend' },
  ]
  for (const change of cases) {
    const observed = page(); change(observed)
    assert.throws(() => assertSearchEvidence(observed, query, evidence), /SEARCH_CONDITIONS_UNVERIFIED/)
  }
})

test('recommendation and search have separate validated task inputs and entry pages', () => {
  const input = { id: 'b0703f6a-c183-4be5-8cda-5a8ceebae39e', platform: 'liepin', limit: 2, confirmed: true }
  assert.equal(greetingEntry(createGreetingJob(input)), 'https://lpt.liepin.com/recommend')
  assert.equal(greetingEntry(createGreetingJob({ ...input, mode: 'search', search: query })), 'https://lpt.liepin.com/search')
  for (const invalid of [{ mode: 'search' }, { mode: 'recommend', search: query }, { mode: 'search', search: query, platform: 'boss' }]) {
    assert.throws(() => createGreetingJob({ ...input, ...invalid }))
  }
})
