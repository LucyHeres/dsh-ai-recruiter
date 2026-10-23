import type { PlatformDefinition } from '../types.js'
import { BOSS_RESUME_IMPORT_ROUTE } from './ai-route.js'

/** BOSS 直聘：固定推荐/沟通路径与招呼按钮文案。
 *  职位筛选、卡片与详情结构由固定驱动处理，这里只保留跨流程共享的语义。 */
export const bossDefinition: PlatformDefinition = {
  sourcingEntry: 'https://www.zhipin.com/web/chat/recommend',
  // 推荐列表在原页面内的同源 iframe 中，不能把该文档作为顶层页打开。
  sourcingEntryAliases: ['https://www.zhipin.com/web/frame/recommend'],
  receivedEntry: 'https://www.zhipin.com/web/chat/index',
  listPaths: ['/web/chat/recommend', '/web/chat/index', '/web/frame/recommend'],
  // 已收简历在「沟通 → 已获取简历」tab，不在人才管理或推荐牛人。
  receivedTab: '已获取简历',
  greetingLabels: new Set(['立即沟通', '打招呼', '立即打招呼', '聊一聊']),
  communication: {
    entries: ['https://www.zhipin.com/web/chat/index'],
    scope: page => new URL(page.url).pathname === '/web/chat/index' ? 'chat' : undefined,
  },
  receivedResumes: { receivedPath: '/web/chat/index', requiredTab: '已获取简历', guidance: BOSS_RESUME_IMPORT_ROUTE },
}
