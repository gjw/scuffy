import type Anthropic from "@anthropic-ai/sdk";
import type { LLMCallContext, Middleware } from "../agent/middleware.js";
import type { ToolCall, ToolResult } from "../tools/types.js";
import type { SessionLogger } from "./session.js";
import type { ToolCallSummary } from "./types.js";

/**
 * Logging middleware — records every LLM call, tool call, and tool result
 * to the session JSONL log. Must be first in the middleware pipeline
 * (Invariant 5) so it sees all events.
 */
export function createLoggingMiddleware(logger: SessionLogger): Middleware {
  let llmCallStart = 0;
  const toolCallStarts = new Map<string, number>();

  return {
    name: "logging",

    beforeLLMCall(ctx: LLMCallContext): LLMCallContext {
      llmCallStart = Date.now();
      logger.log({
        type: "llm_request",
        timestamp: new Date().toISOString(),
        messageCount: ctx.messages.length,
        model: ctx.config.model,
      });
      return ctx;
    },

    afterLLMResponse(response: Anthropic.Message): Anthropic.Message {
      const durationMs = Date.now() - llmCallStart;

      const textContent = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      const toolCalls: ToolCallSummary[] = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, tool: b.name, input: b.input }));

      logger.log({
        type: "llm_response",
        timestamp: new Date().toISOString(),
        content: textContent,
        toolCalls,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
        durationMs,
      });

      return response;
    },

    beforeToolCall(call: ToolCall): ToolCall {
      toolCallStarts.set(call.id, Date.now());
      logger.log({
        type: "tool_call",
        timestamp: new Date().toISOString(),
        tool: call.name,
        input: call.input,
        callId: call.id,
      });
      return call;
    },

    afterToolResult(call: ToolCall, result: ToolResult): ToolResult {
      const start = toolCallStarts.get(call.id) ?? Date.now();
      toolCallStarts.delete(call.id);

      logger.log({
        type: "tool_result",
        timestamp: new Date().toISOString(),
        callId: call.id,
        output: result.content,
        isError: result.isError ?? false,
        durationMs: Date.now() - start,
        metadata: result.metadata,
      });

      return result;
    },
  };
}
