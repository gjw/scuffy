import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import crypto from "node:crypto";
import path from "node:path";
import type { AgentConfig } from "../config.js";
import { runAgentLoop } from "../agent/loop.js";
import type { Middleware } from "../agent/middleware.js";
import type { Session } from "../agent/types.js";
import type { ToolRegistry } from "../tools/registry.js";

/**
 * Persistent REPL loop. Accepts user instructions, runs them through
 * the agent loop, and displays results. Session persists across
 * multiple instructions without restart.
 */
export async function startRepl(
  registry: ToolRegistry,
  middleware: Middleware[],
  config: AgentConfig,
): Promise<void> {
  const sessionId = crypto.randomUUID();
  const session: Session = {
    id: sessionId,
    startedAt: new Date(),
    messages: [],
    fileReadTimestamps: new Map(),
    logFile: path.join(config.workingDir, ".scuffy", "sessions", `${sessionId}.jsonl`),
  };

  const rl = readline.createInterface({ input: stdin, output: stdout });

  // Clean exit on Ctrl+C
  process.on("SIGINT", () => {
    console.log("\nExiting.");
    rl.close();
    process.exit(0);
  });

  console.log(`Session: ${sessionId}\n`);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- REPL runs until interrupt
  while (true) {
    let line: string;
    try {
      line = await rl.question("scuffy> ");
    } catch {
      // readline closed (Ctrl+D)
      break;
    }

    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (trimmed === "exit" || trimmed === "quit") {
      break;
    }

    try {
      const result = await runAgentLoop(trimmed, session, registry, middleware, config);
      console.log(`\n${result.response}\n`);
      console.log(
        `[tokens: ${String(result.tokensUsed.in)}/${String(result.tokensUsed.out)}, tools: ${String(result.toolCallCount)}, time: ${String(result.durationMs)}ms]\n`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\nError: ${message}\n`);
    }
  }

  console.log("Goodbye.");
  rl.close();
}
