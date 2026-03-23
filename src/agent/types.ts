import type Anthropic from "@anthropic-ai/sdk";

/**
 * Agent session and result types.
 */

/** A single continuous conversation with the agent. */
export interface Session {
  id: string;
  startedAt: Date;
  messages: Anthropic.MessageParam[];
  /** Tracks which files have been read and when. Enforces read-before-edit. */
  fileReadTimestamps: Map<string, number>;
  logFile: string;
}

/** Result returned when the agent loop completes. */
export interface AgentResult {
  response: string;
  tokensUsed: { in: number; out: number };
  toolCallCount: number;
  durationMs: number;
}

/** External context injected into the first user message. */
export interface ContextInjection {
  type: "specification" | "schema" | "prior_output" | "test_results";
  label: string;
  content: string;
}
