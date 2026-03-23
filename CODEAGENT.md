# CODEAGENT — Scuffy

| Section | Due | Status |
|---|---|---|
| Agent Architecture | MVP | Complete |
| File Editing Strategy | MVP | Complete |
| Multi-Agent Design | MVP | Complete |
| Trace Links | MVP | Pending (needs agent run) |
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

> Trace links will be added after running the agent and capturing session logs.
> Each trace is a JSONL file in `.scuffy/sessions/` containing every event:
> session_start, llm_request, llm_response, tool_call, tool_result, session_end.

- Trace 1 (normal run): *pending — will link to session log showing a successful
  multi-step file edit*
- Trace 2 (different execution path — error, branching condition, or different task
  type): *pending — will link to session log showing error recovery or subagent
  spawning*

---

## Architecture Decisions (Final Submission)

*To be filled during final submission.*

---

## Ship Rebuild Log (Final Submission)

*To be filled during Ship rebuild.*

---

## Comparative Analysis (Final Submission)

*To be filled during final submission.*

---

## Cost Analysis (Final Submission)

*To be filled during final submission.*
