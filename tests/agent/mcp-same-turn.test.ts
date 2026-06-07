import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Config } from '../../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(__dirname, '..', 'fixtures', 'stub-mcp-server.mjs');

// Same minimal mocks as core.test.ts — keep fs/identity/memory inert.
vi.mock('../../src/providers/index.js', () => ({
  createProvider: () => ({ chat: vi.fn() }),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, appendFileSync: vi.fn(), existsSync: vi.fn(() => false), readFileSync: vi.fn(() => ''), mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});
vi.mock('../../src/agent/identity.js', () => ({
  IdentityManager: class {
    get() { return { id: 'test-id', name: 'wally', createdAt: '', capabilities: [] }; }
    addCapability() {}
  },
}));

// Capture appended history messages so we can assert no secret leaks.
const appended: Array<{ role: string; content: unknown }> = [];
vi.mock('../../src/memory/history.js', () => ({
  HistoryMemory: class {
    getBuffer() { return []; }
    append(m: { role: string; content: unknown }) { appended.push(m); }
    getLastN() { return []; }
    getSince() { return []; }
    warmLoad() {}
  },
}));
vi.mock('../../src/memory/errors.js', () => ({
  ErrorMemory: class { append() {} getLastN() { return []; } formatForPrompt() { return ''; } },
}));

const { AgentCore } = await import('../../src/agent/core.js');
const { createProvider } = await import('../../src/providers/index.js');
const { IdentityManager } = await import('../../src/agent/identity.js');
const { HistoryMemory } = await import('../../src/memory/history.js');
const { ErrorMemory } = await import('../../src/memory/errors.js');
const { MCPManager } = await import('../../src/mcp/manager.js');

const config: Config = {
  provider: 'anthropic', agentName: 'wally', agentPort: 3456,
  agentModel: 'claude-sonnet-4-6', agentTimeoutMs: 300_000,
};

function makeAgent() {
  const agent = new AgentCore(config, new IdentityManager('', 'wally'), new HistoryMemory(''), new ErrorMemory(''), '/tmp/test-audit.jsonl');
  return agent;
}

describe('AgentCore — MCP same-turn install + use', () => {
  let mgr: InstanceType<typeof MCPManager>;

  afterEach(async () => {
    appended.length = 0;
    await mgr?.shutdownAll();
  });

  it('connects a server via connect_mcp_server then calls its tool in the same turn', async () => {
    const agent = makeAgent();
    mgr = new MCPManager();
    agent.setMcpManager(mgr);
    // Wire the callback exactly as index.ts does (minus saveMcpServer disk write).
    agent.connectMcpServer = async (name, cfg) => {
      await mgr.connect(name, cfg);
      agent.setMcpManager(mgr);
    };

    const provider = (createProvider as ReturnType<typeof vi.fn>)('');
    let call = 0;
    provider.chat = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 't1', name: 'connect_mcp_server', input: { name: 'stub', command: process.execPath, args: [STUB] } }],
        };
      }
      if (call === 2) {
        return {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 't2', name: 'stub__echo', input: { msg: 'same-turn' } }],
        };
      }
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    });
    (agent as unknown as { provider: typeof provider }).provider = provider;

    const result = await agent.chat('connect the stub and echo');
    expect(result).toBe('done');

    // The echo tool_result must contain the round-tripped output, proving same-turn use.
    const flat = JSON.stringify(appended);
    expect(flat).toContain('echo: same-turn');
  });

  it('connect_mcp_server tool schema has no env field (no secrets via chat)', () => {
    const agent = makeAgent();
    const tools = (agent as unknown as { buildTools(): Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> }).buildTools();
    const tool = tools.find(t => t.name === 'connect_mcp_server');
    expect(tool).toBeDefined();
    expect(Object.keys(tool!.inputSchema.properties ?? {})).not.toContain('env');
  });
});
