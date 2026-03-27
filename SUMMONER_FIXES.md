# Summoner Pipeline Fixes

Six bugs identified from analyzing a live run. Fix them in the order listed —
each fix is independent, but #1 is the most impactful.

All changes are in `src/summoner/index.ts` unless noted otherwise.

---

## Fix 1: Pass known bead ID through handleExit in parallel mode

**File:** `src/summoner/index.ts`

**Problem:** In `mainParallel()` (line 1121-1123), when a slot fails, the code
calls `handleParallelFailure(finished.beadId)` (which correctly uses the slot's
tracked bead ID) and then `handleExit(finished.result)`. But `handleExit`
(line 776) calls `extractBeadId(result.output)` to parse the bead ID from the
agent's stdout — ignoring the already-known `finished.beadId`.

`extractBeadId` uses regex on stdout and can return the wrong bead ID (or
`null`/`"unknown"`) if the agent's output doesn't match the expected patterns.
This causes `splitBead` to be invoked with the wrong bead ID, which is why the
log shows "Budget exceeded on ship-rebuild-k2o" when the actual failing bead was
ship-rebuild-pt4.

**Fix:** Add an optional `knownBeadId` parameter to `handleExit`. When provided,
use it instead of parsing stdout.

```typescript
// Line 776: Add optional parameter
function handleExit(result: SpawnResult, knownBeadId?: string): void {
  const beadId = knownBeadId ?? extractBeadId(result.output);
  // ... rest unchanged
}
```

Then update the parallel mode call site (line 1123):

```typescript
} else {
  handleParallelFailure(finished.beadId);
  handleExit(finished.result, finished.beadId);
}
```

Also update the warden drain call site (line 768) — this one has no known bead
ID, so leave it as `handleExit(result)` (no second arg).

**Test:** Run with parallel slots. Trigger a budget-exceeded exit. Verify the
log message in `splitBead` shows the correct bead ID matching the slot's
`finished.beadId`.

---

## Fix 2: Add circuit breaker for consecutive failures

**File:** `src/summoner/index.ts`

**Problem:** The `drainWardenBeads()` loop (lines 759-769) spawns a Trench for
each warden bead, and if the Trench dies immediately (e.g., `Fatal: Connection
error`), the loop just tries again. Since connection errors produce exit code 1
with no parseable bead ID, `handleExit` does nothing to increment attempts or
halt. The loop retries indefinitely.

In the observed run, this caused **16 consecutive connection error spawns**,
each burning MCP setup and CASS injection overhead.

**Fix:** Add a consecutive-failure counter to `drainWardenBeads()`. After 3
consecutive non-zero exits, break out and log a warning.

```typescript
function drainWardenBeads(): void {
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;

  for (;;) {
    const beads = listBeads();
    const wardenBeads = beads.filter((b) =>
      b.status !== "closed" && (b.labels ?? []).includes("warden")
    );
    if (wardenBeads.length === 0) break;

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.log(
        `=== Circuit breaker: ${String(consecutiveFailures)} consecutive failures ` +
        `draining warden beads. ${String(wardenBeads.length)} warden bead(s) remain. ===`
      );
      notifyChair(
        "Circuit breaker tripped",
        `${String(consecutiveFailures)} consecutive Trench failures while ` +
        `draining warden beads. ${String(wardenBeads.length)} remain. ` +
        `Likely a connection or provider issue.`
      );
      break;
    }

    console.log(`=== ${String(wardenBeads.length)} warden bead(s) to fix ===`);
    const result = spawnRoleClean("trench");
    handleExit(result);

    if (result.exitCode !== 0) {
      consecutiveFailures++;
    } else {
      consecutiveFailures = 0;
    }
  }
}
```

Also add the same pattern to `mainParallel()`. After `handleExit` on a failed
slot, increment a `consecutiveParallelFailures` counter. Reset it on any
success. If it hits 5, log a circuit breaker message, notify chair, and break
the main loop.

**Test:** Kill the MCP mail server, run the summoner, verify it stops after 3
failures instead of looping indefinitely.

---

