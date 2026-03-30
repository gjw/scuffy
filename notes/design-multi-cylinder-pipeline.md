# Multi-Cylinder Pipeline — Design Spec

## The Problem

The current Scuffy pipeline is single-cylinder: Scout plans the project, Tower plans
an entire phase (8-15 beads), the Summoner dispatches beads to parallel slots, and
Trenches execute. This breaks down because:

1. **Tower plans against stale state.** Tower reads the codebase once, creates 12 beads.
   By the time bead 8 executes, beads 1-7 have changed the codebase. Tower's plan is
   stale before it's half-executed. Beads reference files that don't exist yet, assume
   interfaces that haven't been created, or target patterns that other beads have already
   changed.

2. **The unit of parallelism is wrong.** Three random beads from a flat list race each
   other and step on shared files. Merge conflicts are constant. Bead B (API routes) gets
   dispatched before Bead A (repositories) lands, fails because the code it depends on
   doesn't exist, retries, fails again, hits the circuit breaker. This wasted 3+ hours
   in our phase 4 run.

3. **Nobody thinks about users.** Tower creates implementation tasks ("add issues routes")
   instead of use cases ("a member can create an issue in their program"). Without user
   role specificity, permission boundaries are discovered during implementation or—worse—
   during smoke testing.

4. **Integration verification is deferred to phase end.** The smoke test runs after ALL
   beads in a phase complete. If a foundational bead failed silently (merged via bypass,
   or Judicar closed it prematurely), the smoke test discovers 10 problems at once instead
   of 1 problem immediately.

## The Architecture

### Agent Roles

```
Scout → CLAUDE.md (broadcast)
Scout → Tower (phase descriptions + user roles)
Tower → Groomer (feature use cases, dependency-ordered)
Groomer → Trench (implementation chains, sequenced per flow)
Warden → Tower (quality feedback, sizing data)
Judicar → Summoner (retry/split/skip decisions on failure)
```

### Scout: System Architect

**Thinks about:** the system as a whole.

**Outputs (once, at project start):**

1. **Technology decisions** — language, framework, database, testing strategy, CSS
   approach, API style, monorepo structure. These go in CLAUDE.md and are permanent.

2. **User role taxonomy** — the irreducible set of user types that drive authorization
   and UX differences. For Ship:

   ```markdown
   ## User Roles
   - Anonymous: sees landing page, redirected to login for everything else
   - Member: views all workspace data, creates/edits own work items, submits plans
   - Admin: full access, approves plans, manages programs, configures workspace
   - Program Lead: member + manages their program's projects and sprints
   ```

   The role taxonomy answers: "who are the distinct users, what can each do, and where
   do their capabilities diverge?" State (empty inbox, 100 issues) is NOT a role—it's
   a UI concern. Roles drive authorization boundaries.

   Roles go in CLAUDE.md or a dedicated ROLES.md. Every downstream agent reads them.

3. **Phase ordering** — high-level, not bead-level. "Auth before programs before sprints
   before planning before coordination." Each phase gets a one-paragraph description with
   exit criteria written as user capabilities, not implementation tasks.

4. **Forward-looking constraints** — technology needs that aren't required yet but will
   be. "Phase 7 will need real-time updates; plan for WebSocket support." This prevents
   early phases from making choices that paint later phases into a corner.

5. **Seed persona definitions** — concrete test users mapped to roles:

   ```
   - Ava Stone (admin) — tests admin flows
   - Milo Rivera (member, program lead for Lighthouse) — tests elevated member flows
   - Priya Narang (member) — tests basic member flows
   ```

   The smoke test uses these personas as its test matrix.

### Tower: Product Planner

**Thinks about:** users and their capabilities.

**Inputs:** phase description from Scout, current codebase (reads it fresh), user role
taxonomy, Warden sizing feedback from previous phases.

**Outputs (once per phase):**

