import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectedResumePosition } from '../dist/lib/resume-position.js'

test('a closed liepin source selector uses its observed parent selection label, not the typed query', () => {
  const page = { items: [
    { ref: 'source', role: 'combobox', elementId: 'ejobId', parentRef: 'selection', value: '', states: ['enabled', 'editable', 'collapsed'] },
    { ref: 'selection', role: 'div', name: '全部职位' },
  ] }
  assert.equal(selectedResumePosition(page, '全部职位')?.ref, 'source')
  assert.equal(selectedResumePosition(page, 'Java开发'), undefined)
  page.items[1].name = 'Java开发'
  assert.equal(selectedResumePosition(page, '全部职位'), undefined)
  assert.equal(selectedResumePosition(page, 'Java开发')?.ref, 'source')
  page.items[0].states = ['enabled', 'editable', 'expanded']
  page.items[0].value = 'Java开发'
  assert.equal(selectedResumePosition(page, 'Java开发'), undefined)
})

test('background source filters and duplicate controls cannot authorize a source position', () => {
  const option = { ref: 'position', role: 'option', name: 'Java开发', states: ['selected'] }
  assert.equal(selectedResumePosition({ items: [option] }, 'Java开发')?.ref, 'position')
  assert.equal(selectedResumePosition({ items: [{ ...option, states: ['selected', 'blocked_by_dialog'] }] }, 'Java开发'), undefined)
  assert.equal(selectedResumePosition({ items: [option, { ...option, ref: 'second' }] }, 'Java开发'), undefined)
})

test('the real liepin received-resume selector verifies from its container when AX omits collapsed', () => {
  // 实测契约（2026-10-17 只读快照，lpt.liepin.com/resume/apply）：
  //   ref_143  div      name="全部职位"  bounds{188,70,180,32}
  //     └ ref_21 combobox input elementId="ejobId" value="" parentRef=ref_143
  //   DOM 快照: states=[enabled,editable,collapsed,occluded]
  //   语义(AX) 快照: states=[occluded] —— 没有 collapsed、也不给 value
  // 旧实现要求 combobox 带 collapsed 且只检查被引用的那个元素，于是无论指向
  // 容器还是 input 都无法通过，核验变成死局。
  const dom = { items: [
    { ref: 'selection', role: 'div', name: '全部职位', tagName: 'div' },
    { ref: 'ejobId', role: 'combobox', tagName: 'input', elementId: 'ejobId', parentRef: 'selection', value: '', states: ['enabled', 'editable', 'collapsed', 'occluded'] },
  ] }
  const semantic = { items: [
    { ref: 'selection', role: 'div', name: '全部职位', tagName: 'div' },
    { ref: 'ejobId', role: 'combobox', tagName: 'input', elementId: 'ejobId', parentRef: 'selection', value: '', states: ['occluded'] },
  ] }
  for (const page of [dom, semantic]) {
    assert.equal(selectedResumePosition(page, '全部职位')?.ref, 'ejobId', '无 ref 时按页面整体核对')
    assert.equal(selectedResumePosition(page, '全部职位', 'ejobId')?.ref, 'ejobId', '引 input 也要通过')
    assert.equal(selectedResumePosition(page, '全部职位', 'selection')?.ref, 'selection', '引容器也要通过')
    assert.equal(selectedResumePosition(page, 'python开发工程师'), undefined, '不匹配的职位不能通过')
  }
})
