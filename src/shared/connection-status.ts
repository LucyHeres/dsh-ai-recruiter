import type { WorkbenchState } from './workbench.js'

export const EXTENSION_REQUIRED_CODE = 'BROWSER_EXTENSION_NOT_INSTALLED'
export const EXTENSION_MISSING_MESSAGE = '尚未安装【薪招】浏览器扩展'
export const EXTENSION_DESCRIPTION = '浏览器扩展可以为插件提供招聘平台的自动化访问与操作能力。'
export const isExtensionRequired = (error: unknown) => String(error instanceof Error ? error.message : error).includes(EXTENSION_REQUIRED_CODE)

/** 连接状态只反映扩展是否就绪，不随任务占用或连接进度变化。 */
export function browserConnectionStatus(state: WorkbenchState | undefined, error: string): '已连接' | '未连接' {
  return !error && state?.extensionInstallation?.status !== 'not_installed' && state?.connection.ready ? '已连接' : '未连接'
}
