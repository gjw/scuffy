# CODEAGENT — Scuffy

| Section | Due | Status |
|---|---|---|
| Agent Architecture | MVP | Complete |
| File Editing Strategy | MVP | Complete |
| Multi-Agent Design | MVP | Complete |
| Trace Links | MVP | Complete |
| Architecture Decisions | Final Submission | — |
| Ship Rebuild Log | Final Submission | — |
| Comparative Analysis | Final Submission | — |
| Cost Analysis | Final Submission | — |

## Agent Architecture (MVP)

### Overview

Scuffy is a custom TypeScript agent loop — no LangGraph, no LangChain. The core
cycle is: assemble messages, call Claude, execute tool calls, repeat until the LLM
produces a text response.

### System Diagram

```
User instruction
       │
       ▼
┌──────────────┐
│  REPL Loop   │  Persistent readline loop. Session state (messages,
│  (repl.ts)   │  fileReadTimestamps) accumulates across instructions.
└──────┬───────┘
       │ instruction + session
       ▼
┌──────────────────────────────────────────────────────┐
│                   Agent Loop (loop.ts)                │
│                                                      │
│  ┌─────────────────────────────────────────────┐     │
│  │ 1. Build system prompt + user message       │     │
│  │    (context.ts — injects ContextInjections) │     │
│  │                                             │     │
│  │ 2. Apply beforeLLMCall middleware           │     │
│  │    ├── LoggingMiddleware (logs request)     │     │
│  │    └── TimeAwarenessMiddleware (injects     │     │
│  │        current time + elapsed into prompt)  │     │
│  │                                             │     │
│  │ 3. Call Claude API (messages.create)        │     │
│  │                                             │     │
│  │ 4. Apply afterLLMResponse middleware        │     │
│  │                                             │     │
│  │ 5. Check stop_reason:                       │     │
│  │    ├── end_turn/max_tokens → return text    │     │
│  │    └── tool_use → execute tools, loop to 1  │     │
│  └─────────────────────────────────────────────┘     │
│                        │                             │
│              ┌─────────┴──────────┐                  │
│              ▼                    ▼                   │
│    ┌──────────────┐    ┌──────────────┐              │
│    │ Tool Router  │    │ Tool Router  │  (parallel   │
│    │              │    │              │   tool calls) │
│    │ 1. Lookup    │    │ 1. Lookup    │              │
│    │ 2. Zod parse │    │ 2. Zod parse │              │
│    │ 3. Execute   │    │ 3. Execute   │              │
│    │ 4. Middleware │    │ 4. Middleware │              │
│    └──────────────┘    └──────────────┘              │
└──────────────────────────────────────────────────────┘
       │
       ▼
  AgentResult { response, tokensUsed, toolCallCount, durationMs }
```

### Entry Conditions

- The REPL receives a non-empty instruction from the user.
- `runAgentLoop()` is called with: instruction string, persistent `Session`, full
  `ToolRegistry`, middleware stack, and `AgentConfig`.

### Exit Conditions

- **Normal:** The LLM returns `stop_reason: "end_turn"` — it has finished and produced
  a text response. All text blocks are concatenated and returned.
- **Token limit:** `stop_reason: "max_tokens"` — the response was cut off. The partial
  text is returned as-is.
- **Safety cap:** `maxIterations` reached (default 100). Returns an error message. This
  prevents runaway tool-call loops.

### Error Branches

- **Unknown tool:** Tool router returns an error message listing available tools. The
  LLM receives this as a tool_result with `is_error: true` and can self-correct.
- **Zod validation failure:** Invalid parameters are caught by `safeParse()`. The error
  message (including which fields failed) is returned to the LLM.
- **Tool execution error:** All exceptions in `tool.execute()` are caught. The error
  message is returned to the LLM as `is_error: true`. The loop continues — the LLM
  decides whether to retry, try a different approach, or report the error.
- **API error:** Uncaught — propagates to the REPL, which logs it and prompts for the
  next instruction. The session is preserved.

### State Management

| State | Scope | Persistence |
|---|---|---|
| `Session.messages` | Full conversation history | In-memory, survives across instructions within one REPL session |
| `Session.fileReadTimestamps` | Map of file path → mtime | In-memory, tracks reads for edit validation |
| `AgentConfig` | Model, tokens, working dir | Immutable after startup |
| `ToolRegistry` | Registered tools | Immutable after startup |
| JSONL session log | Every event in the session | Append-only file at `.scuffy/sessions/{id}.jsonl` |

### Middleware Pipeline

Middleware executes in registration order. Each middleware can intercept four points:
`beforeLLMCall`, `afterLLMResponse`, `beforeToolCall`, `afterToolResult`.

