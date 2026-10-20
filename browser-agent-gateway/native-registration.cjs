'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { configurationPath } = require('./config.cjs')
const { HOST_NAME, EXTENSION_ID } = require('./native-host.cjs')
const quoteSh = value => "'" + value.split("'").join("'\"'\"'") + "'"

// Register at user scope. No administrator rights or separate Node installation required.
function registerNativeHost() {
  const home = os.homedir()
  const isolatedDirectory = process.env.XINZHAO_NATIVE_HOST_DIRECTORY
    ? path.resolve(process.env.XINZHAO_NATIVE_HOST_DIRECTORY) : null
  const base = isolatedDirectory || path.join(home, '.xinzhao', 'native-host')
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const generation = fs.mkdtempSync(path.join(base, 'dsh-'))
  const entry = path.join(generation, 'entry.cjs')
  const launcher = path.join(generation, process.platform === 'win32' ? 'launch.cmd' : 'launch.sh')
  const manifests = [], registryKeys = []
  const nativePath = path.join(__dirname, 'native-host.cjs')
  fs.writeFileSync(entry, `'use strict'\nrequire(${JSON.stringify(nativePath)}).serve(${JSON.stringify(configurationPath())})\n`, { mode: 0o600 })
  // Preserve Electron hosts' embedded Node mode without relying on PATH.
  if (process.platform === 'win32') {
    if ([process.execPath, entry].some(value => /[%"\r\n]/.test(value))) {
      fs.rmSync(generation, { recursive: true, force: true }); throw new Error('NATIVE_HOST_PATH_UNSUPPORTED')
    }
    fs.writeFileSync(launcher, `@echo off\r\nchcp 65001 >nul\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${process.execPath}" "${entry}" "%~1"\r\n`)
  } else {
    fs.writeFileSync(launcher, `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quoteSh(process.execPath)} ${quoteSh(entry)} "$@"\n`, { mode: 0o700 })
  }
  const manifest = { name: HOST_NAME, description: 'Xinzhao local DSH browser connection', path: launcher,
    type: 'stdio', allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] }
  const write = file => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${path.basename(generation)}.tmp`
    fs.writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(temp, file); manifests.push(file)
  }
  const dispose = () => {
    for (const key of registryKeys) {
      const current = spawnSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      if (current.status === 0 && current.stdout.includes(path.join(generation, 'host.json'))) {
        spawnSync('reg.exe', ['delete', key, '/f'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
      }
    }
    for (const file of manifests) {
      try { if (JSON.parse(fs.readFileSync(file, 'utf8')).path === launcher) fs.unlinkSync(file) } catch (_) {}
    }
    fs.rmSync(generation, { recursive: true, force: true })
  }
  try {
    let directories
    if (isolatedDirectory) directories = [isolatedDirectory]
    else if (process.platform === 'darwin') directories = ['Google/Chrome', 'Chromium', 'Microsoft Edge']
      .map(browser => path.join(home, 'Library', 'Application Support', browser, 'NativeMessagingHosts'))
    else if (process.platform === 'linux') directories = ['google-chrome', 'chromium', 'microsoft-edge']
      .map(browser => path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), browser, 'NativeMessagingHosts'))
    else if (process.platform === 'win32') {
      const file = path.join(generation, 'host.json'); write(file)
      for (const vendor of ['Google\\Chrome', 'Microsoft\\Edge', 'Chromium']) {
        const key = `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${HOST_NAME}`
        const result = spawnSync('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', file, '/f'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
        if (result.status !== 0) throw new Error('NATIVE_HOST_REGISTRATION_FAILED')
        registryKeys.push(key)
      }
      directories = []
    } else throw new Error('NATIVE_HOST_PLATFORM_UNSUPPORTED')
    for (const directory of directories) write(path.join(directory, `${HOST_NAME}.json`))
    return { hostName: HOST_NAME, extensionId: EXTENSION_ID, dispose }
  } catch (error) { dispose(); throw error }
}
module.exports = { registerNativeHost }
