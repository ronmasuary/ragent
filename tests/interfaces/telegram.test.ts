import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Capture handlers registered by startTelegramBot
type AnyFn = (...args: unknown[]) => unknown;
let capturedTextHandler: AnyFn | null = null;
let capturedStatusHandler: AnyFn | null = null;

const mockTelegram = {
  sendMessage: vi.fn().mockResolvedValue({}),
  sendChatAction: vi.fn().mockResolvedValue({}),
};

const mockBot = {
  start: vi.fn(),
  command: vi.fn((cmd: string, fn: AnyFn) => {
    if (cmd === 'status') capturedStatusHandler = fn;
  }),
  on: vi.fn((event: string, fn: AnyFn) => {
    if (event === 'text') capturedTextHandler = fn;
  }),
  launch: vi.fn(() => new Promise(() => {})), // never resolves — simulates long-running polling
  stop: vi.fn(),
  telegram: mockTelegram,
};

vi.mock('telegraf', () => ({ Telegraf: vi.fn(() => mockBot) }));

const { startTelegramBot } = await import('../../src/interfaces/telegram.js');

const CHAT_ID = 42;
const OTHER_CHAT_ID = 999;
const ALLOWED_CHAT = String(CHAT_ID);

function makeCtx(chatId: number, text: string) {
  return {
    chat: { id: chatId },
    message: { text },
    reply: vi.fn().mockResolvedValue({}),
    sendChatAction: vi.fn().mockResolvedValue({}),
  };
}

const mockAgent = {
  isRunning: false,
  currentInterface: 'http' as string,
  chat: vi.fn<[string], Promise<string>>(),
};

describe('Telegram bot — fire-and-forget message handling', () => {
  beforeAll(() => {
    startTelegramBot(mockAgent as never, 'wally', 'test-token', ALLOWED_CHAT);
  });

  beforeEach(() => {
    mockAgent.isRunning = false;
    mockAgent.chat.mockReset();
    mockTelegram.sendMessage.mockClear();
    mockTelegram.sendChatAction.mockClear();
  });

  it('text handler resolves before agent.chat() resolves', async () => {
    let resolveChat!: (v: string) => void;
    mockAgent.chat.mockReturnValue(new Promise(r => { resolveChat = r; }));

    const ctx = makeCtx(CHAT_ID, 'do a long task');
    const handlerDone = capturedTextHandler!(ctx) as Promise<void>;

    // Handler must resolve (return to Telegraf) before chat finishes
    await handlerDone;
    expect(mockAgent.chat).toHaveBeenCalledWith('do a long task');
    expect(mockTelegram.sendMessage).not.toHaveBeenCalled();

    // Agent finishes → result delivered via sendMessage (not ctx.reply)
    resolveChat('task complete');
    await vi.waitFor(() => {
      expect(mockTelegram.sendMessage).toHaveBeenCalledWith(CHAT_ID, 'task complete');
    });
  });

  it('replies busy immediately when agent.isRunning is true', async () => {
    mockAgent.isRunning = true;

    const ctx = makeCtx(CHAT_ID, 'hello');
    await capturedTextHandler!(ctx);

    expect(mockAgent.chat).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('still working'));
    expect(mockTelegram.sendMessage).not.toHaveBeenCalled();
  });

  it('sends error message via sendMessage when agent.chat() throws', async () => {
    mockAgent.chat.mockRejectedValue(new Error('tool failed after retries'));

    const ctx = makeCtx(CHAT_ID, 'run something');
    await capturedTextHandler!(ctx);

    await vi.waitFor(() => {
      expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('went wrong'),
      );
    });
  });

  it('sends busy message via sendMessage when agent throws Agent busy', async () => {
    mockAgent.chat.mockRejectedValue(new Error('Agent busy'));

    const ctx = makeCtx(CHAT_ID, 'hello');
    await capturedTextHandler!(ctx);

    await vi.waitFor(() => {
      expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('still working'),
      );
    });
  });

  it('splits responses longer than 4096 chars into multiple sendMessage calls', async () => {
    const longResponse = 'word '.repeat(1000); // ~5000 chars
    mockAgent.chat.mockResolvedValue(longResponse);

    const ctx = makeCtx(CHAT_ID, 'write a lot');
    await capturedTextHandler!(ctx);

    await vi.waitFor(() => {
      expect(mockTelegram.sendMessage.mock.calls.length).toBeGreaterThan(1);
      const joined = mockTelegram.sendMessage.mock.calls.map(c => c[1]).join('');
      expect(joined.trim()).toBe(longResponse.trim());
    });
  });

  it('ignores messages from non-allowed chat IDs', async () => {
    mockAgent.chat.mockResolvedValue('response');

    const ctx = makeCtx(OTHER_CHAT_ID, 'hello');
    await capturedTextHandler!(ctx);

    expect(mockAgent.chat).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('sets currentInterface to telegram before calling agent.chat()', async () => {
    mockAgent.currentInterface = 'http';
    mockAgent.chat.mockResolvedValue('ok');

    const ctx = makeCtx(CHAT_ID, 'hello');
    await capturedTextHandler!(ctx);

    await vi.waitFor(() => expect(mockTelegram.sendMessage).toHaveBeenCalled());
    expect(mockAgent.currentInterface).toBe('telegram');
  });
});

describe('Telegram bot — /status command', () => {
  beforeEach(() => {
    mockAgent.isRunning = false;
    mockAgent.chat.mockReset();
    mockTelegram.sendMessage.mockClear();
  });

  it('status handler resolves before agent.chat() resolves', async () => {
    let resolveChat!: (v: string) => void;
    mockAgent.chat.mockReturnValue(new Promise(r => { resolveChat = r; }));

    const ctx = makeCtx(CHAT_ID, '');
    const handlerDone = capturedStatusHandler!(ctx) as Promise<void>;

    await handlerDone;
    expect(mockAgent.chat).toHaveBeenCalledWith('/status');
    expect(mockTelegram.sendMessage).not.toHaveBeenCalled();

    resolveChat('wally • uptime 42s');
    await vi.waitFor(() => {
      expect(mockTelegram.sendMessage).toHaveBeenCalledWith(CHAT_ID, 'wally • uptime 42s');
    });
  });

  it('status replies busy when agent.isRunning is true', async () => {
    mockAgent.isRunning = true;

    const ctx = makeCtx(CHAT_ID, '');
    await capturedStatusHandler!(ctx);

    expect(mockAgent.chat).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('still working'));
  });
});