| Order | Middleware | Purpose |
|---|---|---|
| 1 | `LoggingMiddleware` | Writes every event to JSONL. Must be first (sees everything). |
| 2 | `TimeAwarenessMiddleware` | Injects `Current time: ... Session started Nm ago.` into system prompt. |

### Tool Registry

Tools are registered at startup via `ToolRegistry`. Each tool is a value with:
`name`, `description`, `parameters` (Zod schema), and `execute` function. The registry
converts Zod schemas to Anthropic API tool format via `z.toJSONSchema()`.

Registered tools (MVP):

| Tool | Purpose |
|---|---|
| `think` | No-op reasoning scratchpad |
| `readFile` | Read file with line numbers, pagination |
| `editFile` | Anchor-based surgical edit |
| `writeFile` | Full file write (new files) |
| `listDir` | Directory listing |
| `glob` | File pattern matching |
| `grep` | Content search with regex |
| `bash` | Shell command execution |
| `task` | Spawn ephemeral subagent |

---

## File Editing Strategy (MVP)

### Strategy: Anchor-Based String Replacement

We chose anchor-based replacement — the same approach used by Claude Code and
OpenCode. The LLM provides an exact `old_string` to find in the file and a `new_string`
to replace it with. No line numbers, no diffs, no AST parsing.

**Why this strategy:**

- **Robust to concurrent edits.** String anchors survive line number shifts from
  earlier edits in the same session.
- **Simple to implement.** ~120 lines including all safety checks.
- **Battle-tested.** Both Claude Code and OpenCode use this pattern in production.
  Our PRESEARCH.md research confirmed it handles files >200 lines reliably when
  the LLM includes sufficient context for uniqueness.
- **LLM-friendly.** Claude produces exact string matches more reliably than it
  produces well-formed unified diffs or correct line numbers.

### Mechanism Step by Step

1. **Path resolution.** `resolvePath()` resolves the path against `workingDir` and
   rejects any path that escapes the boundary (directory traversal prevention).

2. **Read-before-edit check (Invariant 1).** The tool checks
   `ctx.fileReadTimestamps` for the resolved path. If the file has never been read
   in this session, the edit is rejected with an error telling the LLM to use
   `readFile` first. This prevents blind edits.

3. **Stale file detection.** The tool compares the file's current `mtime` against
   the timestamp recorded when the LLM last read it. If the file has been modified
   externally (or by another tool call) since the last read, the edit is rejected.
   The LLM must re-read the file to get current contents.

4. **Identity check.** If `old_string === new_string`, the edit is rejected. This
   catches no-op edits that would waste a tool call.

5. **Uniqueness check (Invariant 2).** `countOccurrences()` counts non-overlapping
   matches of `old_string` in the file:
   - **0 matches:** Error — the string was not found. The LLM likely has stale
     context or made a copy error.
   - **1 match:** Proceed with replacement.
   - **>1 matches, `replace_all` false:** Error — ambiguous match. The LLM is told
     to provide more surrounding context to make a unique match, or set
     `replace_all: true`.
   - **>1 matches, `replace_all` true:** All occurrences are replaced (e.g., for
     variable renames).

6. **Replacement.** For single match: `content.replace(old_string, new_string)`.
   For `replace_all`: `content.split(old_string).join(new_string)`.

7. **Write and update timestamp.** The modified content is written to disk. The
   file's new `mtime` is recorded in `fileReadTimestamps`, so subsequent edits
   to the same file work without requiring another read.

### What Happens When the Location Is Wrong

The LLM gets structured error feedback. Each failure mode maps to a specific,
actionable error message:

| Failure | Error returned to LLM | Expected LLM recovery |
|---|---|---|
| File not read yet | `"file has not been read in this session. Use readFile first"` | LLM calls `readFile`, then retries the edit |
| File modified since read | `"file has been modified since last read. Re-read the file first"` | LLM re-reads to get current content |
| String not found | `"old_string not found in {path}"` | LLM re-reads the file, copies the exact text, retries |
| Ambiguous match | `"old_string matches N times... Provide more context"` | LLM includes more surrounding lines to disambiguate |

The agent loop continues after every error — the LLM receives the error as a
`tool_result` with `is_error: true` and decides how to recover. The loop only
terminates when the LLM produces a text response or `maxIterations` is hit.

### Design Trade-offs

- **No post-edit type checking (MVP).** OpenCode runs LSP diagnostics after every
  edit. We deferred this — the LLM can run `bash` with `tsc --noEmit` if it wants
  verification. Adding a `typecheck` middleware is a planned post-MVP enhancement.
