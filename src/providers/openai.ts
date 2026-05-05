import OpenAI from 'openai';
import type { LLMProvider, LLMResponse, NormalizedContentBlock, NormalizedMessage, NormalizedTool } from './types.js';

type OpenAIMessage =
  | OpenAI.Chat.ChatCompletionSystemMessageParam
  | OpenAI.Chat.ChatCompletionUserMessageParam
  | OpenAI.Chat.ChatCompletionAssistantMessageParam
  | OpenAI.Chat.ChatCompletionToolMessageParam;

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(model: string) {
    this.model = model;
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    });
  }

  async chat(params: {
    system: string;
    tools: NormalizedTool[];
    messages: NormalizedMessage[];
    maxTokens: number;
  }): Promise<LLMResponse> {
    const { system, tools, messages, maxTokens } = params;

    const openAITools: OpenAI.Chat.ChatCompletionTool[] = tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const openAIMessages: OpenAIMessage[] = [
      { role: 'system', content: system },
      ...unpackMessages(messages),
    ];

    const RETRYABLE = new Set([429, 503]);
    const DELAYS_MS = [2000, 4000, 8000, 16000];
    let response!: OpenAI.Chat.Completions.ChatCompletion;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        response = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: maxTokens,
          tools: openAITools,
          messages: openAIMessages,
        });
        break;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status && RETRYABLE.has(status) && attempt < 4) {
          await new Promise(r => setTimeout(r, DELAYS_MS[attempt]));
          continue;
        }
        throw err;
      }
    }

    const choice = response.choices[0];
    const finishReason = choice.finish_reason;

    let stopReason: LLMResponse['stopReason'];
    if (finishReason === 'stop') stopReason = 'end_turn';
    else if (finishReason === 'tool_calls') stopReason = 'tool_use';
    else stopReason = 'other';

    const content: NormalizedContentBlock[] = [];
    const msg = choice.message;

    if (msg.content) {
      content.push({ type: 'text', text: msg.content });
    }

    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let input: unknown;
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = {};
        }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
    }

    return { stopReason, content };
  }
}

function unpackMessages(messages: NormalizedMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: 'user', content: msg.content });
      continue;
    }

    if (msg.role === 'user') {
      const toolResults = msg.content.filter(b => b.type === 'tool_result');
      const otherBlocks = msg.content.filter(b => b.type !== 'tool_result');

      if (otherBlocks.length > 0) {
        const text = otherBlocks
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map(b => b.text)
          .join('');
        if (text) result.push({ role: 'user', content: text });
      }

      for (const b of toolResults) {
        if (b.type !== 'tool_result') continue;
        const content = b.is_error ? `[ERROR] ${b.content}` : b.content;
        result.push({
          role: 'tool' as const,
          tool_call_id: b.tool_use_id,
          content,
        });
      }
    } else {
      const textBlocks = msg.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text');
      const toolUseBlocks = msg.content.filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use');

      const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: textBlocks.length > 0 ? textBlocks.map(b => b.text).join('') : null,
      };

      if (toolUseBlocks.length > 0) {
        assistantMsg.tool_calls = toolUseBlocks.map(b => ({
          id: b.id,
          type: 'function' as const,
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input),
          },
        }));
      }

      result.push(assistantMsg);
    }
  }

  return result;
}
