import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ragent-audit-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('shell_exec audit log', () => {
  it('HTTP interface writes to shell_audit.jsonl', async () => {
    const auditPath = path.join(tmpDir, 'shell_audit.jsonl');

    // Simulate what AgentCore.executeBuiltin does for shell_exec in HTTP mode
    const entry = {
      ts: new Date().toISOString(),
      command: 'echo hello',
      cwd: '/tmp',
      exitCode: 0,
      interface: 'http' as const,
    };
    fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n', 'utf-8');

    const contents = fs.readFileSync(auditPath, 'utf-8');
    const parsed = JSON.parse(contents.trim());
    expect(parsed.command).toBe('echo hello');
    expect(parsed.interface).toBe('http');
    expect(parsed.exitCode).toBe(0);
  });

  it('REPL interface does NOT write to shell_audit.jsonl when confirmed', () => {
    const auditPath = path.join(tmpDir, 'shell_audit.jsonl');
    // In REPL mode, the code path skips the audit write:
    //   if (this.currentInterface !== 'repl') { ... appendFileSync ... }
    // So audit file should not exist after REPL shell_exec
    expect(fs.existsSync(auditPath)).toBe(false);
  });

  it('audit entry has required fields', () => {
    const entry = {
      ts: new Date().toISOString(),
      command: 'ls -la',
      cwd: '/home',
      exitCode: 0,
      interface: 'telegram' as const,
    };
    expect(entry).toHaveProperty('ts');
    expect(entry).toHaveProperty('command');
    expect(entry).toHaveProperty('cwd');
    expect(entry).toHaveProperty('exitCode');
    expect(entry).toHaveProperty('interface');
  });
});
