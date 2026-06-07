import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { NormalizedTool } from '../providers/types.js';
import type { MCPServerConfig, MCPServersFile } from './types.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 3_000;

interface Connection {
  client: Client;
  transport: StdioClientTransport;
  tools: NormalizedTool[];
}

export interface MCPManagerOptions {
  /** Per-server connect timeout (initialize handshake). Default 10s. */
  connectTimeoutMs?: number;
}

/**
 * MCP client glue. Spawns configured MCP stdio servers as child processes,
 * fetches their tools, and exposes them namespaced as `server__tool`.
 *
 * Every server is isolated: one failing to spawn warns + continues, never
 * sinks the others or blocks boot.
 */
export class MCPManager {
  private connections = new Map<string, Connection>();
  private toolIndex = new Map<string, { server: string; originalName: string }>();
  private connectTimeoutMs: number;

  constructor(opts: MCPManagerOptions = {}) {
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  /** Connect (or reconnect) a single server. Throws on failure (caller warns + continues). */
  async connect(name: string, cfg: MCPServerConfig): Promise<void> {
    // Reconnect cleanup: a runtime re-add must not orphan the old child process.
    if (this.connections.has(name)) await this.disconnect(name);

    // Transport wants Record<string,string>; process.env has undefined values.
    const env: Record<string, string> = { ...getDefaultEnvironment(), ...(cfg.env ?? {}) };

    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env,
      cwd: cfg.cwd,
    });
    const client = new Client({ name: 'ragent', version: '1.0.0' }, { capabilities: {} });

    try {
      // Connect timeout — a server hanging on initialize must not block startup forever.
      await Promise.race([
        client.connect(transport),
        timeout(this.connectTimeoutMs, `connect timed out after ${this.connectTimeoutMs / 1000}s`),
      ]);

      // listTools pagination
      const rawTools: { name: string; description?: string; inputSchema: unknown }[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        rawTools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);

      const tools: NormalizedTool[] = rawTools.map(t => ({
        name: `${name}__${t.name}`,
        description: t.description ?? '',
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      }));

      for (const t of tools) {
        const originalName = t.name.slice(name.length + 2); // strip `${name}__`
        this.toolIndex.set(t.name, { server: name, originalName });
      }
      this.connections.set(name, { client, transport, tools });
      console.error(`[mcp] ${name} connected (${tools.length} tools)`);
    } catch (err) {
      console.error(`[mcp] ${name} failed: ${(err as Error).message}`);
      try { await transport.close(); } catch { /* best effort */ }
      throw err;
    }
  }

  /** Connect every server in the config. Each is isolated by its own try/catch. */
  async connectAll(file: MCPServersFile): Promise<void> {
    for (const [name, cfg] of Object.entries(file.mcpServers)) {
      try {
        await this.connect(name, cfg);
      } catch {
        // warn + continue — connect() already logged
      }
    }
  }

  /** Flatten every connected server's tools. */
  getTools(): NormalizedTool[] {
    return [...this.connections.values()].flatMap(c => c.tools);
  }

  /** Connected servers + their tool names, for GET /mcp. */
  listServers(): Array<{ name: string; tools: string[] }> {
    return [...this.connections.entries()].map(([name, c]) => ({
      name,
      tools: c.tools.map(t => t.name),
    }));
  }

  /** Call a namespaced MCP tool. Throws on unknown tool or server-side error. */
  async callTool(namespacedName: string, input: Record<string, unknown>): Promise<string> {
    const entry = this.toolIndex.get(namespacedName);
    if (!entry) throw new Error(`Unknown MCP tool: ${namespacedName}`);
    const conn = this.connections.get(entry.server);
    if (!conn) throw new Error(`MCP server not connected: ${entry.server}`);

    const res = await conn.client.callTool({ name: entry.originalName, arguments: input });

    const text = Array.isArray(res.content)
      ? res.content
          .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')
          .map(b => b.text)
          .join('\n')
      : '';

    if (res.isError) throw new Error(text || `MCP tool ${namespacedName} returned an error`);
    return text;
  }

  /** Close one server's transport (terminates its child) and drop its tools. */
  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    for (const t of conn.tools) this.toolIndex.delete(t.name);
    this.connections.delete(name);
    try {
      await Promise.race([conn.transport.close(), timeout(CLOSE_TIMEOUT_MS, 'close timed out')]);
    } catch (err) {
      console.error(`[mcp] ${name} close error: ${(err as Error).message}`);
    }
  }

  /** Close every transport (terminates all child processes). Per-close timeout so a stuck child can't hang exit. */
  async shutdownAll(): Promise<void> {
    await Promise.all(
      [...this.connections.keys()].map(name => this.disconnect(name)),
    );
  }
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
