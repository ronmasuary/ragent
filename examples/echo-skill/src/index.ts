/**
 * Echo skill — minimal example showing the Ragent skill interface.
 *
 * To install: copy this directory into skills/
 *   cp -r examples/echo-skill skills/
 *
 * The agent hot-loads it automatically (chokidar watches skills/).
 */

import type { Skill, SkillContext } from '../../../src/skills/types.js';

const skill: Skill = {
  name: 'echo',
  version: '1.0.0',

  // Tools exposed to the LLM. Each tool needs: name, description, inputSchema.
  tools: [
    {
      name: 'echo',
      description: 'Echoes back the message you send it. Useful for testing skill installation.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message: {
            type: 'string',
            description: 'The message to echo back',
          },
        },
        required: ['message'],
      },
    },
  ],

  // Called by AgentCore when the LLM decides to use one of this skill's tools.
  async execute(toolName: string, input: unknown, _ctx: SkillContext): Promise<unknown> {
    if (toolName === 'echo') {
      const { message } = input as { message: string };
      return { echoed: message };
    }
    throw new Error(`Unknown tool: ${toolName}`);
  },

  // Optional: extra instructions injected into the agent's system prompt.
  systemPrompt: 'You have access to an echo tool for testing purposes.',
};

export default skill;
