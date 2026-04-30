import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, '..', '.env') });

export interface Config {
  provider: 'anthropic' | 'openai';
  agentName: string;
  agentPort: number;
  agentModel: string;
  agentTimeoutMs: number;
  telegramBotToken?: string;
  telegramChatId?: string;
  enabledSkills?: string[];
}

export function loadConfig(): Config {
  const provider = (process.env.PROVIDER ?? 'anthropic') as 'anthropic' | 'openai';

  if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('Missing required env var: ANTHROPIC_API_KEY');
  }
  if (provider === 'openai' && !process.env.OPENAI_API_KEY) {
    throw new Error('Missing required env var: OPENAI_API_KEY');
  }

  const isAnthropic = provider !== 'openai';
  const defaultModel = isAnthropic ? 'claude-sonnet-4-6' : 'gpt-4o';

  const enabledSkillsEnv = process.env.ENABLED_SKILLS;

  return {
    provider,
    agentName: process.env.AGENT_NAME ?? 'wally',
    agentPort: Number(process.env.AGENT_PORT) || 3456,
    agentModel: process.env.AGENT_MODEL ?? defaultModel,
    agentTimeoutMs: Number(process.env.AGENT_TIMEOUT_MS) || 300_000,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_ALLOWED_CHAT_ID,
    enabledSkills: enabledSkillsEnv
      ? enabledSkillsEnv.split(',').map(s => s.trim()).filter(Boolean)
      : undefined,
  };
}
