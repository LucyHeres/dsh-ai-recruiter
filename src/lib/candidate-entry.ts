/** 平台预设使用的保守候选人身份解析，同时保留历史去重键兼容与失败现场诊断。
 * 不符合预设的页面交给模型理解，模型选人不受本模块识别规则限制。
 */

/** 简历列表里出现的导航、页签与容器文案；这些不是候选人。 */
const NAVIGATION_LABELS = new Set([
  '人才推荐', '推荐人才', '已收简历', '收到的简历', '收到简历', '已收附件',
  '简历管理', '简历库', '人才库', '全部简历', '我的简历', '附件简历',
  '筛选', '排序', '搜索', '更多', '展开', '收起', '下一页', '上一页', '下页', '首页', '末页',
])

/** 只有这些角色的元素才可能是"一个候选人条目"。 */
const CANDIDATE_ROLES = ['button', 'link', 'listitem', 'row', 'option', 'tab', 'cell', 'treeitem', 'div', 'li']

export interface CandidateEntry {
  /** 页面元素引用，用于点击。 */
  ref: string
  /** 归一化后的身份文本（去掉活跃状态噪声），用于幂等键。 */
  identity: string
  /** 展示用姓名。 */
  name: string
}

const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim()

/** 去掉平台附加的活跃状态，避免同一人因状态变化被当成两个人。 */
const stripActivity = (value: string) => value
  .replace(/刚刚活跃|今天活跃|\d+分钟前活跃|\d+小时前活跃|\d+天内活跃|近期活跃|本周活跃|最近活跃|最近关注|未读|已读/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

/**
 * 是否命中导航/页签文案。
 *
 * 精确比对而不是包含匹配：真实候选人的卡片文本很长，可能恰好含有这些词；
 * 而导航元素的**整个**可访问名通常就是这几个字（或后面只跟少量后缀）。
 */
function isNavigationLabel(identity: string): boolean {
  if (NAVIGATION_LABELS.has(identity)) return true
  // 「人才推荐 附件简历」这类由导航文案 + 简历字样拼成的容器名。
  for (const label of NAVIGATION_LABELS) {
    if (identity.startsWith(label) && identity.length <= label.length + 12) return true
  }
  return false
}

/** 姓名：优先"X先生/女士/同学"，其次"两字以上姓名 + 年龄/学历"开头。 */
function readName(body: string): string | null {
  const titled = /([\u4e00-\u9fa5A-Za-z·]{1,12}(?:先生|女士|同学))/.exec(body)
  if (titled) return titled[1]
  const leading = /^([\u4e00-\u9fa5A-Za-z·]{2,12})(?=\s|\d)/.exec(body)
  // 纯数字/纯符号前缀不是姓名。
  return leading && /[\u4e00-\u9fa5A-Za-z]/.test(leading[1]) ? leading[1] : null
}

/** 学历：页面给出的最高一项。 */
const readDegree = (body: string) => /(博士|硕士|本科|大专|中专|高中)/.exec(body)?.[1] ?? null
/** 年龄：两位数字 + 岁。 */
const readAge = (body: string) => /\d{2}岁/.exec(body)?.[0] ?? null
/** 经历：工作年限、毕业年份或应届。 */
const readExperience = (body: string) => /(\d+(?:-\d+)?年(?:经验|工作经验)|工作\d+年|\d{4}年毕业|应届)/.exec(body)?.[0] ?? null

/**
 * 把一个列表元素判定为候选人；不合格返回原因而不是硬抛，便于调用方决定跳过还是停止。
 *
 * 身份特征要求：必须有姓名，且学历/年龄/经历中至少命中两项——只有"简历"字样的
 * 容器、页签和导航文案一律不算候选人。
 */
export function readCandidate(rawName: unknown, role?: unknown): { candidate?: CandidateEntry; reason?: string } {
  const identity = stripActivity(normalize(rawName))
  if (!identity) return { reason: '元素没有可读文本' }
  if (role && !CANDIDATE_ROLES.includes(String(role))) return { reason: `元素角色 ${String(role)} 不是候选人条目` }
  if (isNavigationLabel(identity)) return { reason: `命中导航/页签文案「${identity.slice(0, 12)}」，不是候选人` }
  if ([...identity.matchAll(/\d{2}\s*岁/g)].length > 1) return { reason: '条目包含多位候选人，不能作为单人入口' }
  const name = readName(identity)
  if (!name) return { reason: '无法从条目中读出姓名' }
  if (['div', 'li'].includes(String(role)) && !identity.startsWith(name)) return { reason: '容器未以候选人姓名开头，不能作为单人入口' }
  const signals = [readDegree(identity), readAge(identity), readExperience(identity)].filter(Boolean)
  if (signals.length < 2) {
    return { reason: `「${name}」缺少可核验的身份特征（需要学历/年龄/经历中至少两项），不作为候选人` }
  }
  return { candidate: { ref: '', identity, name } }
}

/**
 * 从一页快照里挑出候选人条目。
 *
 * 同一身份只保留一次（去重），避免把同一人的多个 DOM 副本当成多人。
 */
export function readCandidates(items: unknown) {
  const candidates: CandidateEntry[] = []
  const rejected: string[] = []
  const seen = new Set<string>()
  const nativeCards: { candidate: CandidateEntry; bounds: any }[] = []
  const counts = new Map<string, number>()
  const samples: { role: string; text: string; reason: string }[] = []
  const result = () => ({ candidates, rejected, audit: { elementCount: Array.isArray(items) ? items.length : 0,
    reasons: [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    samples: samples.sort((a, b) => Number(/岁|本科|硕士|博士|经验/.test(b.text)) - Number(/岁|本科|硕士|博士|经验/.test(a.text))).slice(0, 5) } })
  if (!Array.isArray(items)) return result()
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    if (typeof entry.ref !== 'string' || !entry.ref) continue
    const enabled = Array.isArray(entry.states) ? !entry.states.includes('disabled') : !(entry.states as any)?.disabled
    if (!enabled) continue
    const states = entry.states as any
    const blocked = Array.isArray(states) ? states.some(state => ['occluded', 'blocked_by_dialog', 'hidden'].includes(state))
      : !!(states?.occluded || states?.blocked_by_dialog || states?.hidden)
    const read = blocked ? { reason: '条目被标记为遮挡或不可见，不能点击' } : readCandidate(entry.name, entry.role)
    if (!read.candidate) {
      rejected.push(read.reason ?? '不可识别')
      const reason = read.reason?.startsWith('命中导航') ? '导航或页签'
        : read.reason?.includes('缺少可核验') ? '身份信息不足（学历、年龄、经历需至少两项）'
        : read.reason?.startsWith('元素角色') ? '非候选人类型的元素'
        : read.reason ?? '不可识别'
      counts.set(reason, (counts.get(reason) ?? 0) + 1)
      // 有界样本，优先保留带身份特征的条目，并去掉重复按钮文案。
      if (samples.length < 500 && !samples.some(sample => sample.text === String(entry.name ?? ''))) samples.push({ role: String(entry.role ?? '未知'), text: String(entry.name ?? ''), reason })
      continue
    }
    if (seen.has(read.candidate.identity)) continue
    seen.add(read.candidate.identity)
    const candidate = { ...read.candidate, ref: entry.ref }
    // 猎聘同一卡片有多层 div；只在同名、身份特征相同且几何上包含时合并。
    // 不把同名但位于不同位置的人合成一人，也不把列表容器当作单人入口。
    if (['div', 'li'].includes(String(entry.role))) {
      const bounds = entry.bounds as any
      const signature = (card: CandidateEntry) => [card.name, readAge(card.identity), readDegree(card.identity), readExperience(card.identity)].join('|')
      const contains = (a: any, b: any) => a && b && [a.x, a.y, a.width, a.height, b.x, b.y, b.width, b.height].every(Number.isFinite)
        && a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
        && a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height
      const existing = nativeCards.find(card => signature(card.candidate) === signature(candidate) && (contains(card.bounds, bounds) || contains(bounds, card.bounds)))
      if (existing) {
        if (candidate.identity.length < existing.candidate.identity.length) {
          candidates.splice(candidates.indexOf(existing.candidate), 1, candidate)
          existing.candidate = candidate; existing.bounds = bounds
        }
        continue
      }
      nativeCards.push({ candidate, bounds })
    }
    candidates.push(candidate)
  }
  return result()
}

