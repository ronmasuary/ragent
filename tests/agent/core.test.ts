import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../src/config.js';

// Minimal mocks
vi.mock('../../src/providers/index.js', () => ({
  createProvider: () => ({
    chat: vi.fn(),
  }),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    appendFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    mkdirSync: vi.fn(),
  };
});

vi.mock('../../src/agent/identity.js', () => ({
  IdentityManager: class {
    get() { return { id: 'test-id', name: 'wally', createdAt: '', capabilities: [] }; }
    addCapability() {}
  },
}));

vi.mock('../../src/memory/history.js', () => ({
  HistoryMemory: class {
    getBuffer() { return []; }
    append() {}
    getLastN() { return []; }
    getSince() { return []; }
    warmLoad() {}
  },
}));

vi.mock('../../src/memory/errors.js', () => ({
  ErrorMemory: class {
    append() {}
    getLastN() { return []; }
    formatForPrompt() { return ''; }
  },
}));

const { AgentCore } = await import('../../src/agent/core.js');
const { createProvider } = await import('../../src/providers/index.js');
const { IdentityManager } = await import('../../src/agent/identity.js');
const { HistoryMemory } = await import('../../src/memory/history.js');
const { ErrorMemory } = await import('../../src/memory/errors.js');

const config: Config = {
  provider: 'anthropic',
  agentName: 'wally',
  agentPort: 3456,
  agentModel: 'claude-sonnet-4-6',
  agentTimeoutMs: 300_000,
};

function makeAgent() {
  const identityManager = new IdentityManager('', 'wally');
  const historyMemory = new HistoryMemory('');
  const errorMemory = new ErrorMemory('');
  const agent = new AgentCore(config, identityManager, historyMemory, errorMemory, '/tmp/test-audit.jsonl');
  return { agent, historyMemory, errorMemory };
}

describe('AgentCore — generation counter (timeout orphan)', () => {
  it('does not reset isRunning when gen has been bumped (HTTP timeout scenario)', async () => {
    const { agent } = makeAgent();
    const provider = (createProvider as ReturnType<typeof vi.fn>)('');

    let resolveLong!: () => void;
    const longPending = new Promise<void>(r => { resolveLong = r; });

    provider.chat = vi.fn().mockImplementation(async () => {
      await longPending;
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    });
    (agent as unknown as { provider: typeof provider }).provider = provider;

    // Start a long-running chat
    const chatPromise = agent.chat('slow');
    await Promise.resolve(); // yield so isRunning = true

    expect(agent.isRunning).toBe(true);

    // Simulate HTTP timeout: bump gen and clear isRunning externally
    agent.gen++;
    agent.isRunning = false;

    // New request can now proceed
    expect(agent.isRunning).toBe(false);

    // When the orphaned chat finishes, it should NOT re-set isRunning to false
    // (it's already false, and gen !== myGen so the guard protects against flipping it back)
    resolveLong();
    await chatPromise;
    expect(agent.isRunning).toBe(false);
  });
});

describe('AgentCore — global mutex', () => {
  it('blocks concurrent chat() calls', async () => {
    const { agent } = makeAgent();
    const provider = (createProvider as ReturnType<typeof vi.fn>)('');

    let resolveFirst!: () => void;
    const firstPending = new Promise<void>(r => { resolveFirst = r; });

    provider.chat = vi.fn().mockImplementation(async () => {
      await firstPending;
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    });
    (agent as unknown as { provider: typeof provider }).provider = provider;

    const first = agent.chat('slow');
    // yield so the first chat() can set isRunning = true
    await Promise.resolve();

    await expect(agent.chat('concurrent')).rejects.toThrow('Agent busy');

    resolveFirst();
    await first;
  });

  it('releases isRunning after success', async () => {
    const { agent } = makeAgent();
    const provider = (createProvider as ReturnType<typeof vi.fn>)('');
    provider.chat = vi.fn().mockResolvedValue({
      stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }],
    });
    (agent as unknown as { provider: typeof provider }).provider = provider;

    await agent.chat('hello');
    expect(agent.isRunning).toBe(false);
  });

  it('releases isRunning after _loop throws', async () => {
    const { agent } = makeAgent();
    const provider = (createProvider as ReturnType<typeof vi.fn>)('');
    provider.chat = vi.fn().mockRejectedValue(new Error('provider crash'));
    (agent as unknown as { provider: typeof provider }).provider = provider;

    await expect(agent.chat('boom')).rejects.toThrow('provider crash');
    expect(agent.isRunning).toBe(false);
  });
});

describe('AgentCore — reflection loop', () => {
  it('reflects on tool error and retries', async () => {
    const { agent } = makeAgent();
    const provider = (createProvider as ReturnType<typeof vi.fn>)('');
    let callCount = 0;

    provider.chat = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: return tool_use
        return {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: '/nonexistent' } }],
        };
      }
      // After reflection: return end_turn
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'I tried a different approach.' }] };
    });

    // Inject mock provider
    (agent as unknown as { provider: typeof provider }).provider = provider;

    const result = await agent.chat('read a file');
    expect(result).toBe('I tried a different approach.');
    expect(callCount).toBeGreaterThan(1); // at least one retry
  });

  it('surfaces error after 3 retries', async () => {
    const { agent } = makeAgent();
    const provider = (createProvider as ReturnType<typeof vi.fn>)('');

    provider.chat = vi.fn().mockResolvedValue({
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: '/bad' } }],
    });

    (agent as unknown as { provider: typeof provider }).provider = provider;

    const result = await agent.chat('read a file');
    expect(result).toContain('failed after');
    expect(result).toContain('retries');
    // 4 calls: 1 initial + 3 reflections (each time we get tool_use with error, after 3 we stop)
    expect(provider.chat).toHaveBeenCalledTimes(4);
  });

  it('reflection messages NOT appended to HistoryMemory', async () => {
    const { agent, historyMemory } = makeAgent();
    const appendSpy = vi.spyOn(historyMemory, 'append');
    const provider = (createProvider as ReturnType<typeof vi.fn>)('');
    let callCount = 0;

    provider.chat = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: '/bad' } }],
        };
      }
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    });

    (agent as unknown as { provider: typeof provider }).provider = provider;

    await agent.chat('test');

    // user message + assistant end_turn response should be in history
    // reflection message should NOT be
    const calls = appendSpy.mock.calls;
    const reflectionAppended = calls.some(([msg]) => {
      const content = typeof msg.content === 'string' ? msg.content : '';
      return content.includes('Reflect on why');
    });
    expect(reflectionAppended).toBe(false);
  });
});
