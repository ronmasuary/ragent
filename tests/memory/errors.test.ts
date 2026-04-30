import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ErrorMemory } from '../../src/memory/errors.js';

let tmpDir: string;
let errors: ErrorMemory;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ragent-errors-'));
  errors = new ErrorMemory(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ErrorMemory', () => {
  it('appends and reads back last N', () => {
    errors.append({ tool: 'shell_exec', input: { command: 'bad' }, error: 'permission denied', context: 'test' });
    errors.append({ tool: 'read_file', input: { path: '/x' }, error: 'not found', context: 'test' });
    const last = errors.getLastN(5);
    expect(last).toHaveLength(2);
    expect(last[0].tool).toBe('shell_exec');
    expect(last[1].error).toBe('not found');
  });

  it('getLastN respects limit', () => {
    for (let i = 0; i < 10; i++) {
      errors.append({ tool: 'test', input: {}, error: `err ${i}`, context: '' });
    }
    const last = errors.getLastN(5);
    expect(last).toHaveLength(5);
    expect(last[4].error).toBe('err 9');
  });

  it('formats for system prompt', () => {
    errors.append({ tool: 'shell_exec', input: { command: 'chmod' }, error: 'permission denied', context: '' });
    const formatted = errors.formatForPrompt(5);
    expect(formatted).toContain('Past mistakes to avoid:');
    expect(formatted).toContain('shell_exec');
    expect(formatted).toContain('permission denied');
  });

  it('returns empty string when no errors', () => {
    expect(errors.formatForPrompt()).toBe('');
  });
});
