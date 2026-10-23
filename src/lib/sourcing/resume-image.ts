import { PNG } from 'pngjs'

/** Canvas pixels omit the webpage's white background. Publish an opaque RGB
 * image so vision providers see the same dark text on white as the browser. */
export function resumeImageOnWhite(data: Uint8Array): Uint8Array {
  const bytes = Buffer.from(data)
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('RESUME_IMAGE_INVALID: 简历截图不是有效 PNG')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (!width || !height || width * height > 32 * 1024 * 1024) throw new Error('RESUME_IMAGE_BUDGET_EXCEEDED')
  try {
    const decoded = PNG.sync.read(bytes)
    return PNG.sync.write(decoded, { bitDepth: 8, inputColorType: 6, inputHasAlpha: true, colorType: 2,
      bgColor: { red: 255, green: 255, blue: 255 } })
  } catch { throw new Error('RESUME_IMAGE_INVALID: 简历截图解码失败') }
}

/** Ignore only layout whitespace between Han characters; never substitute a
 * surname, guess a character, or accept a different person after OCR failure. */
export const visualResumeName = (name: string) => name.trim().replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, '')
