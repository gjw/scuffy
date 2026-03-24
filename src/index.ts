/**
 * Scuffy — autonomous coding agent.
 *
 * Entry point. Wires up the tool registry, middleware stack, and REPL.
 */

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";

/** Load .env file into process.env. Does not override existing vars. */
function loadDotenv(dir: string): void {
  try {
    const content = readFileSync(path.join(dir, ".env"), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env file — that's fine, rely on environment
  }
}

loadDotenv(process.cwd());
import type { Middleware } from "./agent/middleware.js";
import { ToolRegistry } from "./tools/registry.js";
import { thinkTool } from "./tools/think.js";
import { listDirTool } from "./tools/listDir.js";
import { readFileTool } from "./tools/readFile.js";
import { editFileTool } from "./tools/editFile.js";
import { writeFileTool } from "./tools/writeFile.js";
import { globTool } from "./tools/glob.js";
import { grepTool } from "./tools/grep.js";
import { bashTool } from "./tools/bash.js";
import { createTaskTool } from "./tools/task.js";
import { finishBeadTool } from "./tools/finishBead.js";
import { escalateTool } from "./tools/escalate.js";
import { startRepl } from "./cli/repl.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Register available tools
  const registry = new ToolRegistry();
  registry.register(thinkTool);
  registry.register(listDirTool);
  registry.register(readFileTool);
  registry.register(editFileTool);
  registry.register(writeFileTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(bashTool);
  registry.register(createTaskTool(registry, config));
  registry.register(finishBeadTool);
  registry.register(escalateTool);

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
