# P1: finishBead "not my fault" bypass with pipeline pause

**Create as bead:** `br create --title="finishBead: detect pre-existing failures, bypass + emergency fix bead + pipeline pause" --type=feature --priority=1`

## Problem

Trench agents repeatedly waste entire sessions escalating on test/typecheck
failures they didn't cause. Each wasted session costs ~$8 in tokens. The
failures accumulate because nobody owns them — every Trench says "not my
fault" and escalates.

## Design (single Trench, current architecture)

### finishBead enhanced flow

1. Run quality checks (typecheck, lint, test)
2. If all pass → normal commit + close
3. If any fail → run `git diff --name-only HEAD` to get agent's changed files
4. Compare failing files against changed files:
   - **Agent's fault:** failure is in a file the agent modified → reject as normal
   - **Not agent's fault:** ALL failures are in files the agent didn't touch →
     bypass: commit the agent's work, close the bead, BUT:
     a. Create a P0 emergency bead: "Fix pre-existing failures in [files]: [errors]"
     b. Touch `.pause` file to halt the summoner
     c. Log a warning in the session JSONL
     d. Notify Chair via agent mail

5. The summoner is now paused. Next spawn sees `.pause` and waits.
6. The emergency P0 bead is the highest priority when resumed.
7. Chair (or an automated process) removes `.pause`, summoner picks up
   the emergency bead, a fresh Trench fixes the tests, and the pipeline
   continues clean.

### Why pause?

Without pause, the next Trench starts working on a DIFFERENT bead while
the tests are broken. Its finishBead also hits the pre-existing failures,
creates ANOTHER emergency bead, pauses again. If 3 Trenches are queued,
you get 3 identical emergency beads. Pausing immediately ensures exactly
one emergency bead and one fix attempt.

## Design (parallel Trenches in worktrees)

With multiple Trenches working simultaneously in separate git worktrees:

### The merge problem

Each worktree has its own working copy. Trench A and Trench B both pass
tests in their own worktrees. Both merge to main. The MERGE creates a
test failure that neither Trench caused — their code interacts badly.

### Detection at merge time

finishBead's merge step (checkout main, merge branch) should run tests
AFTER the merge, not just before:

1. Agent works on branch, commits, tests pass on branch
2. finishBead merges branch to main
3. finishBead runs tests AGAIN on main (post-merge check)
4. If post-merge tests fail:
   - Revert the merge (`git reset --hard HEAD~1` on main)
   - Agent's branch still has its clean work
   - Create emergency bead: "Merge conflict between [branch] and main:
     [failing tests]. Resolve before re-merging."
   - Pause pipeline
   - Notify Chair

This catches integration failures at merge time, before they pollute main.

### The baseline problem

When Trench A starts, it checks out main. If main already has broken tests
(from a previous integration failure that wasn't caught), Trench A is
screwed from the start.

Solution: the summoner runs `npm run test` on main BEFORE spawning a Trench.
If main's tests fail, DON'T spawn Trench — instead spawn the emergency fix
bead first. This is a cheap check (1-2 seconds) that prevents wasting an
entire session.

### Full parallel flow

```
Summoner loop:
  1. Check main health: npm run test on main
     - If FAIL → spawn emergency fix Trench, don't proceed until green
     - If PASS → continue

  2. For each available worktree slot:
     - Create worktree from main
     - Spawn Trench in worktree
     - Trench works on branch in worktree

  3. On Trench completion:
     - finishBead merges to main
     - Post-merge test run
     - If PASS → delete worktree, continue
     - If FAIL → revert merge, keep branch, create emergency bead, pause
```

## Key design decisions

### What counts as "not my fault"?

Strict: failure is in a file listed in `git diff --name-only` → agent's fault.
Otherwise → not agent's fault.

This is imperfect — the agent could break a test by changing a DEPENDENCY
that the test imports. But it's good enough for 90% of cases and avoids
false negatives (blaming the agent for something truly pre-existing).

A more accurate check: run tests on the PARENT commit (before agent's changes).
If the same tests fail there, they're definitively pre-existing. This costs
one extra test run but is 100% accurate.

### Should the bypass commit include the agent's work?

YES. The agent's code passes on its own (it was only blocked by someone
else's failure). Throwing it away wastes the session. Commit it, fix the
pre-existing issue separately.

### Should the pause be automatic or manual?

AUTOMATIC. The whole point is that this happens at 3am while Chair is asleep.
If the pipeline pauses, Chair wakes up to a clean problem description and
one emergency bead, not 15 failed sessions all hitting the same bug.

Chair can configure: `SUMMONER_AUTO_PAUSE_ON_PREEXISTING=1` (default true).

## Files involved

- `src/tools/finishBead.ts` — add pre-existing failure detection and bypass
- `src/summoner/index.ts` — add main health check before spawning
- `src/summoner/index.ts` — add post-merge test run (parallel mode)
- `src/tools/createBead.ts` — finishBead calls this internally for emergency beads

## Implementation phases

Phase 1 (now): Single-Trench bypass in finishBead. Detect, commit, create
emergency bead, pause. No worktree changes.

Phase 2 (parallel): Summoner main health check. Pre-spawn test run.
Emergency bead before any Trench starts.

Phase 3 (parallel merge): Post-merge test run. Revert on failure. Worktree
cleanup.
