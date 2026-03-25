import { z } from "zod";

/**
 * Agent configuration. Model and API key come from environment variables.
 * Everything else has sensible defaults that can be overridden.
 */

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_ITERATIONS = 100;
const DEFAULT_TOKEN_BUDGET = 800_000;

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  SCUFFY_PROVIDER: z.enum(["anthropic", "openai"]).optional(),
  SCUFFY_MODEL: z.string().optional(),
  SCUFFY_MAX_TOKENS: z.coerce.number().positive().optional(),
  SCUFFY_MAX_ITERATIONS: z.coerce.number().positive().int().optional(),
  SCUFFY_TOKEN_BUDGET: z.coerce.number().positive().int().optional(),
  SCUFFY_MCP_SERVERS: z.string().optional(),
});

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string | undefined;
  args?: string[] | undefined;
  url?: string | undefined;
  env?: Record<string, string> | undefined;
  /** Whitelist of tool names to register. If omitted, all tools are registered. */
  tools?: string[] | undefined;
}

const McpServerConfigSchema = z.array(
  z.object({
    name: z.string(),
    transport: z.enum(["stdio", "http"]),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    tools: z.array(z.string()).optional(),
  }),
);

export interface AgentConfig {
  provider: "anthropic" | "openai";
  model: string;
  maxTokens: number;
  maxIterations: number;
  tokenBudget: number;
  mcpServers: McpServerConfig[];
  systemPrompt: string;
  workingDir: string;
  anthropicApiKey?: string | undefined;
  openaiApiKey?: string | undefined;
}

export function loadConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  const env = EnvSchema.parse(process.env);

  const provider = overrides?.provider ?? env.SCUFFY_PROVIDER ?? "anthropic";

  const config: AgentConfig = {
    provider,
    model: overrides?.model ?? env.SCUFFY_MODEL ?? DEFAULT_MODEL,
    maxTokens: overrides?.maxTokens ?? env.SCUFFY_MAX_TOKENS ?? DEFAULT_MAX_TOKENS,
    maxIterations: overrides?.maxIterations ?? env.SCUFFY_MAX_ITERATIONS ?? DEFAULT_MAX_ITERATIONS,
    tokenBudget: overrides?.tokenBudget ?? env.SCUFFY_TOKEN_BUDGET ?? DEFAULT_TOKEN_BUDGET,
    mcpServers: overrides?.mcpServers ?? parseMcpServers(env.SCUFFY_MCP_SERVERS),
    systemPrompt: overrides?.systemPrompt ?? "",
    workingDir: overrides?.workingDir ?? process.cwd(),
  };

  if (env.ANTHROPIC_API_KEY) config.anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (overrides?.anthropicApiKey) config.anthropicApiKey = overrides.anthropicApiKey;
  if (env.OPENAI_API_KEY) config.openaiApiKey = env.OPENAI_API_KEY;
  if (overrides?.openaiApiKey) config.openaiApiKey = overrides.openaiApiKey;

  // Validate that the selected provider has an API key
  if (provider === "anthropic" && !config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required when using the Anthropic provider");
  }
  if (provider === "openai" && !config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required when using the OpenAI provider");
  }

  return config;
}

/** Parse MCP server configs from JSON env var. Returns empty array on missing/invalid. */
function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return McpServerConfigSchema.parse(parsed);
  } catch {
    console.error("Warning: SCUFFY_MCP_SERVERS is not valid JSON. Ignoring.");
    return [];
  }
}
