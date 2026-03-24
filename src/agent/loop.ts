import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig } from "../config.js";
import type { SessionLogger } from "../logging/session.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolCall, ToolContext, ToolResult } from "../tools/types.js";
import { buildSystemPrompt, buildUserMessage } from "./context.js";
import {
  applyAfterLLMResponse,
  applyAfterToolResult,
  applyBeforeLLMCall,
  applyBeforeToolCall,
  type Middleware,
} from "./middleware.js";
import type { AgentResult, ContextInjection, Session } from "./types.js";

/**
 * Core agent loop: assemble messages → call Claude → execute tool calls → repeat.
 * Terminates when the LLM produces a text response or maxIterations is reached.
 */
export async function runAgentLoop(
  instruction: string,
  session: Session,
  registry: ToolRegistry,
  middleware: Middleware[],
  config: AgentConfig,
  options?: {
    injections?: ContextInjection[] | undefined;
    client?: Anthropic | undefined;
    logger?: SessionLogger | undefined;
  },
): Promise<AgentResult> {
  const startTime = Date.now();
  const client = options?.client ?? new Anthropic({ apiKey: config.apiKey });
  const anthropicTools = registry.toAnthropicTools();
  const logger = options?.logger;

  const tokensUsed = { in: 0, out: 0 };
  let toolCallCount = 0;

  // Build the initial user message with context injections
  const userContent = buildUserMessage(instruction, options?.injections);
  session.messages.push({ role: "user", content: userContent });

  for (let iteration = 0; iteration < config.maxIterations; iteration++) {
    const baseSystemPrompt = buildSystemPrompt(config);

    // Apply beforeLLMCall middleware (can modify messages and system prompt)
    const llmCtx = applyBeforeLLMCall(middleware, {
      messages: session.messages,
      systemPrompt: baseSystemPrompt,
      config,
    });

    // Call Claude API
    const createParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: config.model,
      max_tokens: config.maxTokens,
      system: llmCtx.systemPrompt,
      messages: llmCtx.messages,
    };
    if (anthropicTools.length > 0) {
      createParams.tools = anthropicTools;
    }
    const rawResponse = await client.messages.create(createParams);

    // Apply afterLLMResponse middleware
    const response = applyAfterLLMResponse(middleware, rawResponse);

    // Accumulate token usage
    tokensUsed.in += response.usage.input_tokens;
    tokensUsed.out += response.usage.output_tokens;

    // Append assistant message to history
    session.messages.push({ role: "assistant", content: response.content });

    // If the LLM is done (text response), extract and return
    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === "text",
      );
      const responseText = textBlocks.map((b) => b.text).join("\n");

      return {
        response: responseText,
        tokensUsed,
        toolCallCount,
        durationMs: Date.now() - startTime,
      };
    }

    // If the LLM wants to use tools, execute them
    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        toolCallCount++;

        let call: ToolCall = {
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        };

        // Apply beforeToolCall middleware
        call = applyBeforeToolCall(middleware, call);

        // Execute the tool
        let result = await executeTool(call, registry, session, config, logger);

        // Apply afterToolResult middleware
        result = applyAfterToolResult(middleware, call, result);

        // Check for exit signal from tools like finishBead/escalate
        if (result.metadata?.["exit"] === true) {
          const exitCode =
            typeof result.metadata["exitCode"] === "number" ? result.metadata["exitCode"] : 0;
          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: result.content,
            is_error: false,
          });
          session.messages.push({ role: "user", content: toolResults });
          return {
            response: result.content,
            tokensUsed,
            toolCallCount,
            durationMs: Date.now() - startTime,
            exitCode,
          };
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: result.content,
          is_error: result.isError ?? false,
        });
      }

      // Append tool results as a user message
      session.messages.push({ role: "user", content: toolResults });

      continue;
    }

    // Unknown stop reason — break out
    break;
  }

  // maxIterations exceeded or unexpected stop
  return {
    response: "Error: agent loop exceeded maximum iterations or encountered an unexpected state.",
    tokensUsed,
    toolCallCount,
    durationMs: Date.now() - startTime,
  };
}

/** Execute a single tool call. Catches all errors and returns them as ToolResult. */
async function executeTool(
  call: ToolCall,
  registry: ToolRegistry,
  session: Session,
  config: AgentConfig,
  logger?: SessionLogger,
): Promise<ToolResult> {
  const tool = registry.get(call.name);
  if (!tool) {
    return {
      content: `Error: unknown tool "${call.name}". Available tools: ${registry
        .getAll()
        .map((t) => t.name)
        .join(", ")}`,
      isError: true,
    };
  }

  // Validate parameters with Zod
  const parseResult = tool.parameters.safeParse(call.input);
  if (!parseResult.success) {
    return {
      content: `Error: invalid parameters for tool "${call.name}": ${parseResult.error.message}`,
      isError: true,
    };
  }

  const ctx: ToolContext = {
    sessionId: session.id,
    workingDir: config.workingDir,
    fileReadTimestamps: session.fileReadTimestamps,
    log: logger
      ? (event) => {
          logger.log(event);
        }
      : () => {
          /* noop when no logger */
        },
  };

  try {
    return await tool.execute(parseResult.data as never, ctx);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Error executing tool "${call.name}": ${message}`,
      isError: true,
    };
  }
}
