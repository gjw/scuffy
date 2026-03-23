import { z } from "zod";

/**
 * Agent configuration. Model and API key come from environment variables.
 * Everything else has sensible defaults that can be overridden.
 */

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_ITERATIONS = 100;

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  SCUFFY_MODEL: z.string().optional(),
  SCUFFY_MAX_TOKENS: z.coerce.number().positive().optional(),
  SCUFFY_MAX_ITERATIONS: z.coerce.number().positive().int().optional(),
});

export interface AgentConfig {
  model: string;
  maxTokens: number;
  maxIterations: number;
  systemPrompt: string;
  workingDir: string;
  apiKey: string;
}

export function loadConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  const env = EnvSchema.parse(process.env);

  return {
    model: overrides?.model ?? env.SCUFFY_MODEL ?? DEFAULT_MODEL,
    maxTokens: overrides?.maxTokens ?? env.SCUFFY_MAX_TOKENS ?? DEFAULT_MAX_TOKENS,
    maxIterations: overrides?.maxIterations ?? env.SCUFFY_MAX_ITERATIONS ?? DEFAULT_MAX_ITERATIONS,
    systemPrompt: overrides?.systemPrompt ?? "",
    workingDir: overrides?.workingDir ?? process.cwd(),
    apiKey: env.ANTHROPIC_API_KEY,
  };
}
