import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { JSDOM } from 'jsdom'
const require = createRequire(import.meta.url)

test('rich job descriptions preserve paragraphs and lists while removing executable markup', () => {
  const dom = new JSDOM('')
  const react = { ...require('react'), useMemo: fn => fn() }
  const source = buildSync({ entryPoints: ['src/client/components/job-description.tsx'], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/*'] }).outputFiles[0].text
  const module = { exports: {} }
  runInNewContext(source, { module, exports: module.exports, window: dom.window, require: name => name === 'react' ? react : require(name) })
  const html = '<h2>任职要求</h2><p><strong>Java</strong> 开发</p><ol><li>熟悉数据库</li></ol><img src=x onerror=alert(1)><script>alert(1)</script><svg onload=alert(1)></svg><iframe srcdoc="bad"></iframe><a href="javascript:alert(1)">岗位</a><div style="position:fixed" onclick="alert(1)">说明</div>'
  const tree = module.exports.JobDescription({ html })
  const output = tree.props.dangerouslySetInnerHTML.__html
  const doc = new JSDOM(output).window.document
  assert.equal(doc.querySelector('strong').textContent, 'Java')
  assert.equal(doc.querySelector('ol li').textContent, '熟悉数据库')
  assert.equal(doc.querySelectorAll('img,script,svg,iframe,a,[style],[onclick],[onerror]').length, 0)
  assert.doesNotMatch(output, /alert\(1\)/)
  assert.match(doc.body.textContent, /说明/)
  dom.window.close()
})
