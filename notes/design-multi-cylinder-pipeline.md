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
Warden → Groomer/Tower (quality feedback, sizing data)
Judicar → Summoner (retry/split/re-groom decisions on failure)
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

   The distinction matters because roles drive **authorization** (can this person do this
   action?) while state drives **UI behavior** (empty state vs populated, pagination).
   Scout defines roles. Tower addresses both roles AND states in use cases.

   Roles go in CLAUDE.md or a dedicated ROLES.md. Every downstream agent reads them.

3. **Phase ordering** — high-level, not bead-level. "Auth before programs before sprints
   before planning before coordination." Each phase gets a one-paragraph description with
   exit criteria written as user capabilities, not implementation tasks.

4. **Forward-looking constraints** — technology needs that aren't required yet but will
   be. "Phase 7 will need real-time updates; plan for WebSocket support." This is the
   "last responsible moment" principle: defer decisions until you must make them, but
   communicate the constraint early so no one paints a later phase into a corner.

5. **Seed persona definitions** — concrete test users mapped to roles:

   ```
   - Ava Stone (admin) — tests admin flows
   - Milo Rivera (member, program lead for Lighthouse) — tests elevated member flows
   - Priya Narang (member) — tests basic member flows
   ```

   The smoke test and flow-level integration tests use these personas as their test
   matrix. "Curl as Ava" and "curl as Priya" should produce different results where
   roles diverge.

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

   **Critical:** dependencies are flow-to-flow, not step-to-step. "The issues web
   pages flow depends on the issues API flow" — meaning the pages flow starts AFTER
   the API flow has fully completed and merged to main. Not "pages flow starts after
   API flow step 3." This is coarser but dramatically simpler to schedule, reason
   about, and recover from.

3. **Acceptance criteria per feature** — written as role-specific user actions that the
   integration test and smoke test can verify. "Curl as Ava (admin) → see all plans.
   Curl as Priya (member) → see only her plans."

**Tower does NOT create beads.** It creates feature descriptions that the Groomer
decomposes. This is the key structural change from the current system.

### Groomer: Execution Planner (NEW)

**Thinks about:** the codebase as it exists right now.

The Groomer is the missing layer between Tower's abstract product planning and Trench's
concrete code execution. It reads the codebase just-in-time — minutes before execution,
not hours before — and produces a plan that references actual files, actual interfaces,
actual patterns.

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

3. **Parallel safety assessment** — identifies which steps within the chain are truly
   sequential vs. potentially parallelizable. However, within a single flow, steps
   execute sequentially by default. The parallel safety assessment primarily informs
   how flows interact: "This flow touches only api/src/issues*. Flow B touches only
   api/src/sprints*. No file overlap, safe to run simultaneously."

**The Groomer's real job is synchronization.** It solves the readers-writers problem
that plagues the current system. Within a flow, ordering is trivially correct: each
step commits to the flow's branch and the next step reads from that branch. Between
flows, the Groomer ensures they touch different file areas so merge conflicts are
minimized when flows merge to main.

**Re-grooming on failure:** If a step fails and the Groomer's plan was wrong (file
reference stale, interface changed), the Summoner re-invokes the Groomer on the
remaining steps. The Groomer reads the codebase fresh (including partial work already
on the flow branch), sees what actually exists now, and produces a corrected chain
for the remaining work. Cost: ~50-100K tokens — far cheaper than retrying a bad bead
repeatedly.

### Trench: Code Executor

**Thinks about:** one implementation step.

**Inputs:** one concrete step from the Groomer's chain, the flow branch (which contains
all previous steps' work), CLAUDE.md conventions, user role context from the feature
use case.

**Outputs:** code committed to the flow branch, tests, verified against quality checks.

Trench is unchanged from the current system except:
- It receives more specific instructions (file names, interfaces to extend)
- It knows the user role context ("this route is member-only, add role check")
- It knows it's part of a sequential chain (no dependency surprises)
- It commits to a **flow branch**, not a per-step branch on main

### Summoner: Flow Orchestrator

**Manages:** flow lifecycle, slot assignment, inter-flow dependencies, failure handling.

The Summoner's role changes from dispatching individual beads to managing flow
lifecycles. Each slot runs one flow at a time. Multiple flows run in parallel across
slots.

## Git Model: Feature Branches, Not Per-Step Merges

This is a critical design decision that affects everything below.

### Why NOT per-step merge to main

