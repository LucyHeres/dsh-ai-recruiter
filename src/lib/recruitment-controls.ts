import type { Platform } from '../shared/workbench.js'
import { platformDefinition } from './platforms/catalog.js'
export const greetingLabels = (platform: Platform) => platformDefinition(platform).greetingLabels
export const completedGreetingLabels = new Set(['已沟通', '继续沟通', '已打招呼', '已发送'])
