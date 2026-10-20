import { mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
const root = new URL('../', import.meta.url)
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
await mkdir(new URL('artifacts/', root), { recursive: true })
execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', 'artifacts'], { cwd: root, stdio: 'inherit' })