An earlier draft proposed merging each step to main as it completes, so the next step
(and other flows) always see the latest global state. This is wrong because:

1. **It destabilizes the execution environment.** The Groomer planned the flow's chain
   based on the codebase at flow start. If another flow's step merges to main mid-flow,
   and the current flow rebases, suddenly there are new files, new types, new patterns
   that the Groomer didn't account for. The next Trench encounters unexpected code. This
   is the exact same problem that plagues the current bead-dispatch system, just smaller.

2. **Partial merges are incoherent.** Merging step A1 (issue schema) to main without A2
   (issue repository) and A3 (issue routes) means main has a schema that nothing uses.
   Other flows might see it and make wrong assumptions. The schema only makes sense in
   the context of the complete feature.

3. **Rollback is hard.** If Flow A fails on step A3 and can't recover, but A1 and A2
   are already on main, you can't easily undo them. With feature branches, `git branch
   -D flow-a` and it's gone — main is untouched.

### Feature branches: one branch per flow

Each flow gets a long-lived feature branch that persists for the entire flow lifecycle.
All steps within the flow commit to this branch. The branch merges to main only when
the entire flow completes (including its integration test).

```
main ──────────────────────────── merge A ── merge B ── merge C ──
  \                               /          /          /
   flow-a: ── A1 ── A2 ── A3 ───           /          /
  \                                        /          /
   flow-b: ── B1 ── B2 ── B3 ────────────           /
  \                                                 /
   flow-c: (starts after A merges) ── C1 ── C2 ───
```

**Within a flow:** Each step sees the previous step's work because it's on the same
branch. A2 reads what A1 wrote. No merge, no rebase, no surprise. The Groomer's plan
stays valid for the entire flow because the branch is stable — only this flow's
Trenches write to it.

**Between flows:** Flows A and B run in parallel on separate branches. They don't see
each other's work. This is fine because the Groomer planned them to touch different
file areas. When they merge to main, conflicts are between two complete, coherent
features — much easier to resolve than conflicts between partial-work fragments.

**Cross-flow dependencies:** When Flow C depends on Flow A, Flow C starts AFTER Flow A
has fully merged to main. Flow C branches from the updated main, so it has all of
Flow A's code. This is flow-to-flow dependency, not step-to-step. It's coarser than
"start C after A step 3" but dramatically simpler and more robust:

- The Summoner tracks flow-level deps, not step-level
- Flow C's Groomer sees Flow A's complete code, not partial fragments
- No inter-flow signaling protocol needed — just "is Flow A merged? Then start C."
- If Flow A fails entirely, Flow C simply doesn't start (clean, no partial state)

### Worktree lifecycle

One worktree per slot. The worktree persists for the life of the flow. This also
solves several operational problems from the current system: scattered session logs,
stale worktree branches blocking other slots, and worktrees being destroyed/recreated
on circuit breaker resets.

```
Flow assigned to Slot 0:
  1. ensureWorktree(0)                        // create or verify slot-0 worktree
  2. git checkout main && git reset --hard    // start from latest main
  3. git checkout -b flow-a                   // create flow branch

  For each step in chain:
    4. Trench executes step, commits to flow-a
    5. Quality checks (typecheck, lint, test) on flow-a branch
    6. If step fails: retry on same branch, or re-groom remaining steps

  After all steps:
    7. Run flow-level integration test on flow-a branch
    8. Run flow-level Warden audit on flow-a branch
    9. git checkout main (on main worktree)
   10. git merge flow-a --no-edit
   11. Handle merge conflicts if any (resolution Trench)
   12. Detach worktree, release slot
