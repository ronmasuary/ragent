#!/usr/bin/env node
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, '..', '.env') });

import { loadConfig } from './config.js';
import { IdentityManager } from './agent/identity.js';
import { HistoryMemory } from './memory/history.js';
import { ErrorMemory } from './memory/errors.js';
import { AgentCore } from './agent/core.js';
import { loadSkills, registerSkill, SKILLS_DIR } from './skills/loader.js';
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

  // Wire skill install callback — used by install_skill built-in tool and POST /skills/install
  agent.installSkill = async (filePath: string, overwrite = false) => {
    if (!filePath.endsWith('.skill')) return { name: '', error: 'File must have .skill extension' };
    if (!fs.existsSync(filePath)) return { name: '', error: `File not found: ${filePath}` };

    const skillName = path.basename(filePath, '.skill');
    const targetDir = path.join(SKILLS_DIR, skillName);

    if (fs.existsSync(targetDir)) {
      if (!overwrite) {
        return { name: skillName, error: `Skill "${skillName}" already installed. Pass overwrite: true to upgrade.` };
      }
      fs.rmSync(targetDir, { recursive: true, force: true });
    }

    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(execFile);

    fs.mkdirSync(targetDir, { recursive: true });
    await execAsync('unzip', ['-o', filePath, '-d', targetDir], { timeout: 30_000 });

    const assetsDir = path.join(targetDir, 'assets');
    if (fs.existsSync(assetsDir)) {
      const allAssets = fs.readdirSync(assetsDir);
      const scripts = allAssets
        .filter(f => f.startsWith('install-') && (f.endsWith('.cjs') || f.endsWith('.js')))
        .filter(f => {
          if (f.endsWith('.js')) {
            const cjsName = f.slice(0, -3) + '.cjs';
            return !allAssets.includes(cjsName);
          }
          return true;
        });
      for (const scriptFile of scripts) {
        try {
          await execAsync('node', [path.join(assetsDir, scriptFile)], {
            cwd: targetDir,
            timeout: 60_000,
          });
        } catch (err) {
          // Clean up partial install so agent isn't left with a broken skill
          fs.rmSync(targetDir, { recursive: true, force: true });
          return { name: skillName, error: `Asset script "${scriptFile}" failed: ${(err as Error).message}` };
        }
      }
    }

    await rescanSkills(onNewSkill, loadedSkillNames, setCacheInvalidated);
    return { name: skillName };
  };

  // Start HTTP server
  const server = startHttpServer(
    {
      agent,
      identityManager,
      historyMemory,
      shellAuditPath,
      loadedSkillNames,
      onNewSkill,
      setCacheInvalidated,
      timeoutMs: config.agentTimeoutMs,
      apiKey: config.apiKey,
    },
    config.agentPort,
  );

  // Start Telegram bot (optional)
  let stopTelegram: (() => void) | undefined;
  if (config.telegramBotToken) {
    stopTelegram = startTelegramBot(agent, config.agentName, config.telegramBotToken, config.telegramChatId);
  } else {
    console.error('[ragent] TELEGRAM_BOT_TOKEN not set — Telegram disabled');
  }

  // Start REPL if --repl flag or stdin is a TTY
  if (process.argv.includes('--repl') || process.stdin.isTTY) {
    startREPL(agent, config.agentName);
  }

  console.error(`[ragent] ${config.agentName} ready on port ${config.agentPort}`);

  async function shutdown(signal: string) {
    console.error(`[ragent] ${signal} received — shutting down gracefully...`);
    server.close();
    const deadline = Date.now() + 30_000;
    while (agent.isRunning && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
    }
    stopTelegram?.();
    console.error('[ragent] Shutdown complete.');
    process.exit(0);
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(err => {
  console.error('[ragent] Fatal:', err);
  process.exit(1);
});