1. **Feature use cases** — not "add issues routes" but:

   - "As a **member**, I can view and filter issues in my program's sprints"
   - "As a **member**, I can create an issue and assign it within my program"
   - "As an **admin**, I can create issues in any program and reassign across teams"
   - "As an **anonymous** user, I see a login prompt when trying to access issues"

   Each use case specifies the role, the action, and the expected outcome.

2. **Feature dependency ordering** — which features depend on which. "Issue creation
   depends on issue listing depends on issue persistence." This is coarse-grained—
   feature-level, not bead-level. The Groomer handles the fine-grained decomposition.

3. **Acceptance criteria per feature** — written as role-specific user actions that the
   smoke test can verify. "Curl as Ava (admin) → see all plans. Curl as Priya (member)
   → see only her plans."

**Tower does NOT create beads.** It creates feature descriptions that the Groomer
decomposes. This is the key structural change from the current system.

### Groomer: Execution Planner (NEW)

**Thinks about:** the codebase as it exists right now.

**Inputs:** one feature use case from Tower, the current codebase (reads it fresh just
before planning), established patterns from existing code, knowledge of what other
flows are planned (to avoid file conflicts).

**Outputs (once per feature):**

1. **An implementation chain** — a short sequence of concrete steps:

   ```
   Feature: "Member can create an issue in their program"
   Chain:
     A. Add Issue schema to shared/src/planning.ts (extends existing file)
     B. Add IssueRepository interface + in-memory impl to api/src/repositories/
     C. Add POST /issues route to api/src/issues.ts, wire into createApp
     D. Add IssueCreateForm component to web/src/pages/
     E. Integration test: curl POST /issues as Milo, verify 201
   ```

   Each step names specific files, references actual existing code, and is sized based
   on what the Groomer can see in the codebase.

2. **Size estimates** — based on actual file inspection, not guessing. "Step B requires
   creating 1 new file (~50 lines) and modifying 1 existing file (adding 2 lines to the
   repository index). Estimated: 12-15 tool calls."

3. **Parallel safety assessment** — "Steps A-C touch api/ only. Steps D touch web/ only.
   Step E touches both. Steps A-C and D can run in parallel. E must run after both."

**The Groomer's real job is synchronization.** Within a flow, each step reads the
codebase AFTER the previous step has written to it. Between flows, the Groomer ensures
they touch different file areas so read/write ordering doesn't matter. This is the
readers-writers problem, and the Groomer is the scheduler.

### Trench: Code Executor

**Thinks about:** one implementation step.

**Inputs:** one concrete step from the Groomer's chain, the current codebase, CLAUDE.md
conventions, user role context from the feature use case.

**Outputs:** code, tests, verified against quality checks.

Trench is unchanged from the current system except:
- It receives more specific instructions (file names, interfaces to extend)
- It knows the user role context ("this route is member-only, add role check")
- It knows it's part of a sequential chain (no dependency surprises)

### Summoner: Orchestrator

**Manages:** flow execution, slot assignment, failure handling.