## Fix 3: Dependency-aware parallel bead assignment

**File:** `src/summoner/index.ts`

**Problem:** `preClaimBead()` (lines 614-653) filters eligible beads by status
(`open`) and excludes already-claimed IDs, but it does NOT check whether a
bead's dependencies are resolved. It uses `br ready --json` as a ranking
source but falls back to `br list --json` filtered to `status === "open"`,
which includes beads whose blockers haven't been closed.

In the observed run, slot-1 was assigned `ship-rebuild-b8n` which had three
unresolved blocking dependencies. The agent correctly refused to work on it,
but the session was wasted.

**Fix:** Use `br ready --json` as the **only** source for eligible beads, not
as a ranking layer on top of `br list`. If `br ready` returns nothing, don't
fall back to unfiltered beads — return null (no work available).

```typescript
function preClaimBead(phaseLabel: string | null, excludeIds: Set<string>): { id: string; title: string } | null {
  // Use br ready to get only dependency-unblocked beads
  const readyResult = br(`--no-auto-flush ready --json`);
  try {
    let rawReady: unknown = JSON.parse(readyResult);
    if (typeof rawReady === "object" && rawReady !== null && !Array.isArray(rawReady) && "issues" in rawReady) {
      rawReady = (rawReady as Record<string, unknown>)["issues"];
    }
    const ready = rawReady as Array<{ id: string; title: string; issue_type: string; priority: number }>;
    if (!Array.isArray(ready)) return null;

    // Filter: not already claimed, not emergency P0 bugs (handled separately)
    const eligible = ready.filter((b) =>
      !excludeIds.has(b.id) && !(b.issue_type === "bug" && b.priority === 0),
    );
    if (eligible.length === 0) return null;

    const pick = eligible[0];
    br(`update ${pick.id} --claim --no-auto-flush`);
    return { id: pick.id, title: pick.title };
  } catch { /* ignore */ }
  return null;
}
```

**Note:** `br ready` may or may not filter by unresolved dependencies — verify
by running `br ready --json` and checking if beads with open blockers appear.
If `br ready` doesn't filter deps, switch to `bv --robot-next --format toon`
which does dependency-aware ordering, and parse its output instead.

**Test:** Create two beads where B depends on A. Verify `preClaimBead` only
returns A, not B.

---

## Fix 4: Fix claimBead phase-label cross-contamination

**File:** `src/tools/claimBead.ts`

**Problem:** When `claimBead` is called with a `phaseLabel`, it passes the label
to `bv --robot-next --label <phase>`. If that fails, it falls back to
`br ready --json` **without** the phase filter (line ~152). This can claim a
bead from the wrong phase.

Additionally, in parallel mode, the summoner already pre-claims a specific bead
and passes `beadId` in the prompt (line 1091: `claimBead with beadId="${bead.id}"`).
When a `beadId` is provided, the tool should claim THAT bead and only that bead —
not run a query.

**Fix:** Two changes:

1. When `params.beadId` is provided, skip the bv/br query entirely and claim
   that specific bead:

```typescript
if (params.beadId) {
  // Direct claim — summoner already selected this bead
  const claimResult = await run(
    `br update ${params.beadId} --claim --no-auto-flush`,
    ctx.workingDir
  );
  if (!claimResult.ok) {
    return { content: `Failed to claim bead ${params.beadId}: ${claimResult.output}`, isError: true };
  }
  // Read bead details for context
  const showResult = await run(`br show ${params.beadId} --json`, ctx.workingDir);
  // ... return success with bead details
}
```

2. In the fallback path (when no beadId and bv fails), pass the phase label to
   `br ready` as well:

```typescript
const labelArg = params.phaseLabel ? ` --label ${params.phaseLabel}` : "";
const readyResult = await run(`br ready --json${labelArg}`, ctx.workingDir);
```

**Test:** Call `claimBead` with `beadId="ship-rebuild-xyz"`. Verify it claims
exactly that bead without querying bv or br ready.

---

## Fix 5: Worktree merge-back timing

**File:** `src/summoner/index.ts`

