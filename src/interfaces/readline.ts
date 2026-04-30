import readline from 'readline';
import type { AgentCore } from '../agent/core.js';

export function startREPL(agent: AgentCore, agentName: string): void {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  agent.currentInterface = 'repl';

  // Gate shell_exec with stdin confirmation
  agent.confirmShellExec = (command: string, cwd: string) => new Promise(resolve => {
    rl.question(
      `About to run: \`${command}\` in \`${cwd}\`. Confirm? (yes/no) `,
      answer => resolve(answer.trim() === 'yes'),
    );
  });

  const prompt = () => process.stdout.write(`${agentName}> `);

  prompt();

  rl.on('line', async (line) => {
    const message = line.trim();
    if (!message) { prompt(); return; }

    process.stdout.write('[thinking...]\n');
    try {
      const response = await agent.chat(message);
      process.stdout.write(`${agentName}: ${response}\n`);
    } catch (err) {
      process.stdout.write(`[error] ${(err as Error).message}\n`);
    }
    prompt();
  });

  rl.on('close', () => {
    console.log('\nGoodbye.');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    rl.close();
  });
}
