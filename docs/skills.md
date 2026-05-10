# Skill Authoring Guide

## Example skill

See [`examples/echo-skill/`](../examples/echo-skill/) for a fully annotated working example. Copy it to `skills/` to install:

```bash
cp -r examples/echo-skill skills/
```

## What is a Skill?

A skill is a self-contained capability module dropped into the `skills/` directory.
The agent auto-discovers and loads it at startup or via hot-loading (chokidar watches `skills/`).

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

## .skill File Format

`.skill` files are ZIP archives — the distribution format for SKILL.md skills. No TypeScript required.

### Internal structure

```
<skill-name>/
├── SKILL.md                   ← required
└── assets/
    └── install-*.js           ← optional setup scripts (Node.js 22+)
```

### SKILL.md frontmatter

```
---
name: my-skill          (required — used as skill identifier)
version: 1.0.0          (optional — defaults to 1.0.0)
description: >
  Describe when to use this skill...
---

Everything below the closing --- is injected verbatim as the agent's system prompt.
```

The agent has no typed tools for SKILL.md skills. It uses built-in tools (`shell_exec`, `fetch_url`, `download_file`, `read_file`, etc.) guided by the system prompt content.

> **`fetch_url` vs `download_file`**: Use `fetch_url` for text/JSON responses. Use `download_file` for binary content (ZIPs, executables, images) — it uses `arrayBuffer()` and writes raw bytes, preserving the file intact.

### Installing

```sh
# HTTP endpoint (first install)
curl -X POST http://localhost:3456/skills/install \
  -H 'Content-Type: application/json' \
  -d '{"path": "/absolute/path/to/file.skill"}'

# Upgrade an already-installed skill
curl -X POST http://localhost:3456/skills/install \
  -H 'Content-Type: application/json' \
  -d '{"path": "/absolute/path/to/file.skill", "overwrite": true}'

# Any chat interface — Telegram, REPL, or /chat
# "Install /absolute/path/to/file.skill"
# "Upgrade the my-skill skill from /tmp/my-skill.skill"  ← agent passes overwrite:true
```

What happens on install:
1. If skill dir exists and `overwrite` is false → returns error (safe default)
2. If skill dir exists and `overwrite` is true → removes old dir, then extracts fresh ZIP
3. ZIP is extracted to `skills/<name>/` (30s timeout)
4. Any `assets/install-*.js` scripts run via `node` (cwd = skill dir, 60s timeout)
   - If a script fails, the partial install is cleaned up and an error is returned
5. Skill is registered immediately — no restart needed
6. SKILL.md body is injected into the agent's system prompt on next chat call

> **Security:** Install scripts run arbitrary Node.js with agent process privileges. Only install `.skill` files from sources you trust.

## Tool Return Values

- Return any JSON-serializable value
- Throw an `Error` to signal failure (agent will reflect and retry)
- Long strings are truncated at 6000 chars automatically
