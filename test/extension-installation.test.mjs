import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtensionInstallationDetector } from '../dist/lib/extension-installation.js'

const id = 'elbamdfkepfcainfggecfjhahpjjdmdg'
test('installation refresh detects install and uninstall without treating an empty record as installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-installation-'))
  try {
    await mkdir(join(root, 'Default'))
    await writeFile(join(root, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }))
    const prefs = entry => writeFile(join(root, 'Default/Preferences'), JSON.stringify({ extensions: { settings: { [id]: entry } } }))
    await prefs({})
    const detector = new ExtensionInstallationDetector([root])
    assert.equal((await detector.read(false)).status, 'not_installed')
    await prefs({ state: 1, manifest: { name: '薪招', version: '3.2.46' } })
    assert.equal((await detector.read(false)).status, 'not_installed', 'ordinary polling uses the bounded cache')
    assert.equal((await detector.read(false, true)).status, 'installed', 'start preflight refreshes stale installation evidence')
    await prefs({})
    assert.equal((await detector.read(false, true)).status, 'not_installed')
    const connected = await detector.read(true, true, '3.2.46')
    assert.equal(connected.status, 'installed'); assert.equal(connected.source, 'connection')
    assert.equal((await detector.read(false, true)).status, 'not_installed', 'a past connection cannot hide a subsequent uninstall')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('installation requires a known version at least 3.2.46 and compares numeric version components', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-version-'))
  try {
    await mkdir(join(root, 'Default'))
    await writeFile(join(root, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }))
    const detector = new ExtensionInstallationDetector([root])
    for (const [version, expected] of [
      ['3.2.45', 'outdated'], ['3.2.9', 'outdated'], ['3.2', 'outdated'],
      ['3.2.46', 'installed'], ['3.2.46.0', 'installed'], ['3.2.46.1', 'installed'],
      ['3.2.100', 'installed'], ['3.10.0', 'installed'], ['4', 'installed'],
      [undefined, 'unknown'], ['', 'unknown'], ['3.2.46-beta', 'unknown'], ['3.2.046', 'unknown'],
      [3.246, 'unknown'], ['3.2.46.0.1', 'unknown'], ['65536', 'unknown'],
    ]) {
      await writeFile(join(root, 'Default/Preferences'), JSON.stringify({ extensions: { settings: { [id]: { manifest: { name: '薪招', version } } } } }))
      const installation = await detector.read(false, true)
      assert.equal(installation.status, expected, String(version))
      assert.equal(installation.version, expected === 'unknown' ? undefined : version)
      if (expected !== 'installed') assert.match(installation.detail, /3\.2\.46/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('unpacked extension manifests provide missing versions and other profiles may have a supported version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-profiles-'))
  try {
    await mkdir(join(root, 'Default'))
    await mkdir(join(root, 'Profile 1/Extensions', id, '3.2.46_0'), { recursive: true })
    await writeFile(join(root, 'Local State'), JSON.stringify({ profile: { last_used: 'Default', info_cache: { 'Profile 1': {} } } }))
    await writeFile(join(root, 'Default/Preferences'), JSON.stringify({ extensions: { settings: { [id]: { manifest: { version: '3.2.45' } } } } }))
    const extensionPath = join(root, 'Profile 1/Extensions', id, '3.2.46_0')
    await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify({ name: '薪招', version: '3.2.46' }))
    const detector = new ExtensionInstallationDetector([root])
    for (const path of [join(id, '3.2.46_0'), extensionPath]) {
      await writeFile(join(root, 'Profile 1/Preferences'), JSON.stringify({ extensions: { settings: { [id]: { path } } } }))
      const installation = await detector.read(false, true)
      assert.equal(installation.status, 'installed'); assert.equal(installation.version, '3.2.46')
      assert.match(installation.detail, /浏览器配置/)
    }
    for (const [version, expected] of [['3.2.45', 'outdated'], [undefined, 'unknown'], ['3.2.46', 'installed']]) {
      const installation = await detector.read(true, false, version)
      assert.equal(installation.status, expected, 'the authenticated extension takes priority over other installed profiles')
      assert.equal(installation.source, 'connection')
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('missing or unreadable browser profiles are unknown rather than confirmed uninstalled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-installation-'))
  try {
    const detector = new ExtensionInstallationDetector([root])
    assert.equal((await detector.read(false)).status, 'unknown')
    await writeFile(join(root, 'Local State'), 'not valid json')
    assert.equal((await detector.read(false, true)).status, 'unknown')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('residual extension records whose manifest was removed are uninstalled, even with a cached inline version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-uninstalled-'))
  try {
    await mkdir(join(root, 'Default'))
    await writeFile(join(root, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }))
    const detector = new ExtensionInstallationDetector([root])
    for (const manifest of [undefined, { name: '薪招', version: '3.2.46' }]) {
      await writeFile(join(root, 'Default/Secure Preferences'), JSON.stringify({ extensions: { settings: { [id]: { path: join(root, 'removed-extension'), manifest } } } }))
      assert.equal((await detector.read(false, true)).status, 'not_installed')
    }
    await mkdir(join(root, 'removed-extension'))
    await writeFile(join(root, 'removed-extension/manifest.json'), 'invalid json')
    assert.equal((await detector.read(false, true)).status, 'unknown', 'an unreadable manifest is distinct from a removed one')
  } finally { await rm(root, { recursive: true, force: true }) }
})
