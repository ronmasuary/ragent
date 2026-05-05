# Echo Skill

Minimal example skill showing the Ragent skill interface. Use this as a template when building your own skills.

## What it does

Exposes one tool — `echo` — that returns whatever message you send it. Useful for verifying skill installation works.

## Install

```bash
cp -r examples/echo-skill skills/
```

The agent hot-loads it automatically. You'll see `[SkillWatcher] Hot-loaded new skill: echo` in the logs.

## Try it

```bash
curl -X POST http://localhost:3456/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "use the echo tool to say hello"}'
```

## Skill interface

See [`src/index.ts`](src/index.ts) for the full annotated implementation. Every skill must export a default object matching:

```typescript
{
  name: string
  version: string
  tools: Array<{ name, description, inputSchema }>
  execute(toolName, input, ctx): Promise<unknown>
  systemPrompt?: string  // optional — injected into agent system prompt
}
```

See [`docs/skills.md`](../../docs/skills.md) for the full authoring guide.
