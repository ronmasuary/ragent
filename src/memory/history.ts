import fs from 'fs';
import path from 'path';
import type { NormalizedMessage, NormalizedContentBlock } from '../providers/types.js';

const CAP_BYTES = 10 * 1024 * 1024;
const IN_MEMORY_LIMIT = 100;
const TRIM_FRACTION = 0.2;

export interface HistoryEntry {
  ts: string;
  role: 'user' | 'assistant';
  content: string;
  tools?: unknown[];
}

export class HistoryMemory {
  private filePath: string;
  private buffer: NormalizedMessage[] = [];

  constructor(identityDir: string) {
    this.filePath = path.join(identityDir, 'history.jsonl');
  }

  /** Read last 20 lines from disk, sanitize orphaned tool pairs, populate buffer. */
  warmLoad(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const lines = raw.split('\n').filter(l => l.trim());
      const last20 = lines.slice(-IN_MEMORY_LIMIT);
      const parsed: NormalizedMessage[] = [];
      for (const line of last20) {
        try {
          const entry = JSON.parse(line) as HistoryEntry;
          parsed.push({
            role: entry.role,
            content: entry.tools ? (entry.tools as NormalizedContentBlock[]) : entry.content,
          });
        } catch {
          // skip malformed lines
        }
      }
      this.buffer = sanitize(parsed);
      console.error(`[HistoryMemory] Warm-loaded ${this.buffer.length} messages`);
    } catch (err) {
      console.error('[HistoryMemory] warm-load failed:', err);
    }
  }

  getBuffer(): NormalizedMessage[] {
    return this.buffer;
  }

  /** Append message to in-memory buffer and disk. Cap check runs async. */
  append(message: NormalizedMessage): void {
    this.buffer.push(message);
    const entry: HistoryEntry = {
      ts: new Date().toISOString(),
      role: message.role,
      content: typeof message.content === 'string' ? message.content : '',
      tools: Array.isArray(message.content) ? (message.content as unknown[]) : undefined,
    };
    const line = JSON.stringify(entry) + '\n';
    try {
      fs.appendFileSync(this.filePath, line, 'utf-8');
    } catch (err) {
      console.error('[HistoryMemory] append failed:', err);
    }
    setImmediate(() => this.checkCap());
  }

  private checkCap(): void {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size <= CAP_BYTES) return;
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const lines = raw.split('\n').filter(l => l.trim());
      const dropCount = Math.ceil(lines.length * TRIM_FRACTION);
      const trimmed = lines.slice(dropCount);
      fs.writeFileSync(this.filePath, trimmed.join('\n') + '\n', 'utf-8');
      console.error(`[HistoryMemory] Cap exceeded — dropped ${dropCount} oldest lines`);
    } catch {
      // non-blocking
    }
  }

  /** Get last N messages from in-memory buffer. */
  getLastN(n: number): NormalizedMessage[] {
    return this.buffer.slice(-n);
  }

  /** Read entries since an ISO timestamp from disk. */
  getSince(since: string): HistoryEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    const sinceMs = new Date(since).getTime();
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return raw
        .split('\n')
        .filter(l => l.trim())
        .map(l => { try { return JSON.parse(l) as HistoryEntry; } catch { return null; } })
        .filter((e): e is HistoryEntry => e !== null && new Date(e.ts).getTime() >= sinceMs);
    } catch {
      return [];
    }
  }
}

/**
 * Sanitize: remove orphaned tool_use blocks without matching tool_result, and vice versa.
 * Also removes any trailing assistant message.
 */
export function sanitize(messages: NormalizedMessage[]): NormalizedMessage[] {
  const result: NormalizedMessage[] = [...messages];

  // Remove tool_result blocks whose tool_use_id has no matching tool_use in the previous message
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

    const hasToolResults = (msg.content as NormalizedContentBlock[]).some(b => b.type === 'tool_result');
    if (!hasToolResults) continue;

    const validIds = new Set<string>();
    const prev = result[i - 1];
    if (prev?.role === 'assistant' && Array.isArray(prev.content)) {
      for (const b of prev.content as NormalizedContentBlock[]) {
        if (b.type === 'tool_use') validIds.add(b.id);
      }
    }

    const cleaned = (msg.content as NormalizedContentBlock[]).filter(b => {
      if (b.type !== 'tool_result') return true;
      return validIds.has(b.tool_use_id);
    });

    if (cleaned.length === 0) {
      result.splice(i, 1);
      i--;
    } else if (cleaned.length !== (msg.content as NormalizedContentBlock[]).length) {
      result[i] = { ...msg, content: cleaned };
    }
  }

  // Remove trailing assistant messages
  while (result.length > 0 && result[result.length - 1].role === 'assistant') {
    result.pop();
  }

  return result;
}
