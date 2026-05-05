import { describe, it, expect, vi } from 'vitest';

vi.mock('openai', () => {
  return {
    default: class OpenAI {
      chat = {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{
              finish_reason: 'stop',
              message: { content: 'Hello from OpenAI', tool_calls: null },
            }],
          }),
        },
      };
    },
  };
});

const { OpenAIProvider } = await import('../../src/providers/openai.js');

describe('OpenAIProvider', () => {
  it('normalizes stop finish_reason to end_turn', async () => {
    const provider = new OpenAIProvider('gpt-4o');
    const OpenAI = (await import('openai')).default;
    const instance = new OpenAI();
    (provider as unknown as { client: typeof instance }).client = instance;

    const result = await provider.chat({
      system: 'test',
      tools: [],
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 100,
    });

    expect(result.stopReason).toBe('end_turn');
  });

  it('normalizes tool_calls finish_reason to tool_use', async () => {
    const provider = new OpenAIProvider('gpt-4o');
    const OpenAI = (await import('openai')).default;
    const instance = new OpenAI();
    instance.chat.completions.create = vi.fn().mockResolvedValue({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: '/test' }) },
          }],
        },
      }],
    });
    (provider as unknown as { client: typeof instance }).client = instance;

    const result = await provider.chat({
      system: 'test',
      tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
      messages: [{ role: 'user', content: 'read something' }],
      maxTokens: 100,
    });

    expect(result.stopReason).toBe('tool_use');
    expect(result.content[0]).toMatchObject({ type: 'tool_use', name: 'read_file' });
  });

  it('retries on 429 up to 4 times then succeeds', async () => {
    vi.useFakeTimers();
    const provider = new OpenAIProvider('gpt-4o');
    const OpenAI = (await import('openai')).default;
    const instance = new OpenAI();

    let callCount = 0;
    const successResponse = {
      choices: [{ finish_reason: 'stop', message: { content: 'ok', tool_calls: null } }],
    };
    instance.chat.completions.create = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        const err = Object.assign(new Error('rate limited'), { status: 429 });
        throw err;
      }
      return successResponse;
    });
    (provider as unknown as { client: typeof instance }).client = instance;

    const chatPromise = provider.chat({ system: 'test', tools: [], messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
    // advance timers to skip retry delays
    await vi.runAllTimersAsync();
    const result = await chatPromise;

    expect(result.stopReason).toBe('end_turn');
    expect(callCount).toBe(3);
    vi.useRealTimers();
  });

  it('throws after 5 failed attempts on 429', async () => {
    vi.useFakeTimers();
    const provider = new OpenAIProvider('gpt-4o');
    const OpenAI = (await import('openai')).default;
    const instance = new OpenAI();

    const rateLimitErr = Object.assign(new Error('rate limited'), { status: 429 });
    instance.chat.completions.create = vi.fn().mockRejectedValue(rateLimitErr);
    (provider as unknown as { client: typeof instance }).client = instance;

    // Attach catch immediately to prevent unhandled rejection before we await
    const chatPromise = provider.chat({ system: 'test', tools: [], messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
    const safePromise = chatPromise.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const result = await safePromise;
    expect((result as Error).message).toBe('rate limited');
    expect(instance.chat.completions.create).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });

  it('does not retry on non-retryable errors', async () => {
    const provider = new OpenAIProvider('gpt-4o');
    const OpenAI = (await import('openai')).default;
    const instance = new OpenAI();

    const authErr = Object.assign(new Error('unauthorized'), { status: 401 });
    instance.chat.completions.create = vi.fn().mockRejectedValue(authErr);
    (provider as unknown as { client: typeof instance }).client = instance;

    await expect(provider.chat({ system: 'test', tools: [], messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })).rejects.toThrow('unauthorized');
    expect(instance.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it('translates tool_result user messages to role:tool OpenAI format', async () => {
    const provider = new OpenAIProvider('gpt-4o');
    const OpenAI = (await import('openai')).default;
    const instance = new OpenAI();
    instance.chat.completions.create = vi.fn().mockResolvedValue({
      choices: [{ finish_reason: 'stop', message: { content: 'done', tool_calls: null } }],
    });
    (provider as unknown as { client: typeof instance }).client = instance;

    await provider.chat({
      system: 'test',
      tools: [],
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: '/x' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file content' }] },
      ],
      maxTokens: 100,
    });

    const callArgs = (instance.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const msgs = callArgs.messages as Array<{ role: string; tool_call_id?: string }>;
    const toolMsg = msgs.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.tool_call_id).toBe('call-1');
  });
});
