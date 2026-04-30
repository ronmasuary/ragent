import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { HistoryMemory, sanitize } from '../../src/memory/history.js';
import type { NormalizedMessage } from '../../src/providers/types.js';

let tmpDir: string;
let history: HistoryMemory;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ragent-test-'));
  history = new HistoryMemory(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('HistoryMemory', () => {
  it('appends and reads back', () => {
    const msg: NormalizedMessage = { role: 'user', content: 'hello' };
    history.append(msg);
    const buf = history.getLastN(10);
    expect(buf).toHaveLength(1);
    expect(buf[0].content).toBe('hello');
  });

  it('getLastN respects limit', () => {
    for (let i = 0; i < 5; i++) {
      history.append({ role: 'user', content: `msg ${i}` });
    }
    const buf = history.getLastN(3);
    expect(buf).toHaveLength(3);
    expect((buf[2].content as string)).toBe('msg 4');
  });

  it('warm-load reads last 20 from disk', () => {
    // Append 25 messages directly to file
    const filePath = path.join(tmpDir, 'history.jsonl');
    for (let i = 0; i < 25; i++) {
      fs.appendFileSync(filePath, JSON.stringify({ ts: new Date().toISOString(), role: 'user', content: `msg ${i}` }) + '\n');
    }
    const h2 = new HistoryMemory(tmpDir);
    h2.warmLoad();
    expect(h2.getBuffer().length).toBeLessThanOrEqual(20);
  });

  it('getSince returns entries after timestamp', async () => {
    const before = new Date().toISOString();
    await new Promise(r => setTimeout(r, 10));
    history.append({ role: 'user', content: 'after' });
    const entries = history.getSince(before);
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe('after');
  });

  it('10MB cap drops oldest 20%', () => {
    const filePath = path.join(tmpDir, 'history.jsonl');
    // Write > 10MB to file
    const bigLine = JSON.stringify({ ts: new Date().toISOString(), role: 'user', content: 'x'.repeat(1000) }) + '\n';
    const lineCount = 11_000; // ~11MB
    const content = bigLine.repeat(lineCount);
    fs.writeFileSync(filePath, content);

    // Trigger cap via append
    const h2 = new HistoryMemory(tmpDir);
    h2.append({ role: 'user', content: 'trigger' });

    // Give setImmediate time to run
    return new Promise<void>(resolve => {
      setImmediate(() => {
        const newSize = fs.statSync(filePath).size;
        expect(newSize).toBeLessThan(11_000 * bigLine.length);
        resolve();
      });
    });
  });
});

describe('sanitize', () => {
  it('removes orphaned tool_result blocks', () => {
    const messages: NormalizedMessage[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'result', is_error: false }],
      },
    ];
    const result = sanitize(messages);
    // The orphaned tool_result message should be removed (no matching tool_use in prev)
    expect(result.some(m =>
      Array.isArray(m.content) && (m.content as { type: string }[]).some(b => b.type === 'tool_result')
    )).toBe(false);
  });

  it('removes trailing assistant messages', () => {
    const messages: NormalizedMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const result = sanitize(messages);
    expect(result[result.length - 1].role).not.toBe('assistant');
  });
});
