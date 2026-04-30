import fs from 'fs';
import path from 'path';

export interface ErrorEntry {
  ts: string;
  tool: string;
  input: Record<string, unknown>;
  error: string;
  context: string;
}

export class ErrorMemory {
  private filePath: string;

  constructor(identityDir: string) {
    this.filePath = path.join(identityDir, 'errors.jsonl');
  }

  append(entry: Omit<ErrorEntry, 'ts'>): void {
    const full: ErrorEntry = { ts: new Date().toISOString(), ...entry };
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(full) + '\n', 'utf-8');
    } catch (err) {
      console.error('[ErrorMemory] append failed:', err);
    }
  }

  getLastN(n = 5): ErrorEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return raw
        .split('\n')
        .filter(l => l.trim())
        .slice(-n)
        .map(l => { try { return JSON.parse(l) as ErrorEntry; } catch { return null; } })
        .filter((e): e is ErrorEntry => e !== null);
    } catch {
      return [];
    }
  }

  /** Format last N errors for system prompt tail injection. */
  formatForPrompt(n = 5): string {
    const errors = this.getLastN(n);
    if (errors.length === 0) return '';
    const lines = errors.map(e =>
      `- ${e.tool}(${JSON.stringify(e.input)}) → ${e.error} [${e.ts.slice(0, 10)}]`
    );
    return `\nPast mistakes to avoid:\n${lines.join('\n')}`;
  }
}
