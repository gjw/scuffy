import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export type SessionOutcome = "success" | "escalate" | "budget" | "crash" | "running";

/** Derive agent role from the session instruction text. */
function deriveRole(instruction: string): string {
  const lower = instruction.toLowerCase();
  if (lower.includes("break the work into beads") || lower.includes("scaffold the project") || lower.includes("initialize the workspace") || lower.includes("createbead tool")) return "scout";
  if (lower.includes("audit phase") || lower.includes("adversarial audit") || lower.includes("quality checks")) return "warden";
  if (lower.includes("review remaining work") || lower.includes("reprioritize") || lower.includes("split this bead") || lower.includes("has failed twice") || lower.includes("exceeded the token budget") || lower.includes("oversized bead")) return "tower";
  if (lower.includes("urgent") && lower.includes("typecheck")) return "trench-emergency";
  if (lower.includes("claimbead") || lower.includes("claim bead") || lower.includes("get your assignment")) return "trench";
  return "trench"; // default
}

export interface SessionSummary {
  sessionId: string;
  startTime: string;
  endTime: string | null;
  durationMs: number;
  role: string;
  model: string;
  beadId: string | null;
  beadTitle: string | null;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  toolCalls: number;
  errors: number;
  outcome: SessionOutcome;
  escalationReason: string | null;
  escalationMessage: string | null;
}

interface RawEvent {
  type: string;
  sessionId?: string;
  timestamp?: string;
  model?: string;
  tool?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
  isError?: boolean;
  beadId?: string;
  title?: string;
  summary?: string;
  reason?: string;
  message?: string;
  content?: string;
  instruction?: string;
  role?: string;
  agentName?: string;
  tokenBudget?: number;
  parallel?: boolean;
  slotId?: string;
  totalTokens?: { in: number; out: number };
}

/** Parse a single JSONL session file into a SessionSummary. */
export function parseSession(filePath: string): SessionSummary {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n").filter((l) => l.length > 0);

  let sessionId = path.basename(filePath, ".jsonl");
  let startTime = "";
  let endTime: string | null = null;
  let durationMs = 0;
  let model = "unknown";
  let beadId: string | null = null;
  let beadTitle: string | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let toolCalls = 0;
  let errors = 0;
  let outcome: SessionOutcome = "crash";
  let escalationReason: string | null = null;
  let escalationMessage: string | null = null;
  let role = "unknown";

  for (const line of lines) {
    let event: RawEvent;
    try {
      event = JSON.parse(line) as RawEvent;
    } catch {
      continue;
    }

    switch (event.type) {
      case "session_start":
        if (event.sessionId) sessionId = event.sessionId;
        if (event.timestamp) startTime = event.timestamp;
        // Prefer structured role from session metadata (new format)
        if (event.role) {
          role = event.role;
        } else if (event.instruction) {
          role = deriveRole(event.instruction);
        }
        if (event.model) model = event.model;
        break;

      case "llm_request":
        if (event.model) model = event.model;
        break;

      case "llm_response":
        tokensIn += event.tokensIn ?? 0;
        tokensOut += event.tokensOut ?? 0;
        cacheRead += event.cacheReadTokens ?? 0;
        cacheWrite += event.cacheWriteTokens ?? 0;
        if (event.model) model = event.model;
        break;

      case "tool_call":
        toolCalls++;
        break;

      case "tool_result":
        if (event.isError) errors++;
        break;

      case "bead_claim":
        if (event.beadId) beadId = event.beadId;
        if (event.title) beadTitle = event.title;
        break;

      case "bead_complete":
        outcome = "success";
        break;

      case "escalation":
        outcome = "escalate";
        escalationReason = event.reason ?? null;
        escalationMessage = event.message ?? null;
        break;

      case "session_end":
        if (event.timestamp) endTime = event.timestamp;
        if (event.durationMs) durationMs = event.durationMs;
        break;
    }
  }

  // Detect budget exceeded (loop.ts returns with BUDGET_EXCEEDED in final response)
  if (outcome === "crash") {
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as RawEvent;
        if (
          event.type === "llm_response" &&
          typeof event.content === "string" &&
          event.content.includes("BUDGET_EXCEEDED")
        ) {
          outcome = "budget";
          break;
        }
      } catch {
        continue;
      }
    }
  }

  // Detect still-running sessions (no end event, started recently)
  if (outcome === "crash" && startTime && !endTime) {
    const ageMs = Date.now() - new Date(startTime).getTime();
    if (ageMs < 30 * 60 * 1000) {
      outcome = "running";
    }
  }

  // Derive role from session ID prefix or bead content
  if (sessionId.startsWith("sub-")) {
    role = "subagent";
  }

  // Calculate duration from timestamps if session_end didn't provide it
  if (durationMs === 0 && startTime && endTime) {
    durationMs = new Date(endTime).getTime() - new Date(startTime).getTime();
  }

  return {
    sessionId,
    startTime,
    endTime,
    durationMs,
    role,
    model,
    beadId,
    beadTitle,
    tokensIn,
    tokensOut,
    cacheRead,
    cacheWrite,
    toolCalls,
    errors,
    outcome,
    escalationReason,
    escalationMessage,
  };
}

/** Parse all session files in a workspace's .scuffy/sessions/ directory.
 * Also collects sessions from parallel worktree slots (.worktrees/slot-N/). */
export function parseAllSessions(workspaceDir: string): SessionSummary[] {
  const sessionsDir = path.join(workspaceDir, ".scuffy", "sessions");
  const sessionFiles = new Set<string>();

  // Main workspace sessions
  try {
    for (const f of readdirSync(sessionsDir)) {
      if (f.endsWith(".jsonl")) sessionFiles.add(path.join(sessionsDir, f));
    }
  } catch { /* no sessions dir */ }

  // Parallel worktree sessions
  const worktreesDir = path.join(workspaceDir, ".worktrees");
  try {
    for (const slot of readdirSync(worktreesDir)) {
      const slotSessions = path.join(worktreesDir, slot, ".scuffy", "sessions");
      try {
        for (const f of readdirSync(slotSessions)) {
          if (f.endsWith(".jsonl")) {
            // Use filename as dedup key (same UUID = same session)
            const mainPath = path.join(sessionsDir, f);
            if (!sessionFiles.has(mainPath)) {
              sessionFiles.add(path.join(slotSessions, f));
            }
          }
        }
      } catch { /* slot has no sessions */ }
    }
  } catch { /* no worktrees dir */ }

  let files = [...sessionFiles];

  const summaries = files
    .map((f) => { try { return parseSession(f); } catch { return null; } })
    .filter((s): s is SessionSummary => s !== null && s.startTime !== "")
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  return summaries;
}
