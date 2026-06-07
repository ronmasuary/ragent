# MCP Client — Ragent

Ragent is an **MCP (Model Context Protocol) client**. It can spawn configured MCP
**stdio servers** as child processes, fetch their tools, and merge them into its
own tool surface — exactly like Claude Code / Desktop. Any MCP server becomes
"installable and usable" generically; nothing server-specific lives in ragent.

> **v1 scope:** tools only. MCP resources and prompts are not consumed yet.
> Non-text tool result blocks (images, audio) are dropped.

## How it works

```
mcp.json ─► MCPManager.connectAll() ─► spawn stdio child ─► listTools()
                                                              │
                                          tools namespaced as server__tool
                                                              │
                                              merged into AgentCore tool list
```

- Each server is spawned as a child process over stdio using the official
  `@modelcontextprotocol/sdk`.
- Tool names are namespaced **`server__tool`** (double underscore) to avoid
  collisions between servers.
- A server that fails to spawn or hangs on `initialize` (10s timeout) is logged
  and skipped — **warn + continue**. The agent still boots, and other servers
  are unaffected.

## Configuration — `mcp.json`

Standard format, at the repo root (gitignored — may hold secrets):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    "weather": {
      "command": "node",
      "args": ["/opt/weather/server.js"],
      "env": { "API_TOKEN": "..." }
    }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `command` | yes | Executable to spawn (`npx`, `node`, an absolute path, …) |
| `args` | no | Argument array |
| `env` | no | Extra env vars merged over the inherited environment — **carries secrets** |
| `cwd` | no | Working directory for the child process |

Override the config path with `MCP_CONFIG=/abs/path/to/mcp.json`.

## Runtime add (no restart)

A server can be connected live and is usable in the **same** chat turn (the tool
list is rebuilt per loop iteration).

**Via chat** — the built-in `connect_mcp_server` tool:

> "Connect an MCP server named `weather` running `node /opt/weather/server.js`"

```jsonc
// tool input — note: NO env field
{ "name": "weather", "command": "node", "args": ["/opt/weather/server.js"] }
```

The chat tool **cannot pass `env`**: chat tool inputs are persisted to
`history.jsonl` and re-injected into later prompts, so secrets must never flow
through it. Servers needing secret env are added via `mcp.json` or the auth'd
HTTP endpoint below.

**Via HTTP** — `POST /mcp/add` (carries `env`, since an auth'd HTTP body is not
written to chat history):

```sh
curl -X POST http://localhost:3456/mcp/add \
  -H 'Content-Type: application/json' \
  -H "X-Api-Key: $API_KEY" \
  -d '{"name":"weather","command":"node","args":["/opt/weather/server.js"],"env":{"API_TOKEN":"..."}}'
```

Both paths persist the entry to `mcp.json` so it survives a restart.

Other endpoints: `GET /mcp` (list connected servers + their tools),
`DELETE /mcp/:name` (disconnect + remove from `mcp.json`). See [api.md](./api.md).

## Lifecycle

- **Startup:** `connectAll(loadMcpConfig())` connects every configured server.
- **Reconnect:** re-adding a name disconnects the old child first (no orphans).
- **Shutdown:** on SIGINT/SIGTERM, after the in-flight chat drains, every MCP
  child transport is closed (per-close 3s timeout so a stuck child can't hang
  exit). Ragent terminates **only its own** spawned children.

## Local testing (no npm publish)

For a server not published to npm, point `command`/`args` at a local build via
absolute path (or `npm link` it and use the bin name):

```json
{ "mcpServers": { "my-server": {
  "command": "node",
  "args": ["/abs/path/to/your-server/dist/server.js"]
} } }
```

```sh
# or link it, then use the bin name
cd /abs/path/to/your-server && npm link
# mcp.json → { "command": "your-server-bin" }
```

Fastest inner loop for development is the stub fixture used in the test suite:
`tests/fixtures/stub-mcp-server.mjs` (one `echo` tool, no setup).

> A server with unmet runtime prerequisites still spawns but its tool calls
> error — which exercises ragent's warn+continue path.
