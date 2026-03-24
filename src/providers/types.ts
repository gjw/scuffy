/**
 * Provider-agnostic LLM types.
 *
 * The agent loop, middleware, and session all work with these types.
 * Provider implementations translate to/from SDK-specific types internally.
 */

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
};
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type LLMMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

export interface LLMToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LLMResponse {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: { inputTokens: number; outputTokens: number };
}

export interface LLMProvider {
  createCompletion(params: {
    model: string;
    maxTokens: number;
    system: string;
    messages: LLMMessage[];
    tools?: LLMToolDef[];
  }): Promise<LLMResponse>;
}
