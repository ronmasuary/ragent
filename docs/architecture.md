# Architecture — Ragent

## Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                          Ragent Process                          │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │   readline   │  │  HTTP Server │  │   Telegram Bot     │    │
│  │    REPL      │  │  port 3456   │  │  (optional)        │    │
│  └──────┬───────┘  └──────┬───────┘  └────────┬───────────┘    │
│         │                 │                    │                 │
│         └─────────────────┼────────────────────┘                │
│                           │ (mutex)                              │
│                    ┌──────▼───────┐                             │
│                    │  AgentCore   │◄──── SkillRegistry          │
│                    │  (agentic    │      (dynamic)              │
│                    │   loop +     │◄──── Built-in Tools         │
│                    │  reflection) │      (always loaded)        │
│                    └──────┬───────┘                             │
│                           │                                      │
│              ┌────────────┼────────────┐                        │
│              │            │            │                         │
│       ┌──────▼────┐ ┌─────▼─────┐ ┌───▼──────┐                │
│       │ Anthropic  │ │  OpenAI   │ │ Memory   │                │
│       │ Provider   │ │ Provider  │ │ (history │                │
│       │ (+caching) │ │           │ │  errors  │                │
│       └───────────┘ └───────────┘ │  audit)  │                │
│                                   └──────────┘                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    Skill Watcher                           │  │
│  │  fs.watch(skills/) → debounce → npm install? → import()   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Request Data Flow (POST /chat)

```
User → POST /chat { message }
         │
         ▼
  [Mutex acquired — generation counter pattern]
         │
         ▼
  AgentCore.chat(message)
    1. Append user message to history (buffer + disk)
    2. Build system prompt (identity + skill prompts + past errors)
    3. Build tool list (built-in + all skill tools)
    4. Apply cache_control markers (Anthropic only)
    5. Call LLMProvider.chat()
         │
         ├── LLM returns end_turn → persist assistant message → done
         │
         └── LLM returns tool_use
               │
               ▼
         Execute tool (built-in or skill)
           - shell_exec (REPL): PAUSE → ask user → wait for stdin
           - shell_exec (HTTP/Telegram): run immediately → log to shell_audit.jsonl
           - on error: log to errors.jsonl
                       inject reflection message (in-flight only, NOT persisted)
                       retry up to 3 times
           - on max retries: surface error to user
               │
               ▼
         Append tool_result → loop back to step 4
         │
         ▼
  Append assistant response to history (buffer + disk)
  [Mutex released]
         │
         ▼
  Response → User
```

## Skill Lifecycle

```
Cold start:
  skills/ dir scan → import each → SkillRegistry

Runtime (new skill installed):
  install script drops skills/wallet/
       │
       ▼
  fs.watch fires → debounce 500ms
       │
       ▼
  Check package.json deps → npm install?
       │
       ▼
  import('skills/wallet/src/index.js')
       │
  ┌────┴────────┐
  │ valid shape │→ add to SkillRegistry → cacheInvalidated = true
  │ invalid     │→ log warning, skip
  └─────────────┘
       │
       ▼
  Next AgentCore call: rebuild tool array with cache markers
```

## Prompt Caching (Anthropic only)

- System prompt: `cache_control: { type: "ephemeral" }` on last text block
- Tools: `cache_control: { type: "ephemeral" }` on last tool in array
- When a new skill loads: `cacheInvalidated = true` — next API call rebuilds with fresh markers
- Cache TTL: 5 minutes (Anthropic managed)

## Error Reflection

When a tool call fails:
1. Error logged to `errors.jsonl`
2. Reflection message injected in-flight (NOT to `history.jsonl`)
3. LLM retries with: `"Your last tool call \`<toolName>\` failed: \`<error>\`. Reflect on why and try differently."`
4. Max 3 retries per user message
5. After 3: surface error to user

Past errors (last 5) are injected at the system prompt tail on every startup.

## Mutex (HTTP)

Generation counter prevents a timed-out request from clearing the flag
for a concurrently running request:

```typescript
let isRunning = false;
let gen = 0;

if (isRunning) return res.status(409).json({ error: 'Agent busy' });
const myGen = ++gen;
isRunning = true;

chatPromise.finally(() => { if (gen === myGen) isRunning = false; });
await Promise.race([chatPromise, timeoutPromise]);
```
