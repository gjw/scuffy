import type { LLMMessage } from "../providers/types.js";

/**
 * Agent session and result types.
 */

/** A single continuous conversation with the agent. */
export interface Session {
  id: string;
  startedAt: Date;
  messages: LLMMessage[];
  /** Tracks which files have been read and when. Enforces read-before-edit. */
  fileReadTimestamps: Map<string, number>;
  /** Bead claimed by claimBead tool in this session. Cleared on escalate. */
  claimedBeadId: string | null;
  logFile: string;
}

/** Result returned when the agent loop completes. */
export interface AgentResult {
  response: string;
  tokensUsed: { in: number; out: number; cacheRead: number; cacheWrite: number };
  toolCallCount: number;
  durationMs: number;
  /** Set by exit-signaling tools (finishBead, escalate). Caller uses this for process.exit(). */
  exitCode?: number | undefined;
}

/** External context injected into the first user message. */
export interface ContextInjection {
  type: "specification" | "schema" | "prior_output" | "test_results";
  label: string;
  content: string;
}
