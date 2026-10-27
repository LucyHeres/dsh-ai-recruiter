import { MINIMUM_EXTENSION_VERSION, type ExtensionInstallation, type WorkbenchState } from './workbench.js'

export const EXTENSION_REQUIRED_CODE = 'BROWSER_EXTENSION_NOT_INSTALLED'
export const EXTENSION_UPGRADE_CODE = 'BROWSER_EXTENSION_OUTDATED'
export const EXTENSION_VERSION_UNKNOWN_CODE = 'BROWSER_EXTENSION_VERSION_UNKNOWN'
export const EXTENSION_MISSING_MESSAGE = '尚未安装【薪招】浏览器扩展'
export const EXTENSION_UPGRADE_MESSAGE = `请升级【薪招】浏览器扩展至 ${MINIMUM_EXTENSION_VERSION} 或更高版本`
export const EXTENSION_UNCONFIRMED_MESSAGE = '尚未确认【薪招】浏览器扩展的安装状态'
export const EXTENSION_DESCRIPTION = '浏览器扩展可以为插件提供招聘平台的自动化访问与操作能力。'
export const isExtensionRequired = (error: unknown) => [EXTENSION_REQUIRED_CODE, EXTENSION_UPGRADE_CODE, EXTENSION_VERSION_UNKNOWN_CODE].some(code => String(error instanceof Error ? error.message : error).includes(code))
export const extensionNeedsSetup = (installation: ExtensionInstallation | undefined) => installation?.status === 'not_installed' || installation?.status === 'outdated'
export const extensionSetupMessage = (installation: ExtensionInstallation | undefined) => installation?.status === 'outdated' ? EXTENSION_UPGRADE_MESSAGE : installation?.status === 'unknown' ? EXTENSION_UNCONFIRMED_MESSAGE : EXTENSION_MISSING_MESSAGE

/** Chrome extension versions contain up to four numeric components, compared numerically. */
export function extensionVersionStatus(version: unknown): 'installed' | 'outdated' | 'unknown' {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(version)) return 'unknown'
  const parts = version.split('.').map(Number)
  if (parts.some(part => !Number.isSafeInteger(part) || part > 65535)) return 'unknown'
  const minimum = MINIMUM_EXTENSION_VERSION.split('.').map(Number)
  for (let i = 0; i < 4; i++) {
    const difference = (parts[i] ?? 0) - (minimum[i] ?? 0)
    if (difference) return difference > 0 ? 'installed' : 'outdated'
  }
  return 'installed'
}

/** 连接状态只反映扩展是否就绪，不随任务占用或连接进度变化。 */
export function browserConnectionStatus(state: WorkbenchState | undefined, error: string): '已连接' | '未连接' {
  return !error && state?.extensionInstallation?.status === 'installed' && state?.connection.ready ? '已连接' : '未连接'
}
