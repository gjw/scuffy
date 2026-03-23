/**
 * Scuffy — autonomous coding agent.
 *
 * Entry point. Wires up the tool registry, middleware stack, and REPL.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import type { Middleware } from "./agent/middleware.js";
import { ToolRegistry } from "./tools/registry.js";
import { thinkTool } from "./tools/think.js";
import { listDirTool } from "./tools/listDir.js";
import { startRepl } from "./cli/repl.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Register available tools
  const registry = new ToolRegistry();
  registry.register(thinkTool);
  registry.register(listDirTool);

  // Middleware stack (empty until logging middleware is implemented)
  const middleware: Middleware[] = [];

  // Ensure sessions directory exists
  await mkdir(path.join(config.workingDir, ".scuffy", "sessions"), { recursive: true });

  console.log(`Scuffy agent (${config.model})`);
  console.log(`Working directory: ${config.workingDir}`);
  await startRepl(registry, middleware, config);
}

main().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
