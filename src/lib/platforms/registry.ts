import type { Platform } from '../../shared/workbench.js'
import type { RecruitmentPlatform } from './types.js'
import { liepinPlatform } from './liepin/index.js'
import { bossPlatform } from './boss/index.js'
import { platformDefinition } from './catalog.js'

const implementations: Record<Platform, RecruitmentPlatform> = { liepin: liepinPlatform, boss: bossPlatform }
/** 组装执行器与纯元数据能力：definition 里的 greeting/receivedResumes 能力
 *  自动生效，新增平台不需要在调用侧补分支。
 *  每个平台只组装一次，调用方拿到的始终是同一个实例。 */
const platforms = Object.fromEntries((Object.keys(implementations) as Platform[]).map(platform => {
  const definition = platformDefinition(platform)
  return [platform, { ...implementations[platform], greeting: definition.greeting, receivedResumes: definition.receivedResumes }]
})) as Record<Platform, RecruitmentPlatform>
export const recruitmentPlatform = (platform: Platform): RecruitmentPlatform => platforms[platform]
