import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { MCPServerConfig, MCPServersFile } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This module lives in src/mcp/, so the repo root is TWO levels up.
// (src/config.ts uses one '..' because it sits directly in src/.)
const MCP_CONFIG_PATH = process.env.MCP_CONFIG
  ? path.resolve(process.env.MCP_CONFIG)
  : path.resolve(__dirname, '..', '..', 'mcp.json');

/** Read mcp.json from repo root. Missing or malformed → empty, never crashes boot. */
export function loadMcpConfig(): MCPServersFile {
  if (!fs.existsSync(MCP_CONFIG_PATH)) return { mcpServers: {} };
  try {
    const raw = fs.readFileSync(MCP_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as MCPServersFile;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.mcpServers !== 'object') {
      console.error(`[mcp] ${MCP_CONFIG_PATH} missing "mcpServers" — ignoring`);
      return { mcpServers: {} };
    }
    return { mcpServers: parsed.mcpServers ?? {} };
  } catch (err) {
    console.error(`[mcp] Failed to parse ${MCP_CONFIG_PATH}: ${(err as Error).message} — ignoring`);
    return { mcpServers: {} };
  }
}

/** Read-modify-write mcp.json so a runtime-added server survives restart. */
export function saveMcpServer(name: string, cfg: MCPServerConfig): void {
  const file = loadMcpConfig();
  file.mcpServers[name] = cfg;
  writeMcpConfig(file);
}

/** Delete a server key and rewrite mcp.json. */
export function removeMcpServer(name: string): void {
  const file = loadMcpConfig();
  delete file.mcpServers[name];
  writeMcpConfig(file);
}

function writeMcpConfig(file: MCPServersFile): void {
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(file, null, 2) + '\n', 'utf-8');
}
