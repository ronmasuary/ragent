/** A single MCP stdio server entry in mcp.json. */
export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** Shape of mcp.json — standard `{ mcpServers: { name: cfg } }`. */
export interface MCPServersFile {
  mcpServers: Record<string, MCPServerConfig>;
}
