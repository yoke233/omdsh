/** Settings-aware first-prompt title provider for the terminal profile. */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import {
  generateSessionTitleWithLlm,
  SessionTitleLlmConfigFields,
  type SessionTitleLlmConfig,
} from '@deepseek-ai/dsh-session-title-llm'
import z from '@deepseek-ai/schemastery'

export const name = 'session-title-first-prompt-llm'
export const inject = ['sessionTitle', 'llm', 'sessions']

export interface Config extends Omit<SessionTitleLlmConfig, 'provider' | 'model'> {
  provider: Volatile<string | undefined>
  model: Volatile<string | undefined>
}

export const Config: z<SessionTitleLlmConfig, Config> = z.object({
  targetWords: SessionTitleLlmConfigFields.targetWords,
  targetCjkCharacters: SessionTitleLlmConfigFields.targetCjkCharacters,
  maxInputBytes: SessionTitleLlmConfigFields.maxInputBytes,
  maxOutputTokens: SessionTitleLlmConfigFields.maxOutputTokens,
  timeoutMs: SessionTitleLlmConfigFields.timeoutMs,
  provider: z.string().volatile(),
  model: z.string().volatile(),
})

function currentConfig(config: Config): SessionTitleLlmConfig {
  const provider = config.provider.get()
  const model = config.model.get()
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('session-title settings require provider and model together')
  }
  return {
    targetWords: config.targetWords,
    targetCjkCharacters: config.targetCjkCharacters,
    maxInputBytes: config.maxInputBytes,
    maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
    ...(provider === undefined || model === undefined ? {} : { provider, model }),
  }
}

export function apply(ctx: Context, config: Config): void {
  currentConfig(config)
  const providerId = SessionTitleProviderId(name)
  ctx.sessionTitle.register({
    id: providerId,
    automatic: 'first-prompt',
    async generate(request) {
      const first = request.messages[0]
      if (first === undefined) throw new Error('first-prompt title provider requires one human message')
      return generateSessionTitleWithLlm(
        ctx,
        currentConfig(config),
        request,
        [first],
        providerId,
      )
    },
  })
}
