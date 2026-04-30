import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMResponse, NormalizedContentBlock, NormalizedMessage, NormalizedTool } from './types.js';

async function retryOnOverload<T>(fn: () => Promise<T>): Promise<T> {
  let delay = 1000;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if ((status !== 529 && status !== 429) || attempt === 3) throw err;
      const retryDelay = status === 429 ? delay * 2 : delay;
      console.error(`[Anthropic] ${status} ${status === 429 ? 'rate limited' : 'overloaded'} — retrying in ${retryDelay / 1000}s (attempt ${attempt + 1}/4)`);
      await new Promise(r => setTimeout(r, retryDelay));
      delay *= 2;
    }
  }
  throw new Error('unreachable');
}

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(model: string) {
    this.model = model;
    this.client = new Anthropic({
      defaultHeaders: {
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
    });
  }

  async chat(params: {
    system: string;
    tools: NormalizedTool[];
    messages: NormalizedMessage[];
    maxTokens: number;
  }): Promise<LLMResponse> {
    const { system, tools, messages, maxTokens } = params;

    const anthropicTools: Anthropic.Tool[] = tools.map((t, i) => {
      const tool: Anthropic.Tool = {
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
      };
      if (i === tools.length - 1) {
        (tool as Anthropic.Tool & { cache_control: unknown }).cache_control = { type: 'ephemeral' };
      }
      return tool;
    });

    const anthropicMessages: Anthropic.MessageParam[] = messages.map(m => ({
      role: m.role,
      content: normalizedContentToAnthropic(m.content),
    }));

    const response = await retryOnOverload(() => this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system: [
        {
          type: 'text',
          text: system,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: anthropicTools,
      messages: anthropicMessages,
    }));

    let stopReason: LLMResponse['stopReason'];
    if (response.stop_reason === 'end_turn') stopReason = 'end_turn';
    else if (response.stop_reason === 'tool_use') stopReason = 'tool_use';
    else stopReason = 'other';

    const content: NormalizedContentBlock[] = response.content.map(b => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      return { type: 'text', text: '' };
    });

    return { stopReason, content };
  }
}

function normalizedContentToAnthropic(
  content: string | NormalizedContentBlock[]
): Anthropic.MessageParam['content'] {
  if (typeof content === 'string') return content;
  return content.map(b => {
    if (b.type === 'text') return { type: 'text' as const, text: b.text };
    if (b.type === 'tool_use') {
      return {
        type: 'tool_use' as const,
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      };
    }
    return {
      type: 'tool_result' as const,
      tool_use_id: b.tool_use_id,
      content: b.content,
      is_error: b.is_error,
    };
  }) as Anthropic.MessageParam['content'];
}
