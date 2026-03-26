import { execFileSync } from "node:child_process";
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

  // Query CASS for relevant lessons from prior sessions
  let cassInstruction = instruction;
  try {
    const taskDesc = instruction.slice(0, 200);
    const cassOut = execFileSync(
      "/bin/sh",
      ["-c", `cm context ${JSON.stringify(taskDesc)} --workspace ${JSON.stringify(config.workingDir)} --json 2>/dev/null`],
      { timeout: 10_000, encoding: "utf-8" },
    );
    const parsed: unknown = JSON.parse(cassOut);
    if (typeof parsed === "object" && parsed !== null && "data" in parsed) {
      const data = (parsed as Record<string, unknown>)["data"];
      if (typeof data === "object" && data !== null && "relevantBullets" in data) {
        const bullets = (data as Record<string, unknown>)["relevantBullets"];
        if (Array.isArray(bullets) && bullets.length > 0) {
          const MAX_LESSONS = 3;
          const selected = bullets.slice(0, MAX_LESSONS);
          const lessons = selected
            .map((b: unknown) => {
              if (typeof b === "object" && b !== null && "content" in b) {
                return `- ${String((b as Record<string, unknown>)["content"])}`;
              }
              return null;
            })
            .filter(Boolean)
            .join("\n");
          if (lessons.length > 0) {
            cassInstruction = `${instruction}\n\n## Lessons from prior sessions (CASS)\n\n${lessons}`;
            console.log(`[CASS: injected ${String(selected.length)} of ${String(bullets.length)} lesson(s)]`);
          }
        }
      }
    }
  } catch {
    // cm not available or no lessons — continue without
  }

  const result = await runAgentLoop(cassInstruction, session, registry, allMiddleware, config, {
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

  // Record session outcome to CASS (all roles, all exit codes)
  try {
    const outcomeStatus = result.exitCode === 0 ? "success" : result.exitCode === 2 ? "partial" : "failure";
    const outcomeText = result.response.slice(0, 300);
    execFileSync(
      "/bin/sh",
      ["-c", `cm outcome ${outcomeStatus} "" --text ${JSON.stringify(outcomeText)} --duration ${String(Math.round((Date.now() - startTime) / 1000))} 2>/dev/null`],
      { cwd: config.workingDir, timeout: 10_000 },
    );
  } catch {
    // cm not available — continue
  }

  // Commit WIP on non-zero exit (budget exceeded, escalation without escalate tool).
  // Escalate tool already commits, but budget guard and crashes don't.
  // Without this, dirty uncommitted files contaminate the next session.
  if (result.exitCode && result.exitCode !== 0) {
    try {
      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd: config.workingDir, encoding: "utf-8", timeout: 10_000,
      }).trim();
      if (status.length > 0) {
        const msg = `WIP: session ended with exit ${String(result.exitCode)}`;
        execFileSync("git", ["add", "-A"], { cwd: config.workingDir, timeout: 10_000 });
        execFileSync("git", ["commit", "-m", msg, "--no-verify"], { cwd: config.workingDir, timeout: 10_000 });
        console.log(`[committed WIP: ${msg}]`);
      }
    } catch {
      // Git commit failed — nothing we can do, move on
    }
  }

  process.exit(result.exitCode ?? 0);
}
