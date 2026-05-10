import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import { createProvider } from '../providers/index.js';
import type { LLMProvider, NormalizedMessage, NormalizedContentBlock, NormalizedTool } from '../providers/index.js';
import type { Skill, SkillContext } from '../skills/types.js';
import type { IdentityManager } from './identity.js';
import type { HistoryMemory } from '../memory/history.js';
import type { ErrorMemory } from '../memory/errors.js';
import type { Config } from '../config.js';

const execFileAsync = promisify(execFile);

const MAX_TOKENS = 8192;
const MAX_ITERATIONS = 20;
const MAX_REFLECTION_RETRIES = 3;
const MAX_TOOL_RESULT_CHARS = 6000;
const MAX_HISTORY_MESSAGES = 20;

const BASE_SYSTEM_PROMPT = `You are {AGENT_NAME}, an autonomous AI agent.
You act autonomously on behalf of your operator. Report status clearly and concisely.

RESPONSE STYLE:
- Be concise by default. Short, clear answers.
- Bullet points for structured data.
- Never dump raw JSON unless explicitly asked.

BUILT-IN TOOLS:
You always have access to: read_file, write_file, shell_exec, fetch_url, download_file, list_dir, check_process, install_skill.
Skills may add more tools as they are installed.

When helping users, only access files and tools the user has explicitly pointed you to. Do not browse the filesystem for related files, reference implementations, or context in other projects.`;

export type Interface = 'repl' | 'http' | 'telegram';

export interface ShellAuditEntry {
  ts: string;
  command: string;
  cwd: string;
  exitCode: number;
  interface: 'http' | 'telegram';
}

export class AgentCore {
  private provider: LLMProvider;
  private identityManager: IdentityManager;
  private historyMemory: HistoryMemory;
  private errorMemory: ErrorMemory;
  private skillRegistry = new Map<string, Skill>();
  private skillTools: NormalizedTool[] = [];
  private cacheInvalidated = false;
  private agentName: string;
  private shellAuditPath: string;

  /** Set by readline interface to gate shell_exec confirmation in REPL mode. */
  confirmShellExec?: (command: string, cwd: string) => Promise<boolean>;

  /** Wired by index.ts — installs a .skill file from a path. */
  installSkill?: (filePath: string, overwrite?: boolean) => Promise<{ name: string; error?: string }>;

  /** Which interface is currently handling a request — governs shell_exec behavior. */
  currentInterface: Interface = 'http';

  /** Mutex state — managed by HTTP server via generation counter pattern. */
  isRunning = false;
  gen = 0;

  constructor(
    config: Config,
    identityManager: IdentityManager,
    historyMemory: HistoryMemory,
    errorMemory: ErrorMemory,
    shellAuditPath: string,
  ) {
    this.provider = createProvider(config.agentModel);
    this.identityManager = identityManager;
    this.historyMemory = historyMemory;
    this.errorMemory = errorMemory;
    this.agentName = config.agentName;
    this.shellAuditPath = shellAuditPath;
  }

  registerSkill(skill: Skill): void {
    for (const tool of skill.tools) {
      if (this.skillRegistry.has(tool.name)) {
        console.error(`[AgentCore] Warning: tool "${tool.name}" already registered — overwriting`);
      }
      this.skillRegistry.set(tool.name, skill);
    }
    this.skillTools = [...this.skillTools, ...skill.tools];
    this.cacheInvalidated = true;
    console.error(`[AgentCore] Registered skill: ${skill.name} (${skill.tools.length} tools)`);
  }

