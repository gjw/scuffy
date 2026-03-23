import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { AgentConfig } from "../config.js";
import { runAgentLoop } from "../agent/loop.js";
import { createLoggingMiddleware } from "../logging/loggingMiddleware.js";
import { SessionLogger } from "../logging/session.js";
import { createTimeAwarenessMiddleware } from "../logging/timeAwarenessMiddleware.js";
import type { Session } from "../agent/types.js";
import type { ToolRegistry } from "./registry.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const parameters = z.object({
  name: z.string().describe("Short descriptive name for the subagent task."),
  prompt: z
    .string()
    .describe(
      "The instruction for the subagent. Be specific — the subagent starts with " +
        "no message history and must understand the full task from this prompt alone.",
    ),
});

/**
 * Factory that creates the task tool. Captures registry and config so the
 * subagent can invoke the same tools and reach the same API. Register this
 * after all other tools so the subagent inherits the full registry.
 */
export function createTaskTool(
  registry: ToolRegistry,
  config: AgentConfig,
): Tool<typeof parameters> {
  return {
    name: "task",
    description:
      "Spawn an ephemeral subagent to handle a subtask. The subagent has access to " +
      "all registered tools but runs with its own isolated message history. Use this " +
      "to parallelize independent work or delegate focused subtasks. Multiple task " +
      "calls in a single response run in parallel. Returns the subagent's final response.",
    parameters,

    async execute(params: z.infer<typeof parameters>, _ctx: ToolContext): Promise<ToolResult> {
      const subSessionId = crypto.randomUUID();
      const logFile = path.join(
        config.workingDir,
        ".scuffy",
        "sessions",
        `sub-${subSessionId}.jsonl`,
      );

      const session: Session = {
        id: subSessionId,
        startedAt: new Date(),
        messages: [],
        fileReadTimestamps: new Map(),
        logFile,
      };

      const logger = new SessionLogger(logFile);
      const loggingMw = createLoggingMiddleware(logger);
      const timeAwarenessMw = createTimeAwarenessMiddleware(session);
      const middleware = [loggingMw, timeAwarenessMw];

      logger.log({
        type: "session_start",
        sessionId: subSessionId,
        timestamp: new Date().toISOString(),
        instruction: params.prompt,
      });

      try {
        const result = await runAgentLoop(params.prompt, session, registry, middleware, config, {
          logger,
        });

        logger.log({
          type: "session_end",
          timestamp: new Date().toISOString(),
          totalTokens: result.tokensUsed,
          durationMs: result.durationMs,
        });
        logger.close();

        return {
          content: result.response,
          metadata: {
            subSessionId,
            name: params.name,
            tokensUsed: result.tokensUsed,
            toolCallCount: result.toolCallCount,
            durationMs: result.durationMs,
          },
        };
      } catch (err: unknown) {
        logger.close();
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Subagent "${params.name}" failed: ${message}`,
          isError: true,
        };
      }
    },
  };
}
