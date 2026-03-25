import type { AgentConfig } from "../config.js";
import type { SessionLogger } from "../logging/session.js";
import type { LLMProvider, TextBlock, ToolUseBlock } from "../providers/types.js";
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
 * Core agent loop: assemble messages → call LLM → execute tool calls → repeat.
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
    provider?: LLMProvider | undefined;
    logger?: SessionLogger | undefined;
    notifyHuman?: ((message: string) => Promise<void>) | undefined;
    recordOutcome?: ((status: "success" | "failure" | "partial", rules: string) => Promise<void>) | undefined;
  },
): Promise<AgentResult> {
  const startTime = Date.now();
  if (!options?.provider) {
    throw new Error("LLMProvider is required — pass it in options.provider");
  }
  const provider = options.provider;
  const toolDefs = registry.toToolDefs();
  const logger = options.logger;

  const tokensUsed = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  let toolCallCount = 0;

  // Build the initial user message with context injections
  const userContent = buildUserMessage(instruction, options.injections);
  session.messages.push({ role: "user", content: userContent });

  for (let iteration = 0; iteration < config.maxIterations; iteration++) {
    const baseSystemPrompt = buildSystemPrompt(config);

    // Apply beforeLLMCall middleware (can modify messages and system prompt)
    const llmCtx = applyBeforeLLMCall(middleware, {
      messages: session.messages,
      systemPrompt: baseSystemPrompt,
      config,
    });

    // Call LLM via provider
    const completionParams: Parameters<LLMProvider["createCompletion"]>[0] = {
      model: config.model,
      maxTokens: config.maxTokens,
      system: llmCtx.systemPrompt,
      messages: llmCtx.messages,
    };
    if (toolDefs.length > 0) {
      completionParams.tools = toolDefs;
    }
    const rawResponse = await provider.createCompletion(completionParams);

    // Apply afterLLMResponse middleware
    const response = applyAfterLLMResponse(middleware, rawResponse);

    // Accumulate token usage
    tokensUsed.in += response.usage.inputTokens;
    tokensUsed.out += response.usage.outputTokens;
    tokensUsed.cacheRead += response.usage.cacheReadTokens;
    tokensUsed.cacheWrite += response.usage.cacheWriteTokens;

    // Token budget guard: auto-escalate before hitting provider limit
    if (tokensUsed.in >= config.tokenBudget) {
      session.messages.push({ role: "assistant", content: response.content });
      return {
        response:
          `Token budget exceeded (${String(tokensUsed.in)} input tokens vs ${String(config.tokenBudget)} budget). ` +
          `Auto-escalating to prevent provider limit crash.`,
        tokensUsed,
        toolCallCount,
        durationMs: Date.now() - startTime,
        exitCode: 1,
      };
    }

    // Append assistant message to history
    session.messages.push({ role: "assistant", content: response.content });

    // If the LLM is done (text response), extract and return
    if (response.stopReason === "end_turn" || response.stopReason === "max_tokens") {
      const textBlocks = response.content.filter(
        (block): block is TextBlock => block.type === "text",
      );
      const responseText = textBlocks.map((b) => b.text).join("\n");

      return {
        response: responseText,
        tokensUsed,
        toolCallCount,
        durationMs: Date.now() - startTime,
      };
    }

    // LLM wants to use tools — execute them
    {
      const toolUseBlocks = response.content.filter(
        (block): block is ToolUseBlock => block.type === "tool_use",
      );

      const toolResults: Array<{
        type: "tool_result";
        tool_use_id: string;
        content: string;
        is_error: boolean;
      }> = [];

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
        let result = await executeTool(call, registry, session, config, logger, options.notifyHuman, options.recordOutcome);

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
    }
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
  notifyHuman?: (message: string) => Promise<void>,
  recordOutcome?: (status: "success" | "failure" | "partial", rules: string) => Promise<void>,
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
    getClaimedBeadId: () => session.claimedBeadId,
    setClaimedBeadId: (id: string | null) => {
      session.claimedBeadId = id;
    },
    notifyHuman: notifyHuman ?? (async () => {}),
    recordOutcome: recordOutcome ?? (async () => {}),
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
