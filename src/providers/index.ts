import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import type { LLMProvider } from './types.js';

export * from './types.js';

export function createProvider(model: string): LLMProvider {
  const provider = process.env.PROVIDER ?? 'anthropic';
  if (provider === 'openai') return new OpenAIProvider(model);
  return new AnthropicProvider(model);
}

export function resolveAgentModel(): string {
  const provider = process.env.PROVIDER ?? 'anthropic';
  const isAnthropic = provider !== 'openai';
  return process.env.AGENT_MODEL ?? (isAnthropic ? 'claude-sonnet-4-6' : 'gpt-4o');
}
