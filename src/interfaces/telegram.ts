import { Telegraf } from 'telegraf';
import type { AgentCore } from '../agent/core.js';

const TELEGRAM_MAX_LENGTH = 4096;
const TYPING_REFRESH_MS = 4000;

export function startTelegramBot(
  agent: AgentCore,
  agentName: string,
  token: string,
  allowedChatIdStr?: string,
): void {
  const allowedChatId = parseInt(allowedChatIdStr ?? '', 10);

  if (isNaN(allowedChatId)) {
    console.error('[Telegram] TELEGRAM_ALLOWED_CHAT_ID not set or invalid — bot will not start');
    return;
  }

  const bot = new Telegraf(token);

  bot.start((ctx) => {
    if (ctx.chat.id !== allowedChatId) return;
    void ctx.reply(`Hi, I'm ${agentName}, an autonomous AI agent. Send me a message to get started.`);
  });

  bot.command('status', async (ctx) => {
    if (ctx.chat.id !== allowedChatId) return;
    agent.currentInterface = 'telegram';
    try {
      const response = await agent.chat('/status');
      const chunks = splitMessage(response || 'Ready.');
      for (const chunk of chunks) await ctx.reply(chunk);
    } catch (err) {
      await ctx.reply(`Error: ${(err as Error).message}`);
    }
  });

  bot.on('text', async (ctx) => {
    if (ctx.chat.id !== allowedChatId) return;

    agent.currentInterface = 'telegram';
    const userMessage = ctx.message.text;

    await ctx.sendChatAction('typing');
    const typingInterval = setInterval(() => {
      void ctx.sendChatAction('typing');
    }, TYPING_REFRESH_MS);

    try {
      const response = await agent.chat(userMessage);
      clearInterval(typingInterval);
      const chunks = splitMessage(response || '(no response)');
      for (const chunk of chunks) await ctx.reply(chunk);
    } catch (err) {
      clearInterval(typingInterval);
      console.error('[Telegram] Error:', err);
      await ctx.reply('Sorry, something went wrong. Please try again.');
    }
  });

  bot.on('message', (ctx) => {
    if (ctx.chat.id !== allowedChatId) return;
    void ctx.reply('Please send text messages only.');
  });

  bot.launch().catch(err => {
    console.error('[Telegram] Bot stopped unexpectedly:', err);
  });

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  console.error('[Telegram] Bot started.');
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