- **No undo stack.** Edits are written directly to disk. Recovery is via `git
  checkout` or re-editing. For the Ship rebuild, we'll use git checkpoints.
- **String matching, not fuzzy.** We require exact matches — no whitespace
  normalization or fuzzy fallback. This is stricter than OpenCode's patch tool but
  avoids silent misapplication of edits.

---

## Multi-Agent Design (MVP)

### Orchestration Model: Supervisor via Tool Call

Scuffy uses a **supervisor pattern** — the main agent spawns subagents through the
`task` tool. There is no peer-to-peer communication or shared state between agents.

```
Main Agent (supervisor)
    │
    ├── tool_use: task({name: "read-api", prompt: "..."})
    │       │
    │       ▼
    │   Subagent A (ephemeral)
    │   ├── own Session (fresh messages, own fileReadTimestamps)
    │   ├── own SessionLogger (.scuffy/sessions/sub-{id}.jsonl)
    │   ├── same ToolRegistry (all tools including task)
    │   └── returns: AgentResult.response → tool_result content
    │
    ├── tool_use: task({name: "analyze-tests", prompt: "..."})
    │       │
    │       ▼
    │   Subagent B (ephemeral, runs in parallel with A)
    │   └── same pattern as above
    │
    └── Receives both results as tool_results
        └── Synthesizes, merges, or acts on combined output
```

### How Agents Communicate

- **Downward (supervisor → subagent):** The prompt string. The subagent starts with
  zero message history, so the prompt must contain all necessary context. There is no
  implicit state sharing.
- **Upward (subagent → supervisor):** The subagent's final text response becomes the
  `tool_result` content. Metadata (tokens used, duration, tool call count) is attached
  but not visible to the LLM.
- **Lateral (subagent ↔ subagent):** None. Subagents are isolated. If coordination is
  needed, the supervisor mediates.

### How Parallel Outputs Are Merged

When the main agent issues multiple `task` tool calls in a single response, the agent
loop executes them sequentially (current implementation) and returns all results in one
`tool_result` user message. The main agent sees all results in its next turn and is
responsible for merging — there is no automatic conflict resolution. The LLM decides
how to synthesize.

### Session Isolation

Each subagent gets:

- A fresh `Session` with a new UUID (no shared message history)
- An empty `fileReadTimestamps` map (must read files before editing, even if the parent
  already read them)
- Its own `SessionLogger` writing to `.scuffy/sessions/sub-{uuid}.jsonl`
- The same `ToolRegistry` and `AgentConfig` as the parent

This isolation is deliberate — subagents cannot corrupt the parent's conversation
state, and their file edits are tracked independently.

### Recursive Subagents

The `task` tool is in the registry, so subagents can spawn their own subagents. Depth
is bounded by `maxIterations` and practical token costs. No explicit depth limit is
enforced at MVP.

---

## Trace Links (MVP)

Session traces are JSONL files in [`traces/`](traces/). Each line is a structured
event: `session_start`, `llm_request`, `llm_response`, `tool_call`, `tool_result`,
`session_end`.

- **Trace 1 (normal run):** [`traces/trace-1-normal-edit.jsonl`](traces/trace-1-normal-edit.jsonl)
  — Agent reads `src/tools/think.ts`, makes a surgical edit to the description
  string, then re-reads to verify. Three tool calls: `readFile` → `editFile` →
  `readFile`. Demonstrates the read-before-edit invariant and successful
  anchor-based replacement.

- **Trace 2 (error recovery):** [`traces/trace-2-error-recovery.jsonl`](traces/trace-2-error-recovery.jsonl)
  — Agent attempts an edit with a non-existent string (fails: file not read +
  string not found), then self-corrects by reading the file first and retrying
  with the correct string. Three tool calls: `editFile` (error) → `readFile` →
  `editFile` (success). Demonstrates error feedback and LLM self-correction.

- **Trace 3 (multi-agent):** [`traces/trace-3-multi-agent.jsonl`](traces/trace-3-multi-agent.jsonl)
  + [`traces/trace-3-sub-agent.jsonl`](traces/trace-3-sub-agent.jsonl)
  — Supervisor agent spawns a subagent via the `task` tool to read and summarize
  `src/config.ts`. Subagent runs in its own session (separate JSONL log), reads
  the file, returns a structured summary. Parent receives the result as a
  `tool_result` and synthesizes the final response. Demonstrates the supervisor
  orchestration model and session isolation.

---

## Architecture Decisions (Final Submission)

### 1. Custom TypeScript Loop vs LangGraph/LangChain

**Decision:** Build a custom agent loop from scratch in TypeScript.

**What we considered:** LangGraph (recommended by the PRD), LangChain, and a raw
loop over the Anthropic SDK.

