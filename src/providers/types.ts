/** Normalized tool definition — adapters translate to provider format */
export interface NormalizedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Normalized content blocks — provider-agnostic, Anthropic-layout */
export type NormalizedContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface NormalizedMessage {
  role: 'user' | 'assistant';
  content: string | NormalizedContentBlock[];
}

export interface LLMResponse {
  stopReason: 'end_turn' | 'tool_use' | 'other';
  content: NormalizedContentBlock[];
}

export interface LLMProvider {
  chat(params: {
    system: string;
    tools: NormalizedTool[];
    messages: NormalizedMessage[];
    maxTokens: number;
  }): Promise<LLMResponse>;
}
