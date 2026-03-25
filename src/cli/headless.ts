import crypto from "node:crypto";
import path from "node:path";
import type { AgentConfig } from "../config.js";
import { runAgentLoop } from "../agent/loop.js";
import type { Middleware } from "../agent/middleware.js";
import type { Session } from "../agent/types.js";
import { SessionLogger } from "../logging/session.js";
import { createLoggingMiddleware } from "../logging/loggingMiddleware.js";
import { createTimeAwarenessMiddleware } from "../logging/timeAwarenessMiddleware.js";
import type { LLMProvider } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";

/**
 * Headless mode — runs a single agent loop with one instruction, then exits.
 * Exit code comes from the agent's exit-signaling tools (finishBead → 0, escalate → 1).
 */
export async function runHeadless(
  registry: ToolRegistry,
  middleware: Middleware[],
  config: AgentConfig,
  provider: LLMProvider,
  instruction: string,
  notifyHuman?: (message: string) => Promise<void>,
  recordOutcome?: (status: "success" | "failure" | "partial", rules: string) => Promise<void>,
): Promise<void> {
  const sessionId = crypto.randomUUID();
  const session: Session = {
    id: sessionId,
    startedAt: new Date(),
    messages: [],
    fileReadTimestamps: new Map(),
    claimedBeadId: null,
    logFile: path.join(config.workingDir, ".scuffy", "sessions", `${sessionId}.jsonl`),
  };

  const logger = new SessionLogger(session.logFile);
  const loggingMw = createLoggingMiddleware(logger);
  const timeAwarenessMw = createTimeAwarenessMiddleware(session);

  // Logging first (Invariant 5), then time awareness, then user-provided middleware
  const allMiddleware: Middleware[] = [loggingMw, timeAwarenessMw, ...middleware];

  logger.log({
    type: "session_start",
    sessionId,
    timestamp: new Date().toISOString(),
    instruction,
  });

  const startTime = Date.now();

  console.log(`Scuffy headless — session ${sessionId}`);
  console.log(`Working directory: ${config.workingDir}`);

  const result = await runAgentLoop(instruction, session, registry, allMiddleware, config, {
    provider,
    logger,
    notifyHuman,
    recordOutcome,
  });

  console.log(`\n${result.response}`);
  console.log(
    `[tokens: ${String(result.tokensUsed.in)}in/${String(result.tokensUsed.out)}out, cache: ${String(result.tokensUsed.cacheRead)}r/${String(result.tokensUsed.cacheWrite)}w, tools: ${String(result.toolCallCount)}, time: ${String(result.durationMs)}ms]`,
  );

  logger.log({
    type: "session_end",
    timestamp: new Date().toISOString(),
    totalTokens: result.tokensUsed,
    durationMs: Date.now() - startTime,
  });
  logger.close();

  process.exit(result.exitCode ?? 0);
}
