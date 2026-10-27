import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { MINIMUM_EXTENSION_VERSION, type ExtensionInstallation } from '../shared/workbench.js'
import { extensionVersionStatus } from '../shared/connection-status.js'

const EXTENSION_ID = 'elbamdfkepfcainfggecfjhahpjjdmdg'
const result = (status: ExtensionInstallation['status'], detail: string, source: ExtensionInstallation['source']): ExtensionInstallation =>
  ({ status, detail, source, checkedAt: new Date().toISOString() })

function versionResult(version: unknown, source: ExtensionInstallation['source']): ExtensionInstallation {
  const status = extensionVersionStatus(version)
  const detail = status === 'installed' ? `已检测到薪招扩展 v${version}。`
    : status === 'outdated' ? `当前薪招扩展版本为 ${version}，请升级至 ${MINIMUM_EXTENSION_VERSION} 或更高版本。`
    : `已检测到薪招扩展，但无法确认版本。请确认版本不低于 ${MINIMUM_EXTENSION_VERSION}，并重新连接浏览器。`
  return { ...result(status, detail, source), ...(status !== 'unknown' ? { version: version as string } : {}) }
}

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
async function readJson(file: string): Promise<{ value?: any; failed?: boolean; missing?: boolean }> {
  try { return { value: JSON.parse(await readFile(file, 'utf8')) } }
  catch (error) { const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'; return { failed: !missing, missing } }
}

/** Read installation metadata only; never expose profile paths or preference contents. */
async function detect(directories: readonly string[]): Promise<ExtensionInstallation> {
  let readable = false, failed = false
  let detected: ExtensionInstallation | undefined
  for (const directory of directories) {
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
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Object.keys(entry).length) continue
        let version = entry.manifest?.version
        // 解压加载的扩展可能只在配置中保留路径，版本从该扩展的 manifest 读取。
        if (typeof entry.path === 'string' && entry.path) {
          const path = isAbsolute(entry.path) ? entry.path : join(directory, name, 'Extensions', entry.path)
          const manifest = await readJson(join(path, 'manifest.json'))
          // 卸载后可能留下路径记录；文件已经不存在时不能当作安装或未知版本的证据。
          if (manifest.missing) continue
          failed ||= !!manifest.failed
          if (manifest.failed) version = undefined
          else version ??= manifest.value?.version
        }
        const installation = versionResult(version, 'browser_profile')
        if (installation.status === 'installed') {
          if (name !== profiles?.last_used) installation.detail += ' 请使用已安装该版本的浏览器配置连接。'
          return installation
        }
        if (!detected || detected.status === 'unknown') detected = installation
      }
    }
  }
  if (detected) return detected
  if (failed || !readable) return result('unknown', '暂时无法确认扩展安装状态，请在 Chrome 中检查薪招扩展，或使用安装指引。', 'browser_profile')
  return result('not_installed', '未检测到薪招扩展。请在 Chrome 中完成安装并启用，然后重新检测。', 'browser_profile')
}

export class ExtensionInstallationDetector {
  constructor(private readonly directories: readonly string[] = browserDirectories()) {}
  private cached?: { value: ExtensionInstallation; until: number }
  private inFlight?: Promise<ExtensionInstallation>
  async read(connected: boolean, refresh = false, version?: string): Promise<ExtensionInstallation> {
    // 已认证连接的实际版本优先，不能被其他浏览器配置里的新版本覆盖。
    if (connected) return versionResult(version, 'connection')
    if (refresh) this.cached = undefined
    if (this.cached && this.cached.until > Date.now()) return this.cached.value
    this.inFlight ??= detect(this.directories).then(value => { this.cached = { value, until: Date.now() + 15000 }; return value })
    try { return await this.inFlight } finally { this.inFlight = undefined }
  }
}
