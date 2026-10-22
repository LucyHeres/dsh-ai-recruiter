import assert from 'node:assert/strict'
import { test } from 'node:test'
import { communicationLabels, communicationState, greetingDetail, greetingLabel, hasGreeted } from '../dist/shared/communication.js'
import { greetingOutcome } from '../dist/lib/candidate-identity.js'

test('greeting business labels have exactly two states, including historical projections', () => {
  assert.deepEqual(Object.values(communicationLabels), ['已打招呼', '未打招呼'])
  for (const value of [undefined, 'unknown', 'uncertain', 'none']) assert.equal(communicationState(value), 'none')
  assert.equal(communicationState('recorded'), 'recorded')
})

test('interrupted execution never fabricates a greeting and remains blocked from replay', () => {
  const row = { stage: 'unknown', attemptedAt: 'past', detail: '招呼结果待确认' }
  assert.equal(hasGreeted(row), false)
  assert.equal(greetingLabel(row), '未打招呼')
  assert.doesNotMatch(greetingDetail(row), /待确认|待核对|待核实|未知/)
  assert.equal(greetingOutcome(row), 'uncertain', 'execution protection stays separate from business state')
  assert.equal(row.stage, 'unknown', 'historical execution receipt is not rewritten')
})

test('a click receipt or an observed existing contact establishes greeted independently of delivery', () => {
  for (const row of [{ stage: 'succeeded' }, { stage: 'unknown', clickedAt: 'past' }, { stage: 'skipped', knownContacted: true }]) {
    assert.equal(greetingLabel(row), '已打招呼')
    assert.equal(greetingDetail(row), '已打招呼')
  }
})
