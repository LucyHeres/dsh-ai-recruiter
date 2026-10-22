import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { runBrowserAgent, type BrowserAgentOptions, type BrowserAgentResult } from './browser-agent.js'
import type { DeveloperLog } from './developer-log.js'
import { assertHostModelProvider } from './host-model-provider.js'

export type BrowserAgentRunner = (options: BrowserAgentOptions) => Promise<BrowserAgentResult>
export type BrowserAgentModelConfig = {
  browserAgentProvider?: string
  browserAgentModel?: string
  /** auto-low selects only an adapter-advertised low effort; inherit preserves the host selection. */
  browserAgentReasoningEffort?: string
}
/** One model loop for browser tasks; task modules supply only goals and hooks. */
export function hostBrowserAgent(ctx: Context, logger?: DeveloperLog, config: BrowserAgentModelConfig = {}): () => BrowserAgentRunner {
  return () => {
    const llm = ctx.get('llm') as { stream(options: GenerateOptions): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>;
      resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<LlmResolvedModelInfo>;
      listProviders?: () => readonly { id: string }[] } | undefined
    const defaults = ctx.get('agentDefaultModel') as { currentSelection(): Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort'> } | undefined
    const selected = defaults?.currentSelection()
    const provider = config.browserAgentProvider?.trim(), model = config.browserAgentModel?.trim()
    if (!!provider !== !!model) throw new Error('BROWSER_AGENT_MODEL_CONFIG_INVALID: 浏览器专用 provider/model 必须同时填写')
    const baseRoute = provider && model ? { provider, model } as Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort'> : selected && { ...selected }
    if (!llm || !baseRoute?.provider || !baseRoute.model) throw new Error('招聘工作台需要宿主模型服务和默认模型')
    assertHostModelProvider(llm, baseRoute.provider, !!provider)
    let cachedInfo: { value: LlmResolvedModelInfo; expiresAt: number } | undefined
    return async options => {
      const route = { ...baseRoute }
      const effort = config.browserAgentReasoningEffort?.trim() || 'auto-low'
      if (effort !== 'inherit') {
        let info = cachedInfo && cachedInfo.expiresAt > Date.now() ? cachedInfo.value : undefined
        if (!info && llm.resolveModelInfo) {
          const lookup = new AbortController(), timer = setTimeout(() => lookup.abort(), 1500)
          const signal = AbortSignal.any([options.signal, lookup.signal])
          try {
            info = await Promise.race([llm.resolveModelInfo(route.provider, route.model, signal), new Promise<never>((_, reject) => {
              if (signal.aborted) reject(signal.reason)
              else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            })])
            if (info && !signal.aborted) cachedInfo = { value: info, expiresAt: Date.now() + 5 * 60 * 1000 }
          } catch { options.signal.throwIfAborted() } finally { clearTimeout(timer); lookup.abort() }
        }
        const requested = effort === 'auto-low' ? 'low' : effort
        const supported = info?.reasoning?.efforts.find(item => item.id === requested)
        if (supported) route.reasoningEffort = supported.id
        else if (effort !== 'auto-low') throw new Error('BROWSER_AGENT_REASONING_UNSUPPORTED: 当前模型未声明该推理档位，不发送不支持的参数')
      }
      try { (options.logger ?? logger)?.write('info', 'browser_agent.model_profile', { provider: route.provider, model: route.model,
        reasoningEffort: route.reasoningEffort, profile: effort, dedicatedRoute: !!provider }) } catch { /* observer only */ }
      return runBrowserAgent(llm, route, { ...options, logger: options.logger ?? logger })
    }
  }
}
