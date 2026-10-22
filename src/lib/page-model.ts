import { recruiterMessageSource as source } from './llm-message-source.js'
import { BlockAssembler, createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { nativePagePlanner } from './page-tool-agent.js'
import type { PageInspector } from './page-inspection.js'
import type { DeveloperLog } from './developer-log.js'
import { assertHostModelProvider } from './host-model-provider.js'

/** Uses the Host's configured default model and credential-owning LLM adapter. */
export interface PagePlanner<T> { decide(observation: Record<string, unknown>, signal: AbortSignal, inspect?: PageInspector): Promise<T>; recordResult?(result: Record<string, unknown>): void }

export function hostPagePlanner<T>(ctx: Context, schema: z.ZodType<T>, system: string, feature: string, logger?: DeveloperLog): () => PagePlanner<T> {
  return () => {
    const llm = ctx.get('llm') as { stream(options: GenerateOptions): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>;
      listProviders?: () => readonly { id: string }[] } | undefined
    const defaults = ctx.get('agentDefaultModel') as { currentSelection(): Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort'> } | undefined
    const route = defaults?.currentSelection()
    if (!llm || !route?.provider || !route.model) throw new Error('招聘工作台需要宿主模型服务和默认模型，请在薪灵模型设置中完成配置')
    assertHostModelProvider(llm, route.provider)
    if (feature === 'greeting' || feature === 'resume') return nativePagePlanner(llm, route, schema, system, feature, logger)
    return {
      async decide(observation, signal) {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(90000)])
        const messages = [createUserMessage({ source,
          content: [{ type: 'text', text: JSON.stringify(observation) }] })]
        for (let attempt = 0; attempt < 2; attempt++) {
          requestSignal.throwIfAborted()
          const started = Date.now(), assembler = new BlockAssembler()
          let finished = false
          try {
            for await (const chunk of llm.stream({ ...route, system: `${system}\nJSON Schema: ${JSON.stringify(z.toJSONSchema(schema))}`, messages, maxTokens: 4096, signal: requestSignal })) {
              if (chunk.type === 'finish') finished = true
              assembler.push(chunk)
            }
            requestSignal.throwIfAborted()
            const finish = assembler.finish
            if (!finished || finish.kind !== 'stop') {
              logger?.write('warn', `${feature}.model_incomplete`, { finishReason: finish.kind,
                errorCode: 'failure' in finish ? finish.failure.code : undefined })
              throw new Error('AI 页面理解未完成，请检查薪灵模型连接后重试')
            }
            const raw = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('').trim()
            try {
              const action = schema.parse(JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')))
              logger?.write('info', `${feature}.model_decision`, { action: (action as { action?: unknown }).action, ref: (action as { ref?: unknown }).ref,
                durationMs: Date.now() - started, inputTokens: assembler.usage?.inputTokens, outputTokens: assembler.usage?.outputTokens })
              return action
            } catch {
              if (attempt) throw new Error(`${feature.toUpperCase()}_MODEL_ACTION_INVALID`)
              messages.push(createUserMessage({ source,
                content: [{ type: 'text', text: '上次输出不是符合 schema 的完整 JSON；没有执行任何动作。请根据同一份页面重新输出一个合法动作。' }] }))
            }
          } catch (error) {
            logger?.write('warn', `${feature}.model_failed`, { durationMs: Date.now() - started, attempt })
            signal.throwIfAborted()
            throw error
          }
        }
        throw new Error(`${feature.toUpperCase()}_MODEL_ACTION_INVALID`)
      },
    }
  }
}

