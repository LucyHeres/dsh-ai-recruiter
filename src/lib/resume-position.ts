import { itemText, normalized, statesOf } from './page-actions.js'

const UNREADABLE = ['hidden', 'invisible', 'blocked_by_dialog']
const readable = (item: any) => item?.ref && !statesOf(item).some(state => UNREADABLE.includes(state))

/** 平台职位筛选的可见文案可能渲染在容器上，真正的值在一个空的 search input 里。 */
function parentChain(items: any[], item: any) {
  const chain: any[] = []
  const seen = new Set<string>()
  let parent = items.find(candidate => candidate.ref === item?.parentRef)
  while (parent && !seen.has(parent.ref)) {
    chain.push(parent)
    seen.add(parent.ref)
    parent = items.find(candidate => candidate.ref === parent.parentRef)
  }
  return chain
}

/**
 * 当前平台职位筛选是否为期望值。
 *
 * 真实页面（猎聘「收到简历」）的筛选是 rc-select：可见文案「全部职位」挂在容器 div 上，
 * 值所在的 `<input id="ejobId">` 是空的 search input，语义(AX) 快照对它可能只给
 * `occluded`、不给 `collapsed`。也就是说证据**跨两个元素**，只检查其中一个必然失败：
 * 指向 input 缺 `collapsed`，指向容器又不是 combobox。这里同时接受两种形态。
 */
export function selectedResumePosition(page: any, name: string, ref?: string) {
  const expected = normalized(name).toLocaleLowerCase()
  if (!expected) return undefined
  const items: any[] = Array.isArray(page?.items) ? page.items : []
  const text = (item: any) => normalized(itemText(item)).toLocaleLowerCase()
  const isCombobox = (item: any) => item?.role === 'combobox'
  // 容器形态：容器自己写着期望值，并且包含一个下拉控件——这才说明它是筛选容器，
  // 而不是恰好同名的标题或卡片。下拉处于展开态时容器文案可能只是刚输入的关键词或
  // 展开的选项列表，因此不作为已选证据。
  const enclosesClosedCombobox = (container: any) => items.some(item => isCombobox(item)
    && !statesOf(item).includes('expanded')
    && parentChain(items, item).some(parent => parent.ref === container.ref))
  const candidates = items.filter(item => (ref ? item.ref === ref : true) && readable(item))
  // 直接控件证据优先：combobox 自己的父级标签/取值，或带选中态的选项/标签。
  const controls = candidates.filter(item => {
    const states = statesOf(item)
    const selected = states.some(state => ['selected', 'checked', 'current'].includes(state))
    if (selected && ['option', 'combobox', 'button', 'tab'].includes(item.role)) return text(item).includes(expected)
    if (!isCombobox(item)) return false
    // 展开中的下拉不能证明当前值；是否 `collapsed` 不作要求——部分快照不给这个状态。
    if (states.includes('expanded')) return false
    if (parentChain(items, item).some(parent => normalized(parent.name).toLocaleLowerCase() === expected)) return true
    return !states.includes('editable') && normalized(item.value).toLocaleLowerCase() === expected
  })
  if (controls.length) return controls.length === 1 ? controls[0] : undefined
  // 兜底：可见文案在容器上、值在容器内的空 search input 里（rc-select 常见形态）。
  // 容器必须包含一个未展开的下拉控件，否则同名的标题或卡片会被误判。
  const containers = candidates.filter(item => text(item).includes(expected) && enclosesClosedCombobox(item))
  return containers.length === 1 ? containers[0] : undefined
}
