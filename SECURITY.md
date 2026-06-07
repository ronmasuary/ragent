# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: ronmas2@gmail.com

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

You'll receive a response within 48 hours. Please allow time to patch before public disclosure.

## Known limitations

- `shell_exec` runs commands without sandboxing — enable `API_KEY` auth before exposing port 3456 publicly
- HTTP server has no rate limiting — recommended to keep behind a firewall or VPN
- Skills run arbitrary code — only install skills from trusted sources

## MCP servers

- MCP servers are spawned as child processes. Ragent trusts and spawns **only** the
  servers listed in `mcp.json` (or added via the auth'd `POST /mcp/add`).
- Server secrets (e.g. the wallet KEK, API tokens) live in each server's `env` block
  in `mcp.json`. **`mcp.json` is gitignored** — never commit it. Secrets are injected
  into the spawned child, not into ragent's own environment.
- The chat `connect_mcp_server` tool **deliberately cannot pass `env`**: chat tool
  inputs are persisted to `history.jsonl` and re-injected into later prompts, so
  routing secrets through chat would leak them. Secret-env servers must be added via
  `mcp.json` or the auth'd `POST /mcp/add` (whose body is not written to history).
- MCP tool output passes the same `MAX_TOOL_RESULT_CHARS` truncation as every other
  tool result. Non-text result blocks (images/audio) are dropped (tools-only v1).
- On shutdown, ragent terminates only the MCP child processes it spawned.