**Why we made this call:** LangGraph adds a dependency graph, state machine, and
Python runtime for something that is fundamentally a while loop: build messages →
call Claude → execute tool calls → repeat. Our loop is ~80 lines in `loop.ts`. We
get direct control over middleware ordering, error propagation, and session state
without framework abstractions. The trade-off is that we own tracing ourselves
(JSONL session logs) instead of getting LangSmith for free — but our logs are
simple enough that custom tracing was trivial.

**Would we change it?** No. The framework would have added complexity without
solving a problem we actually had.

### 2. AST-Aware Exploration Tools (describeModule + listNamespace)

**Decision:** Build two ts-morph-powered tools that let the agent explore code
structure without reading entire files.

**What we considered:** Relying solely on `readFile` with offset/limit, or adding
LSP integration like OpenCode.

**Why we made this call:** The single biggest cost driver in a coding agent is
context from file reads. A 500-line file dumped into context costs ~2K tokens, and
the agent typically only needs to know what a module exports, not read every line.
`describeModule` returns the API surface — exports, signatures, line numbers — in
a fraction of the tokens. `listNamespace` does the same at directory level.

**Measured impact:** ~5.7x reduction in file-read context per session (from ~80K
tokens to ~14K for typical exploration). This is the single largest architectural
win in the project. The three-tier fallback (ts-morph with tsconfig → ts-morph
without tsconfig → regex) ensures it degrades gracefully when type resolution
fails.

**Would we change it?** We'd add a `references` mode earlier — knowing call sites
is as valuable as knowing exports.

### 3. Anchor-Based String Replacement for File Editing

**Decision:** Use exact string matching (old_string → new_string) rather than
unified diffs, line-range replacement, or AST-based editing.

**What we considered:** All four strategies from the PRD. Our PRESEARCH research
found that both Claude Code and OpenCode use anchor-based replacement in
production.

**Why we made this call:** String anchors survive line number drift from earlier
edits. Claude produces exact string matches more reliably than well-formed unified
diffs. The implementation is ~120 lines with safety checks (read-before-edit,
stale-file detection, uniqueness validation). The main risk — ambiguous matches in
large files — is mitigated by requiring the LLM to include enough surrounding
context.

**Would we change it?** We'd add post-edit type checking (`tsc --noEmit` after
each edit) as middleware, which OpenCode does and we deferred.

### 4. Supervisor Pattern for Multi-Agent

**Decision:** Main agent spawns subagents via the `task` tool. No peer-to-peer
communication, no shared state.

**What we considered:** Peer mesh (agents communicate directly), blackboard
pattern (shared state store), and the supervisor pattern.

**Why we made this call:** Subagent isolation prevents state corruption — each
subagent gets a fresh session, fresh file-read timestamps, and its own trace log.
The supervisor sees all results and decides how to merge. This is simple to reason
about and debug. The cost is that subagents can't share context, so the supervisor
prompt must include everything the subagent needs.

