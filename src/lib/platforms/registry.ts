import type { Platform } from '../../shared/workbench.js'
import type { RecruitmentPlatform } from './types.js'
import { liepinPlatform } from './liepin/index.js'
import { bossPlatform } from './boss/index.js'

const platforms: Record<Platform, RecruitmentPlatform> = { liepin: liepinPlatform, boss: bossPlatform }
export const recruitmentPlatform = (platform: Platform): RecruitmentPlatform => platforms[platform]
