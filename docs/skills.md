# Skill Authoring Guide

## What is a Skill?

A skill is a self-contained capability module dropped into the `skills/` directory.
The agent auto-discovers and loads it at startup or via `fs.watch` hot-loading.

## Skill Interface

```typescript
import type { Skill, SkillContext } from '../../src/skills/types.js';

const mySkill: Skill = {
  name: 'my-skill',        // unique identifier
  version: '1.0.0',        // semver
  tools: [
    {
      name: 'my_tool',
      description: 'What this tool does — the LLM reads this.',
      inputSchema: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'The value to process' },
        },
        required: ['value'],
      },
    },
  ],
  async execute(toolName: string, input: Record<string, unknown>, ctx: SkillContext): Promise<unknown> {
    if (toolName === 'my_tool') {
      return `Processed: ${input.value}`;
    }
    throw new Error(`Unknown tool: ${toolName}`);
  },
  // Optional — injected at the end of the agent's system prompt
  systemPrompt: 'You have access to my-skill. Use my_tool to process values.',
};

export default mySkill;
```

## Directory Structure

```
skills/
└── my-skill/
    ├── src/
    │   └── index.ts      # or index.js (preferred for production)
    └── package.json      # optional — if skill has its own deps
```

If `package.json` exists with deps not in the root `node_modules`,
the skill watcher runs `npm install --prefix skills/my-skill` before importing.

## Hot-Loading

When you drop a new directory under `skills/`, the agent's `fs.watch` detects it
and loads it within ~500ms (debounce delay).

**Important:** This only works for NEW skill directories. If you update code in
an already-loaded skill, the agent must restart — ESM `import()` caches by URL permanently.

## SkillContext

```typescript
interface SkillContext {
  agentName: string;   // e.g. "wally"
}
```

## Installing via Instructions

1. Create an instruction markdown file describing what to install and where
2. POST it to `/instructions`
3. Agent confirms what it plans to do
4. POST `/chat` with "proceed" — agent runs the install script
5. New skill hot-loads automatically

## Tool Return Values

- Return any JSON-serializable value
- Throw an `Error` to signal failure (agent will reflect and retry)
- Long strings are truncated at 6000 chars automatically
