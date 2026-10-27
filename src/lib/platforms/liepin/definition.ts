import type { PlatformDefinition } from '../types.js'

/** 猎聘：入口路径、招呼按钮文案、沟通列表语义与收到简历列表规则。
 *  这里只有纯元数据和纯页面判断，组件选择器留在驱动里。 */
export const liepinDefinition: PlatformDefinition = {
  sourcingEntry: 'https://lpt.liepin.com/recommend',
  sourcingSearchEntry: 'https://lpt.liepin.com/search',
  receivedEntry: 'https://lpt.liepin.com/resume/apply',
  listPaths: ['/recommend', '/search', '/resume/apply'],
  receivedTab: '收到简历',
  greetingLabels: new Set(['立即沟通']),
  communication: {
    entries: ['https://lpt.liepin.com/chat/im'],
    filters: { all: ['全部', '全部沟通'], greeted: [], resume_received: ['有简历'] },
    scope: page => {
      const url = new URL(page.url)
      if (url.pathname === '/resume/apply' && (/收到简历|已收简历/.test(page.title ?? '')
        || (page.selectedTabs ?? []).some((tab: any) => /^(?:收到简历|已收简历)$/.test(tab.name)))) return 'received_list'
      if (url.pathname === '/chat/im') return 'chat'
    },
    // 入口卡片包装类带不透明简历 key；收到简历列表的包装类带行号后缀。
    identity: (node: any, source) => {
      const classes = String(node?.attributes?.class ?? '').split(/\s+/)
      const tokens: string[] = []
      if (classes.includes('xpath-resume-item-wrap')) for (const token of classes) {
        const id = /^xpath-resume-item-wrap-([A-Za-z0-9_-]{8,160})$/.exec(token)?.[1]
        if (id) tokens.push(`resume:${id}`)
      }
      if (source === 'received_list' && classes.includes('manager-resume-card-item-new')) for (const token of classes) {
        const id = /^resume-item-wrap-([A-Za-z0-9_-]{8,160})_\d+$/.exec(token)?.[1]
        if (id) tokens.push(`resume:${id}`)
      }
      return tokens
    },
    receivedWrapper: 'manager-resume-card-item-new',
  },
  greeting: { requireDirectButton: true },
  // 推荐页职位 tab 会带「高交付」后缀，只在 /recommend 生效。
  positionAlias: { suffix: '高交付', path: '/recommend' },
  receivedResumes: { receivedPath: '/resume/apply', requiredTab: '收到简历', allPositionsElementId: 'ejobId',
    guidance: '猎聘从「人才管理 → 收到简历」tab 处理，platformJobName 是可选的平台列表职位筛选，不等于薪人薪事的入库目标职位。提供 platformJobName 时，先设置对应筛选，再用 task_confirm_source_position 引用当前选中值；不能引用尚未选中的选项。不提供时不擅自按薪人薪事目标职位筛选。条件确认后交回平台预设连续处理详情和附件，不逐人重复规划。' },
}
