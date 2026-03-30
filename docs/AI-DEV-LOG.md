# AI Development Log

**Project**: Scuffy — Autonomous Coding Agent (Gauntlet Shipyard)
**Period**: 2026-03-23 to 2026-03-29
**Primary AI Tools**: Claude Code, Claude API (Sonnet 4.6 + Opus 4.6), OpenAI API (GPT-5.4)

---

## Tools & Workflow

**Primary development tool: Claude Code** — used for all agent development,
documentation, and orchestration design. Claude Code sessions ran in the Tower
(planning) and Trench (implementation) roles, coordinated by a human Chair.

**Agent-as-tool: Scuffy itself** — once the agent loop was functional, Scuffy
ran autonomously via the Summoner pipeline to rebuild the Ship application.
The Summoner is a TypeScript state machine that spawns Claude Code instances
in headless mode, each working on a single bead (work item).

**Dual-provider architecture:** The agent supports both Anthropic (Claude) and
OpenAI (GPT-5.4) via a provider abstraction. This was added after Anthropic
was declared a supply chain risk. A few early runs used Claude Opus/Sonnet;
nearly all subsequent runs used GPT-5.4 on a Gauntlet-provided OpenAI key.

**Issue tracking: beads_rust (br) + beads_viewer (bv)** — all work items
tracked as beads with dependency graphs. `bv --robot-triage` provided
dependency-aware prioritization for the Summoner.

**Session logging:** Every agent session produces a JSONL log file capturing
every LLM call, tool call, and result with timestamps and token counts.
These logs are the primary observability layer and the source for cost data.

---

## Effective Prompts

### 1. The Trench System Prompt — "Read Before You Code"

The core behavioral constraint that made autonomous coding sessions reliable:

```
You are Trench — a coding agent. Chair (human) coordinates you alongside a
Tower agent (planner) and possibly other Trench agents working in parallel
on other branches.

Critical Rules:
1. Read Before You Code — Read CLAUDE.md and ARCHITECTURE.md before writing
   any code.
2. Stay In Your Lane — Only modify files related to your task.
3. Ask, Don't Guess — If ambiguous, stop and ask.
4. Trust Diagnostic Output — Don't speculate when you can verify.
5. Never Blame The Environment — No "corrupt runtime" or "reinstall"
   deflections.
6. One Task Per Session — Complete, commit, report, stop.
```

**Why it worked:** The "Never Blame The Environment" rule eliminated the most
common agent failure mode — when debugging gets hard, agents fabricate
environmental explanations instead of reading the actual error. This single
rule saved dozens of sessions from unproductive spirals.

### 2. The finishBead Self-Report Requirement

```
Before completing, you must declare:
- Which test files you changed and why
- Which files you modified beyond your task scope (if any)

The system will diff your actual changes against this self-report. If you
under-reported changes, your submission is rejected.
```

**Why it worked:** Priming the agent for honesty before running automated
checks made it less likely to try to skip tests or hide changes. The diff
audit catches attempts to game the system, but the self-report requirement
means agents rarely try.

### 3. The Tower Sizing Constraint

```
Target: 12-18 tool calls per bead. Max 2 files created/modified per bead.
One concern per bead. If the title contains "and", split it. The #1 cause
of wasted sessions is oversized beads.
```

**Why it worked:** Early runs had beads sized for 50+ tool calls, which blew
context budgets reliably. This constraint forced aggressive decomposition.
The "if the title contains 'and', split it" heuristic was surprisingly
effective at catching compound tasks.

### 4. The Judicar — Triage Agent That Eliminates Work

A specialized agent that never writes code — it only reads context and makes
triage decisions about work items:

```
You are the Judicar. You make triage decisions about beads. You never write
code, never edit files, never run tests. You read context and act through
br commands.

Your principles:
1. Eliminate unnecessary work. Every bead you approve costs 5-30 minutes
   of agent compute.
2. Correctness bugs compound. Polish doesn't. Fix correctness at the
   boundary. Defer polish to the end.
3. Pattern over instance. If you see the same issue in 3 beads, the fix
   is one pattern-level bead, not 3 instance-level beads.
4. Don't replan. Triage. Tower creates work. You eliminate work.
5. Be fast. Read the context, make the call, exit.
```

**Why it worked:** Without the Judicar, the Warden would create dozens of
P2 polish beads that consumed Trench sessions better spent on features.
The Judicar acts as an economic filter — it reasons about whether work is
worth the compute cost before dispatching an agent to do it. The "pattern
over instance" principle was particularly effective at collapsing 3-5
duplicate beads into one structural fix.

