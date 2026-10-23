import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PNG } from 'pngjs'
import { resumeImageOnWhite } from '../dist/lib/sourcing/resume-image.js'

test('Canvas transparency becomes a white background while dark text and edge alpha retain their visual colors', () => {
  const png = new PNG({ width: 3, height: 1 })
  png.data.set([0, 0, 0, 0, 40, 40, 40, 255, 40, 40, 40, 128])
  const source = PNG.sync.write(png), before = Buffer.from(source)
  const result = PNG.sync.read(Buffer.from(resumeImageOnWhite(source)))
  assert.equal(result.alpha, false)
  assert.deepEqual([...result.data], [255, 255, 255, 255, 40, 40, 40, 255, 147, 147, 147, 255])
  assert.deepEqual(source, before, 'source capture bytes stay unchanged for evidence hashing')
})

test('invalid PNG and oversized image headers are refused before publication', () => {
  assert.throws(() => resumeImageOnWhite(new Uint8Array([1, 2, 3])), /RESUME_IMAGE_INVALID/)
  const png = PNG.sync.write(new PNG({ width: 1, height: 1 }))
  png.writeUInt32BE(100000, 16); png.writeUInt32BE(100000, 20)
  assert.throws(() => resumeImageOnWhite(png), /RESUME_IMAGE_BUDGET_EXCEEDED/)
})
