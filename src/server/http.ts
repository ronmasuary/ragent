import express from 'express';
import fs from 'fs';
import type { Request, Response } from 'express';
import type { AgentCore, ShellAuditEntry } from '../agent/core.js';
import type { IdentityManager } from '../agent/identity.js';
import type { HistoryMemory } from '../memory/history.js';
import type { Skill } from '../skills/types.js';
import { rescanSkills } from '../skills/watcher.js';

export interface ServerDeps {
  agent: AgentCore;
  identityManager: IdentityManager;
  historyMemory: HistoryMemory;
  shellAuditPath: string;
  loadedSkillNames: Set<string>;
  onNewSkill: (skill: Skill) => void;
  setCacheInvalidated: () => void;
  timeoutMs: number;
}

export function startHttpServer(deps: ServerDeps, port: number): void {
  const {
    agent, identityManager, historyMemory, shellAuditPath,
    loadedSkillNames, onNewSkill, setCacheInvalidated, timeoutMs,
  } = deps;

  const app = express();
  app.use(express.json());
  app.use(express.text({ type: 'text/markdown' }));

  function rejectIfBusy(res: Response): boolean {
    if (agent.isRunning) {
      res.status(409).json({ error: 'Agent busy' });
      return true;
    }
    return false;
  }

  // ── GET /health ──────────────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, uptime: Math.floor((Date.now() - agent.getStartTime()) / 1000) });
  });

  // ── GET /status ──────────────────────────────────────────────────────────
  app.get('/status', (_req: Request, res: Response) => {
    const identity = identityManager.get();
    res.json({
      name: identity.name,
      uptime: Math.floor((Date.now() - agent.getStartTime()) / 1000),
      provider: process.env.PROVIDER ?? 'anthropic',
      model: process.env.AGENT_MODEL ?? '(default)',
      skills: agent.getLoadedSkills().map(s => s.name),
    });
  });

  // ── GET /identity ─────────────────────────────────────────────────────────
  app.get('/identity', (_req: Request, res: Response) => {
    res.json(identityManager.get());
  });

  // ── POST /chat ────────────────────────────────────────────────────────────
  app.post('/chat', async (req: Request, res: Response) => {
    const { message } = req.body as { message?: string };
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Body must have { "message": "..." }' });
      return;
    }

    if (rejectIfBusy(res)) return;

    agent.currentInterface = 'http';

    try {
      const response = await Promise.race([
        agent.chat(message),
        timeout(timeoutMs, `Chat timed out after ${timeoutMs / 1000}s`),
      ]);
      res.json({ response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /chat/stream ─────────────────────────────────────────────────────
  app.post('/chat/stream', async (req: Request, res: Response) => {
    const { message } = req.body as { message?: string };
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Body must have { "message": "..." }' });
      return;
    }

    if (rejectIfBusy(res)) return;

    agent.currentInterface = 'http';

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const chatPromise = agent.chat(message).finally(() => res.end());

    try {
      const response = await Promise.race([
        chatPromise,
        timeout(timeoutMs, `Timed out after ${timeoutMs / 1000}s`),
      ]);
      send('done', { response });
    } catch (err) {
      send('error', { error: (err as Error).message });
    }
  });

  // ── POST /instructions ────────────────────────────────────────────────────
  app.post('/instructions', async (req: Request, res: Response) => {
    let content: string;

    if (typeof req.body === 'string') {
      // Content-Type: text/markdown
      content = req.body;
    } else if (req.body && typeof req.body === 'object' && (req.body as { path?: string }).path) {
      const filePath = (req.body as { path: string }).path;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        res.status(400).json({ error: `Cannot read file: ${filePath}` });
        return;
      }
    } else {
      res.status(400).json({ error: 'Provide markdown body (text/markdown) or { "path": "/abs/path.md" }' });
      return;
    }

    if (rejectIfBusy(res)) return;

    agent.currentInterface = 'http';

    const prompt = `Read and understand these instructions:\n\n${content}\n\nConfirm you understand and describe what you plan to do. Do NOT run any scripts yet.`;

    try {
      const response = await Promise.race([
        agent.chat(prompt),
        timeout(timeoutMs, `Instructions timed out after ${timeoutMs / 1000}s`),
      ]);
      res.json({ response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── GET /history ──────────────────────────────────────────────────────────
  app.get('/history', (req: Request, res: Response) => {
    const n = Math.min(Number(req.query.n) || 20, 100);
    const since = req.query.since as string | undefined;

    if (since) {
      const entries = historyMemory.getSince(since);
      res.json({ entries });
    } else {
      const messages = historyMemory.getLastN(n);
      res.json({ turns: messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : '[structured]',
      })) });
    }
  });

  // ── GET /skills ───────────────────────────────────────────────────────────
  app.get('/skills', (_req: Request, res: Response) => {
    res.json({ skills: agent.getLoadedSkills() });
  });

  // ── POST /skills/reload ───────────────────────────────────────────────────
  app.post('/skills/reload', async (_req: Request, res: Response) => {
    await rescanSkills(onNewSkill, loadedSkillNames, setCacheInvalidated);
    res.json({ ok: true, skills: agent.getLoadedSkills() });
  });

  // ── GET /shell-audit ──────────────────────────────────────────────────────
  app.get('/shell-audit', (req: Request, res: Response) => {
    const n = Math.min(Number(req.query.n) || 20, 200);
    if (!fs.existsSync(shellAuditPath)) {
      res.json({ entries: [] });
      return;
    }
    try {
      const raw = fs.readFileSync(shellAuditPath, 'utf-8');
      const entries: ShellAuditEntry[] = raw
        .split('\n')
        .filter(l => l.trim())
        .slice(-n)
        .map(l => { try { return JSON.parse(l) as ShellAuditEntry; } catch { return null; } })
        .filter((e): e is ShellAuditEntry => e !== null);
      res.json({ entries });
    } catch {
      res.json({ entries: [] });
    }
  });

  app.listen(port, () => {
    console.error(`[HTTP] Listening on http://localhost:${port}`);
    console.error(`[HTTP]   GET  /health        — liveness`);
    console.error(`[HTTP]   GET  /status        — agent info`);
    console.error(`[HTTP]   GET  /identity      — identity JSON`);
    console.error(`[HTTP]   POST /chat          — send message`);
    console.error(`[HTTP]   POST /chat/stream   — SSE streaming`);
    console.error(`[HTTP]   POST /instructions  — load instruction markdown`);
    console.error(`[HTTP]   GET  /history       — conversation history`);
    console.error(`[HTTP]   GET  /skills        — loaded skills`);
    console.error(`[HTTP]   POST /skills/reload — manual skill rescan`);
    console.error(`[HTTP]   GET  /shell-audit   — shell execution log`);
  });
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(message)), ms)
  );
}
