import { record } from './bridge.js'

// Native model adapters may encode nested JSON as a string. Accept one encoding
// layer, but expose the preferred object contract instead of an untyped `json`.
export const objectInput = {
  description: 'JSON 对象，优先直接传对象；兼容一次 JSON 编码的对象字符串。不接受数组、null 或其他标量。',
  oneOf: [
    { type: 'object' as const, additionalProperties: true },
    { type: 'string' as const },
  ],
} as const

export function readObjectInput(value: unknown, field: string, errorCode = 'BROWSER_ARGUMENT_INVALID'): Record<string, unknown> {
  let decoded = value
  if (typeof decoded === 'string') {
    try { decoded = JSON.parse(decoded) } catch {
      throw new Error(`${errorCode}: ${field} 必须为 JSON 对象或有效的对象 JSON 字符串；请求未发送，请核对参数，不要反复试错。`)
    }
  }
  if (!record(decoded))
    throw new Error(`${errorCode}: ${field} 必须为对象，不接受数组、null、标量或多次编码；请求未发送，请核对参数，不要反复试错。`)
  return decoded
}
