/**
 * Scuffy — autonomous coding agent.
 *
 * Entry point. Wires up the tool registry, middleware stack, and routes
 * to either REPL mode or headless mode based on CLI flags.
 *
 * Usage:
 *   scuffy                                    # REPL mode
 *   scuffy --headless                         # Headless with default instruction
 *   scuffy --headless --role trench           # Headless with role-based prompt
 *   scuffy --headless --instruction "..."     # Headless with custom instruction
 *   scuffy --headless --workdir path/to/dir   # Headless in a specific workspace
 */

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig, type AgentConfig } from "./config.js";

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
import { claimBeadTool } from "./tools/claimBead.js";
import { createBeadTool } from "./tools/createBead.js";
import { closeBeadTool } from "./tools/closeBead.js";
import { flagForChairTool } from "./tools/flagForChair.js";
import { readReferenceTool } from "./tools/readReference.js";
import { connectMcpServers, disconnectAll } from "./mcp/client.js";
import { bridgeMcpTools } from "./mcp/bridge.js";
import { createNotifyHuman } from "./mcp/notify.js";
import { createRecordOutcome } from "./mcp/cass.js";
import { startRepl } from "./cli/repl.js";
import { runHeadless } from "./cli/headless.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import type { LLMProvider } from "./providers/types.js";
import { isValidRole, getRoleConfig, loadRolePrompt, type RoleName } from "./roles.js";

const HEADLESS_SYSTEM_PROMPT = `You are Scuffy, an autonomous coding agent running in headless mode.
You have one job per session: claim a bead, implement it, and exit.

## Memory (if available)

If the mcp_cass_cm_context tool is available, call it FIRST with a brief description
of your task to retrieve lessons from prior sessions. Apply those lessons to your work.
If the tool is not available, skip this step.

## Workflow

1. Call the claimBead tool to get your assignment. It finds, filters, and claims the next actionable bead.
2. Read the bead description it returns for requirements and acceptance criteria.
3. Implement the task.
4. When done, call the finishBead tool. If stuck or blocked, call the escalate tool.

Do NOT claim beads via bash. Do NOT run br update, br close, or bv commands directly.
The claimBead, finishBead, and escalate tools handle all bead lifecycle operations.
Do not ask questions — decide and act.`;

const DEFAULT_HEADLESS_INSTRUCTION =
  "Call claimBead to get your assignment, implement it, " +
  "then call finishBead when done. If stuck or blocked, call escalate.";

/** Parse CLI args. Returns flag values. */
function parseArgs(argv: string[]): {
  headless: boolean;
  workdir: string | undefined;
  instruction: string | undefined;
  role: string | undefined;
} {
  let headless = false;
  let workdir: string | undefined;
  let instruction: string | undefined;
  let role: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--headless") {
      headless = true;
    } else if (arg === "--workdir" && i + 1 < argv.length) {
      i++;
      workdir = argv[i];
    } else if (arg === "--instruction" && i + 1 < argv.length) {
      i++;
      instruction = argv[i];
    } else if (arg === "--role" && i + 1 < argv.length) {
      i++;
      role = argv[i];
    }
  }

  return { headless, workdir, instruction, role };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const overrides: Partial<AgentConfig> = {};
  if (args.workdir) overrides.workingDir = path.resolve(args.workdir);

  // Role-based configuration (--role flag overrides system prompt, agent name, model)
  let resolvedRole: RoleName | undefined;
  if (args.role) {
    if (!isValidRole(args.role)) {
      console.error(`Unknown role: ${args.role}. Valid roles: scout, trench, tower, warden-light, warden-dark`);
      process.exit(1);
    }
    resolvedRole = args.role;
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    const roleConfig = getRoleConfig(resolvedRole);
    overrides.systemPrompt = loadRolePrompt(resolvedRole, repoRoot);
    overrides.agentName = roleConfig.agentName;
    if (roleConfig.modelOverride) overrides.model = roleConfig.modelOverride;
  } else if (args.headless) {
    overrides.systemPrompt = HEADLESS_SYSTEM_PROMPT;
  }

  const config = loadConfig(overrides);

  // Create LLM provider (loadConfig validates the required key is present)
  let provider: LLMProvider;
  if (config.provider === "openai") {
    if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is required");
    provider = new OpenAIProvider(config.openaiApiKey);
  } else {
    if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required");
    provider = new AnthropicProvider(config.anthropicApiKey);
  }

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
  registry.register(createTaskTool(registry, config, provider));
  registry.register(claimBeadTool);
  registry.register(createBeadTool);
  registry.register(closeBeadTool);
  registry.register(flagForChairTool);
  registry.register(finishBeadTool);
  registry.register(escalateTool);
  registry.register(readReferenceTool);

  // Connect to configured MCP servers and register their tools
  const mcpServers = await connectMcpServers(config.mcpServers);
  for (const server of mcpServers) {
    const serverConfig = config.mcpServers.find((s) => s.name === server.name);
    const tools = await bridgeMcpTools(server.name, server.client, serverConfig?.tools);
    for (const tool of tools) {
      registry.register(tool);
    }
  }

  // Middleware stack (empty — logging/time-awareness created per-session in REPL/headless)
  const middleware: Middleware[] = [];

  // Ensure sessions directory exists
  await mkdir(path.join(config.workingDir, ".scuffy", "sessions"), { recursive: true });

  // Clean up MCP connections on exit
  if (mcpServers.length > 0) {
    process.on("exit", () => {
      void disconnectAll(mcpServers);
    });
  }

  // Create MCP callbacks (no-op when servers aren't connected)
  const notifyHuman = createNotifyHuman(mcpServers, config.workingDir, config.agentName);
  const recordOutcome = createRecordOutcome(mcpServers);

  if (args.headless) {
    const roleDefault = resolvedRole ? getRoleConfig(resolvedRole).defaultInstruction : undefined;
    const instruction =
      args.instruction ?? process.env["SCUFFY_INSTRUCTION"] ?? roleDefault ?? DEFAULT_HEADLESS_INSTRUCTION;
    await runHeadless(registry, middleware, config, provider, instruction, notifyHuman, recordOutcome);
  } else {
    console.log(`Scuffy agent (${config.provider}/${config.model})`);
    console.log(`Working directory: ${config.workingDir}`);
    await startRepl(registry, middleware, config, provider);
  }
}

main().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