**Would we change it?** For the Ship rebuild, a limited shared context (e.g.,
read-only access to parent's file-read cache) would reduce redundant reads.

### 5. Middleware Pipeline for Cross-Cutting Concerns

**Decision:** Four-point middleware hooks (beforeLLMCall, afterLLMResponse,
beforeToolCall, afterToolResult) with ordered registration.

**Why we made this call:** Logging, time injection, and future concerns (token
budgets, safety checks) need to intercept at different points in the loop without
modifying loop logic. The middleware pattern keeps `loop.ts` clean and makes each
concern independently testable.

### 6. Dual-Provider Support (Anthropic + OpenAI)

**Decision:** Support both Claude and GPT models via a provider abstraction,
switchable by environment variable.

**Why we made this call:** Anthropic was declared a supply chain risk. We added
OpenAI/GPT-5.4 support so the agent can run on either provider. The abstraction
is thin — both providers use compatible tool-call formats — so it added minimal
complexity.

---

## Ship Rebuild Log (Final Submission)

### Overview

The Ship rebuild ran through approximately 15–30 full pipeline restarts over the
course of the project. Each restart involved blowing away Scuffy's workspace and
starting fresh. The final (longest) run produced 274 sessions, consumed 103M
tokens, cost ~$247, and ran for over 3 hours. It reached roughly 70% completion
before being stopped for the early submission deadline.

### Pipeline Architecture and Evolution

The pipeline is a state machine called the **Summoner**:

1. Summoner checks the work log. If empty, it spawns **Scout**.
2. Scout reads the project brief (a markdown file defining business and functional
   requirements, deliberately architecture-agnostic) and creates work items (beads).
3. Summoner uses **BeadViewer** (`bv --robot-next`) to select the highest-priority
   unblocked bead and spawns a **Trench** (coding agent) to implement it.
4. After a configurable number of completed beads, Summoner spawns **Warden** for
   quality patrols.
5. Loop continues until all beads are closed.

The Summoner started as a bash script and quickly became unwieldy. Rewriting it
in TypeScript immediately solved reliability issues — proper error handling, typed
state transitions, and deterministic tool execution.

### Agent Roles

| Role | Responsibility |
|---|---|
| **Summoner** | State machine orchestrator. Spawns agents, manages lifecycle. |
| **Scout** | Reads the brief, creates and sizes work items. |
| **Trench** | Coding agent. Claims a bead, implements, tests, submits. |
| **Warden (Light)** | Sanitizes code, updates docs, sands off edges. Creates beads for issues found. |
| **Warden (Dark)** | Deeper audit — finds bad queries, API coupling, architectural debt. Creates beads. |

Warden does not fix problems — it identifies them and creates work items for
Trench to resolve.

### Interventions and Restarts

Most interventions were **process-level**, not code-level. When something failed,
the response was to adjust the pipeline architecture and restart rather than
patch the running system.

**Restart triggers:**

- **Summoner reliability:** The bash-to-TypeScript rewrite was the biggest single
  improvement. Early bash versions had fragile error handling and state tracking.
- **Context blowouts:** Agents would scan entire files and blow through the 800K
  token context cap. Early on these killed the pipeline. Later iterations added
  graceful degradation — agents could request bead resizing instead of crashing.
- **Work item sizing:** Beads were consistently too large. Scout would create
  epics that should have been 5–10 smaller tasks. This remains the primary
  source of inefficiency — agents requesting resizes wastes tokens but no longer
  causes failures.
- **br SQLite corruption:** The upstream beads_rust tool has a recurring database
  corruption bug (documented in Bug-002 with three occurrences). This is an
  external dependency issue, not an agent failure, but it forced pipeline restarts
  when the work log became unreadable.

### Context Management Mitigations

The dominant failure mode was context exhaustion. Mitigations added over
successive restarts:

1. **ts-morph exploration tools** (`describeModule`, `listNamespace`): Let agents
   inspect code structure without reading entire files. ~5.7x token reduction.
2. **Reduced readFile window**: Enforced smaller line limits per read.
3. **Graceful bead resize**: Trench can exit and request the Summoner to split a
   bead into smaller pieces instead of failing.
4. **Agent mail for human input**: Agents mail the human about ambiguous decisions
   without blocking. This avoids stalls and creates a log of design decisions for
   the next iteration.

### The Deterministic Completion Gate (finishBead)

One of the most significant architectural choices. When Trench finishes a bead,
it calls the `finishBead` tool, which runs a deterministic verification pipeline:

1. **Self-reporting requirement:** The agent must declare which test files it
   changed and why. This primes the agent for honesty — it won't try to skip
   tests because it knows it has to report them.
2. **Automated checks:** Runs `tsc --noEmit`, `eslint`, and `vitest` against the
   work branch.
3. **Test audit:** Diffs actual changed files against the agent's self-report.
   If the agent under-reported changes, submission is rejected.
4. **Parent-branch comparison:** If checks fail, the tool re-runs them against
   the parent branch. If the failures already existed before the agent's work,
   the submission is accepted (bypass mode). If the agent introduced new
   failures, it is told to go back and fix them.
5. **Inherited debt handling:** When bypass mode activates, the tool automatically
   creates a high-priority P0 bead for the pre-existing failures, ensuring the
   next agent picks them up immediately.

This system means type errors can still sneak through (via inherited failures that
get bypassed), but they are always tracked and prioritized for the next agent.

### Agent Mail and Ambiguity Handling

Agents were instructed to mail the human when encountering ambiguity — not to
block, but to log the decision they made and why. Examples of ambiguity reports:

- **Architecture choice:** "I chose a TypeScript monorepo with React+Vite frontend,
  Express backend, shared package, and npm workspaces because it aligns with the
  reference product shape. Alternative: Next.js or single-package app."
- **API design:** "I am interpreting 'consistent response shapes' as shared generic
  envelopes plus per-resource DTOs rather than standalone per-resource interfaces.
  This keeps backend-frontend contracts aligned with minimal duplication."
- **Documentation scope:** "I'm creating a separate file for smaller architecture
  decisions and linking from the main doc rather than making it monolithic."
- **Domain interpretation:** "The brief doesn't specify sprint status lifecycle —
  I'm interpreting it as [draft → active → completed → archived]."

These reports served dual purpose: they documented decisions for the current run,
and they informed better briefs for the next iteration.

### What Ship Looks Like at 70% Completion

The agent-built application has functional:

- Issue dashboard with create, view, and filter capabilities
- User creation and management
- Program creation
- Sprint view with week/sprint number display
- Personal view showing assigned issues
- Sprint planning interface
- Change-request status tracking
- Database schemas, migrations, and domain entities
- Shared type definitions across frontend and backend

**Not yet built:** Database persistence. Everything runs in-memory. The schemas
and migrations exist but are not wired to a live database. This was a sequencing
decision by the planning agent (get everything working in-memory first, persist
later) and would have been reached if the run had continued.

### Current State of the Pipeline

The pipeline no longer crashes, no longer requires manual intervention, and
handles its own edge cases. Dedicated agents resolve merge conflicts,
ambiguous type definitions, and triage escalations. Work item sizing is
largely correct at creation time — resizes still happen but are infrequent.
The br SQLite corruption issue was resolved by updating the upstream
dependency (the fix had existed for 23 days before we found it).

The latest build ran to completion with zero manual interventions and zero
hard failures. Per-agent success rate is ~98%.

---

## Comparative Analysis (Final Submission)

### 1. Executive Summary

We built Scuffy, a custom TypeScript coding agent with a multi-agent pipeline
(Summoner → Scout → Trench → Warden → Judicar), and directed it to rebuild
Ship (a project management application) from a technology-agnostic business
requirements brief. The agent chose its own stack, generated its own work
items, and built the application autonomously. The final build ran 157
sessions consuming 90M tokens in 232 minutes (~$217 estimated), producing
123K lines of TypeScript across 378 files with real Postgres persistence.

The pipeline was restarted 30–50 times over the week — not patching the
agent's output, but diagnosing root causes, improving the orchestration
architecture, and starting fresh each time. The result is a pipeline that
got progressively better at building software. The final run required zero
manual code interventions.

Functional features: authentication and login, program and project
management, team directory and profiles, weekly planning, issue tracking
with assignment, standups, wiki, and a planning review queue. FleetGraph
(the AI agent layer from the original) did not land.

### 2. Architectural Comparison

**Codebase scale:**

| Metric | Original (FleetGraph) | Agent-Built (Ship) |
|---|---|---|
| TypeScript files | 459 | 378 |
| Lines of code | 131,389 | 123,403 |
| Test files | 116 | 137 |
| React pages | ~130 components | 15 pages + shell |
| Type/interface definitions | 106+ files | 1,009 definitions |
| Packages | monorepo (pnpm) | monorepo (npm workspaces) |
| Database | PostgreSQL (single documents table) | PostgreSQL (normalized per-entity tables) |
| Git commits | — | 378 |

The agent-built version approaches the original in raw scale. It is not a
stub or prototype — it is a functional application with persistence, auth,
and a multi-page UI.

**Stack choices:**

Both versions converged on very similar stacks: TypeScript, React, Vite,
Express, PostgreSQL. The original used pnpm workspaces; the agent chose npm
workspaces. Both use a monorepo with api/, web/, and shared/ packages.

This convergence is more significant than it appears. The agent had a tool
to read the original FleetGraph source code but never used it — not once,
across any run. It did not know the original's directory layout, package
structure, or stack choices. The brief described business requirements
only: what users need, what they should see, what the product should do.
The agent independently arrived at nearly the same architecture a human
team built, from requirements alone.

**The document model divergence:**

The most significant architectural difference is the data model. The original
uses a **single unified `documents` table** where sprints, issues, people,
retros, programs, and all other entities are rows distinguished by a
`document_type` enum and a JSONB `properties` column. This is a bold,
opinionated choice — it simplifies queries and migrations but means every
entity shares one table.

The agent chose **separate domain entities** with dedicated tables — every
time, across every restart, without exception. We framed the brief neutrally.
The agent consistently chose conventional normalized schemas with per-entity
tables. This is arguably what most human developers would also choose — the
original's document model was the architectural outlier.

**Brief framing matters more than expected:**

Across 30–50 restarts, one of the most impactful changes was rewriting the
brief to be voiced as **what the user needs, expects, and should see** rather
than describing what the system should do and how it should behave internally.
The user-voiced brief produced considerably more coherent and complete
output — the agent built features that felt like a product, not features
that satisfied a spec.

### 3. Performance Benchmarks

| Metric | Value | What It Reveals |
|---|---|---|
| 123,403 lines across 378 files | ~326 lines/file avg | Substantial files, not stubs |
| 1,009 type/interface definitions | 2.7 per file | Strong type discipline without instruction |
| 137 test files for 378 source files | ~36% test coverage by file count | Agent tests more aggressively than the original (~25%) |
| 15 React pages + shell | All functional components | Consistent patterns, no class components |
| 90M tokens consumed | ~573K tokens/session avg | Context-hungry — reads dominate writes |
| 157 sessions, ~$217 | ~$1.38/session | Cost-per-session is low; total cost comes from volume |
| 33 avg tools/session | | Agent is active per session, not stuck in reasoning loops |
| 232 minutes runtime | | Under 4 hours wall clock for a functional application |

**Comparison with the original.** The original FleetGraph is a mature, shipped
product with e2e tests, terraform infrastructure, collaborative editing (Yjs),
real-time WebSocket collaboration, and FleetGraph (an AI analysis agent). The
agent-built version covers the core PM functionality — programs, issues,
people, plans, wiki — with persistence, auth, and tests. It does not have
collaborative editing, the AI agent layer, or production infrastructure.

The agent's output-to-input token ratio remains heavily skewed toward reads.
For every token of code the agent writes, it reads dozens of tokens of existing
code. This is the fundamental cost structure of a coding agent and the reason
the ts-morph exploration tools had outsized impact on economics.

### 4. Shortcomings

The project required **30–50 full pipeline restarts** — blowing away the
workspace and starting over. Each restart represents a failure that the agent
pipeline could not self-correct. The human had to diagnose the root cause,
modify the orchestration architecture, and restart. The agent has no
process-level self-awareness.

**Intervention categories (not exhaustive):**

- **~5 restarts:** Summoner reliability failures. The bash-based orchestrator
  had fragile error handling. Fix: rewrite Summoner in TypeScript.
- **~10 restarts:** Context blowouts. Agents read entire files, accumulated
  context, and hit the 800K token cap. Fix: ts-morph exploration tools,
  smaller read windows, graceful resize exits.
- **~8 restarts:** Work item sizing. Scout created beads too large for a
  single session. Fix: sizing constraints in Tower prompt, ability for
  Trench to request bead resizing.
- **~5 restarts:** br SQLite corruption. An upstream dependency bug
  (documented in [Bug-002](docs/bugs/bug-002-btree-corruption/)) — the fix
  had been released 23 days before we hit it. Running a stale version cost
  multiple restarts. See [Bug-001](docs/bug-001-investigation.md).
- **~5 restarts:** Brief and prompt iteration. Reframing the brief from
  system-specification voice to user-needs voice. Adding the Judicar role.
  Adding CASS lessons.
- **~10+ restarts:** Miscellaneous — tool parameter changes, phase gating
  bugs (see [phase leak case study](docs/case-study-phase-leak.md)),
  smoke test failures, configuration adjustments.

**What these interventions reveal:**

1. **No process-level learning.** The agent cannot observe that "context
   blowouts keep killing sessions" and decide to read files differently.
   Every systemic improvement required human diagnosis and architectural
   change.

2. **Planning agents cannot estimate complexity.** Scout consistently
   created work items that were too large. It has no model of
   implementation cost. The planner and implementer have different cost
   models with no feedback loop between them.

3. **The agent ignores available resources.** We built a tool to read the
   original FleetGraph source. The agent never used it — across any run,
   with any prompt. It preferred to build from the brief alone.

4. **Type errors compound across agents.** The finishBead bypass mode means
   type errors propagate. The tool creates P0 beads for these, but they
   accumulate faster than agents resolve them.

5. **Layer confusion in debugging.** When symptoms appear in one layer
   (e.g., Vitest crashes) but the cause is in another (React infinite
   re-render), agents consistently debug the symptom layer instead of
   descending to the cause. See [OOM hardlock case study](docs/case-study-oom-hardlock.md).

6. **Role ambiguity causes inaction.** An agent correctly diagnosed a
   one-line bug but refused to fix it because it interpreted its role as
   "verification only." Cost: 6.5 hours of idle time. See [polite trench
   case study](docs/case-study-polite-trench.md).

### 5. Advances

**Raw throughput.** The final run produced 123K lines of functional
application code in 232 minutes of runtime — under 4 hours for a
full-stack application with persistence, auth, tests, and a multi-page
UI. Once the pipeline was stable, the agent produced working features
continuously without breaks, fatigue, or context-switching cost.

**Efficiency improved across restarts.** The final build produced 8x
more code than the early builds while consuming fewer tokens (90M vs
103M) in fewer sessions (157 vs 274). The pipeline got better at building
software, not just at not crashing.

**Consistency.** Every file follows the same patterns — consistent naming,
consistent error handling, consistent component structure. There is no
style drift across a 378-file codebase. A human team producing this
volume of code in a week would inevitably introduce inconsistencies.

**Automatic debt tracking.** The finishBead system creates work items for
inherited failures mechanically. Technical debt is never silently ignored.
This is encoded in the tool, not left to agent discipline.

**Ambiguity documentation.** The agent mail system produced a running log
of every design decision the agent considered ambiguous. These reports
informed better briefs for subsequent iterations, creating a feedback
loop across restarts.

**The pipeline matured beyond stability.** Early runs broke constantly.
Mid-week runs were stable but inefficient. The final run is genuinely
autonomous — dedicated agents handle merge conflicts, ambiguous
definitions, and triage escalations. Per-agent success rate is ~98%.
Zero manual interventions, zero hard failures. The progression from
"breaks constantly" to "runs inefficiently" to "runs well" was driven
entirely by pipeline architecture changes, not by improvements to the
underlying LLM.

### 6. Trade-off Analysis

**Custom agent loop vs. LangGraph:** Right call. Our loop is ~80 lines
and we have full control over middleware, error propagation, and session
state. The trade-off (owning our own tracing) was trivial.

**Anchor-based editing vs. unified diffs:** Right call. The LLM produces
exact string matches more reliably than well-formed diffs. We would add
post-edit type checking if rebuilding.

**Supervisor pattern vs. peer agents:** Right call. Session isolation
prevents state corruption and makes debugging straightforward. A shared
read-only context layer would be worth adding.

**ts-morph exploration tools:** Unambiguously right call. The 5.7x context
reduction was the single biggest improvement to session success rates.
Should have been built earlier.

**User-voiced brief over system-specification brief:** Right call,
discovered late. Describing what the user should see and experience
produced more coherent output than describing what the system should do
internally. This is the single most impactful prompt engineering finding
of the project.

**finishBead deterministic gate:** Right call. The self-reporting
requirement, parent-branch diffing, and automatic debt creation are the
pipeline's most valuable safety mechanisms. The bypass mode for inherited
failures is a pragmatic compromise.

**Judicar triage agent:** Right call, added mid-week. Without economic
filtering, the Warden created dozens of polish beads that consumed Trench
sessions better spent on features. The Judicar's "pattern over instance"
principle was particularly effective at collapsing duplicate beads.

### 7. If You Built It Again

**Progressive planning over monolithic.** We actually did this — the final
builds used phased planning (MVP subset → expand → polish) instead of
upfront full planning. It worked dramatically better. The earlier
monolithic approach meant nothing was deployable until most work was done.

**User-voiced briefs from the start.** The shift from "the system shall..."
to "the user sees..." should have happened on day one instead of day five.

**Pin dependencies aggressively.** The br SQLite bug cost multiple
restarts. The fix existed upstream for 23 days. An auto-update script or
version pinning to latest would have prevented hours of debugging.

**Shared read-only context between agents.** Subagent isolation is correct
for writes, but agents should share file-read caches to avoid redundant
reads that waste tokens.

**Post-edit type checking as middleware.** Moving type checking immediately
after each edit (instead of at the finishBead gate) would catch errors
before they compound across multiple edits in a session.

**Build the Judicar earlier.** The economic filter that prevents
unnecessary work from consuming compute should be a day-one feature, not
a mid-week addition.

**Multi-cylinder pipeline.** The current architecture is single-cylinder:
Tower plans an entire phase of 8–15 beads, then the Summoner dispatches
them to parallel slots. This breaks down because Tower plans against
stale state (by bead 8, beads 1–7 have changed the codebase), the unit
of parallelism is wrong (random beads from a flat list race each other
and cause merge conflicts), and integration verification is deferred to
phase end (problems compound instead of surfacing immediately).

The redesign (documented in `notes/design-multi-cylinder-pipeline.md`)
restructures the pipeline around **flows** — user-capability-scoped
sequences of steps. Tower becomes a product planner that thinks in user
capabilities ("a member can create an issue in their program"), not
implementation tasks ("add issues routes"). A new **Groomer** agent
decomposes each feature into concrete implementation steps just-in-time,
reading the codebase minutes before execution instead of hours before.
Each flow runs as a sequential chain on a single worktree — no merge
conflicts within a flow. Flows that touch different areas of the codebase
run in parallel across worktrees. Integration verification happens per-flow,
not per-phase, so problems surface immediately instead of accumulating.

This is the actual "build it again" plan — not hypothetical, currently
being implemented.

---

## Cost Analysis (Final Submission)

See [`docs/AI-COST-ANALYSIS.md`](docs/AI-COST-ANALYSIS.md) for the full cost breakdown
including development spend (~$550–600 across ~600+ sessions), production
projections, and per-project cost analysis.
