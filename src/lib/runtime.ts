import type { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { Bridge } from './bridge.js'
import { Store } from './store.js'
import { DeveloperLog, type DeveloperLogLevel } from './developer-log.js'
export interface CommonConfig { serverName: string; companyKey: string; stateDirectory: string; developerLogLevel?: DeveloperLogLevel }
export const commonSchema = {
  serverName: Schema.string().default('xrxs'),
  companyKey: Schema.string().default('').description('本任务公司的稳定标识，用于隔离本地执行记录；切换公司时同步修改'),
  stateDirectory: Schema.string().default('').description('产物和任务记录目录，默认 ~/.xinling-recruitment'),
}
export const output = { schema: { type: 'json' } as const,
  render: (_args: unknown, value: any) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
export function runtime(ctx: Context, config: CommonConfig, feature: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(config.serverName)) throw new Error('serverName 格式错误')
  const store = new Store(config.stateDirectory, `${config.serverName}:${config.companyKey}:${feature}`)
  const logger = new DeveloperLog(store.root, config.developerLogLevel, createRequire(import.meta.url)('../../package.json').version)
  logger.write('info', 'plugin.started', { feature, pid: process.pid, nodeVersion: process.version })
  const lifetime = new AbortController(), tasks = new Set<Promise<any>>()
  ctx.effect(() => async () => { lifetime.abort(); await Promise.allSettled([...tasks]); logger.write('info', 'plugin.stopped'); await logger.flush() })
  function run(exec: ToolRunContext, action: (bridge: Bridge, store: Store) => Promise<any>) {
    const signal = AbortSignal.any([exec.signal, lifetime.signal])
    const task = logger.trace('tool.run', {}, async () => { signal.throwIfAborted(); return action(new Bridge(ctx, config.serverName, exec, signal), store) })
    tasks.add(task); void task.then(() => tasks.delete(task), () => tasks.delete(task)); return task
  }
  return { run, store, logger }
}
