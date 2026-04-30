# Ragent — wally AI Agent

Autonomous AI agent with hot-loadable skills. Agent starts clean; capabilities arrive later via skill installation.

## Quick Start

```sh
cp .env.example .env
# Set ANTHROPIC_API_KEY in .env
npm install
./start.sh          # background
./stop.sh           # stop
# or
npx tsx src/index.ts --repl   # interactive REPL
```

## Env Vars

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes (if Anthropic) | — | Anthropic API key |
| `PROVIDER` | No | `anthropic` | `anthropic` or `openai` |
| `OPENAI_API_KEY` | Yes (if OpenAI) | — | OpenAI API key |
| `AGENT_NAME` | No | `wally` | Agent name |
| `AGENT_PORT` | No | `3456` | HTTP port |
| `AGENT_MODEL` | No | `claude-sonnet-4-6` | LLM model |
| `AGENT_TIMEOUT_MS` | No | `300000` | HTTP chat timeout |
| `TELEGRAM_BOT_TOKEN` | No | — | Enable Telegram |
| `TELEGRAM_ALLOWED_CHAT_ID` | No | — | Allowed Telegram chat |
| `ENABLED_SKILLS` | No | all | Comma-separated skill filter |

## Architecture

```
Ragent
├── HTTP Server (:3456) + Telegram Bot + REPL
│   └── AgentCore (agentic loop + reflection)
│       ├── LLMProvider (Anthropic or OpenAI)
│       ├── Built-in Tools (read_file, write_file, shell_exec, fetch_url, list_dir, check_process)
│       ├── SkillRegistry (dynamic, hot-loadable)
│       └── Memory (history.jsonl + errors.jsonl + shell_audit.jsonl)
└── SkillWatcher (fs.watch skills/ → hot-load new dirs)
```

## Adding Skills

1. Drop a skill directory into `skills/<name>/src/index.ts` (or `.js`)
2. Skill auto-loads via `fs.watch` (new dirs only — updates require restart)
3. Or POST `/skills/reload` to trigger manual scan

Skill interface:
```typescript
export default {
  name: 'my-skill',
  version: '1.0.0',
  tools: [{ name: 'my_tool', description: '...', inputSchema: { ... } }],
  async execute(toolName, input, ctx) { return result; },
  systemPrompt: 'Optional instructions for the agent.',
};
```

See `docs/skills.md` for full authoring guide.

## Tests

```sh
npm test            # run all tests
npm run test:watch  # watch mode
```

## Limitations

- **`shell_exec` auto-runs via HTTP/Telegram** — logged to `shell_audit.jsonl`. Add auth for production.
- **Skill code updates require restart** — ESM import() cache is permanent.
- **fs.watch `recursive` is macOS/Windows only** — use chokidar on Linux.
- **No HTTP auth** — add `X-API-Key` middleware for remote use.