```

**Key detail in step 4:** The Trench commits directly to the flow branch, not to a
sub-branch. There's no per-step branching within a flow. The flow branch accumulates
commits: A1's commit, then A2's commit on top, then A3's on top of that. Each Trench
session starts by reading the flow branch (which has all prior steps) and commits its
work there.

**Key detail in step 6:** On step failure, the retry runs on the SAME flow branch with
the SAME accumulated state. The retry hint tells the Trench: "Step 3 failed with
typecheck error X. The branch has steps 1-2 committed. Fix the issue and commit."
If the step fails twice, the Summoner can re-invoke the Groomer to re-plan the
remaining steps, reading the flow branch (with its partial work) as the new starting
point.

### Session logs and traceability

With one worktree per flow, logs become naturally coherent:

```
[flow-issues-api/slot-0] Step 1/4: creating issue schema
[flow-sprints-api/slot-1] Step 1/3: creating sprint schema
[flow-issues-api/slot-0] Step 2/4: creating issue repository
[flow-sprints-api/slot-1] Step 2/3: creating sprint routes
[flow-issues-api/slot-0] Step 3/4: creating issue routes
```

Every line has flow ID + slot + step progress. Grep `flow-issues-api` to see one
feature's complete journey. Session files live in a per-flow subdirectory:
`.scuffy/sessions/flow-issues-api/step-1.jsonl`, `step-2.jsonl`, etc.

## The Summoner Main Loop

The Summoner changes from a bead-dispatch loop to a flow-scheduling loop:

```typescript
async function mainLoop(): Promise<void> {
  for (;;) {
    // Phase-level checks
    if (allFlowsComplete()) {
      runPhaseWarden();        // holistic cross-flow audit
      runPhaseSmokeTest();     // full integration verification
      expandNextPhase();       // Tower plans next phase
      continue;
    }

    // Assign ready flows to empty slots
    for (const slot of emptySlots()) {
      const flow = nextUnblockedFlow(interFlowDeps);
      if (!flow) break;

      // Groomer plans the chain just before execution starts
      const chain = runGroomer(flow.feature, flow.slot);
      assignFlowToSlot(slot, flow, chain);
      dispatchStep(slot);  // start step 1
    }

    // Wait for any active step to finish
    const finished = await waitForAnyStep();

    if (finished.success) {
      if (finished.flow.hasNextStep()) {
        // Advance to next step in same flow, same branch, same worktree
        dispatchStep(finished.slot);
      } else {
        // Flow complete — verify and merge
        runFlowIntegrationTest(finished.slot, finished.flow);
        runFlowWarden(finished.slot, finished.flow);
        mergeFlowToMain(finished.flow.branch);
        releaseSlot(finished.slot);
        // Check if this unblocks other flows
        checkInterFlowDeps();
      }
    } else {
      handleStepFailure(finished);
      // retry, re-groom, or escalate to Judicar
    }
  }
}
```

### Step failure handling

**Attempt 1 failure:** Retry on the same slot, same branch. The flow branch has all
prior steps' work plus the failed step's partial changes. The retry Trench gets a hint:
"Step 3 failed with error X. Prior steps are committed. Fix and finish."

**Attempt 2 failure:** Re-invoke the Groomer. The Groomer reads the flow branch as-is
(steps 1-2 committed, step 3's partial work either committed as WIP or reverted). It
produces a corrected plan for the remaining steps, potentially splitting the failed
step or approaching it differently. Cost: ~50-100K tokens. The flow continues from the
re-groomed plan.

**Attempt 3 failure (after re-groom):** Escalate to Judicar. Judicar decides:
- **Skip this step** and continue the flow (if the step was optional, like tests)
- **Abandon the flow** and release the slot (if the feature is fundamentally blocked)
- **Split the flow** into sub-flows with an intermediate merge point
- **Request human input** via mail (if the problem is architectural, not operational)

Other flows are unaffected by any of this. The failure is scoped to one slot, one flow.

### Inter-flow dependency resolution

The Summoner maintains a flow dependency graph derived from Tower's feature ordering:

```typescript
interface FlowDep {
  flow: FlowId;
  dependsOn: FlowId;  // flow-level, not step-level
}
```

A flow is "ready" when all flows it depends on have merged to main. The Summoner checks
this before assigning flows to slots:

```typescript
function nextUnblockedFlow(deps: FlowDep[]): Flow | null {
  for (const flow of pendingFlows) {
    const blockers = deps
      .filter(d => d.flow === flow.id)
      .filter(d => !completedFlows.has(d.dependsOn));
    if (blockers.length === 0) return flow;
  }
  return null;
}
```

When a flow merges to main, `checkInterFlowDeps()` re-evaluates all pending flows.
Newly unblocked flows get assigned to empty slots immediately.

**Stall detection:** If all slots are empty and no flows are unblocked, either:
- All remaining flows depend on a failed/abandoned flow → Judicar decides
- There's a circular dependency → Groomer bug, Judicar escalates to Chair

## Warden Placement

Three natural audit points, from most to least frequent:

### 1. Flow-level Warden (after each flow completes)

Runs on the flow branch before merging to main. Scoped audit of that feature's code:
- Does the issues API follow established conventions?
- Are there type safety issues in the new code?
- Test coverage for the new feature?
- Are the new files consistent with existing patterns?

This is fast (~2-3 minutes) because it's reviewing 3-8 files, not an entire phase.
If the Warden finds issues, it creates fix steps that append to the flow's chain.
The fixes are applied on the flow branch before merging. This means Warden issues
never pollute main — they're caught and fixed pre-merge.

### 2. Phase-level Warden (after all flows merge)

Runs on main after all flows for a phase have merged. Holistic cross-flow audit:
- Do issues and sprints use the same API patterns?
- Are there inconsistencies between features built by different flows?
- Are there integration gaps between features?

This replaces the current phase-boundary Warden and works the same way: creates fix
beads (or fix flows), Judicar filters, Trenches execute.

### 3. Never mid-flow

A flow is internally coherent — the Groomer planned it as a unit, and the Trenches
execute it sequentially. Auditing half a feature is pointless and would create noise.
The flow-level Warden at completion is the right moment.

## Judicar: Reduced but Still Essential

Judicar invocations drop dramatically because the multi-cylinder architecture
eliminates the primary failure modes:

| Current failure mode | Why it happens | Why it's gone |
|---------------------|----------------|---------------|
| Dependency ordering failures | Beads dispatched before deps land | Steps are sequential within a flow |
| Stale codebase references | Tower planned hours ago | Groomer reads just-in-time |
| Circuit breaker cascades | 5 random beads all fail | Failures scoped to one flow |
| Attempt counter filtering | Beads filtered after 2 tries | Re-groom produces new plan |

**Judicar is still needed for:**

1. **Step failure after re-groom** — the Groomer re-planned but it still fails. Is
   the feature fundamentally blocked? Should we skip it? Split differently?

2. **Inter-flow dependency timeout** — Flow A has been stuck for 30 minutes, Flow C
   is waiting. Can C proceed with a mock? Should A be abandoned?

3. **Warden bead triage** — same as current. Flow-level Warden proposes fixes; Judicar
   filters which are worth doing before merge.

4. **Ad hoc anomaly detection** — the Summoner detects unusual system-level conditions
   (multiple flows stalling simultaneously, main broken after a merge, memory pressure)
   and spawns Judicar for a judgment call. This is NOT triggered by individual bead
   failure counts but by system-level pattern recognition.

**Estimated frequency:** 2-3 Judicar invocations per phase, down from 15-20 in the
current system.

## The Engine Metaphor

The current system is a single-cylinder engine:

```
[plan ALL beads] → [execute ALL in parallel] → [test ALL at phase end]
```

Big power stroke, long dead time between firing, and if one cylinder misfires the
whole rotation stalls.

The multi-cylinder system:

```
Cylinder 1: [groom] → A1 → A2 → A3 → [verify] → [warden] → merge
Cylinder 2: [groom] → B1 → B2 → [verify] → [warden] → merge
Cylinder 3: (waits for Cyl 1) → [groom] → C1 → C2 → [verify] → [warden] → merge
```

Multiple overlapping plan-execute-verify cycles. Each cylinder fires at a different
point. More continuous power delivery, less wasted time, and a misfire in one cylinder
doesn't stall the others. Each cylinder runs a complete feature from planning through
verification to merge — a coherent vertical slice, not scattered horizontal layers.

## Parallelism Analysis

The current system has 3 parallel slots but achieves far less than 3x throughput
because of global stop-the-world operations. The multi-cylinder architecture
eliminates most of these, achieving near-continuous slot utilization.

### What freezes all slots in the current system

Every one of these calls `drainAllSlots()` or runs a blocking `spawnRoleClean()` on
the main worktree, halting all parallel work:

| Operation | Frequency | Duration | Trigger |
|-----------|-----------|----------|---------|
| Warden drain (dark + light) | Every N beads or phase end | 20-40 min (8-12 serial Trench sessions) | `completedSinceWarden >= WARDEN_INTERVAL` |
| Emergency P0 bypass drain | ~5x per phase | 2-5 min each | `finishBead` detects pre-existing failures |
| Circuit breaker pause | 1-3x per phase | 5-10 min | 5 consecutive parallel failures |
| Tower phase expansion | 1x per phase | 3-5 min | Phase placeholder detected |
| Judicar triage | ~15-20x per phase | 1-2 min each | Bead fails 2x |
| Merge conflict resolution | ~5-10x per phase | 2-3 min each | `mergeToMain` returns "conflict" |

In a typical 60-minute phase (like phases 5-6 in our run 6), estimated time with
all 3 slots occupied: ~25-30 minutes. The rest is global stops, drains, and serial
operations. **Practical parallelism: ~1.3-1.5x despite having 3 slots.**

### What freezes slots in multi-cylinder

Almost nothing is global. Failures, Warden, and Judicar are all scoped to one flow
on one slot. Other slots keep running.

| Operation | Scope | Impact on other slots |
|-----------|-------|----------------------|
| Step failure + retry | One flow, one slot | **None** — other flows keep running |
| Re-groom on failure | One flow, one slot | **None** — Groomer runs on that slot |
| Judicar triage | One flow, one slot | **None** — Judicar runs for that flow |
| Flow-level Warden | One flow, one slot | **None** — runs on flow branch pre-merge |
| Merge to main | Brief serialized op | **Seconds** — other slots stall briefly for merge lock |
| Phase boundary | All slots | **Natural sync** — all flows done, slots idle anyway |

**The emergency P0 bypass cascade disappears entirely.** Quality checks run per-step
on the flow branch. If a step breaks something, it's caught on that flow, retried on
that slot. Other flows never see it because it's not on main yet. There is no global
"main is broken, drain everything" event.

**The Warden drain disappears.** Flow-level Warden runs on the flow's slot after the
flow's last step, auditing the flow branch before merge. If it finds issues, fix steps
are appended to the flow's chain and executed on the same slot. No drain, no global
stop. Phase-level Warden runs at the natural sync point (all flows done = all slots
idle anyway — no drain needed).

### Projected utilization

For a phase with 3-4 features, 3 slots, ~45 minutes of execution time:

| | Current system | Multi-cylinder |
|---|---|---|
| Theoretical max | 3x (135 slot-minutes) | 3x (135 slot-minutes) |
| Global stop time | ~30-35 min (drains, P0s, circuit breakers) | ~5-7 min (phase boundary only) |
| Effective slot-minutes | ~60-75 | ~120-128 |
| Practical parallelism | 1.3-1.5x | 2.5-2.8x |

This means a clean phase that takes 60 minutes in the current system should take
~35-40 minutes in multi-cylinder — not because individual steps are faster, but
because slots are almost never idle.

**Caveat on phase 4:** Our phase 4 took 4.5 hours, but ~3 hours of that was a
specific bug (dependency ordering + router architecture issue), not parallelism
overhead. The honest comparison is phases 5-6, which ran clean at ~60 minutes each.
Multi-cylinder would cut those to ~35-40 minutes through better slot utilization.
The dependency ordering bug would also not have occurred in multi-cylinder (steps
are sequential within a flow), but attributing the full 3-hour savings to parallelism
would be misleading.

### The deeper point: failure isolation

The parallelism improvement is significant, but the bigger win is **failure blast
radius**. In the current system, one bad bead can cascade into a global stop:

```
Bad bead → bypass → P0 created → drain all slots → serial fix → health check loop
```

Every slot stops. Every in-flight bead's work is wasted. Recovery takes 10-20 minutes
of wall time with zero productive work happening.

In multi-cylinder:

```
Bad step → retry on this slot → re-groom if needed → other slots unaffected
```

One slot loses 5 minutes. The other two keep producing. The system degrades
gracefully instead of catastrophically.

## Conway's Law Alignment

The communication structure determines the system architecture:

| From | To | Channel | What | When |
|------|----|---------|------|------|
| Scout | Everyone | CLAUDE.md | Stack, roles, constraints | Once |
| Scout | Tower | Phase descriptions | Scope + exit criteria | Once |
| Tower | Groomer | Feature use cases | Per role, acceptance criteria | Per phase |
| Groomer | Trench | Implementation chain | File-specific steps, sized | Per feature |
| Trench A | Trench B | **The codebase** | Patterns, interfaces, code | Implicitly |
| Warden | Groomer/Tower | Quality + sizing report | Convention violations, sizing data | Per flow + per phase |
| Judicar | Summoner | Decisions | Retry / re-groom / skip | On failure |

**The codebase is the primary inter-Trench communication channel.** Trench A doesn't
message Trench B. Within a flow, communication is through the flow branch — each step
reads what the previous step wrote. Between flows, communication is through main —
when Flow A merges, all subsequent flows branch from a main that includes A's code.

Every failure in the current system is some form of "an agent read the codebase before
the code it needed was there." The multi-cylinder architecture solves this structurally:
- Within a flow: steps are sequential on the same branch (trivially correct)
- Between flows: flows branch from main after their dependencies merge (correct by scheduling)
- The only remaining timing risk is merge conflicts when parallel flows touch the same
  files, which the Groomer minimizes by assigning non-overlapping file areas to
  concurrent flows.

## Token Cost

The Groomer adds ~50-100K tokens per feature (read codebase, plan, size, assess
parallel safety). For a phase with 3-4 features, that's 200-400K extra tokens (~$2-4).

Re-grooming on failure adds another 50-100K per incident. Expected: 0-1 re-grooms per
phase in steady state.

Flow-level Warden adds ~100-200K tokens per flow (scoped audit of 3-8 files). For 3-4
flows per phase: 300-800K tokens (~$3-8).

Total overhead per phase: ~$5-12.

For comparison: a clean phase in the current system (phases 5-6) runs ~60 minutes
with ~15-20M tokens across all sessions. The multi-cylinder overhead adds ~$5-12 but
saves ~20 minutes of wall time by keeping slots occupied. The overhead pays for itself
in the first phase through fewer retries and less wasted work.

Note: phase 4 burned ~20M tokens in thrashing over 4 hours, but that was primarily
a dependency ordering bug plus a specific router architecture issue — not a fair
comparison for parallelism savings alone. The multi-cylinder architecture would have
prevented the dependency ordering bug (sequential steps within a flow), but the
router issue would still have required human guidance.

## What This Doesn't Solve

- **Scout's technology choices being wrong** — if Scout picks the wrong framework,
  everything downstream suffers. This is the same in any architecture.
- **Genuinely hard bugs** — a subtle React Router + jsdom interaction that crashes
  the test environment. No amount of planning prevents this.
- **External service failures** — API key errors, mail server crashes, Docker issues.
  These are operational, not architectural.
- **Tower creating bad feature decompositions** — if Tower groups the wrong use cases
  into a feature, the Groomer inherits a bad scope. Tower still requires product
  judgment. The Groomer can flag "this feature is too broad to be one flow" but it
  can't fix Tower's product thinking.

## Implementation Path

1. **Add Groomer role** with prompt and tool access (describeModule, listNamespace,
   createBead). Follows the same spawn/prompt/exit pattern as existing roles. The
   prompt needs: feature use case input, instructions to read codebase and produce a
   sized chain, parallel safety assessment template.

2. **Modify Tower** to output feature use cases with role-specific acceptance criteria
   instead of beads. Tower's prompt changes from "create 8-15 beads" to "identify
   3-5 features as use cases, order them by dependency, write acceptance criteria."

3. **Add flow management to Summoner:**
   - Flow state machine: `pending → grooming → executing → testing → auditing → merging → done`
   - Step state machine within flow: `dispatched → running → committed → done`
   - Inter-flow dependency graph (flow-to-flow only, not step-to-step)
   - Slot affinity: a flow stays on one slot for its entire lifecycle
   - Feature branch lifecycle: create at flow start, merge at flow end

4. **Add user role taxonomy to Scout prompt** — output ROLES.md with role definitions,
   seed personas, and the role → capability mapping.

5. **Add flow-level integration test and Warden** — after each flow completes on its
   branch, run a scoped curl/test check and a scoped Warden audit before merging.

6. **Modify Judicar for flow-level triage** — re-groom as a recovery option (instead
   of only retry/split), inter-flow dependency timeout handling.

7. **Log format changes** — prefix with flow ID + slot + step progress. Session files
   in per-flow subdirectories.

**Estimated complexity:** medium-high. The Groomer is straightforward (new role,
existing spawn pattern). The Summoner flow management is the hardest part — the state
machine with inter-flow dependencies, slot affinity, and the feature branch lifecycle
is more complex than the current dispatch loop. But the current loop's apparent
simplicity is deceptive: the retry/circuit-breaker/Judicar/bypass/drain logic makes it
equally complex and far less predictable.

**Risk mitigation:** implement incrementally. Start with single-flow execution (one
cylinder, no parallelism) to validate the Groomer → step chain → flow branch → merge
lifecycle. Then add multi-flow parallelism. Then add inter-flow dependencies. Each
increment is independently testable.
