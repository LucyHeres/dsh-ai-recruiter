import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visualResumeReader } from '../dist/lib/sourcing/visual-resume.js'
import { PNG } from 'pngjs'

function fixture(options = {}) {
  const signal = new AbortController().signal, files = new Map(), offsets = [], inputs = [], progress = [], modelImages = []
  let y = options.startY ?? 0, revision = 0, imageVersion = 1, modelCalls = 0, captureSequence = 0
  const total = options.total ?? 2000, height = 800, name = '林先生'
  const page = () => ({ tabId: 1, frameId: 9, frameInteraction: 'same-origin', documentId: 'resume-document',
    url: 'https://www.zhipin.com/web/frame/c-resume/?source=recommend', snapshotId: 's' + revision,
    viewport: { width: 774, height: total }, items: [{ ref: 'canvas', tagName: 'canvas', bounds: { x: 0, y, width: 774, height } }] })
  let current = page()
  const broker = { currentPage: () => current, tools: [
    { name: 'browser_snapshot', execute: async args => { assert.equal(args.frameId, 9); revision++; current = page(); return current } },
    { name: 'browser_scroll', execute: async args => {
      assert.equal(args.snapshotId, current.snapshotId)
      inputs.push(args.deltaY)
      if (options.stalled) return
      y = Math.min(total - height, Math.max(0, y + args.deltaY + (options.gap ? height * 2 : 0)))
    } },
  ] }
  const call = async (name, args) => {
    assert.deepEqual(args.policy.allowedOrigins, ['https://www.zhipin.com'])
    assert.equal(args.policy.riskLevel, 'read')
    if (name === 'browser_capture_content') {
      assert.equal(args.frameId, 9); assert.equal(args.documentId, 'resume-document')
      offsets.push(y)
      const captureId = 'capture-' + ++captureSequence, png = new PNG({ width: 2, height: 1 })
      png.data.set([0, 0, 0, 0, Math.floor(y / 256), y % 256, imageVersion, 255])
      const data = PNG.sync.write(png)
      files.set(captureId, data)
      return { captureId, mimeType: 'image/png', size: data.length }
    }
    assert.equal(name, 'artifact_read')
    const data = files.get(args.captureId)
    return { captureId: args.captureId, offset: 0, totalSize: data.length, size: data.length,
      base64: data.toString('base64'), fileName: 'resume.png', mimeType: 'image/png', eof: true }
  }
  const readName = options.spacedName ? '林 先 生' : name
  const text = `${readName} 工作经历：2020年至今在甲公司负责Java业务系统开发、接口设计、数据库优化、订单与支付服务上线及持续维护。项目经历：负责需求分析、联调、故障排查、架构改进和交付。`
  const agent = async optionsForModel => {
    modelCalls++
    assert.equal(optionsForModel.tools.length, 1)
    assert.equal(optionsForModel.tools[0].name, 'sourcing_submit_resume_text')
    assert.equal(optionsForModel.goal.candidateName, undefined, 'the model must read the name from images')
    const { bodyImageStart, bodySegmentStart, bodySegmentEnd, batch } = optionsForModel.goal
    assert.ok(optionsForModel.inputImages.length <= 8)
    const imageOffsets = optionsForModel.inputImages.map(image => {
      const png = PNG.sync.read(Buffer.from(image.data))
      return png.data[4] * 256 + png.data[5]
    })
    modelImages.push(imageOffsets)
    assert.equal(imageOffsets[0], 0, 'each isolated request independently reads the name from the first image')
    const captured = offsets.slice(-optionsForModel.goal.totalSegments)
    assert.deepEqual(imageOffsets.slice(bodyImageStart - 1), captured.slice(bodySegmentStart - 1, bodySegmentEnd))
    assert.ok(optionsForModel.inputImages.every(image => image.data instanceof Uint8Array))
    for (const image of optionsForModel.inputImages) {
      const png = PNG.sync.read(Buffer.from(image.data))
      assert.equal(png.alpha, false, 'vision receives an opaque RGB image')
      assert.deepEqual([...png.data.subarray(0, 4)], [255, 255, 255, 255], 'transparent webpage background becomes white')
    }
    try {
      await optionsForModel.tools[0].execute({ candidateName: options.wrongName || options.wrongNameBatch === batch ? '另一个人' : readName,
        text: options.transcript?.(batch) ?? (batch === 1 ? text : `后续正文第${batch}批，包含剩余的工作职责与教育信息。`),
        complete: !options.unreadable && options.unreadableBatch !== batch }, signal)
    } catch (error) {
      if (!options.swallowRejection) throw error
      return { status: 'budget', message: 'BROWSER_AGENT_TURN_BUDGET', turns: 2, modelMs: 0, toolMs: 0 }
    }
    return { status: 'completed', message: '', turns: 1, modelMs: 0, toolMs: 0 }
  }
  const read = visualResumeReader(broker, call, agent, async message => { progress.push(message) })
  return { run: () => read(current, name, signal), offsets, inputs, progress, modelImages, get modelCalls() { return modelCalls },
    changeImage: () => { imageVersion++ } }
}

