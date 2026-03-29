# Scuffy -- Autonomous Coding Agent

Custom TypeScript agent loop that builds applications from business requirements.
No LangGraph, no LangChain -- a from-scratch agent with a multi-agent pipeline
(Summoner/Scout/Trench/Warden), Zod-validated tools, and dual-provider LLM support.

## Submission Documents

| Document | Description |
|---|---|
| [CODEAGENT.md](CODEAGENT.md) | Agent architecture, file editing strategy, multi-agent design, trace links, comparative analysis, ship rebuild log |
| [PRESEARCH.md](PRESEARCH.md) | Open source research, architecture design decisions, stack and operations |
| [docs/AI-COST-ANALYSIS.md](docs/AI-COST-ANALYSIS.md) | Development costs, production projections, token usage data |
| [docs/AI-DEV-LOG.md](docs/AI-DEV-LOG.md) | Tools & workflow, effective prompts, code analysis, key learnings |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design, data model, API surface, invariants |
| [traces/](traces/) | JSONL session traces (normal run, error recovery, multi-agent) |
| [notes/](notes/) | Case studies: OOM hardlock, polite trench, phase leak |

## Quick Start

```bash
# GitLab (primary)
git clone ssh://git@labs.gauntletai.com:22022/gabrielwilkins/scuffy.git

# GitHub (mirror)
git clone https://github.com/gjw/scuffy.git

cd scuffy
npm install
```

Create a `.env` file (or export these variables):

```
ANTHROPIC_API_KEY=sk-...          # Required (default provider)
OPENAI_API_KEY=sk-...             # Optional (alternative provider)
SCUFFY_PROVIDER=anthropic         # "anthropic" or "openai"
SCUFFY_MODEL=claude-sonnet-4-6    # Any model the provider accepts
```

Build and run:

```bash
npm run build          # Compile TypeScript
npm run dev            # Interactive REPL
npm run serve          # Web UI (Express + WebSocket on port 3000)
```

Headless mode (single-instruction, used by the Summoner orchestrator):

```bash
node dist/index.js --headless --instruction "Implement the login endpoint"
node dist/index.js --headless --role trench --workdir workspace/ship-rebuild
```

Requires Node.js >= 24.

## Architecture

The core cycle: assemble messages, call the LLM, execute tool calls, repeat until the
model produces a final text response. A middleware pipeline (logging, time-awareness,
error recovery) wraps each step. Tools are Zod-schema-defined capabilities registered
at startup -- adding a tool requires no changes to the loop.

Key properties:

- **Dual provider** -- Anthropic and OpenAI behind a shared `LLMProvider` interface.
  Switch providers via env var, no code changes.
- **Middleware pipeline** -- composable before/after hooks on LLM calls and tool
  executions for logging, context injection, and error handling.
- **Zod-validated tools** -- parameter schemas are the documentation. The registry
  converts them to provider-native tool definitions automatically.
- **JSONL session logging** -- append-only, one JSON object per event, `jq`-friendly.
- **Exit signaling** -- tools (`finishBead`, `escalate`) control process exit codes,
  enabling orchestration by the Summoner script.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design, data model, API
surface, and invariants.

## Project Structure

```
src/
  agent/          # Core loop, context assembly, middleware pipeline
  tools/          # All agent tools (readFile, editFile, bash, grep, etc.)
  providers/      # Anthropic + OpenAI LLM provider implementations
  cli/            # REPL and headless entry points
  logging/        # JSONL session logger
  mcp/            # MCP server integration (bridge, notify, CASS)
  serve.ts        # Express + WebSocket web server
  index.ts        # Main entry point, wiring
prompts/          # Role prompts (Tower, Trench, Warden, etc.)
workspace/        # Agent working directories (gitignored)
  ship-rebuild/   # Where Scuffy builds Ship from scratch
.beads/           # Issue tracking (beads_rust JSONL)
.scuffy/sessions/ # Session logs (gitignored)
```

## Commands

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript (`tsc`) |
| `npm run dev` | Run agent in interactive REPL mode |
| `npm run serve` | Start web UI server |
| `npm run test` | Run tests (`vitest`) |
| `npm run lint` | Lint with ESLint + Prettier |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run typecheck` | Type-check without emit |

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) -- System design, data model, API surface, invariants
- [CODEAGENT.md](CODEAGENT.md) -- Submission document (agent architecture, multi-agent design, traces)
- [PRESEARCH.md](PRESEARCH.md) -- Research and design decisions
- [docs/AI-COST-ANALYSIS.md](docs/AI-COST-ANALYSIS.md) -- Token usage and cost tracking
- [docs/AI-DEV-LOG.md](docs/AI-DEV-LOG.md) -- AI development log (tools, prompts, learnings)
- `notes/` -- Case studies and session analyses

## Ship Rebuild

The `workspace/ship-rebuild/` directory is where Scuffy autonomously rebuilds the Ship
project management application from a business requirements brief. The Summoner
orchestrator script dispatches headless Scuffy agents in parallel -- Scout plans the
architecture, Trench agents implement individual beads, and Warden agents verify
quality -- producing a complete application without human intervention.
