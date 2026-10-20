import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const p = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }))
const files = new Set(pack.files.map(f => f.path))
for (const file of [p.main, p.types, p.dsh.bundle.patch, 'README.md', 'skills/xinzhao-browser-control/SKILL.md', 'browser-agent-gateway/package.json', 'browser-agent-gateway/mcp-server.js', 'browser-agent-gateway/gateway.js', 'browser-agent-gateway/ensure.js', 'browser-agent-gateway/ws-server.js', 'browser-agent-gateway/protocol.js', 'browser-agent-gateway/config.cjs', p.bin['dsh-ai-recruiter-browser'], 'dsh-target.json', 'docs/verification.md', 'examples/config.patch.yml']) {
  assert.ok(files.has(file.replace(/^\.\//, '')), `Missing ${file}`)
}
for (const [dep, version] of Object.entries(p.peerDependencies)) assert.equal(p.devDependencies[dep], version)
assert.equal(p.dsh.client.platform, 'web')
for (const file of Object.values(p.exports['./client'])) assert.ok(files.has(file.replace(/^\.\//, '')), `Missing client export ${file}`)
const client = await readFile(resolve(root, p.exports['./client'].default), 'utf8')
assert.ok(client.startsWith('window.__ModuleLoader__.load('), 'Client must use DSH lazy-CJS factory format')
// Match module specifiers, not ordinary object properties such as DOMPurify's `node: root`.
assert.ok(!/['"]node:/.test(client) && !client.includes('browser-agent-gateway'), 'Client cannot bundle Host runtime')
assert.equal(p.exports['.'].default, './' + p.main)
assert.equal(p.exports['.'].types, './' + p.types)
assert.equal(p.dsh.bundle.patch, './cordis.patch.yml')
assert.ok(!p.workspaces)
assert.ok(!Object.values(p.scripts).some(s => s.includes('../')))
assert.ok(![...files].some(f => /^(node_modules|test|scripts|src|artifacts)\//.test(f) || f.includes('.token') || f.includes('browser-agent.local.json')))
// Every emitted JavaScript and declaration import must resolve to a file inside this tarball.
for (const file of [...files].filter(f => f.endsWith('.js') || f.endsWith('.d.ts'))) {
  const source = await readFile(resolve(root, file), 'utf8')
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
    const target = relative(root, resolve(root, dirname(file), match[1]))
    // 声明文件使用 NodeNext 的 .js import，TypeScript 实际解析同名 .d.ts。
    const declaration = file.endsWith('.d.ts') && target.endsWith('.js') ? target.slice(0, -3) + '.d.ts' : ''
    assert.ok(!target.startsWith('..') && (files.has(target) || (declaration && files.has(declaration))), `${file} imports missing ${target}`)
  }
}
for (const exported of Object.values(p.exports)) {
  if (typeof exported === 'string') assert.ok(files.has(exported.replace(/^\.\//, '')), `Missing export ${exported}`)
}
assert.equal(JSON.parse(await readFile(resolve(root, 'browser-agent-gateway/package.json'), 'utf8')).type, 'commonjs')
for (const file of [...files].filter(f => /\.(js|cjs)$/.test(f))) {
  const source = await readFile(resolve(root, file), 'utf8')
  for (const match of source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
    const target = relative(root, resolve(root, dirname(file), match[1]))
    assert.ok([target, target + '.js', target + '.cjs'].some(f => files.has(f)), `${file} requires missing ${target}`)
  }
}
const entry = await import(new URL('../' + p.main, import.meta.url))
assert.equal(entry.name, p.name)
assert.equal(typeof entry.apply, 'function')
console.log(`${pack.filename}: ${files.size} files; entry and all relative imports are self-contained`)
