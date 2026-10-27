import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The market requires lib/, while the development checkout and tests use dist/.
// Stage an equivalent, independently rebuildable project without local data.
const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const stage = resolve(root, 'artifacts/market', `${manifest.name}-${manifest.version}`)
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }))
await rm(stage, { recursive: true, force: true })
await mkdir(stage, { recursive: true })
const marketPath = value => value.replace(/^(\.\/)?dist(?=\/|$)/, '$1lib')
for (const { path } of pack.files) {
  if (path === 'package.json') continue
  const target = resolve(stage, marketPath(path))
  await mkdir(resolve(target, '..'), { recursive: true })
  await cp(resolve(root, path), target)
}
const mapPaths = value => typeof value === 'string' ? marketPath(value)
  : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapPaths(child)]))
manifest.main = marketPath(manifest.main)
manifest.types = marketPath(manifest.types)
manifest.exports = mapPaths(manifest.exports)
manifest.files = manifest.files.map(marketPath)
await writeFile(resolve(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
for (const path of ['src', 'scripts', 'package-lock.json', 'tsconfig.json', 'tsconfig.client.json']) {
  await cp(resolve(root, path), resolve(stage, path), { recursive: true, filter: source => !source.includes('__pycache__') })
}
const config = JSON.parse(await readFile(resolve(stage, 'tsconfig.json'), 'utf8'))
config.compilerOptions.outDir = 'lib'
await writeFile(resolve(stage, 'tsconfig.json'), JSON.stringify(config, null, 2) + '\n')
for (const file of ['build-client.mjs', 'clean.mjs']) {
  const path = resolve(stage, 'scripts', file)
  await writeFile(path, (await readFile(path, 'utf8')).replaceAll('dist/', 'lib/'))
}
for (const { path } of pack.files.filter(({ path }) => path.startsWith('dist/'))) {
  assert.deepEqual(await readFile(resolve(stage, marketPath(path))), await readFile(resolve(root, path)), `${path} changed during staging`)
}
const [artifact] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json'], { cwd: stage, encoding: 'utf8' }))
assert.ok(artifact.files.some(({ path }) => path === manifest.main))
assert.ok(!(await readdir(stage)).includes('node_modules'))
console.log(JSON.stringify({ directory: stage, package: resolve(stage, artifact.filename), files: artifact.files.length }))
