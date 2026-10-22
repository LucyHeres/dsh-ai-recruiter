import type {} from '@deepseek-ai/dsh-llm'

/** Identify task-local plugin observations without attributing them to the user. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'ai-recruiter': { kind: 'ai-recruiter' }
  }
}
export const recruiterMessageSource = { kind: 'ai-recruiter' as const }
