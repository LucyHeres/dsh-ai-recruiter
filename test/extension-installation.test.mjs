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
    await prefs({ state: 1, manifest: { name: '薪招' } })
    assert.equal((await detector.read(false)).status, 'not_installed', 'ordinary polling uses the bounded cache')
    assert.equal((await detector.read(false, true)).status, 'installed', 'start preflight refreshes stale installation evidence')
    await prefs({})
    assert.equal((await detector.read(false, true)).status, 'not_installed')
    const connected = await detector.read(true, true)
    assert.equal(connected.status, 'installed'); assert.equal(connected.source, 'connection')
    assert.equal((await detector.read(false, true)).status, 'not_installed', 'a past connection cannot hide a subsequent uninstall')
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
