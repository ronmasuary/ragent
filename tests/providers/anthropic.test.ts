import { describe, it, expect, vi } from 'vitest';

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class Anthropic {
      messages = {
        create: vi.fn().mockResolvedValue({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Hello' }],
        }),
      };
    },
  };
});

const { AnthropicProvider } = await import('../../src/providers/anthropic.js');

describe('AnthropicProvider', () => {
  it('places cache_control on last tool', async () => {
    const provider = new AnthropicProvider('claude-sonnet-4-6');
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const instance = new Anthropic();

    // Inject mock
    (provider as unknown as { client: typeof instance }).client = instance;

    await provider.chat({
      system: 'you are wally',
      tools: [
        { name: 'tool_a', description: 'a', inputSchema: { type: 'object', properties: {} } },
        { name: 'tool_b', description: 'b', inputSchema: { type: 'object', properties: {} } },
      ],
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 100,
    });

    expect(instance.messages.create).toHaveBeenCalled();
    const callArgs = (instance.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const tools = callArgs.tools as Array<{ name: string; cache_control?: unknown }>;

    // Last tool should have cache_control
    expect(tools[tools.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    // Other tools should NOT have cache_control
    expect(tools[0].cache_control).toBeUndefined();
  });

  it('applies cache_control to system prompt', async () => {
    const provider = new AnthropicProvider('claude-sonnet-4-6');
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const instance = new Anthropic();
    (provider as unknown as { client: typeof instance }).client = instance;

    await provider.chat({
      system: 'you are wally',
      tools: [],
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 100,
    });

    const callArgs = (instance.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemBlocks = callArgs.system as Array<{ type: string; cache_control?: unknown }>;
    expect(systemBlocks[systemBlocks.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('normalizes end_turn stop reason', async () => {
    const provider = new AnthropicProvider('claude-sonnet-4-6');
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const instance = new Anthropic();
    instance.messages.create = vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hi' }],
    });
    (provider as unknown as { client: typeof instance }).client = instance;

    const result = await provider.chat({
      system: '',
      tools: [],
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 100,
    });

    expect(result.stopReason).toBe('end_turn');
    expect(result.content[0]).toEqual({ type: 'text', text: 'hi' });
  });
});
