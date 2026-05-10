import { Telegraf } from 'telegraf';
import type { AgentCore } from '../agent/core.js';

const TELEGRAM_MAX_LENGTH = 4096;
const TYPING_REFRESH_MS = 4000;

export function startTelegramBot(
  agent: AgentCore,
  agentName: string,
  token: string,
  allowedChatIdStr?: string,
): (() => void) | undefined {
  const allowedChatId = parseInt(allowedChatIdStr ?? '', 10);

  if (isNaN(allowedChatId)) {
    console.error('[Telegram] TELEGRAM_ALLOWED_CHAT_ID not set or invalid — bot will not start');
    return;
  }

  const bot = new Telegraf(token);
  let botAlive = true;

  bot.start((ctx) => {
    if (ctx.chat.id !== allowedChatId) return;
    void ctx.reply(`Hi, I'm ${agentName}, an autonomous AI agent. Send me a message to get started.`);
  });

  bot.command('status', async (ctx) => {
    if (ctx.chat.id !== allowedChatId) return;
    if (agent.isRunning) {
      await ctx.reply("I'm still working on your last message — please wait.");
      return;
    }

    const chatId = ctx.chat.id;
    agent.currentInterface = 'telegram';

    // Fire-and-forget: return before agent.chat() completes so Telegraf's
    // internal 90s update-handler timeout never fires on long tasks.
    void (async () => {
      try {
        const response = await agent.chat('/status');
        const chunks = splitMessage(response || 'Ready.');
        for (const chunk of chunks) await bot.telegram.sendMessage(chatId, chunk);
      } catch (err) {
        await bot.telegram.sendMessage(chatId, `Error: ${(err as Error).message}`);
      }
    })();
  });

  bot.on('text', async (ctx) => {
    if (ctx.chat.id !== allowedChatId) return;
    // Commands are handled by bot.command() — skip here to avoid double-firing
    if (ctx.message.text.startsWith('/')) return;

    if (agent.isRunning) {
      await ctx.reply("I'm still working on your last message — please wait.");
      return;
    }

    agent.currentInterface = 'telegram';
    const userMessage = ctx.message.text;
    const chatId = ctx.chat.id;

    try { await ctx.sendChatAction('typing'); } catch { /* network blip, proceed without indicator */ }

    // Fire-and-forget: return before agent.chat() completes so Telegraf's
    // internal 90s update-handler timeout never fires on long tasks.
    // Results are delivered via bot.telegram.sendMessage once the agent finishes.
    void (async () => {
      const typingInterval = setInterval(() => {
        if (botAlive) bot.telegram.sendChatAction(chatId, 'typing').catch(() => {});
      }, TYPING_REFRESH_MS);

      try {
        const response = await agent.chat(userMessage);
        clearInterval(typingInterval);
        const chunks = splitMessage(response || '(no response)');
        for (const chunk of chunks) await bot.telegram.sendMessage(chatId, chunk);
      } catch (err) {
        clearInterval(typingInterval);
        if ((err as Error).message === 'Agent busy') {
          await bot.telegram.sendMessage(chatId, "I'm still working on another message — please wait.");
        } else {
          console.error('[Telegram] Error:', err);
          await bot.telegram.sendMessage(chatId, 'Sorry, something went wrong. Please try again.');
        }
      }
    })();
  });

  bot.on('message', (ctx) => {
    if (ctx.chat.id !== allowedChatId) return;
    void ctx.reply('Please send text messages only.');
  });

  async function launchWithRetry() {
    let delay = 2_000;
    while (true) {
      try {
        await bot.launch();
        break; // clean stop via SIGINT/SIGTERM
      } catch (err) {
        if (!botAlive) break;
        console.error(`[Telegram] Bot stopped, reconnecting in ${delay / 1000}s:`, err);
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  void launchWithRetry();

  console.error('[Telegram] Bot started.');

  return () => { botAlive = false; bot.stop('SIGTERM'); };
}

function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split('\n\n');
  let current = '';

  for (const para of paragraphs) {
    const sep = current ? '\n\n' : '';
    if ((current + sep + para).length <= TELEGRAM_MAX_LENGTH) {
      current += sep + para;
    } else {
      if (current) chunks.push(current);
      if (para.length > TELEGRAM_MAX_LENGTH) {
        let remaining = para;
        while (remaining.length > TELEGRAM_MAX_LENGTH) {
          chunks.push(remaining.slice(0, TELEGRAM_MAX_LENGTH));
          remaining = remaining.slice(TELEGRAM_MAX_LENGTH);
        }
        current = remaining;
      } else {
        current = para;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