  private buildSystemPrompt(): string {
    const identity = this.identityManager.get();
    const base = BASE_SYSTEM_PROMPT.replaceAll('{AGENT_NAME}', this.agentName);

    const seenSkills = new Set<string>();
    const skillPrompts: string[] = [];
    for (const skill of this.skillRegistry.values()) {
      if (!seenSkills.has(skill.name) && skill.systemPrompt) {
        seenSkills.add(skill.name);
        skillPrompts.push(skill.systemPrompt);
      }
    }

    const skillSection = skillPrompts.length > 0
      ? `\n\n--- SKILL INSTRUCTIONS ---\n${skillPrompts.join('\n\n---\n\n')}\n--- END SKILL INSTRUCTIONS ---`
      : '';

    const pastErrors = this.errorMemory.formatForPrompt(5);

    return `${base}

Agent ID: ${identity.id}
Agent Name: ${identity.name}
Capabilities: ${identity.capabilities.join(', ') || 'none yet'}${skillSection}${pastErrors}`;
  }

  private buildTools(): NormalizedTool[] {
    const builtins: NormalizedTool[] = [
      {
        name: 'read_file',
        description: 'Read the contents of a local file.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Absolute or relative file path' } },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Write content to a local file, creating it if needed.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to write' },
            content: { type: 'string', description: 'Content to write' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'shell_exec',
        description: 'Run a shell command. In REPL mode requires user confirmation first.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to run' },
            cwd: { type: 'string', description: 'Working directory (optional, defaults to process.cwd())' },
          },
          required: ['command'],
        },
      },
      {
        name: 'fetch_url',
        description: 'Make an HTTP request to a URL and return the response as text. Use download_file for binary content (ZIPs, images, executables).',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to request' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'HTTP method (default: GET)' },
            body: { type: 'string', description: 'Request body as string (optional)' },
            headers: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'HTTP headers (optional)',
            },
          },
          required: ['url'],
        },
      },
      {
        name: 'download_file',
        description: 'Download a file from a URL and save it to disk. Handles binary content correctly (ZIPs, images, executables). Use this instead of fetch_url when saving files.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to download from' },
            dest: { type: 'string', description: 'Absolute destination path to save the file' },
          },
          required: ['url', 'dest'],
        },
      },
      {
        name: 'list_dir',
        description: 'List the contents of a directory.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Directory path to list' } },
          required: ['path'],
        },
      },
      {
        name: 'check_process',
        description: 'Check if a process is listening on a given port.',
        inputSchema: {
          type: 'object',
          properties: { port: { type: 'number', description: 'Port number to check' } },
          required: ['port'],
        },
      },
      {
        name: 'install_skill',
        description: 'Install a .skill file (ZIP package) into the agent. Provide the absolute path to the .skill file. Set overwrite: true to upgrade an already-installed skill.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the .skill file' },
            overwrite: { type: 'boolean', description: 'Replace existing skill if already installed (default: false)' },
          },
          required: ['path'],
        },
      },
    ];

    return [...builtins, ...this.skillTools];
  }

  private async executeBuiltin(toolName: string, input: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case 'read_file': {
        const filePath = input.path as string;
        if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
        return fs.readFileSync(filePath, 'utf-8');
      }

      case 'write_file': {
        const filePath = input.path as string;
        const content = input.content as string;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
        return `Written ${content.length} bytes to ${filePath}`;
      }

      case 'shell_exec': {
        const command = input.command as string;
        const cwd = (input.cwd as string | undefined) ?? process.cwd();

        // Gate on confirmShellExec presence — set only by REPL, never by HTTP/Telegram.
        // currentInterface is shared mutable state and can be overwritten by concurrent requests.
        if (this.confirmShellExec) {
          const confirmed = await this.confirmShellExec(command, cwd);
          if (!confirmed) return 'Command aborted by user.';
        }

        let exitCode = 0;
        let output: string;
        try {
          const result = await execFileAsync('sh', ['-c', command], { cwd, timeout: 60000 });
          output = (result.stdout + result.stderr).trim();
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; code?: number };
          exitCode = e.code ?? 1;
          output = ((e.stdout ?? '') + (e.stderr ?? '')).trim() || (err as Error).message;
        }

        // HTTP / Telegram: log every execution to shell_audit.jsonl
        if (this.currentInterface !== 'repl') {
          const entry: ShellAuditEntry = {
            ts: new Date().toISOString(),
            command,
            cwd,
            exitCode,
            interface: this.currentInterface as 'http' | 'telegram',
          };
          try {
            fs.appendFileSync(this.shellAuditPath, JSON.stringify(entry) + '\n', 'utf-8');
          } catch { /* non-blocking */ }
        }

        return exitCode === 0 ? output || '(no output)' : `Exit ${exitCode}:\n${output}`;
      }

      case 'fetch_url': {
        const url = input.url as string;
        const method = (input.method as string | undefined) ?? 'GET';
        const body = input.body as string | undefined;
        const headers = (input.headers as Record<string, string> | undefined) ?? {};

        const resp = await fetch(url, { method, headers, body: body ?? undefined });
        const text = await resp.text();
        return { status: resp.status, body: text };
      }

      case 'download_file': {
        const url = input.url as string;
        const dest = input.dest as string;
        const resp = await fetch(url, { redirect: 'follow' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} downloading ${url}`);
        const buf = await resp.arrayBuffer();
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(buf));
        return `Downloaded ${buf.byteLength} bytes to ${dest}`;
      }

      case 'list_dir': {
        const dirPath = input.path as string;
        if (!fs.existsSync(dirPath)) throw new Error(`Not found: ${dirPath}`);
        return fs.readdirSync(dirPath).reduce<{ name: string; type: string; size: number }[]>((acc, name) => {
          try {
            const stat = fs.statSync(path.join(dirPath, name));
            acc.push({ name, type: stat.isDirectory() ? 'dir' : 'file', size: stat.size });
          } catch {
            // File removed between readdirSync and statSync — skip it
          }
          return acc;
        }, []);
      }

      case 'check_process': {
        const port = input.port as number;
        return { port, listening: await checkPort(port) };
      }

      case 'install_skill': {
        if (!this.installSkill) throw new Error('Skill installation not available');
        const overwrite = (input.overwrite as boolean | undefined) ?? false;
        const result = await this.installSkill(input.path as string, overwrite);
        if (result.error) throw new Error(result.error);
        return `Skill "${result.name}" installed successfully.`;
      }

      default:
        throw new Error(`Unknown built-in tool: ${toolName}`);
    }
  }

  /** Send a message and get a response. Manages history buffer (trim + persist). */
  async chat(userMessage: string): Promise<string> {
    if (this.isRunning) throw new Error('Agent busy');
    this.isRunning = true;
    const myGen = ++this.gen;
    try {
      // Persist user message first
      const userMsg: NormalizedMessage = { role: 'user', content: userMessage };
      this.historyMemory.append(userMsg);

      // Build trimmed context snapshot for LLM (includes the user message just appended)
      const context = trimToLimit([...this.historyMemory.getBuffer()]);

      return await this._loop(context, userMessage);
    } finally {
      // Only clear if we're still the active generation (HTTP timeout may have orphaned us)
      if (this.gen === myGen) this.isRunning = false;
    }
  }

  /**
   * Agentic loop. Runs LLM → tool → LLM until end_turn or MAX_ITERATIONS.
   *
   * Error reflection: when a tool fails, inject a reflection message into the
   * in-flight context (not persisted to history.jsonl). After MAX_REFLECTION_RETRIES,
   * surface the error to the user.
   */
  private async _loop(context: NormalizedMessage[], userContext: string): Promise<string> {
    const systemPrompt = this.buildSystemPrompt();
    const tools = this.buildTools();

    let inflightMessages = [...context];
    let reflectionsThisMessage = 0;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      console.error(`[AgentCore] iteration ${i + 1}`);

      const response = await this.provider.chat({
        system: systemPrompt,
        tools,
        messages: inflightMessages,
        maxTokens: MAX_TOKENS,
      });

      if (response.stopReason === 'end_turn') {
        const text = extractText(response.content);
        this.historyMemory.append({ role: 'assistant', content: response.content });
        return text;
      }

      if (response.stopReason === 'tool_use') {
        const assistantMsg: NormalizedMessage = { role: 'assistant', content: response.content };
        const toolResults: Extract<NormalizedContentBlock, { type: 'tool_result' }>[] = [];
        const errors: Array<{ toolName: string; errorMsg: string }> = [];

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;

          const toolName = block.name;
          const toolInput = block.input as Record<string, unknown>;
          console.error(`[AgentCore] tool: ${toolName}`);

          let resultStr: string;
          let isError = false;

          try {
            const skill = this.skillRegistry.get(toolName);
            let result: unknown;
            if (skill) {
              result = await skill.execute(toolName, toolInput, { agentName: this.agentName });
            } else {
              result = await this.executeBuiltin(toolName, toolInput);
            }
            resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            console.error(`[AgentCore] ${toolName} ok`);
          } catch (err) {
            const errorMsg = (err as Error).message;
            resultStr = `Error: ${errorMsg}`;
            isError = true;
            errors.push({ toolName, errorMsg });
            console.error(`[AgentCore] ${toolName} failed: ${errorMsg}`);

            this.errorMemory.append({
              tool: toolName,
              input: toolInput,
              error: errorMsg,
              context: userContext.slice(0, 100),
            });
          }

          if (resultStr.length > MAX_TOOL_RESULT_CHARS) {
            resultStr = resultStr.slice(0, MAX_TOOL_RESULT_CHARS) + '\n...[truncated]';
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: resultStr,
            is_error: isError,
          });
        }

        const toolResultMsg: NormalizedMessage = { role: 'user', content: toolResults };

        if (errors.length > 0 && reflectionsThisMessage < MAX_REFLECTION_RETRIES) {
          // Reflect: inject in-flight only, do NOT persist
          reflectionsThisMessage++;
          const { toolName, errorMsg } = errors[0];
          const reflectionMsg: NormalizedMessage = {
            role: 'user',
            content: `Your last tool call \`${toolName}\` failed: \`${errorMsg}\`. Reflect on why this failed and try a different approach.`,
          };
          inflightMessages.push(assistantMsg, toolResultMsg, reflectionMsg);
          console.error(`[AgentCore] Reflection ${reflectionsThisMessage}/${MAX_REFLECTION_RETRIES}`);
          continue;
        }

        // No errors OR max retries reached — persist and continue (or surface error)
        inflightMessages.push(assistantMsg, toolResultMsg);
        this.historyMemory.append(assistantMsg);
        this.historyMemory.append(toolResultMsg);

        if (errors.length > 0) {
          // Max retries exhausted — surface to user
          return `Tool \`${errors[0].toolName}\` failed after ${MAX_REFLECTION_RETRIES} retries: ${errors[0].errorMsg}`;
        }
        continue;
      }

      // Unexpected stop reason
      const text = extractText(response.content);
      this.historyMemory.append({ role: 'assistant', content: response.content });
      return text || `[Agent stopped: ${response.stopReason}]`;
    }

    return '[Agent reached maximum iteration limit]';
  }

  getLoadedSkills(): Array<{ name: string; version: string; tools: string[] }> {
    const seen = new Set<string>();
    const result: Array<{ name: string; version: string; tools: string[] }> = [];
    for (const skill of this.skillRegistry.values()) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        result.push({ name: skill.name, version: skill.version, tools: skill.tools.map(t => t.name) });
      }
    }
    return result;
  }

  getStartTime(): number {
    return startTime;
  }
}

const startTime = Date.now();

function extractText(content: NormalizedContentBlock[]): string {
  return content
    .filter((b): b is Extract<NormalizedContentBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('');
}

/**
 * Trim history to MAX_HISTORY_MESSAGES, cutting from the front.
 * Never leaves a tool_result-only message at the start — trims until a
 * plain user text message is first.
 */
function trimToLimit(messages: NormalizedMessage[]): NormalizedMessage[] {
  while (messages.length > MAX_HISTORY_MESSAGES) {
    messages.shift();
    while (messages.length > 0) {
      const first = messages[0];
      if (first.role === 'user' && typeof first.content === 'string') break;
      messages.shift();
    }
  }
  return messages;
}

function checkPort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}
