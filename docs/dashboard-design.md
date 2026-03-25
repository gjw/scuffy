# Factory Dashboard — Design Document

## Purpose

A browser-based dashboard for monitoring Scuffy's autonomous build process.
Shows session activity, bead progress, agent roles, token costs, and the
dependency graph — everything needed to understand what Scuffy is doing and
whether it's going well, without reading raw JSONL files.

## Data Sources

| Source | Location | Format | Contains |
|---|---|---|---|
| Session logs | `.scuffy/sessions/*.jsonl` | JSONL (one event per line) | Tool calls, LLM requests/responses, tokens, errors, bead claims/completions, escalations, test audits |
| Beads DB | `.beads/` (queried via `bv` and `br`) | SQLite + JSONL | Bead definitions, statuses, dependencies, labels, priorities |
| Git history | `.git/` | Git | Commits, branches, authorship |
| Agent mail | `http://localhost:8765` | MCP/HTTP | Messages between agents and human (linked, not embedded) |
| CASS memory | `http://localhost:8766` | MCP/HTTP | Playbook rules, outcomes (linked, not embedded) |

## Session JSONL Event Types

Each line in a session file is a JSON object with a `type` field:

| Event type | Key fields | Dashboard use |
|---|---|---|
| `session_start` | sessionId, timestamp | Session start time |
| `user_instruction` | instruction | What the agent was told to do |
| `llm_request` | messageCount, model | Model tracking |
| `llm_response` | tokensIn, tokensOut, cacheRead, cacheWrite, durationMs | Token accounting, latency |
| `tool_call` | tool, input, callId | Tool usage breakdown |
| `tool_result` | callId, output, isError, durationMs | Error tracking, tool latency |
| `bead_claim` | beadId, title | Which bead this session worked |
| `bead_complete` | beadId, summary | Completion tracking |
| `escalation` | reason, message | Failure analysis |
| `test_audit` | beadId, reportedChanges, actualChanges, result | Test integrity |
| `session_end` | totalTokens, durationMs | Session summary |

## Architecture

### MVP (Phase 1): Static HTML generator

```
src/dashboard/parse.ts      — JSONL parser, extracts SessionSummary[]
src/dashboard/generate.ts   — HTML generator, produces dashboard.html
scripts/dashboard.sh         — CLI entry: parse + generate + open

SessionSummary {
  sessionId, startTime, endTime, durationMs,
  role, model, beadId, beadTitle,
  tokensIn, tokensOut, cacheRead, cacheWrite,
  toolCalls, errors, outcome (success|escalate|budget|crash)
}
```

### Phase 3: Live mode

```
src/dashboard/server.ts     — Express route mounted on serve.ts
                               GET /dashboard → serves HTML
                               GET /api/sessions → JSON session summaries
                               GET /api/beads → JSON bead state
                               GET /api/graph → mermaid graph string
                               WebSocket /ws/sessions → streams new events
```

## Dashboard Sections

### 1. Session Table (MVP)

Sortable table of all sessions:

| Column | Source |
|---|---|
| Time | session_start.timestamp |
| Role | Derived from agent name or system prompt |
| Bead | bead_claim.beadId + title |
| Tokens (in/out) | Sum of llm_response.tokensIn/Out |
| Cache hit % | cacheRead / (tokensIn) |
| Tool calls | Count of tool_call events |
| Errors | Count of tool_result where isError=true |
| Duration | session_end.durationMs |
| Outcome | success (bead_complete), escalate (escalation), budget (token budget msg), crash (no session_end) |

### 2. Bead Summary (MVP)

Cards or table showing:
- Total beads, open, in_progress, closed
- Per-phase breakdown (phase:X label → progress bar)
- List of recently closed beads with timestamps

### 3. Dependency Graph (MVP)

Mermaid.js rendering of `bv --robot-graph --graph-format=mermaid`.
Nodes colored by status: green=closed, yellow=in_progress, gray=open.
Phase labels as subgraph clusters.

### 4. Cumulative Stats (MVP)

- Total tokens consumed (in + out)
- Total sessions, success rate
- Average tokens per bead
- Average tool calls per session

### 5. Timeline (Phase 2)

Gantt-style horizontal bars on a time axis. Each bar is a session, colored
by role (blue=Trench, purple=Tower, orange=Warden, green=Scout). Bars are
positioned by start/end time, labeled with bead ID. Shows the rhythm of
the build at a glance.

### 6. Cost Estimation (Phase 2)

Token → dollar conversion based on model pricing. Per-session, per-bead,
per-phase, cumulative. Configurable $/1K-token rate.

### 7. Error Analysis (Phase 2)

- Beads that failed most (highest retry count)
- Common error patterns (typecheck, lint, DCG blocked)
- Escalation reasons breakdown

### 8. Real-time Monitoring (Phase 3)

- Auto-refresh session table as new sessions complete
- Live token counter
- Current session: streaming tool calls as they happen
- WebSocket connection to tail the active session's JSONL

### 9. Cross-cutting Integrations (Phase 4)

- CASS: playbook rules shown as annotations on the timeline
- Agent mail: messages shown as events in the timeline
- Git: commits linked to sessions/beads
- Drill-down: click a session row to see the full tool call sequence
- Compare: side-by-side across rebuild attempts