**Problem:** When slot-0 completes a bead (exit 0), `handleParallelSuccess` is
called, which runs `mergeToMain`. This works. But there's a race: while slot-0's
completed work is being merged, slot-1 may already be running on a worktree
forked from pre-merge main. And when slot-0 completes and a NEW bead is
assigned to slot-0, `ensureWorktree` resets the worktree to main HEAD — but
if the merge just happened, the new worktree DOES have the latest code.

The actual problem observed in the run was different: the agent on slot-0
completed `ship-rebuild-pwf`, the summoner merged it to main, but then
immediately assigned `ship-rebuild-s8p` to a worktree. The agent found only
placeholder code — suggesting either:

(a) `extractBranchFromOutput` failed to find the branch name, so `mergeToMain`
    was never called (line 1115-1117 closes the bead without merging), or
(b) The worktree reset (`git checkout --detach main`) in `ensureWorktree`
    happened before the merge landed.

**Investigation needed:** Add logging to confirm whether `extractBranchFromOutput`
is successfully finding branch names for completed beads. Read the function
(lines 600-608) and check if the branch name pattern matches what finishBead
actually creates.

**Fix (after investigation):**

If `extractBranchFromOutput` is the problem — fix the regex/pattern to match
finishBead's actual branch naming.

If the timing is the problem — ensure `mergeToMain` completes and returns true
BEFORE `ensureWorktree` is called for the next bead assignment. The current
code appears sequential (lines 1110-1120 run before the next loop iteration
fills slots at 1081), so this should already be ordered correctly. Add a
defensive `git pull` or `git checkout main && git reset --hard HEAD` in
`ensureWorktree` to guarantee it's on the latest main.

Additionally, the Warden's finding ("board state says beads complete but code
not on main") suggests merges are silently failing. Add a warning log when
`extractBranchFromOutput` returns null:

```typescript
if (branchName) {
  handleParallelSuccess(branchName, finished.beadId, "Completed");
} else {
  console.log(`  WARNING: Could not find branch for bead ${finished.beadId}. Work may not be merged.`);
  br(`close ${finished.beadId} --reason "Completed (branch not found for merge)"`);
}
```

**Test:** Run two parallel beads. After slot-0 completes and slot-0 gets a new
bead, verify the new worktree contains the code from the first completed bead.

---

## Fix 6: Escalation counter for repeated blocked beads

**File:** `src/summoner/index.ts`

**Problem:** In the parallel main loop, when a slot fails (exit 1), the bead is
released via `handleParallelFailure` (set to open) and `handleExit` increments
the attempt counter. But on the next loop iteration, `preClaimBead` can
immediately re-select the same bead because it's open and eligible. If the bead
is blocked on unmerged dependencies, it will fail again identically.

In the observed run, `ship-rebuild-s8p` was assigned, escalated as blocked,
released, re-assigned, escalated again — **5 times** — before finally
succeeding on the 6th attempt (when its dependencies had been merged by then).
This burned ~600K tokens doing nothing.

The existing attempt counter (lines 74-102) DOES eventually halt the bead after
3 failures. But in this case, the agent correctly escalated (exit 1), and the
bead kept getting re-selected because `preClaimBead` doesn't check the attempt
count.

**Fix:** In `preClaimBead`, filter out beads that have 2+ failed attempts:

```typescript
function preClaimBead(phaseLabel: string | null, excludeIds: Set<string>): { id: string; title: string } | null {
  const attempts = loadAttempts();
  // ... after getting the eligible list:
  const eligible = ready.filter((b) =>
    !excludeIds.has(b.id) &&
    !(b.issue_type === "bug" && b.priority === 0) &&
    (attempts.get(b.id) ?? 0) < 2  // Skip beads that have already failed twice
  );
  // ...
}
```

This way, a bead that fails twice won't be re-assigned by `preClaimBead`. It
will only be picked up again after `towerReviewBead` runs (which resets or
replans it), or after its dependencies land and the attempt count is reset.

**Test:** Create a bead, manually set its attempt count to 2 in
`.summoner-attempts`. Verify `preClaimBead` skips it.
