#!/usr/bin/env node
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, '..', '.env') });

import { loadConfig } from './config.js';
import { IdentityManager } from './agent/identity.js';
import { HistoryMemory } from './memory/history.js';
import { ErrorMemory } from './memory/errors.js';
import { AgentCore } from './agent/core.js';
import { loadSkills, registerSkill } from './skills/loader.js';
import { startSkillWatcher, rescanSkills } from './skills/watcher.js';
import { startHttpServer } from './server/http.js';
import { startREPL } from './interfaces/readline.js';
import { startTelegramBot } from './interfaces/telegram.js';
import type { Skill } from './skills/types.js';

process.on('uncaughtException', (err) => {
  console.error('[ragent] Uncaught exception (continuing):', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[ragent] Unhandled rejection (continuing):', reason);
});

async function main() {
  const config = loadConfig();

  console.error(`[ragent] Starting ${config.agentName}...`);

  const identityDir = path.resolve('identities', config.agentName);
  const shellAuditPath = path.join(identityDir, 'shell_audit.jsonl');

  const identityManager = new IdentityManager(identityDir, config.agentName);
  const historyMemory = new HistoryMemory(identityDir);
  const errorMemory = new ErrorMemory(identityDir);

  // Warm-load history before starting server (agent has memory across restarts)
  historyMemory.warmLoad();

  const agent = new AgentCore(config, identityManager, historyMemory, errorMemory, shellAuditPath);

  // Load skills at startup
  const skills = await loadSkills(config.enabledSkills);
  for (const skill of skills) {
    agent.registerSkill(skill);
    registerSkill(skill, identityManager);
  }

  // Track which skill dirs are loaded (by dir name = skill name)
  const loadedSkillNames = new Set(skills.map(s => s.name));

  const onNewSkill = (skill: Skill) => {
    agent.registerSkill(skill);
    registerSkill(skill, identityManager);
    loadedSkillNames.add(skill.name);
  };

  const setCacheInvalidated = () => {
    // agent.registerSkill already sets cacheInvalidated internally
  };

  // Watch skills/ dir for new skill directories (hot-load)
  startSkillWatcher(onNewSkill, loadedSkillNames, setCacheInvalidated);

  // Start HTTP server
  startHttpServer(
    {
      agent,
      identityManager,
      historyMemory,
      shellAuditPath,
      loadedSkillNames,
      onNewSkill,
      setCacheInvalidated,
      timeoutMs: config.agentTimeoutMs,
    },
    config.agentPort,
  );

  // Start Telegram bot (optional)
  if (config.telegramBotToken) {
    startTelegramBot(agent, config.agentName, config.telegramBotToken, config.telegramChatId);
  } else {
    console.error('[ragent] TELEGRAM_BOT_TOKEN not set — Telegram disabled');
  }

  // Start REPL if --repl flag or stdin is a TTY
  if (process.argv.includes('--repl') || process.stdin.isTTY) {
    startREPL(agent, config.agentName);
  }

  console.error(`[ragent] ${config.agentName} ready on port ${config.agentPort}`);
}

main().catch(err => {
  console.error('[ragent] Fatal:', err);
  process.exit(1);
});
