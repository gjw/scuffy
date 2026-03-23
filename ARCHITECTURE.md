# ARCHITECTURE — Scuffy

## Stack

**TypeScript on Node.js.** Custom agent loop — no LangGraph, no LangChain.

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js (≥24) | Active LTS, native fetch, stable test runner APIs |
| Language | TypeScript (strict mode) | Type safety, Zod integration, assignment requirement |
| LLM SDK | `@anthropic-ai/sdk` | PRD requires Anthropic SDK. Direct API access, no wrapper overhead |
| Validation | Zod | Tool parameter schemas, API response validation, type inference |
| Logging | JSONL (custom) | Append-only session logs, human-readable, `jq`-friendly |
| Testing | Vitest | Fast, TypeScript-native, compatible with strict tsconfig |
| Linting | ESLint + Prettier | Standard TS toolchain |

**Peer dependency note:** `@anthropic-ai/sdk` requires Node ≥18. We target Node 24
(Active LTS as of March 2026).

## Directory Structure

```
scuffy/                              # Repo root (/Users/gjw/dev/scuffy)
│
│── src/                             # Agent source code
│   ├── agent/
│   │   ├── loop.ts                  # Core agent loop: prompt → LLM → tools → repeat
│   │   ├── context.ts               # Context assembly: system prompt, time, injected context
│   │   └── middleware.ts            # Middleware pipeline type + built-in middleware
│   ├── tools/
│   │   ├── registry.ts              # Tool registration and lookup
│   │   ├── types.ts                 # Tool interface, ToolResult, ToolCall types
│   │   ├── readFile.ts              # Read file with line numbers, pagination
│   │   ├── editFile.ts              # Anchor-based surgical edit (str_replace)
│   │   ├── writeFile.ts             # Full file write (new files, rewrites)
│   │   ├── bash.ts                  # Shell command execution
│   │   ├── glob.ts                  # File pattern matching
│   │   ├── grep.ts                  # Content search
│   │   ├── listDir.ts               # Directory listing
│   │   ├── task.ts                  # Subagent spawning
│   │   └── think.ts                 # No-op reasoning scratchpad
│   ├── logging/
│   │   ├── session.ts               # JSONL session logger
│   │   └── types.ts                 # Log event types
│   ├── cli/
│   │   └── repl.ts                  # Persistent REPL loop (readline)
│   ├── config.ts                    # Model selection, env vars, defaults
│   └── index.ts                     # Entry point
│
├── prompts/                         # Agent role prompts (Tower, Trench)
│   ├── tower.md
│   └── trench.md
│
├── dist/                            # Build output (gitignored)
├── .scuffy/
│   └── sessions/                    # JSONL session logs (gitignored)
├── workspace/                       # Agent working directories (gitignored)
│   └── ship-rebuild/                # Where the agent builds Ship from scratch
│
├── .beads/                          # Issue tracking database
├── .gitignore
├── tsconfig.json
├── package.json
├── vitest.config.ts
├── project-manifest.toml            # Project metadata
│
├── ARCHITECTURE.md                  # This file
├── CLAUDE.md                        # Agent instructions (Trench reads this)
├── CONTEXT.md                       # Project constraints and workflow
├── REQUIREMENTS.md                  # Extracted from PRD
├── PRESEARCH.md                     # Pre-search research and design decisions
├── CODEAGENT.md                     # Submission template (filled progressively)
└── shipyard_prd.pdf                 # Assignment spec
```

## Workspace Boundaries

There are four distinct codebases in this project. Confusing them causes
cross-contamination — agent source changes mixed with Ship output, or the
agent modifying its own source during a rebuild.

| Codebase | What | Who edits | Where | Git status |
|---|---|---|---|---|
| **Scuffy source** | Agent's own TypeScript | Trench agents (development) | `src/` | Committed to main repo |
| **Scuffy runtime** | Built agent binary | Nobody — built from source | `dist/` | Gitignored |
| **Ship reference** | Original Ship app | Nobody — read-only | External clone | Not in this repo |
| **Ship rebuild** | Ship app our agent builds | Scuffy runtime | `workspace/ship-rebuild/` | Gitignored during dev |

### Two Operating Modes

**Development mode** — Trench agents (Claude Code sessions) edit Scuffy's own source
in `src/`. The working directory is the repo root. This is us building the agent.

