import { setTimeout as delay } from 'node:timers/promises'

/** Cancellation ends the caller's wait before the gateway's in-flight command
 * necessarily settles. Wait read-only and bounded, never cancel/replay input or
 * release a different local/remote execution owner. */
export async function releaseOwnedBrowser(call: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<any>,
  owned: { workflowTaskId?: string; taskId?: string } | undefined,
  timing: { now?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {}) {
  if (!owned?.workflowTaskId && !owned?.taskId) return call('browser_finish', {}) // legacy begin response
  const clock = timing.now ?? (() => performance.now()), sleep = timing.sleep ?? (ms => delay(ms))
  const timeout = timing.timeoutMs ?? 2000, until = clock() + timeout
  const deadline = new AbortController()
  const timeoutError = new Error('BROWSER_AGENT_RELEASE_PENDING: 原命令仍在收尾，未强制结束或重放')
  let rejectDeadline: (error: Error) => void = () => {}
  const expired = new Promise<never>((_, reject) => { rejectDeadline = reject })
  const timer = setTimeout(() => { deadline.abort(timeoutError); rejectDeadline(timeoutError) }, timeout)
  try {
    return await Promise.race([expired, (async () => {
      while (true) {
        deadline.signal.throwIfAborted()
        const state = await call('browser_status', {}, deadline.signal)
        deadline.signal.throwIfAborted()
        if (state.executionOwner === 'remote' || (owned.workflowTaskId ? state.workflowTaskId !== owned.workflowTaskId : state.taskId !== owned.taskId)) {
          throw new Error('BROWSER_AGENT_OWNERSHIP_CHANGED: 不释放其他任务的浏览器执行权')
        }
        if (!state.busy && !state.queueLength) return call('browser_finish', {}, deadline.signal)
        if (clock() >= until) throw timeoutError
        await sleep(Math.min(100, Math.max(0, until - clock())))
      }
    })()])
  } finally { clearTimeout(timer); deadline.abort() }
}
