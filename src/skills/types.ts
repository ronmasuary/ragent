import type { NormalizedTool } from '../providers/types.js';

export type { NormalizedTool };

export interface SkillContext {
  agentName: string;
}

export interface Skill {
  name: string;
  version: string;
  tools: NormalizedTool[];
  execute(toolName: string, input: Record<string, unknown>, ctx: SkillContext): Promise<unknown>;
  systemPrompt?: string;
}