**Rebuild mode** — The Scuffy agent (running from `dist/`) operates on a target
workspace. During Ship rebuild, `workingDir` points to `workspace/ship-rebuild/`.
The agent creates this as a fresh project — `npm init`, scaffold, write code. It
has its own `package.json`, its own `node_modules`, its own git history.

```
Development:                         Rebuild:

  Trench (Claude Code)                 Scuffy (our agent, running)
       │                                    │
       ▼                                    ▼
  scuffy/src/                          workspace/ship-rebuild/
  (editing agent source)               (building Ship from scratch)
```

The `workingDir` in `AgentConfig` is the boundary. All file tools (read, edit, write,
glob, grep, listDir) operate relative to it. A tool MUST NOT access files outside
`workingDir` unless explicitly allowed (e.g., reading a reference file).

### Ship Reference

The original Ship app is studied for the comparative analysis but is NOT part of this
repo. It's cloned separately (or accessed via GitHub) when needed. During the rebuild,
the agent does NOT have access to Ship's source — it builds from a spec/instructions,
not by copying.

### Submission

For final submission, the Ship rebuild output is committed to the repo (or a branch)
so it's accessible via GitHub. The `workspace/` gitignore is lifted for the specific
rebuild we're submitting. Session logs from the rebuild run are included as evidence
for the comparative analysis.

## Data Model

### Messages

The agent maintains a conversation as an array of Anthropic API messages. Each
instruction from the user starts a new turn. Tool calls and results are interleaved
as the agent works.

```typescript
// Conversation state — maps directly to Anthropic API message format
type ConversationMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};
```

### Tool Definition

Every tool is a value conforming to the `Tool` interface. Zod schemas define
parameters — the schema IS the documentation.

```typescript
import { z } from "zod";

interface Tool<T extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: T;
  execute(params: z.infer<T>, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolContext {
  sessionId: string;
  workingDir: string;
  fileReadTimestamps: Map<string, number>;  // path → last-read epoch ms
  log: (event: LogEvent) => void;
}

type ToolResult = {
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
};
```

### Session State

```typescript
interface Session {
  id: string;
  startedAt: Date;
  messages: ConversationMessage[];
  fileReadTimestamps: Map<string, number>;
  logFile: string;  // path to .scuffy/sessions/{id}.jsonl
}
```

### Log Events

```typescript
type LogEvent =
  | { type: "session_start"; sessionId: string; timestamp: string; instruction: string }
  | { type: "llm_request"; timestamp: string; messageCount: number; model: string }
  | { type: "llm_response"; timestamp: string; content: string; toolCalls: ToolCallSummary[]; tokensIn: number; tokensOut: number; durationMs: number }
  | { type: "tool_call"; timestamp: string; tool: string; input: unknown; callId: string }
  | { type: "tool_result"; timestamp: string; callId: string; output: string; isError: boolean; durationMs: number }
  | { type: "session_end"; timestamp: string; totalTokens: { in: number; out: number }; durationMs: number };
```

## API Surface

### Agent Loop

```typescript
// The core function. Takes an instruction + context, runs until the LLM
// produces a final text response (no more tool calls).
async function runAgentLoop(
  instruction: string,
  session: Session,
  tools: Tool[],
  middleware: Middleware[],
  config: AgentConfig,
): Promise<AgentResult>;

interface AgentConfig {
  model: string;           // e.g. "claude-opus-4-6"
  maxTokens: number;       // output token limit per LLM call
  maxIterations: number;   // safety cap on tool-call loops
  systemPrompt: string;
  workingDir: string;
}

interface AgentResult {
  response: string;        // final text from LLM
  tokensUsed: { in: number; out: number };
  toolCallCount: number;
  durationMs: number;
}
```

### Middleware

Middleware wraps the agent loop. Each middleware can act before/after LLM calls
and before/after tool executions.

```typescript
interface Middleware {
  name: string;
  beforeLLMCall?(messages: ConversationMessage[], config: AgentConfig): ConversationMessage[];
  afterLLMResponse?(response: LLMResponse): LLMResponse;
  beforeToolCall?(call: ToolCall): ToolCall;
  afterToolResult?(call: ToolCall, result: ToolResult): ToolResult;
}
```

**Built-in middleware (MVP):**

| Middleware | Purpose |
|---|---|
| `LoggingMiddleware` | Writes every event to session JSONL |
| `TimeAwarenessMiddleware` | Injects current time + elapsed gaps into system prompt |
| `ErrorRecoveryMiddleware` | Formats tool errors for LLM self-correction |

**Post-MVP middleware:**

