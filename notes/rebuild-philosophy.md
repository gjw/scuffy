# Ship Rebuild — Philosophy Discussion

Date: 2026-03-24

## Context

MVP engineering is complete (12/12 beads closed, tagged `mvp` at `b8342da`).
Next milestone: Early Submission (Thu 2026-03-26 23:59) — Ship rebuild complete,
comparative analysis drafted, multi-agent coordination working.

Two strategic questions to resolve before creating beads for the rebuild phase,
plus questions about session management, handoff, and intervention.

---

## Question A: How to generate the PRD that Scuffy consumes

### Options considered

**Option 1: Tower-crafted full spec, Scuffy executes.** You control what gets
built. Cheapest execution. But pre-chewed spec produces boring analysis — Scuffy
just follows orders.

**Option 2: Minimal spec — schema + contracts + "build a PM app".** Maximum
divergence, cheapest planning. But "all current features" is vague without a
feature list.

**Option 3: Hybrid — feature checklist + schema, no architecture prescription.**
Enough guardrails for feature coverage without prescribing how.

**Option 4: Sonnet does analysis, Opus does execution.** Dramatically cheaper
planning phase.

### Decision: Option 3 + Option 4 — curated feature brief, Scuffy creates beads

Use Sonnet (or Tower) to extract a compact context bundle from FleetGraph — schema,
feature checklist, key behaviors — maybe 3-5k tokens. Scuffy's first instruction
is: "Here's what we're building. Create your build plan as beads, then start
executing." Scuffy owns the entire decomposition.

**Rationale:**

- Planning step is cheap (~$0.50 in Opus tokens). "Token pig" is a concern for
  reading 336 raw files, not a curated brief.
- The decomposition IS interesting analysis data.
- Human reviews beads before approving execution.
- `bv --robot-next` handles prioritization once beads exist.

---

## Question A.1: Self-authored conventions

### Decision: Two-layer approach

| Layer | Who writes | What | Why |
|---|---|---|---|
| **Quality floor** | Us, injected as non-negotiable context | `strict: true` tsconfig, no `any`, no `@ts-ignore`, Zod at boundaries | Minimum standards, not architectural choices |
| **Architecture + conventions** | Scuffy, self-authored in workspace CLAUDE.md | Framework, ORM, file structure, patterns, naming, error handling, testing strategy | These ARE choices — the agent's picks are the interesting data |

We do NOT prescribe roles (tower/trench/warden) — let Scuffy decide what process
it needs. If it independently invents a review step, that's interesting. If it
doesn't, that's also interesting. The finishBead tool provides mechanical quality
enforcement regardless.

---

## Question B: Intervention strategy

### Reframing

The comparative analysis is the most heavily weighted deliverable — not the rebuild.
The rebuild generates data for the analysis. Interventions are "data, not failures."

### Options considered

**Option 1: Phase gates with checkpoints.** Human reviews every 30-60 min.
**Option 2: Let it rip.** Single long session. Risks token waste + context rot.
**Option 3: Phase gates with restart budget.** Nuke after 2 corrections.
**Option 4: Two-pass (Sonnet draft, Opus polish).** De-risks but muddies "from scratch."

### Decision: Autonomous bead-driven execution with brakes

Beads ARE the phase gates. Scuffy runs autonomously — finds work with
`bv --robot-next`, executes, verifies with `finishBead`, exits. Summoner spawns
the next session. Human reviews at leisure by inspecting bead closures and code.

**Intervention mechanisms:**

| Mechanism | Who triggers | What happens |
|---|---|---|
| `finishBead` tool | Scuffy | Runs checks → commit → close bead → exit 0 |
| `escalate` tool | Scuffy | Commit work → log reason → exit 1 → summoner pauses |
| `.pause` file | Human | Summoner stops spawning until file removed |
| Bead reopen | Human | `br update <id> --status=open` + add notes |
| Git rollback | Human | `git reset` to tag + reopen beads |

**Replanning:** Scuffy can call `escalate(reason: "need_replan")` if it realizes
the bead decomposition is wrong. Summoner pauses. Human (or Tower session) adjusts
beads. Remove `.pause`, summoner continues.

**Human can always:** touch `.pause` to stop the loop, deploy/inspect Ship at that
point, adjust beads, and resume when ready.

---

## Session Management: Beads as handoff

### The gap

PRESEARCH.md decided fresh-context-per-iteration is powerful (Ralph pattern) and
listed SummarizationMiddleware as post-MVP. Neither was built. The agent loop
accumulates messages with no context management.

### The solution

Beads decouple progress from context:

| Need | Mechanism |
|---|---|
| What's done | `br list --status=closed` |
| What's next | `bv --robot-next` |
| Ordering | Bead dependencies |
| Task context | Bead description + acceptance criteria |
| Persistence | `.beads/beads.jsonl` on disk, committed to git |

Kill the process, lose context, keep progress. New Scuffy picks up seamlessly.

---

## Architecture: Suicide and Rebirth

### The tools

**`finishBead`** — deterministic completion gate:

```
Scuffy calls finishBead(beadId, summary, checks?)
  → run typecheck (if in checks)
  → run lint (if in checks)
  → run tests (if in checks)
  ├─ ANY FAIL → return errors as tool result, Scuffy keeps working
  └─ ALL PASS → git add + commit → br close → log session_end → exit 0
```

