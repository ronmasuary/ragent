# Entity Relationship Diagram — Ragent

## Entities

```
┌─────────────────────────┐         ┌──────────────────────────────┐
│         Identity         │ 1     * │        HistoryEntry           │
├─────────────────────────┤─────────├──────────────────────────────┤
│ id: UUID                 │         │ ts: ISO-8601                  │
│ name: string             │         │ role: 'user'|'assistant'      │
│ createdAt: ISO-8601      │         │ content: string               │
│ capabilities: string[]   │         │ tools?: ToolCall[]            │
└─────────────────────────┘         └──────────────────────────────┘
          │ 1                                       │ 1
          │                                         │ embeds
          │ *                                       │ *
┌─────────────────────────┐         ┌──────────────────────────────┐
│        ErrorEntry        │         │          ToolCall             │
├─────────────────────────┤         ├──────────────────────────────┤
│ ts: ISO-8601             │         │ type: 'tool_use'|'tool_result'│
│ tool: string             │         │ id: string                    │
│ input: Record<str,any>   │         │ name?: string                 │
│ error: string            │         │ input?: Record<string, any>   │
│ context: string          │         │ content?: string              │
└─────────────────────────┘         │ is_error?: boolean            │
                                    └──────────────────────────────┘

┌─────────────────────────┐         ┌──────────────────────────────┐
│          Skill           │ 1     * │        NormalizedTool         │
├─────────────────────────┤─────────├──────────────────────────────┤
│ name: string             │         │ name: string                  │
│ version: string          │         │ description: string           │
│ tools: NormalizedTool[]  │         │ inputSchema: JSONSchema        │
│ execute: fn              │         └──────────────────────────────┘
│ systemPrompt?: string    │
└─────────────────────────┘

┌─────────────────────────┐         ┌──────────────────────────────┐
│       ShellAuditEntry    │         │        NormalizedMessage      │
├─────────────────────────┤         ├──────────────────────────────┤
│ ts: ISO-8601             │         │ role: 'user'|'assistant'      │
│ command: string          │         │ content: string               │
│ cwd: string              │         │      | TextBlock[]            │
│ exitCode: number         │         │      | ToolUseBlock[]         │
│ interface: 'http'|'tele' │         │      | ToolResultBlock[]      │
└─────────────────────────┘         └──────────────────────────────┘
```

## Persistence Mapping

| Entity | Storage |
|--------|---------|
| Identity | `identities/wally/identity.json` |
| HistoryEntry | `identities/wally/history.jsonl` (append-only, 10MB cap) |
| ErrorEntry | `identities/wally/errors.jsonl` (append-only) |
| ShellAuditEntry | `identities/wally/shell_audit.jsonl` (HTTP/Telegram only) |
| Skill | Runtime registry (in-memory); source in `skills/<name>/` |
| Config | `process.env` + `.env` file |

## In-Memory State

| Object | Description |
|--------|-------------|
| `HistoryMemory.buffer` | Last 20 messages (fast LLM context) |
| `AgentCore.skillRegistry` | Map<toolName, Skill> |
| `AgentCore.skillTools` | Flat array of all skill tools |
| `AgentCore.cacheInvalidated` | Flag — rebuilds Anthropic cache markers on next call |
