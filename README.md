# Ragent

> Autonomous AI agent with hot-loadable skills — a reference implementation of the plugin-agent pattern.

Ragent (short for **R**eal **Agent**) is an open-source demo that shows how to build an agentic AI system where capabilities arrive as drop-in plugins called **skills**. The agent starts clean; you extend it at runtime by dropping a skill directory into `skills/`. No restart required for new skills.

---

## Table of Contents

1. [Overview](#overview)
2. [Features](#features)
3. [Architecture](#architecture)
   - [Component Overview](#component-overview)
   - [Agentic Loop](#agentic-loop)
   - [Skill Hot-Load Flow](#skill-hot-load-flow)
   - [Memory Model](#memory-model)
4. [Quick Start](#quick-start)
5. [Configuration](#configuration)
6. [HTTP API Reference](#http-api-reference)
7. [Built-in Tools](#built-in-tools)
8. [Interfaces](#interfaces)
   - [HTTP Server](#http-server)
   - [Telegram Bot](#telegram-bot)
   - [REPL](#repl)
9. [Skills](#skills)
   - [What is a skill?](#what-is-a-skill)
   - [Directory layout](#directory-layout)
   - [Skill interface](#skill-interface)
   - [Minimal example](#minimal-example)
   - [Hot-loading workflow](#hot-loading-workflow)
10. [Memory & Persistence](#memory--persistence)
11. [Development](#development)
12. [Security Notes](#security-notes)
13. [Contributing](#contributing)

---

## Overview

Ragent is a self-contained AI agent runtime built on top of the Anthropic (or OpenAI) API. You send it a message; it decides which tools to call, calls them, reflects on errors, and returns a final response. The agent remembers its conversation history and past tool failures across restarts.

The core idea is the **skill pattern**: instead of hard-coding capabilities, the agent discovers them dynamically. A skill is a Node.js module that exports a tool list and an execute function. Drop it in the `skills/` directory and the agent picks it up within milliseconds — no code changes, no restart.

This repo is a complete, running reference implementation. Fork it, study the patterns, and build your own agents on top.

---

## Features

- **Dual LLM provider** — works with Anthropic (Claude) or OpenAI (GPT) via a common normalized interface
- **Hot-loadable skills** — drop a directory into `skills/`, the agent loads it without a restart
- **Persistent memory** — conversation history, tool errors, and shell audit survive restarts
- **Three interfaces** — HTTP JSON API, Telegram bot, and interactive REPL
- **Reflection loop** — on tool failure the agent reflects and retries up to 3 times before surfacing the error
- **Prompt caching** — Anthropic system prompt and tool list are cached (`ephemeral`) to reduce latency and cost
- **Rate-limit resilience** — exponential backoff on 429/529 with up to 4 retries (Anthropic provider)
- **Shell audit log** — every `shell_exec` call via HTTP or Telegram is logged to `shell_audit.jsonl`

---

## Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Ragent Process                        │
│                                                             │
│  ┌────────────────┐  ┌─────────────────┐  ┌─────────────┐  │
│  │  HTTP Server   │  │  Telegram Bot   │  │    REPL     │  │
│  │  :3456         │  │  (optional)     │  │ (optional)  │  │
│  └───────┬────────┘  └────────┬────────┘  └──────┬──────┘  │
│          │                   │                   │         │
│          └───────────────────┼───────────────────┘         │
│                              │                             │
│                    ┌─────────▼──────────┐                  │
│                    │     AgentCore      │                  │
│                    │  (agentic loop +   │                  │
│                    │   reflection)      │                  │
│                    └──┬──────┬──────┬───┘                  │
│                       │      │      │                       │
│          ┌────────────▼┐  ┌──▼───┐  ┌▼────────────────┐   │
│          │ LLMProvider │  │Skills│  │     Memory      │   │
│          │             │  │Regis-│  │                 │   │
│          │ Anthropic   │  │try   │  │ history.jsonl   │   │
│          │   or        │  │      │  │ errors.jsonl    │   │
│          │ OpenAI      │  │ n    │  │ shell_audit     │   │
│          │             │  │ skills  │ .jsonl          │   │
│          └─────────────┘  └──────┘  └─────────────────┘   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  SkillWatcher  (fs.watch skills/ → hot-load new dirs) │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Agentic Loop

Each call to `agent.chat(message)` enters this loop. It runs until `end_turn`, an error, or the 20-iteration safety limit.

```
  User message
       │
       ▼
  Append to history.jsonl
       │
       ▼
  Build system prompt
  (identity + skill prompts + last 5 errors)
       │
       ▼
  Build tool list
  (6 built-ins + all skill tools)
       │
       ▼
  ┌────────────────────────┐
  │    LLM API call        │◄─────────────────────────────┐
  └────────────┬───────────┘                              │
               │                                          │
       ┌───────┴────────┐                                 │
       │                │                                 │
  stop_reason      stop_reason                            │
  = end_turn       = tool_use                             │
       │                │                                 │
       ▼                ▼                                 │
  Persist        Execute tools                            │
  response       (built-in or skill)                      │
       │                │                                 │
       ▼         ┌──────┴──────────┐                      │
  Return         │  Tool failed?   │                      │
  text to        └──────┬──────────┘                      │
  caller          yes   │   no                            │
                  │     │                                 │
                  ▼     ▼                                 │
            reflect? persist result                       │
            < 3 retries  │                                │
                  │      └────────────────────────────────┘
                  ▼            (continue loop)
            inject reflection
            msg (in-flight,
            not persisted)
                  │
                  └──────────────────────────────────────►┘
                          (retry)

            ≥ 3 retries → surface error to user
```

**Key limits:**

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_ITERATIONS` | 20 | Safety cap per chat call |
| `MAX_TOKENS` | 8192 | LLM output limit per call |
| `MAX_REFLECTION_RETRIES` | 3 | Tool failure retries |
| `MAX_TOOL_RESULT_CHARS` | 6000 | Tool output truncation |
| `MAX_HISTORY_MESSAGES` | 20 | In-memory buffer size |

### Skill Hot-Load Flow

New skill directories are discovered automatically. Code changes to existing skills require a restart.

```
  You drop skills/my-skill/ directory
               │
               ▼
  fs.watch fires (recursive, macOS/Windows)
               │
               ▼ 500 ms debounce
  Is skills/my-skill/package.json present?
       yes ──►  npm install --prefix skills/my-skill
       no  ──►  skip
               │
               ▼
  import('skills/my-skill/src/index.js')
               │
               ▼
  Validate shape:
    name ✓  version ✓  tools[] ✓  execute() ✓
               │
         invalid? → log warning, skip
               │
               ▼
  AgentCore.registerSkill(skill)
    tools added to tool list
    cacheInvalidated = true
               │
               ▼
  IdentityManager.addCapability(skill.name)
               │
               ▼
  Agent uses new tools on next LLM call
```

> **Note:** ESM `import()` caches modules permanently. If you update an existing skill's code, restart the process. Only **new** directories hot-load without a restart.

> **Linux:** `fs.watch` recursive mode is macOS/Windows only. Use [chokidar](https://github.com/paulmillr/chokidar) on Linux.

### Memory Model

Three append-only JSONL files under `identities/<agentName>/`:

```
identities/wally/
├── identity.json          Agent ID, name, capabilities
├── history.jsonl          Conversation turns (user + assistant + tool results)
├── errors.jsonl           Tool failure log
└── shell_audit.jsonl      Shell command executions (HTTP/Telegram only)
```

```
  history.jsonl                   errors.jsonl             shell_audit.jsonl
  ─────────────────────────────   ──────────────────────   ─────────────────────
  { role, content }               { ts, tool, input,       { ts, command, cwd,
                                    error, context }         exitCode, interface }
  Written on every turn           Written on tool failure  Written on shell_exec
  (user, assistant, tool result)  (all interfaces)         (HTTP + Telegram only)

  In-memory buffer: last 20 msgs  Injected into system     Queryable via
  Disk cap: 10 MB (trim 20%)      prompt (last 5 errors)   GET /shell-audit
  Warm-loaded on startup          on every chat call
```

---

## Quick Start

### Prerequisites

- Node.js 18+
- An Anthropic API key (or OpenAI key if using `PROVIDER=openai`)

### Install

```sh
git clone <repo-url> ragent
cd ragent
npm install
cp .env.example .env
```

### Configure

Edit `.env`:

```sh
ANTHROPIC_API_KEY=sk-ant-...
# Optional overrides:
# AGENT_NAME=wally
# AGENT_PORT=3456
```

### Run

**Background daemon (HTTP server):**
```sh
./start.sh         # starts in background, logs to ragent.log
./stop.sh          # stops it
```

**Interactive REPL:**
```sh
npx tsx src/index.ts --repl
```

**Foreground with logs:**
```sh
npx tsx src/index.ts
```

### Verify

```sh
curl http://localhost:3456/health
# → {"ok":true,"uptime":5}

curl http://localhost:3456/status
# → {"name":"wally","uptime":5,"provider":"anthropic","model":"claude-sonnet-4-6","skills":[]}
```

---

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and edit.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes (if Anthropic) | — | Anthropic API key |
| `OPENAI_API_KEY` | Yes (if OpenAI) | — | OpenAI API key |
| `PROVIDER` | No | `anthropic` | LLM provider: `anthropic` or `openai` |
| `AGENT_NAME` | No | `wally` | Agent name — used in identity, prompts, and file paths |
| `AGENT_PORT` | No | `3456` | HTTP server port |
| `AGENT_MODEL` | No | `claude-sonnet-4-6` (Anthropic) / `gpt-4o` (OpenAI) | LLM model ID |
| `AGENT_TIMEOUT_MS` | No | `300000` | HTTP chat request timeout in milliseconds (5 min) |
| `TELEGRAM_BOT_TOKEN` | No | — | Enable Telegram interface (get from @BotFather) |
| `TELEGRAM_ALLOWED_CHAT_ID` | No | — | Restrict Telegram to a single chat ID |
| `ENABLED_SKILLS` | No | (all) | Comma-separated list of skill names to load; omit to load all |
| `OPENAI_BASE_URL` | No | (OpenAI default) | Custom base URL for OpenAI-compatible endpoints |

---

## HTTP API Reference

All endpoints are on `http://localhost:<AGENT_PORT>`.

### `GET /health`

Liveness check.

```
Response 200:
{
  "ok": true,
  "uptime": 42        // seconds since process start
}
```

### `GET /status`

Agent info and loaded skills.

```
Response 200:
{
  "name": "wally",
  "uptime": 120,
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "skills": ["my-skill", "another-skill"]
}
```

### `GET /identity`

Persistent agent identity.

```
Response 200:
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "wally",
  "createdAt": "2025-01-15T10:00:00.000Z",
  "capabilities": ["my-skill"]
}
```

### `POST /chat`

Send a message. Waits for the full agentic loop to complete.

```
Request:
{
  "message": "What files are in the current directory?"
}

Response 200:
{
  "response": "Here are the files in the current directory: ..."
}

Response 400: { "error": "Body must have { \"message\": \"...\" }" }
Response 409: { "error": "Agent busy" }   // another request in progress
Response 500: { "error": "..." }          // agent error or timeout
```

### `POST /chat/stream`

SSE streaming version of `/chat`. Same request body. Returns events as the agent runs.

```
Content-Type: text/event-stream

event: done
data: {"response":"Here are the files..."}

event: error
data: {"error":"..."}
```

### `POST /instructions`

Load a markdown instruction file into the agent's context. The agent reads, understands, and confirms — but does **not** execute scripts automatically.

```
# Option A: inline markdown body
Content-Type: text/markdown
<markdown content>

# Option B: path reference
Content-Type: application/json
{
  "path": "/absolute/path/to/instructions.md"
}

Response 200:
{
  "response": "I understand. I will..."
}
```

### `GET /history`

Retrieve conversation history.

```
# Last N messages from in-memory buffer (max 100)
GET /history?n=10

Response 200:
{
  "turns": [
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi there!" }
  ]
}

# All messages since a timestamp (reads from disk)
GET /history?since=2025-01-15T10:00:00.000Z

Response 200:
{
  "entries": [ ... raw JSONL parsed objects ... ]
}
```

### `GET /skills`

List all currently loaded skills.

```
Response 200:
{
  "skills": [
    {
      "name": "my-skill",
      "version": "1.0.0",
      "tools": ["my_tool", "another_tool"]
    }
  ]
}
```

### `POST /skills/reload`

Trigger a manual rescan of the `skills/` directory. Useful on Linux where `fs.watch` recursive mode is unavailable.

```
Response 200:
{
  "ok": true,
  "skills": [ ... same as GET /skills ... ]
}
```

### `POST /skills/install`

Install a `.skill` file (ZIP package) into the agent. Extracts to `skills/`, runs any `assets/install-*.js` scripts, and registers the skill immediately — no restart needed.

```
Request:
Content-Type: application/json
{
  "path": "/absolute/path/to/file.skill"
}

Response 200:
{
  "ok": true,
  "name": "skill-name",
  "skills": [ ... same as GET /skills ... ]
}

Response 400: { "error": "..." }   // bad path, wrong extension, already installed
Response 500: { "error": "..." }   // unzip failed or other error
```

You can also install via any chat interface (Telegram, REPL, HTTP `/chat`) by telling the agent:

> "Install /path/to/file.skill"

The agent uses the built-in `install_skill` tool to do the same thing.

> **Security:** Install scripts inside `.skill` packages run as Node.js with agent process privileges. Only install `.skill` files from sources you trust.

### `GET /shell-audit`

Last N shell command executions from HTTP and Telegram interfaces (max 200).

```
GET /shell-audit?n=50

Response 200:
{
  "entries": [
    {
      "ts": "2025-01-15T10:05:00.000Z",
      "command": "ls -la",
      "cwd": "/home/user/project",
      "exitCode": 0,
      "interface": "http"
    }
  ]
}
```

---

## Built-in Tools

These tools are always available regardless of which skills are loaded.

| Tool | Description | REPL | HTTP / Telegram |
|------|-------------|------|-----------------|
| `read_file` | Read a local file | Auto | Auto |
| `write_file` | Write/create a local file | Auto | Auto |
| `shell_exec` | Run a shell command | **Asks user to confirm** | Auto-runs, logs to `shell_audit.jsonl` |
| `fetch_url` | HTTP request (GET/POST/PUT/DELETE/PATCH) | Auto | Auto |
| `list_dir` | List directory contents | Auto | Auto |
| `check_process` | Check if a port is listening | Auto | Auto |
| `install_skill` | Install a `.skill` file by path | Auto | Auto |

### Tool schemas

**`read_file`**
```json
{ "path": "string (absolute or relative path)" }
```

**`write_file`**
```json
{ "path": "string", "content": "string" }
```

**`shell_exec`**
```json
{ "command": "string", "cwd": "string (optional)" }
```

**`fetch_url`**
```json
{
  "url": "string",
  "method": "GET|POST|PUT|DELETE|PATCH (optional, default GET)",
  "body": "string (optional)",
  "headers": { "key": "value" }
}
```

**`list_dir`**
```json
{ "path": "string" }
```

**`check_process`**
```json
{ "port": "number" }
```

---

## Interfaces

### HTTP Server

Starts automatically. Listens on `AGENT_PORT` (default `3456`). Handles one request at a time — concurrent requests get `409 Agent busy`. The timeout is `AGENT_TIMEOUT_MS` (default 5 min).

Shell commands execute automatically and are logged to `shell_audit.jsonl`.

### Telegram Bot

Enable by setting `TELEGRAM_BOT_TOKEN` in `.env`. Optionally restrict to one chat with `TELEGRAM_ALLOWED_CHAT_ID`.

Supported Telegram commands:
- `/status` — show agent name, uptime, provider, model, loaded skills
- Any text message — sent to the agent as a chat message

Messages longer than 4096 characters are split automatically. The bot sends a typing indicator refreshed every 4 seconds while the agent is processing.

### REPL

Starts when `--repl` flag is passed or when stdin is a TTY.

```sh
npx tsx src/index.ts --repl
```

Prompt: `wally> `

`shell_exec` in REPL mode shows a confirmation prompt before executing. Type `n` to abort. Ctrl+C exits.

---

## Skills

### What is a skill?

A skill adds capabilities to the agent. Skills are plugins — entirely decoupled from core agent code. There are two kinds:

**TypeScript/JS skills** — expose structured tools the agent can call:
```
skills/my-skill/
├── src/index.ts    (or index.js)
└── package.json    (optional — deps auto-installed on load)
```

**SKILL.md skills** — inject an operational guide as the agent's system prompt. No tools, no TypeScript. The agent uses built-in tools (`shell_exec`, `fetch_url`, etc.) to carry out the instructions in the guide. Distributed as `.skill` files.
```
skills/my-skill/
└── SKILL.md        (YAML frontmatter + guide content)
```

Both types are discovered automatically and can coexist.

### `.skill` file format

`.skill` files are standard ZIP archives distributed to end users. Unpack structure:

```
<skill-name>/
├── SKILL.md                   ← required — frontmatter + system prompt body
└── assets/
    └── install-*.js           ← optional — setup scripts run on install (Node.js 22+)
```

**`SKILL.md` frontmatter:**
```
---
name: my-skill          (required — skill identifier)
version: 1.0.0          (optional — defaults to 1.0.0)
description: >
  When to use this skill...
---

# Guide content starts here — injected verbatim as system prompt
```

**Installing a `.skill` file:**
```sh
# Via HTTP endpoint
curl -X POST http://localhost:3456/skills/install \
  -H 'Content-Type: application/json' \
  -d '{"path": "/path/to/file.skill"}'

# Via any chat interface (Telegram, REPL, HTTP /chat)
# Just tell the agent: "Install /path/to/file.skill"
```

> **Security:** `assets/install-*.js` scripts run as Node.js with agent process privileges. Only install `.skill` files from sources you trust.

### Directory layout

### Skill interface

```typescript
import type { Skill, SkillContext } from '../../src/skills/types.js';

// Full interface:
interface Skill {
  name: string;            // unique, matches directory name by convention
  version: string;         // semver
  tools: NormalizedTool[]; // tools this skill exposes
  execute(
    toolName: string,
    input: Record<string, unknown>,
    ctx: SkillContext
  ): Promise<unknown>;
  systemPrompt?: string;   // optional instructions injected into agent system prompt
}

interface NormalizedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema object
}

interface SkillContext {
  agentName: string;       // e.g. "wally"
}
```

### Minimal example

```typescript
// skills/hello/src/index.ts
import type { Skill } from '../../src/skills/types.js';

const helloSkill: Skill = {
  name: 'hello',
  version: '1.0.0',

  tools: [
    {
      name: 'say_hello',
      description: 'Say hello to a person by name.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the person to greet' },
        },
        required: ['name'],
      },
    },
  ],

  async execute(toolName: string, input: Record<string, unknown>, ctx) {
    if (toolName === 'say_hello') {
      return `Hello, ${input.name}! I am ${ctx.agentName}.`;
    }
    throw new Error(`Unknown tool: ${toolName}`);
  },

  systemPrompt: 'You can greet people by name using the say_hello tool.',
};

export default helloSkill;
```

Drop this into `skills/hello/src/index.ts`. The agent loads it within 500ms.

### Hot-loading workflow

1. Create the skill directory and write your code
2. The `SkillWatcher` detects the new directory via `fs.watch` (debounced 500ms)
3. If `package.json` is present, runs `npm install --prefix skills/my-skill`
4. Imports and validates the module
5. Registers with `AgentCore` — tools are available on the next LLM call
6. Updates `IdentityManager` with the new capability

To manually trigger a rescan (e.g. on Linux):
```sh
curl -X POST http://localhost:3456/skills/reload
```

To filter which skills load, set `ENABLED_SKILLS`:
```sh
ENABLED_SKILLS=hello,my-other-skill npx tsx src/index.ts
```

---

## Memory & Persistence

All persistent state lives under `identities/<agentName>/` (gitignored).

### Conversation history

**File:** `identities/<agentName>/history.jsonl`

Each line is a JSON object: `{ role, content }`. Both user messages and assistant responses (including tool use/result blocks) are appended here.

- **In-memory buffer:** last 20 messages, trimmed from the front when exceeded
- **Warm-load:** on startup, the last 20 lines from disk are loaded into the buffer
- **Disk cap:** 10 MB; when exceeded, the oldest ~20% of entries are dropped

Query via `GET /history`:
```sh
curl "http://localhost:3456/history?n=10"
curl "http://localhost:3456/history?since=2025-01-15T00:00:00.000Z"
```

### Error tracking & reflection

**File:** `identities/<agentName>/errors.jsonl`

Every tool failure is logged:
```json
{
  "ts": "2025-01-15T10:05:00.000Z",
  "tool": "shell_exec",
  "input": { "command": "cat /nonexistent" },
  "error": "File not found: /nonexistent",
  "context": "First 100 chars of the user message that triggered the tool"
}
```

The last 5 errors are injected into the system prompt on every LLM call, giving the agent awareness of its recent failures.

**Reflection loop:** When a tool fails, the agent injects an in-flight reflection message and retries up to `MAX_REFLECTION_RETRIES` (3) times. Reflection messages are **not** persisted to `history.jsonl` — they exist only within the current iteration context.

### Shell audit log

**File:** `identities/<agentName>/shell_audit.jsonl`

Every `shell_exec` call via HTTP or Telegram is logged:
```json
{
  "ts": "2025-01-15T10:05:00.000Z",
  "command": "ls -la /tmp",
  "cwd": "/home/user/project",
  "exitCode": 0,
  "interface": "http"
}
```

REPL `shell_exec` calls are **not** logged (user-interactive, already visible in the terminal).

Query via `GET /shell-audit`:
```sh
curl "http://localhost:3456/shell-audit?n=50"
```

---

## Development

### Project structure

```
ragent/
├── src/
│   ├── index.ts               Entry point — wires all components together
│   ├── config.ts              Environment variable loading and validation
│   ├── agent/
│   │   ├── core.ts            AgentCore — agentic loop, tools, reflection
│   │   └── identity.ts        IdentityManager — persistent agent identity
│   ├── providers/
│   │   ├── types.ts           Normalized LLM interfaces (provider-agnostic)
│   │   ├── index.ts           Provider factory
│   │   ├── anthropic.ts       Anthropic SDK adapter (prompt caching, retries)
│   │   └── openai.ts          OpenAI SDK adapter
│   ├── skills/
│   │   ├── types.ts           Skill and SkillContext interfaces
│   │   ├── loader.ts          Skill discovery, validation, dependency install
│   │   └── watcher.ts         fs.watch-based hot-loader
│   ├── memory/
│   │   ├── history.ts         Conversation history (JSONL, buffer, disk cap)
│   │   └── errors.ts          Tool error log and system prompt injection
│   ├── server/
│   │   └── http.ts            Express HTTP server and all endpoints
│   └── interfaces/
│       ├── readline.ts        Interactive REPL
│       └── telegram.ts        Telegram bot
├── tests/                     Vitest test suite
├── skills/                    Runtime skill directory (empty by default)
├── docs/
│   ├── api.md                 HTTP endpoint reference
│   ├── architecture.md        Component diagram and data flow
│   └── skills.md              Skill authoring guide
├── identities/                Runtime state (gitignored)
├── .env.example               Environment variable template
├── start.sh                   Background daemon launcher
├── stop.sh                    Daemon stopper
├── package.json
└── tsconfig.json
```

### Running tests

```sh
npm test              # run all tests once
npm run test:watch    # watch mode
```

Tests use [Vitest](https://vitest.dev/) and cover: agent core (reflection loop), memory (history buffer, trimming, error logging), providers (Anthropic and OpenAI adapters), HTTP server (endpoints and mutex), and skill loading (discovery, validation, hot-load).

### Adding a provider

1. Create `src/providers/<name>.ts` implementing `LLMProvider`:

```typescript
import type { LLMProvider, ChatParams, LLMResponse } from './types.js';

export class MyProvider implements LLMProvider {
  async chat(params: ChatParams): Promise<LLMResponse> {
    // normalize your provider's API to NormalizedMessage / NormalizedContentBlock
    // return { content: [...], stopReason: 'end_turn' | 'tool_use' | ... }
  }
}
```

2. Register it in `src/providers/index.ts`:

```typescript
case 'myprovider':
  return new MyProvider(config.agentModel);
```

3. Add `PROVIDER=myprovider` to `.env` and the matching `MY_API_KEY` var to `config.ts`.

---

## Security Notes

- **No HTTP authentication** — the HTTP server has no auth by default. Add an `X-API-Key` middleware before exposing it over a network.
- **`shell_exec` auto-runs via HTTP and Telegram** — the agent can execute arbitrary shell commands when accessed via the API or Telegram. All executions are logged to `shell_audit.jsonl`, but they are not gated. Add confirmation logic or restrict tool access for production deployments.
- **Single chat mutex** — the HTTP server allows only one concurrent request. Additional requests get `409 Agent busy`.
- **REPL is safer** — `shell_exec` in REPL mode requires explicit user confirmation before running.

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make changes; ensure tests pass: `npm test`
4. Open a pull request with a clear description of what and why

Bug reports and feature requests welcome via GitHub Issues.