Default checks: typecheck + lint. Tests added when test suite exists.

**`escalate`** — graceful exit without completion:

```
Scuffy calls escalate(reason, message)
  → git add + commit current work (if changes)
  → log escalation event with reason + message
  → exit 1
```

Reasons: `stuck`, `need_replan`, `blocked`.

### The summoner

```bash
#!/bin/bash
# scripts/summoner.sh
WORKDIR="${1:-workspace/ship-rebuild}"
MAX_SLOTS=1  # Hook for future multi-scuffy

while true; do
  # Brake check
  [ -f "$WORKDIR/.pause" ] && echo "Paused." && \
    while [ -f "$WORKDIR/.pause" ]; do sleep 5; done

  # Find work
  NEXT=$(cd "$WORKDIR" && br ready --json | jq -r '.[0].id // empty')
  [ -z "$NEXT" ] && echo "No beads ready. Done." && break

  # Spawn
  echo "=== Spawning Scuffy ==="
  scuffy --headless --workdir "$WORKDIR"
  EXIT=$?

  # Handle exit
  case $EXIT in
    0) echo "Bead complete. Next..." ;;
    1) echo "Scuffy escalated. Review needed." && read -p "Enter to continue..." ;;
    *) echo "Error (exit $EXIT). Review needed." && read -p "Enter to continue..." ;;
  esac
done
```

### Headless mode

`--headless` flag on CLI. Skips REPL, runs one agent loop. System prompt tells
Scuffy to use `bv --robot-next` to find work. Same middleware pipeline, same JSONL
session logs.

---

## Git Strategy for Rebuild

### Decision: Separate git repo in workspace/ship-rebuild/

The Ship rebuild is a different codebase — different package.json, different
dependencies, different purpose. Own git repo means:

- Scuffy's git operations don't touch the agent's repo
- Blow away and restart = `rm -rf workspace/ship-rebuild && mkdir workspace/ship-rebuild && git init`
- Tag attempts: `attempt-1`, `attempt-2`
- For submission: commit workspace contents into Scuffy repo or branch

### Workspace initialization (Chair does manually, document for automation)

```bash
mkdir -p workspace/ship-rebuild
cd workspace/ship-rebuild
git init
br init --prefix ship
npm init -y
```

---

## Reference Access

### Decision: readReference tool

Separate tool from readFile with distinct semantics:

| | readFile | readReference |
|---|---|---|
| Scope | workingDir (workspace) | FleetGraph source (configurable path) |
| Editable | Yes (tracked in fileReadTimestamps) | Read-only |
| Purpose | Scuffy's own code | Consulting the original Ship |
| Audit | "Read own file" in logs | "Consulted reference" in logs |

Session logs clearly distinguish "Scuffy reading its own code" from "Scuffy
consulting the original." Analysis gold: "Scuffy consulted the reference 47 times,
mostly for frontend component structure."

---

## Multi-Scuffy: Deferred, hooks preserved

Off the table for the rebuild. Hooks for future use:

- Summoner `MAX_SLOTS` variable (set to 1)
- `br update --status=in_progress` for bead claiming (prevents double-pickup)
- Bead dependencies prevent parallel work on dependent items
- Future: per-slot workspaces or git worktrees

This project pattern is likely reusable for future Gauntlet assignments.

---

## Execution Phases

```
┌──────────────────────────────────────────────────────┐
│                    PHASE 0 (Tower)                    │
│  Extract feature brief from FleetGraph               │
│  Write quality floor document                        │
│  Output: BRIEF.md + quality constraints              │
└──────────────────────┬───────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────┐
│           PHASE 1 (Tower + Chair, then Scuffy)       │
│  Design Phase 1 instruction together                 │
│  Scuffy session 1:                                   │
│    Read brief + quality floor (injected)             │
│    Write workspace CLAUDE.md (self-authored)          │
│    Create beads with br create + br dep add          │
│    Start first bead → finishBead → exit              │
│  Chair reviews beads before continuing               │
└──────────────────────┬───────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────┐
│       PHASE 2 (Summoner loop, N sessions)            │
│  Summoner: spawn → bv --robot-next → work →          │
│            finishBead/escalate → exit → spawn next   │
│  Human: .pause to brake, inspect, adjust beads       │
│  Scuffy: escalate if stuck or needs replan           │
└──────────────────────┬───────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────┐
│              PHASE 3 (Tower + Chair)                 │
│  Review session logs + rebuild output                │
│  Write comparative analysis (7 sections)             │
│  Complete CODEAGENT.md + remaining deliverables      │
└──────────────────────────────────────────────────────┘
```

---

## What the assignment requires

**Must:**

- Rebuild "all current features" of Ship
- Direct Scuffy to build it (not build by hand)
- Scuffy decides its own architecture (we provide data, not design)
- Document every intervention
- Produce the 7-section comparative analysis with specific evidence from rebuild log
- Run against real code — no mocked responses

**Must not:**

- Build Ship by hand
- Mock responses at any stage

**Does not require:**

- One-shot rebuild — phased direction is clearly permitted
- Perfect reproduction — architectural divergence is expected and valued
- Zero interventions — interventions are data, not failures
