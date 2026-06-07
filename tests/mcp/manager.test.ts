import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { MCPManager } from '../../src/mcp/manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(__dirname, '..', 'fixtures', 'stub-mcp-server.mjs');
const HANG = path.join(__dirname, '..', 'fixtures', 'hang-mcp-server.mjs');

function nodeCfg(file: string) {
  return { command: process.execPath, args: [file] };
}

describe('MCPManager', () => {
  let mgr: MCPManager;

  afterEach(async () => {
    await mgr?.shutdownAll();
  });

  it('connects a stub server and namespaces its tools', async () => {
    mgr = new MCPManager();
    await mgr.connect('stub', nodeCfg(STUB));
    const tools = mgr.getTools();
    expect(tools.map(t => t.name)).toContain('stub__echo');
    expect(mgr.listServers()).toEqual([{ name: 'stub', tools: ['stub__echo'] }]);
  });

  it('round-trips a tool call', async () => {
    mgr = new MCPManager();
    await mgr.connect('stub', nodeCfg(STUB));
    const out = await mgr.callTool('stub__echo', { msg: 'hi' });
    expect(out).toBe('echo: hi');
  });

  it('throws on unknown tool', async () => {
    mgr = new MCPManager();
    await mgr.connect('stub', nodeCfg(STUB));
    await expect(mgr.callTool('stub__nope', {})).rejects.toThrow(/Unknown MCP tool/);
  });

  it('warns + continues when a server command is bad (connectAll isolates failures)', async () => {
    mgr = new MCPManager();
    await mgr.connectAll({
      mcpServers: {
        bad: { command: '/no/such/binary-xyz', args: [] },
        stub: nodeCfg(STUB),
      },
    });
    // bad failed, stub still connected
    expect(mgr.listServers().map(s => s.name)).toEqual(['stub']);
  });

  it('reconnect cleans up the old child (no orphan, single entry)', async () => {
    mgr = new MCPManager();
    await mgr.connect('stub', nodeCfg(STUB));
    await mgr.connect('stub', nodeCfg(STUB)); // re-add
    expect(mgr.listServers()).toHaveLength(1);
    expect(mgr.getTools().map(t => t.name)).toEqual(['stub__echo']);
  });

  it('disconnect removes tools from getTools and dispatch routing', async () => {
    mgr = new MCPManager();
    await mgr.connect('stub', nodeCfg(STUB));
    await mgr.disconnect('stub');
    expect(mgr.getTools()).toHaveLength(0);
    expect(mgr.listServers()).toHaveLength(0);
    await expect(mgr.callTool('stub__echo', { msg: 'x' })).rejects.toThrow(/Unknown MCP tool/);
  });

  it('rejects within the connect timeout for a hanging server', async () => {
    mgr = new MCPManager({ connectTimeoutMs: 2_000 });
    const start = Date.now();
    await expect(mgr.connect('hang', nodeCfg(HANG))).rejects.toThrow(/timed out/);
    // Timeout fires at 2s; closing the hung child adds a SIGTERM grace period.
    expect(Date.now() - start).toBeLessThan(8_000);
    expect(mgr.listServers()).toHaveLength(0);
  }, 12_000);
});
