import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, rm, lstat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export function stable(v: any): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
  return JSON.stringify(v)
}
export const hash = (v: unknown) => createHash('sha256').update(stable(v)).digest('hex')
export class Store {
  readonly root: string
  constructor(root: string, namespace: string) {
    if (root && !isAbsolute(root)) throw new Error('stateDirectory 必须是绝对路径')
    this.root = join(root || join(homedir(), '.xinling-recruitment'), hash(namespace).slice(0, 20))
  }
  async init() { await mkdir(this.root, { recursive: true, mode: 0o700 }); if ((await lstat(this.root)).isSymbolicLink()) throw new Error('状态目录不能是符号链接') }
  path(id: string, suffix = 'json') {
    if (!/^[a-zA-Z0-9_-]{1,90}$/.test(id)) throw new Error('记录 ID 格式错误')
    return join(this.root, `${id}.${suffix}`)
  }
  async get<T = any>(id: string): Promise<T> { return JSON.parse(await readFile(this.path(id), 'utf8')) }
  async find<T>(id: string): Promise<T | null> {
    try { return await this.get<T>(id) } catch (error: any) { if (error.code === 'ENOENT') return null; throw error }
  }
  async list<T>(prefix: string): Promise<T[]> {
    await this.init()
    const names = (await readdir(this.root)).filter(name => name.startsWith(prefix) && /^[A-Za-z0-9_-]+\.json$/.test(name))
    return Promise.all(names.map(name => this.get<T>(name.slice(0, -5))))
  }
  async put(id: string, value: unknown) { await this.file(id, 'json', JSON.stringify(value, null, 2)) }
  async file(id: string, suffix: 'json' | 'md' | 'html', text: string) {
    await this.init()
    const dest = this.path(id, suffix), temp = dest + '.' + randomUUID() + '.tmp'
    await writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await rename(temp, dest)
    return dest
  }
  async locked<T>(key: string, action: () => Promise<T>) {
    await this.init(); const lock = this.path(key, 'lock')
    try { await mkdir(lock, { mode: 0o700 }) } catch (e: any) {
      if (e.code === 'EEXIST') throw new Error('任务正在执行或前次进程异常退出；请先核查记录，不能自动解除锁并重放')
      throw e
    }
    try { return await action() } finally { await rm(lock, { recursive: true }) }
  }
}
export function escapeHtml(s: string) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)) }
export function htmlDocument(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>body{max-width:1100px;margin:40px auto;padding:0 24px;font:15px/1.7 system-ui;color:#172033;overflow-wrap:anywhere}h1,h2{color:#4338ca}table{border-collapse:collapse;width:100%;margin:20px 0}th,td{padding:10px;text-align:left;border-bottom:1px solid #ddd}th{background:#eef2ff}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.muted{color:#64748b}@media print{body{margin:0}section{break-before:page}h2{break-after:avoid}}</style><body>${body}</body></html>`
}