---

## Code Analysis

Strictly speaking, virtually 0% of the code was typed by a human. The human
role was architect, reviewer, and pipeline operator — not author. A more
honest breakdown by review depth:

| Category | AI-Authored | Human Role | Review Depth |
|---|---|---|---|
| Agent core (`src/agent/`, `src/tools/`) | ~100% | Directed, reviewed | Fine (~20%) |
| Summoner pipeline (`src/summoner/`) | ~99% | Designed, iterated | Fine — multiple rewrites directed by human |
| Prompts (`prompts/`) | ~50% | Co-authored | Deep — human wrote structure, agents refined |
| Ship rebuild (`workspace/ship-rebuild/`) | ~100% | Zero touch | Gross — human reviewed output, not code |
| Documentation | ~80% | Co-authored | Fine — human directed and edited drafts |
| Config / infra (scripts, CI, deploy) | ~99% | Directed | Fine |

**Summary:** ~99% AI-generated code. ~1% literally hand-typed (fragments of
deployment scripts and pipeline logic). ~20% of code received fine-grained
human review (line-by-line). ~80% received gross review (does it work? does
the output look right?). The human contribution is almost entirely in
direction, architecture, prompt engineering, and quality judgment — not in
writing code.

---

## Strengths & Limitations

### Where the tools excelled

- **Consistency at scale.** 274 sessions of autonomous coding produced a
  codebase with zero style drift. Every file follows the same patterns,
  naming conventions, and error handling approach. A human team would need
  strong linting and code review to match this.

- **Debt tracking.** The finishBead system mechanically creates work items
  for inherited failures. Technical debt is never silently ignored. This is
  the most valuable property of the pipeline — it turns quality enforcement
  from a discipline problem into a structural guarantee.

- **Throughput when the pipeline is stable.** The final run produced 14,762
  lines of functional application code in under 3.5 hours. The bottleneck
  was never coding speed — it was pipeline architecture and recovery from
  restarts.

### Where the tools fell short

- **Layer confusion in debugging.** The [OOM hardlock case study](case-study-oom-hardlock.md) is the
  clearest example: three agents diagnosed a React infinite re-render as a
  "test infrastructure problem" because the symptoms (Vitest worker crashes)
  appeared in the test layer. Agents debug symptoms, not causes, unless
  explicitly instructed to descend layers.

- **Role ambiguity causes inaction.** The [Polite Trench case study](case-study-polite-trench.md): an agent
  correctly diagnosed a one-line bug but refused to fix it because it
  interpreted its role as "verification only." The cost was 6.5 hours of
  idle time. Clear permissions in prompts are load-bearing.

- **No process-level self-awareness.** The agent cannot observe that it is
  repeatedly failing for systemic reasons and adjust its own pipeline. Every
  systemic improvement required human diagnosis and architectural change.

- **Planning agents cannot estimate complexity.** Scout consistently created
  work items that were too large. It has no model of implementation cost
  because it has never implemented anything.

- **Dependency version management.** BUG-001 and BUG-002 (SQLite issues
  that caused multiple pipeline restarts) were both fixed upstream 23 days
  before we hit them. The fix existed in the very next version of `br`. An
  auto-update script or pinning to latest would have prevented hours of
  debugging across multiple restarts.

---

## Key Learnings

1. **The pipeline is the product, not the agent.** The individual agent
   (prompt + tools + loop) stabilized quickly. All subsequent progress came
   from improving the orchestration: how agents are spawned, how work is
   sized, how failures are handled, how quality gates work. Building a good
   agent is table stakes; building a good pipeline around it is the real
   engineering challenge.

2. **Fresh context beats accumulated context.** Ralph's insight is correct.
   Each agent session should start clean with deterministic inputs (docs,
   brief, task description), not inherit a long conversation history that
   has been compressed and degraded. The one-task-per-session rule was the
   single most important reliability improvement.

3. **Encode lessons as prompts, not as hope.** When an agent fails in a
   novel way, the fix is a CASS lesson injected into future prompts — not a
   hope that the next agent will do better. Agents have no memory. If you
   want changed behavior, you must change the input.

4. **Pin your dependencies.** The most expensive debugging sessions were
   caused by running a stale version of an upstream tool. The fix had been
   released weeks earlier. Auto-update scripts for critical toolchain
   dependencies are not optional.

5. **Monolithic planning is the wrong default.** Having Scout plan the entire
   application upfront meant nothing was deployable until most of the work
   was done. Progressive planning (minimal viable subset, deploy, iterate)
   would have produced working software earlier and created feedback loops
   that monolithic planning denied.
