import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionInstallation } from '../shared/workbench.js'

const EXTENSION_ID = 'elbamdfkepfcainfggecfjhahpjjdmdg'
const result = (status: ExtensionInstallation['status'], detail: string, source: ExtensionInstallation['source']): ExtensionInstallation =>
  ({ status, detail, source, checkedAt: new Date().toISOString() })

function browserDirectories(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') return ['Google/Chrome', 'Chromium', 'Microsoft Edge'].map(name => join(home, 'Library/Application Support', name))
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || join(home, 'AppData/Local')
    return ['Google/Chrome/User Data', 'Chromium/User Data', 'Microsoft/Edge/User Data'].map(name => join(base, name))
  }
  if (process.platform === 'linux') {
    const base = process.env.XDG_CONFIG_HOME || join(home, '.config')
    return ['google-chrome', 'chromium', 'microsoft-edge'].map(name => join(base, name))
  }
  return []
}

const profileName = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && name.length <= 80 && name.trim() === name && !/^\.+$/.test(name) && !/[/\\:\0]/.test(name)
async function readJson(file: string): Promise<{ value?: any; failed?: boolean }> {
  try { return { value: JSON.parse(await readFile(file, 'utf8')) } }
  catch (error) { return { failed: (error as NodeJS.ErrnoException).code !== 'ENOENT' } }
}

/** Read installation metadata only; never expose profile paths or preference contents. */
async function detect(): Promise<ExtensionInstallation> {
  let readable = false, failed = false
  for (const directory of browserDirectories()) {
    const local = await readJson(join(directory, 'Local State'))
    failed ||= !!local.failed
    if (!local.value) continue
    const profiles = local.value.profile
    const allNames = [...new Set([profiles?.last_used, ...(Array.isArray(profiles?.last_active_profiles) ? profiles.last_active_profiles : []), ...Object.keys(profiles?.info_cache ?? {})].filter(profileName))]
    if (allNames.length > 20) failed = true
    const names = allNames.slice(0, 20)
    if (!names.length) names.push('Default')
    for (const name of names) {
      const files = await Promise.all(['Secure Preferences', 'Preferences'].map(file => readJson(join(directory, name, file))))
      for (const file of files) {
        failed ||= !!file.failed
        if (!file.value) continue
        readable = true
        const entry = file.value.extensions?.settings?.[EXTENSION_ID]
        // Chrome 会为已卸载或尚未安装完成的扩展留下空记录（{}），空记录不是安装证据。
        // 停用的扩展仍保留完整记录，因此停用不算未安装；连接与授权另行检查。
        if (entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length > 0) return result('installed',
          name === profiles?.last_used ? '已检测到薪招扩展。' : '已在浏览器配置中检测到薪招扩展，请使用已安装扩展的配置连接。', 'browser_profile')
      }
    }
  }
  if (failed || !readable) return result('unknown', '暂时无法确认扩展安装状态，请在 Chrome 中检查薪招扩展，或使用安装指引。', 'browser_profile')
  return result('not_installed', '未检测到薪招扩展。请在 Chrome 中完成安装并启用，然后重新检测。', 'browser_profile')
}

export class ExtensionInstallationDetector {
  private cached?: { value: ExtensionInstallation; until: number }
  private inFlight?: Promise<ExtensionInstallation>
  async read(connected: boolean, refresh = false): Promise<ExtensionInstallation> {
    if (connected) return result('installed', '薪招扩展已安装并连接。', 'connection')
    if (refresh) this.cached = undefined
    if (this.cached && this.cached.until > Date.now()) return this.cached.value
    this.inFlight ??= detect().then(value => { this.cached = { value, until: Date.now() + 15000 }; return value })
    try { return await this.inFlight } finally { this.inFlight = undefined }
  }
}
