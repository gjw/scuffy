/**
 * Scuffy — autonomous coding agent.
 *
 * Entry point. Will wire up the tool registry, middleware stack, and REPL.
 * Currently a stub that verifies the config loads correctly.
 */

import { loadConfig } from "./config.js";

function main(): void {
  try {
    const config = loadConfig();
    console.log(`Scuffy agent initialized (model: ${config.model})`);
    console.log(`Working directory: ${config.workingDir}`);
  } catch (err: unknown) {
    console.error("Failed to initialize:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
