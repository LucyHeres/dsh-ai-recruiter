import assert from 'node:assert/strict'
import { test } from 'node:test'
import { greetingResultRows, taskResultRows } from '../dist/shared/greeting-results.js'
const row = (name, stage, n, extra = {}) => ({ key: `${name}-${n}`, name, stage, detail: `${stage}-${n}`, updatedAt: `2026-10-16T07:00:0${n}Z`, ...extra })
test('historical failed attempts followed by confirmation show two people rather than four attempts', () => {
  const raw = [row('王冠奇', 'failed', 1), row('王冠奇', 'succeeded', 2, { confirmedAt: 'confirmed' }),
    row('沈海斌', 'failed', 3), row('沈海斌', 'succeeded', 4, { confirmedAt: 'confirmed' })]
  const copy = structuredClone(raw), results = greetingResultRows(raw)
  assert.deepEqual(results.map(r => [r.name, r.stage]), [['王冠奇', 'succeeded'], ['沈海斌', 'succeeded']])
  assert.deepEqual(raw, copy, 'display projection must not erase audit data')
})
test('failed person shows the final failure, while later retry is shown as processing', () => {
  assert.equal(greetingResultRows([row('A', 'failed', 1), row('A', 'failed', 2)])[0].detail, 'failed-2')
  assert.equal(greetingResultRows([row('A', 'failed', 1), row('A', 'sending', 2)])[0].stage, 'sending')
})
test('completed greetings remain completed in business projections while raw execution attempts are preserved', () => {
  assert.equal(greetingResultRows([row('A', 'succeeded', 1, { confirmedAt: 'confirmed' }), row('A', 'failed', 2)])[0].stage, 'succeeded')
  assert.equal(greetingResultRows([row('A', 'succeeded', 1), row('A', 'unknown', 2)])[0].stage, 'succeeded')
})
test('distinct verified profile identities with the same name are not collapsed into the wrong person', () => {
  const results = greetingResultRows([row('张先生', 'failed', 1, { key: 'profile-1', identityKind: 'url' }),
    row('张先生', 'succeeded', 2, { key: 'profile-2', identityKind: 'url', confirmedAt: 'confirmed' }),
    row('张先生', 'succeeded', 3, { key: 'profile-1', identityKind: 'url', confirmedAt: 'confirmed' })])
  assert.equal(results.length, 2); assert.ok(results.every(r => r.stage === 'succeeded'))
})
test('same stable identity remains one row when its display name changes; resume records are unaffected', () => {
  assert.equal(greetingResultRows([row('林先生', 'failed', 1, { key: 'same' }), row('林某', 'succeeded', 2, { key: 'same', confirmedAt: 'confirmed' })]).length, 1)
  const rows = [row('A', 'failed', 1), row('A', 'succeeded', 2)]
  assert.equal(taskResultRows({ kind: 'resume_import', results: rows }), rows)
})
test('two independently confirmed people with the same display name keep their own outcomes', () => {
  assert.equal(greetingResultRows([row('张先生', 'succeeded', 1, { confirmedAt: 'confirmed' }),
    row('张先生', 'succeeded', 2, { confirmedAt: 'confirmed' })]).length, 2)
})

test('different observed platform IDs preserve separate same-name greeting rows',()=>{
 const rows=['resumeA123','resumeB456'].map((id,i)=>({key:id,name:'张先生',identityKind:'platform_id',platformIdentity:{kind:'resume',id,source:'card_class'},stage:'succeeded',updatedAt:String(i),detail:'clicked'}))
 assert.equal(greetingResultRows(rows).length,2)
})