| Middleware | Purpose |
|---|---|
| `SummarizationMiddleware` | Compresses context when approaching token limits |
| `ContextInjectionMiddleware` | Injects specs, schemas, prior output |

### Tool Registration

```typescript
// Tools are registered at startup. The registry generates the Anthropic
// tool definitions from Zod schemas automatically.
const registry = new ToolRegistry();
registry.register(readFileTool);
registry.register(editFileTool);
// ...

// Converts to Anthropic API tool format
const anthropicTools = registry.toAnthropicTools();
```

### Context Injection

External context is injected as part of the initial user message, before the
instruction. The agent receives it as structured input, not as system prompt bloat.

```typescript
interface ContextInjection {
  type: "specification" | "schema" | "prior_output" | "test_results";
  label: string;       // human-readable label
  content: string;     // the injected content
}

// Assembled into the first user message:
// <context type="specification" label="Auth requirements">
// ...content...
// </context>
//
// Your instruction: Add error handling to the login function
```

## Key Abstractions

A fresh Trench agent needs to understand these five concepts:

1. **Agent Loop** — the core cycle. Assemble messages → call Claude → if tool calls,
   execute them and loop; if text response, we're done. The loop is the heartbeat.
   Everything else wraps it.

2. **Tool** — a capability with a typed interface. Zod schema defines parameters,
   `execute` function does the work, result goes back to the LLM. Adding a tool means
   defining a schema and a function — nothing else changes.

3. **Middleware** — composable wrappers around the loop. They intercept before/after
   LLM calls and tool executions. Logging, time awareness, error recovery, context
   injection — all middleware. They handle cross-cutting concerns without polluting
   the core loop.

4. **Session** — the conversation state for one continuous interaction. Holds message
   history, file read timestamps, and a JSONL log file. Persists in memory while the
   REPL is running. Serialized to JSONL for post-session analysis.

5. **Context Assembler** — builds the messages array for each LLM call. Handles system
   prompt construction, time injection, context injection, and message history. The
   assembler is where "what does the LLM see?" is answered.

## Glossary

| Term | Definition | Not to be confused with |
|---|---|---|
| **Agent loop** | The prompt → LLM → tools → repeat cycle until the LLM produces a final text response | Not the REPL loop (which accepts user instructions) |
| **Tool** | A typed function the LLM can call, with Zod-validated parameters | Not a CLI command — tools have structured I/O |
| **Middleware** | A wrapper around the agent loop that intercepts events | Not Express middleware — these wrap LLM calls, not HTTP |
| **Session** | One continuous conversation with the agent, from first instruction to exit | Not an Anthropic API "session" — we manage our own |
| **Instruction** | A single user request within a session | Not a "prompt" — the prompt is the full message array sent to the LLM |
| **Context injection** | External data (specs, schemas, test results) added to the LLM's input | Not "system prompt" — context is injected into user messages |
| **Surgical edit** | An `edit_file` call that replaces a specific string without rewriting the whole file | Not a "diff" — we match exact strings, not line ranges |
| **Subagent** | An ephemeral agent spawned via the `task` tool, returns one result | Not a persistent child process — stateless, one-shot |
| **JSONL session log** | Append-only log of every event in a session, one JSON object per line | Not a trace summary — the raw data from which traces are derived |

## Invariants

These must hold at all times. If any invariant is violated, it's a bug.

1. **Read-before-edit.** `edit_file` must reject edits to files that haven't been read
   in the current session. The `fileReadTimestamps` map is the authority.

2. **Edit uniqueness.** `edit_file` must reject edits where `old_string` matches more
   than once in the file (unless `replace_all` is true).

3. **Every event is logged.** Every LLM call, tool call, and tool result must produce
   a JSONL log entry. No silent operations.

4. **Tools are pure registrations.** Adding or removing a tool must not require changes
   to the agent loop, middleware, or any other tool. The registry is the only coupling
   point.

5. **Middleware ordering is explicit.** Middleware executes in registration order.
   Logging middleware must be first (sees everything). Time awareness must run before
   the LLM call (injects time into messages).

6. **No floating promises.** Every async operation must be awaited, returned, or
   explicitly voided. Unhandled rejections crash the agent.

7. **Session state is in-memory only.** The JSONL log is the persistence layer. If the
   process crashes, the log has everything needed to understand what happened. Session
   state is never written to a database.

8. **Model is configurable.** The model ID must come from config/env, never hardcoded.
   Switching models must not require code changes.
