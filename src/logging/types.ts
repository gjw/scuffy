/**
 * Log event types for JSONL session logging.
 *
 * Every event in a session produces exactly one LogEvent, appended as a single
 * line to the session's JSONL file. The `type` field is the discriminant.
 */

export type ToolCallSummary = {
  id: string;
  tool: string;
  input: unknown;
};

export type SessionStartEvent = {
  type: "session_start";
  sessionId: string;
  timestamp: string;
  instruction: string;
};

export type LLMRequestEvent = {
  type: "llm_request";
  timestamp: string;
  messageCount: number;
  model: string;
};

export type LLMResponseEvent = {
  type: "llm_response";
  timestamp: string;
  content: string;
  toolCalls: ToolCallSummary[];
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
};

export type ToolCallEvent = {
  type: "tool_call";
  timestamp: string;
  tool: string;
  input: unknown;
  callId: string;
};

export type ToolResultEvent = {
  type: "tool_result";
  timestamp: string;
  callId: string;
  output: string;
  isError: boolean;
  durationMs: number;
  metadata?: Record<string, unknown> | undefined;
};

export type UserInstructionEvent = {
  type: "user_instruction";
  timestamp: string;
  instruction: string;
};

export type SessionEndEvent = {
  type: "session_end";
  timestamp: string;
  totalTokens: { in: number; out: number };
  durationMs: number;
};

export type BeadClaimEvent = {
  type: "bead_claim";
  timestamp: string;
  beadId: string;
  title: string;
};

export type BeadCompleteEvent = {
  type: "bead_complete";
  timestamp: string;
  beadId: string;
  summary: string;
};

export type EscalationEvent = {
  type: "escalation";
  timestamp: string;
  reason: "stuck" | "need_replan" | "blocked" | "bead_too_large" | "flag";
  message: string;
};

export type TestAuditEvent = {
  type: "test_audit";
  timestamp: string;
  beadId: string;
  reportedChanges: Array<{ file: string; reason: string }>;
  actualChanges: string[];
  deletedTests: string[];
  result: "clean" | "unreported_changes" | "deleted_tests";
};

export type PreexistingBypassEvent = {
  type: "preexisting_bypass";
  timestamp: string;
  beadId: string;
  failedChecks: string[];
  failingFiles: string[];
  agentChangedFiles: string[];
};

export type LogEvent =
  | SessionStartEvent
  | UserInstructionEvent
  | LLMRequestEvent
  | LLMResponseEvent
  | ToolCallEvent
  | ToolResultEvent
  | SessionEndEvent
  | BeadClaimEvent
  | BeadCompleteEvent
  | EscalationEvent
  | TestAuditEvent
  | PreexistingBypassEvent;