test('visual resume capture covers the actual detail from top to bottom with overlap before transcription', async () => {
  const f = fixture({ startY: 600 })
  const result = await f.run()
  assert.deepEqual(f.offsets, [0, 560, 1120, 1200])
  assert.equal(f.inputs[0], -600)
  assert.equal(result.pages, 4)
  assert.equal(new Set(result.imageHashes).size, 4)
  assert.match(result.text, /工作经历/)
  assert.equal(f.modelCalls, 1)
  assert.ok(f.progress.every(message => !message.includes('已读取当前候选人')))
})

test('commit-time visual verification rechecks pixels and refuses a changed resume without another model call', async () => {
  const f = fixture()
  const first = await f.run(), second = await f.run()
  assert.equal(first.text, second.text)
  assert.equal(f.modelCalls, 1)
  f.changeImage()
  await assert.rejects(f.run(), /CANDIDATE_EVIDENCE_CHANGED/)
  assert.equal(f.modelCalls, 1)
})

test('unreadable images and a different image name cannot produce resume text', async () => {
  await assert.rejects(fixture({ unreadable: true }).run(), /RESUME_IMAGE_UNREADABLE/)
  await assert.rejects(fixture({ wrongName: true }).run(), /CANDIDATE_EVIDENCE_INVALID/)
})

test('OCR layout spaces between Chinese name characters preserve the exact identity', async () => {
  assert.match((await fixture({ spacedName: true }).run()).text, /林 先 生/)
})

test('the actual identity rejection survives a model budget result instead of becoming generic unreadable', async () => {
  await assert.rejects(fixture({ wrongName: true, swallowRejection: true }).run(), /CANDIDATE_EVIDENCE_INVALID.*姓名/)
})

test('stalled scrolling and missing coverage stop before transcription', async () => {
  for (const options of [{ stalled: true }, { gap: true }]) {
    const f = fixture(options)
    await assert.rejects(f.run(), /RESUME_SCROLL_NO_PROGRESS|RESUME_IMAGE_INCOMPLETE/)
    assert.equal(f.modelCalls, 0)
  }
})

test('a ninth image uses a second request with a name anchor and keeps the final short section', async () => {
  const f = fixture({ total: 5000 })
  const result = await f.run()
  assert.equal(result.pages, 9)
  assert.deepEqual(f.modelImages.map(images => images.length), [8, 2])
  assert.deepEqual(f.modelImages[1], [0, 4200])
  assert.match(result.text, /后续正文第2批/)
  assert.equal(new Set(result.imageHashes).size, 9)
})

test('long resumes are captured to their actual bottom and every segment reaches a bounded OCR request', async () => {
  for (const total of [6778, 9000, 30000]) {
    const f = fixture({ total })
    const result = await f.run()
    assert.equal(f.offsets.at(-1) + 800, total)
    assert.equal(result.pages, f.offsets.length)
    assert.ok(result.pages > 8)
    assert.deepEqual(f.modelImages.flatMap((images, i) => i === 0 ? images : images.slice(1)), f.offsets)
    assert.match(result.text, new RegExp(`后续正文第${f.modelCalls}批`))
  }
})

test('a late unreadable batch never returns or caches a partially transcribed resume', async () => {
  const f = fixture({ total: 5000, unreadableBatch: 2, swallowRejection: true })
  await assert.rejects(f.run(), /RESUME_IMAGE_UNREADABLE/)
  await assert.rejects(f.run(), /RESUME_IMAGE_UNREADABLE/)
  assert.equal(f.modelCalls, 4, 'a failed read must recapture and transcribe all batches on a later attempt')
  assert.equal(f.offsets.length, 18)
})

test('a later request must independently verify the exact name before its text can be appended', async () => {
  await assert.rejects(fixture({ total: 5000, wrongNameBatch: 2, swallowRejection: true }).run(), /CANDIDATE_EVIDENCE_INVALID/)
})

test('overlapping batch text is joined without dropping the tail or repeating the shared boundary', async () => {
  const boundary = '负责订单系统的日常维护、数据库优化、联调测试与生产环境故障处理。'
  const first = `林先生 工作经历：在甲公司负责Java系统开发。${'参与需求分析与版本交付。'.repeat(6)}${boundary}`
  const last = `${boundary}教育经历：大专，软件技术。`
  const f = fixture({ total: 5000, transcript: batch => batch === 1 ? first : last })
  const result = await f.run()
  assert.equal(result.text, first + last.slice(boundary.length))
})

test('transcription capacity cannot silently truncate the final batch', async () => {
  const first = '林先生 工作经历：' + '职'.repeat(29991)
  const f = fixture({ total: 5000, transcript: batch => batch === 1 ? first : '末尾正文' })
  await assert.rejects(f.run(), /RESUME_IMAGE_INCOMPLETE/)
})
