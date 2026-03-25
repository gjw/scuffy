import type { z } from "zod";
import type { LogEvent } from "../logging/types.js";

/**
 * Core tool system types.
 *
 * Every tool is a value conforming to the Tool interface. Zod schemas define
 * parameters — the schema IS the documentation. The registry converts schemas
 * to Anthropic API tool definitions automatically.
 */

/** Context passed to every tool execution. */
export interface ToolContext {
  sessionId: string;
  workingDir: string;
  /** Tracks which files have been read and when. Enforces read-before-edit. */
  fileReadTimestamps: Map<string, number>;
  /** Get the bead claimed in this session (set by claimBead tool). */
  getClaimedBeadId: () => string | null;
  /** Set the claimed bead ID (used by claimBead and escalate). */
  setClaimedBeadId: (id: string | null) => void;
  log: (event: LogEvent) => void;
}

/** Result returned from tool execution. */
export type ToolResult = {
  content: string;
  isError?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
};

/** A tool the agent can invoke. Generic over its Zod parameter schema. */
export interface Tool<T extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: T;
  execute(params: z.infer<T>, ctx: ToolContext): Promise<ToolResult>;
}

/** A parsed tool call from an LLM response. */
export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
};
