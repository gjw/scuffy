import type Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig } from "../config.js";
import type { ToolCall, ToolResult } from "../tools/types.js";

/**
 * Middleware wraps the agent loop. Each middleware can act before/after
 * LLM calls and before/after tool executions.
 *
 * All hooks are optional. Pipeline runs in registration order.
 * Invariant 5: Middleware ordering is explicit.
 */
export interface Middleware {
  name: string;
  beforeLLMCall?(messages: Anthropic.MessageParam[], config: AgentConfig): Anthropic.MessageParam[];
  afterLLMResponse?(response: Anthropic.Message): Anthropic.Message;
  beforeToolCall?(call: ToolCall): ToolCall;
  afterToolResult?(call: ToolCall, result: ToolResult): ToolResult;
}

/** Run a middleware hook across all middleware in order. */
export function applyBeforeLLMCall(
  middleware: Middleware[],
  messages: Anthropic.MessageParam[],
  config: AgentConfig,
): Anthropic.MessageParam[] {
  let result = messages;
  for (const mw of middleware) {
    if (mw.beforeLLMCall) {
      result = mw.beforeLLMCall(result, config);
    }
  }
  return result;
}

export function applyAfterLLMResponse(
  middleware: Middleware[],
  response: Anthropic.Message,
): Anthropic.Message {
  let result = response;
  for (const mw of middleware) {
    if (mw.afterLLMResponse) {
      result = mw.afterLLMResponse(result);
    }
  }
  return result;
}

export function applyBeforeToolCall(middleware: Middleware[], call: ToolCall): ToolCall {
  let result = call;
  for (const mw of middleware) {
    if (mw.beforeToolCall) {
      result = mw.beforeToolCall(result);
    }
  }
  return result;
}

export function applyAfterToolResult(
  middleware: Middleware[],
  call: ToolCall,
  toolResult: ToolResult,
): ToolResult {
  let result = toolResult;
  for (const mw of middleware) {
    if (mw.afterToolResult) {
      result = mw.afterToolResult(call, result);
    }
  }
  return result;
}
