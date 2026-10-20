import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const Ajv = createRequire(import.meta.url)('ajv')
const ajv = new Ajv({ allErrors: true, strict: false })
const canonical = (value: unknown): string => JSON.stringify(value, (_key, current) =>
  current && typeof current === 'object' && !Array.isArray(current)
    ? Object.fromEntries(Object.keys(current).sort().map(key => [key, current[key]])) : current)
/** Keep only hashes of failed requests; never retain typed text or credentials. */
export class BrowserCallGuard {
  private failures = new Map<string, { time: number; attempts: Set<string> }>()
  private validators = new Map<string, any>()
  private key(scope: string, tool: string) { return `${scope}:${tool}` }
  checkRetry(scope: string, tool: string, args: unknown) {
    const key = this.key(scope, tool), prior = this.failures.get(key)
    if (prior && Date.now() - prior.time < 120000) {
      const hash = createHash('sha256').update(canonical(args)).digest('hex')
      if (prior.attempts.has(hash) || prior.attempts.size >= 2)
        throw new Error('BROWSER_RETRY_BLOCKED: 本调用未发送。相同失败参数禁止重发；修正后最多再尝试一次。请停止此操作，报告原因并核对页面/工具契约，冷却时间为两分钟。')
    }
  }
  check(scope: string, tool: string, args: unknown, schema: unknown) {
    this.checkRetry(scope, tool, args)
    if (!schema || typeof schema !== 'object') throw new Error('BROWSER_SCHEMA_UNAVAILABLE: 未发送请求，请先查询工具 schema')
    const serialized = JSON.stringify(schema)
    let validate = this.validators.get(serialized)
    if (!validate) {
      validate = ajv.compile(schema)
      if (this.validators.size >= 100) this.validators.clear()
      this.validators.set(serialized, validate)
    }
    if (!validate(args)) {
      const issues = validate.errors.slice(0, 8).map((e: any) => ({ path: e.instancePath || '/', rule: e.keyword, message: e.message, constraint: e.params }))
      throw new Error(`BROWSER_ARGUMENT_INVALID: 未发送浏览器请求。${JSON.stringify(issues)}；查询 ai_recruit_browser_tools 的对应 tool，按 schema 修正，禁止猜测。`)
    }
  }
  failed(scope: string, tool: string, args: unknown) {
    const key = this.key(scope, tool), now = Date.now()
    for (const [k, v] of this.failures) if (now - v.time >= 120000) this.failures.delete(k)
    const item = this.failures.get(key) || { time: now, attempts: new Set<string>() }
    item.attempts.add(createHash('sha256').update(canonical(args)).digest('hex'))
    this.failures.set(key, item)
    if (this.failures.size > 500) this.failures.delete(this.failures.keys().next().value!)
  }
  succeeded(scope: string, tool: string) { this.failures.delete(this.key(scope, tool)) }
}