**Key change:** The unit of dispatch is a **flow** (a Groomer's chain), not a bead.
Each slot runs one flow at a time, executing its chain sequentially. Multiple flows
run in parallel across slots.

```
Slot 0: Flow A — [schema] → [repo] → [routes] → [verify]
Slot 1: Flow B — [schema] → [repo] → [routes] → [verify]
Slot 2: Flow C — [client] → [page] → [tests] → [verify]
```

After each step in a flow, the Summoner merges to main before the next step starts.
This ensures the next step reads updated code. Between flows, merges happen
independently—conflicts are rare because flows touch different feature areas.

**Flow-level integration test:** After a flow completes all its steps, a quick
integration check runs (curl the new endpoint, verify the new page loads). This
catches problems immediately, scoped to one feature, not at phase end.

**Phase-level smoke test:** Still runs at phase end, but now it's a formality—most
issues were already caught by flow-level checks.

## The Engine Metaphor

The current system is a single-cylinder engine:

```
[plan ALL beads] → [execute ALL in parallel] → [test ALL at phase end]
```

Big power stroke, long dead time between firing, and if one cylinder misfires the
whole rotation stalls.

The multi-cylinder system:

```
Cylinder 1: [groom feature A] → [step 1] → [step 2] → [step 3] → [verify A]
Cylinder 2: [groom feature B] → [step 1] → [step 2] → [verify B]
Cylinder 3: [groom feature C] → [step 1] → [step 2] → [step 3] → [step 4] → [verify C]
```

Multiple overlapping plan-execute-verify cycles. Each cylinder fires at a different
point. More continuous power delivery, less wasted time, and a misfire in one cylinder
doesn't stall the others.

## Conway's Law Alignment

The communication structure determines the system architecture:

| From | To | Channel | What | When |
|------|----|---------|------|------|
| Scout | Everyone | CLAUDE.md | Stack, roles, constraints | Once |
| Scout | Tower | Phase descriptions | Scope + exit criteria | Once |
| Tower | Groomer | Feature use cases | Per role, acceptance criteria | Per phase |
| Groomer | Trench | Implementation chain | File-specific steps, sized | Per feature |
| Trench A | Trench B | **The codebase** | Patterns, interfaces, code | Implicitly |
| Warden | Tower | Sizing report | What blew budget, what was right-sized | Per phase |
| Judicar | Summoner | Decisions | Retry / split / skip | On failure |

**The codebase is the primary inter-Trench communication channel.** Trench A doesn't
message Trench B. Trench A writes code, merges to main, and Trench B reads main. Every
failure in the current system is: "Trench B read the codebase before Trench A's code
was there." The Groomer fixes this by controlling when each Trench reads.

## Cross-Flow Dependencies

The hard problem: Flow C (issue pages) needs Flow A (issue API) to exist first.

Options:
1. **Sequence the flows** — defeats parallelism
2. **Inter-flow signaling** — Flow C starts after Flow A's route step completes.
   The Groomer sees all planned flows and explicitly schedules this.
3. **Accept failure and retry** — current approach, but scoped to one flow step

Option 2 is preferred. The Groomer produces a dependency graph between flows:

```
Flow A: issue API       [schema → repo → routes → test]
Flow B: sprint API      [schema → repo → routes → test]
Flow C: issue pages     [client → page → test]  — starts after Flow A step 3
Flow D: sprint pages    [client → page → test]  — starts after Flow B step 3
```

The Summoner reads this graph and schedules accordingly. Flows A and B start
immediately on slots 0 and 1. When Flow A's route step merges, Flow C starts on
slot 2. When Flow B's route step merges, Flow D takes slot 2 next.

## Token Cost

The Groomer adds ~50-100K tokens per feature (read codebase, plan, size, sequence).
For a phase with 3-4 features, that's 200-400K extra tokens (~$2-4).

The phase 4 thrashing in the current system burned ~20M tokens over 4 hours of
retries. The Groomer pays for itself in the first complex phase.

## What This Doesn't Solve

- **Scout's technology choices being wrong** — if Scout picks the wrong framework,
  everything downstream suffers. This is the same in any architecture.
- **Genuinely hard bugs** — a subtle React Router + jsdom interaction that crashes
  the test environment. No amount of planning prevents this.
- **External service failures** — API key errors, mail server crashes, Docker issues.
  These are operational, not architectural.

## Implementation Path

1. Add Groomer role with prompt and tool access (describeModule, listNamespace, createBead)
2. Modify Tower to output feature use cases instead of beads
3. Add flow management to Summoner (slot affinity, inter-flow dependency graph)
4. Add user role taxonomy to Scout prompt
5. Add flow-level integration checks after each flow completes
6. Preserve Warden, Judicar, smoke test as-is (they work well in the current system)

Estimated complexity: medium. The Groomer is a new role but follows the same
spawn/prompt/exit pattern as existing roles. The Summoner changes are the hardest
part—flow management with inter-flow dependencies is more complex than the current
bead dispatch.
