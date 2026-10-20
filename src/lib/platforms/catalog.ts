import type { Platform } from '../../shared/workbench.js'
import { liepinDefinition } from './liepin/definition.js'
import { bossDefinition } from './boss/definition.js'

const definitions = { liepin: liepinDefinition, boss: bossDefinition }
/** Pure metadata has no imports of browser drivers, avoiding cycles in shared
 * controls and existing workflow verifiers. */
export const platformDefinition = (platform: Platform) => definitions[platform]
