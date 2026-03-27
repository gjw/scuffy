/**
 * Structured exit contract between agents, summoner, and dashboard.
 *
 * When a headless session ends, it writes this to .scuffy/exit.json
 * (or .scuffy/exit-{slotId}.json in parallel mode). The summoner reads
 * it instead of parsing stdout with regex. The dashboard can read it
 * from session logs (session_exit event).
 */

/** All possible exit reasons. */
export type ExitReason =
  | "success"           // finishBead completed clean
  | "bypass"            // finishBead completed with pre-existing failure bypass
  | "stuck"             // escalate: agent is stuck
  | "blocked"           // escalate: bead is blocked on dependencies or external
  | "need_replan"       // escalate: bead needs Tower to replan/split
  | "bead_too_large"    // escalate: bead scope exceeds budget
  | "budget_exceeded"   // loop.ts: token budget hit
  | "infra_error"       // can't claim bead, MCP down, br failed
  | "crash"             // process died unexpectedly
  | "unknown";          // fallback

/** Exit codes by category. */
export const EXIT_CODES = {
  SUCCESS: 0,       // finishBead (success or bypass)
  ESCALATION: 1,    // escalate tool (any reason except bead_too_large)
  BUDGET: 2,        // budget exceeded or bead_too_large
} as const;

/** Structured exit metadata written by headless.ts, read by summoner. */
export interface ExitMetadata {
  exitCode: number;
  reason: ExitReason;
  beadId: string | null;
  branch: string | null;
  summary: string;
  bypass: boolean;
  timestamp: string;
}

/** Map exit code + context to a reason. */
export function deriveExitReason(
  exitCode: number,
  escalationReason?: string,
  isBypass?: boolean,
): ExitReason {
  if (exitCode === 0) return isBypass ? "bypass" : "success";
  if (exitCode === 2) return "budget_exceeded";
  if (exitCode === 1 && escalationReason) {
    switch (escalationReason) {
      case "stuck": return "stuck";
      case "blocked": return "blocked";
      case "need_replan": return "need_replan";
      case "bead_too_large": return "bead_too_large";
      default: return "unknown";
    }
  }
  return "crash";
}
