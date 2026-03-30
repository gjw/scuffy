# Case Study: OOM Hardlock — When a React Bug Crashed the Laptop and Three Agents Couldn't Find It

## What Happened

During overnight autonomous operation on 2026-03-28, the Summoner was executing
Phase 4 (team coordination) beads in parallel. A Warden audit correctly detected
that `npm run test` was failing at the web workspace — Vitest workers were crashing
with `ERR_IPC_CHANNEL_CLOSED` and `Channel closed` errors. The Warden created bead
`ship-rebuild-0vc3` to fix it.

The Summoner dispatched two successive Trench agents to investigate. Both failed.
Tower then split the bead into three sub-beads. The Summoner picked up the first
sub-bead, which also failed. At this point, git operations began timing out
(`spawnSync git ETIMEDOUT`), the system entered a death loop of failed Scout
bootstraps, and the laptop hardlocked — requiring a physical power cycle.

The root cause was a single-line React bug that a human diagnosed in under two
minutes by reading the component code.

## The Bug

In `web/src/routes/planningReviewQueue.tsx`, the `usePlanningReviewQueue` hook had
an infinite re-render loop:

```tsx
const loadQueue = useCallback(async (): Promise<void> => {
    setState(createLoadingState());
    planActions.reset();
    retroActions.reset();
    reviewActions.reset();
    // ... fetch data, setState ...
}, [planActions, retroActions, reviewActions, scope]);  // ← BUG

useEffect(() => {
    void loadQueue();
}, [loadQueue]);
```

`useApprovalActions` returns a plain object `{ actionStates, feedback, reset, runAction }`
— a **new reference every render**. So the dependency array `[planActions, retroActions,
reviewActions, scope]` was always "changed," causing `loadQueue` to be recreated every
render, which triggered the `useEffect`, which called `setState(createLoadingState())`,
which triggered another render, ad infinitum.

In production with real network latency, this loop would be slow enough to not
obviously crash. In jsdom tests with instant mock fetch responses, it became a tight
synchronous-ish loop that allocated DOM nodes and React fiber objects without bound,
consuming 4–8 GB of memory before the OS OOM killer intervened.

**The fix:** Change the dependency array to reference the stable `.reset` methods
instead of the full objects:

```tsx
}, [planActions.reset, retroActions.reset, reviewActions.reset, scope]);
```

One line. Tests went from OOM crash to 16 passing in 660ms.

## How the Bug Was Introduced

The `PlanningReviewQueuePage` was one of the most heavily worked components in the
rebuild — approximately 40 agent sessions touched it across Phases 2–4. The infinite
loop was likely introduced during a refactor that extracted `usePlanningReviewQueue`
into a shared module (`planningReviewQueue.tsx`), splitting the hook's approval action
logic into a generic `useApprovalActions` helper. The helper returned a new object each
render, and whoever wrote the `loadQueue` useCallback put the full action objects in
the dep array rather than destructuring the stable callbacks.

This is a textbook React footgun, but it's subtle: the code reads correctly, the
TypeScript types are clean, and the exhaustive-deps lint rule would actually *recommend*
including the full objects. The bug only manifests at runtime as unbounded memory growth.

## Why Three Agents Failed to Diagnose It

This is the most instructive part of the incident.

### Trench Attempt 1 (bead 0vc3)

The first Trench saw `ERR_IPC_CHANNEL_CLOSED` and `Channel closed` in Vitest output.
It treated this as a **test infrastructure problem** — auditing Vitest worker
configuration, checking for process isolation issues, and examining the monorepo test
orchestration. It found nothing actionable and escalated as "blocked."

### Trench Attempt 2 (bead 0vc3)

The second Trench went deeper into Vitest config: set single-worker mode, disabled
file parallelism, disabled test isolation, raised the Node heap size. It even isolated
the problem to a specific test file (`PlanningReviewQueuePage.test.tsx`) and reported
that "even running only this file balloons to 4–8 GB and dies." But it still framed
this as a Vitest runtime problem, not an application code problem. Escalated as blocked.

### Tower Review

Tower received the twice-failed bead and split it into three sub-beads:

- `ship-rebuild-jce9`: "Audit and constrain web Vitest runtime settings"
- `ship-rebuild-gso9`: "Stabilize weekly artifact web tests"
- `ship-rebuild-ofq4`: "Stabilize planning directory and guard web tests"

All three sub-beads were framed as **test runner stability** tasks. Tower's split
was logical given the information from the two Trench reports, but it perpetuated
the misdiagnosis. None of the three beads said "read the React component code and
look for infinite re-render loops."

### The Pattern

Every agent stayed in the **test infrastructure layer**. The symptom (OOM in Vitest
worker) mapped to a mental model of "test runner misconfiguration" rather than
"application code defect." This is a category error: the agents treated the messenger
(Vitest) as the source of the problem, when Vitest was faithfully executing code that
happened to be an infinite loop.

A human developer, upon hearing "jsdom test eats 8 GB of RAM," would immediately
suspect an infinite loop in the component under test. The agents lacked this heuristic.

## How It Crashed the Laptop

The failure cascade:

1. **Bead 0vc3 attempt 1**: Trench runs tests → OOM → escalates. No machine damage
   (single OOM, OS kills the process).
2. **Bead 0vc3 attempt 2**: Trench runs tests again with different config → still OOM
   → escalates. Attempt counter hits 2.
3. **Tower splits into 3 sub-beads**: All sub-beads will also trigger the same OOM.
4. **Sub-bead ofq4 attempt 1**: Trench runs tests → OOM → escalates.
5. **Machine memory pressure accumulates**: Multiple OOM events in succession, plus
   the Summoner process itself, plus git operations. `resetToMain` fails with
   `ETIMEDOUT` — git can't allocate memory to checkout.
6. **Death loop**: Summoner can't reset to main, falls back to Scout bootstrap, Scout
   fails with connection timeout, Summoner retries. Each iteration may spawn another
   process that contributes to memory pressure.
7. **Hardlock**: macOS kernel can't service interrupts under sustained memory pressure.
   Physical power cycle required.

The key amplifier was the Summoner's lack of awareness that OOM kills are categorically
different from logic failures. It kept spawning agents that would trigger the same OOM,
compounding the memory pressure rather than backing off.

## What We Changed

### Immediate Fixes

1. **One-line code fix** (`planningReviewQueue.tsx:697`): Changed the useCallback dep
   array from `[planActions, retroActions, reviewActions, scope]` to
   `[planActions.reset, retroActions.reset, reviewActions.reset, scope]`.

2. **Heap cap** (`web/package.json`): Added `NODE_OPTIONS='--max-old-space-size=2048'`
   to the web test script. If a future test enters an infinite loop, it will hit a
   2 GB allocation failure and crash fast instead of eating all available memory and
   threatening the host machine.

3. **Deleted stale artifacts**: Removed a `PlanningReviewQueuePage.smoke.test.tsx` file
   left behind by one of the crashed agent sessions.

4. **Closed 4 beads**: `ship-rebuild-gso9`, `ship-rebuild-jce9`, `ship-rebuild-ofq4`,
   `ship-rebuild-tfzo` — all OOM-related beads resolved by the root cause fix.

### Systemic Improvements

5. **CASS lesson** (pinned, proven maturity): Added a playbook bullet teaching agents
   that jsdom OOM should trigger investigation of React infinite re-render loops
   *before* touching Vitest configuration. Includes the specific pattern to look for
   (unstable object references in useCallback/useEffect dep arrays) and the diagnostic
   approach (check every dep array for objects recreated each render). This lesson would
   have redirected the first Trench attempt to the correct diagnosis.

6. **Summoner circuit-breaker bead** (`sc-93g`): Created a detailed feature bead for
   the Summoner to distinguish between logic failures (safe to retry) and process-killing
   failures (OOM, SIGKILL — dangerous to retry). Includes detection heuristics (exit
   signals, stderr patterns), desired behavior (tag as `needs-human`, skip sibling beads
   with same test surface), and implementation pointers.

## Lessons for Autonomous Agent Systems

### 1. Layer confusion is the dominant failure mode for debugging agents

All three agents (two Trenches + Tower) correctly identified the symptom layer (Vitest
worker crash) but never descended to the cause layer (React component code). This isn't
a knowledge gap — any of these agents could explain React re-render loops if asked.
It's a **search strategy failure**: the agents' diagnostic heuristic was "OOM in test
runner → fix test runner," when the correct heuristic is "OOM in test → what is the
test executing?"

This suggests that debugging prompts should explicitly include layer-descent instructions:
"Before modifying test infrastructure, read the code under test and check for infinite
loops, unbounded recursion, or runaway allocation."

### 2. Symptoms that kill processes need different retry strategies than logic errors

A test assertion failure is safe to retry — the process exits cleanly, no state is
corrupted, the machine is fine. An OOM kill is not safe to retry — the process is
forcefully terminated, the machine may be under memory pressure, and retrying will
likely trigger the same OOM. The Summoner treated both identically, which turned a
single-test-file bug into a machine-crashing cascading failure.

### 3. The heap cap is load-bearing safety infrastructure

The `--max-old-space-size` flag is not an optimization or a nice-to-have. It is the
difference between "test fails with an error message" and "laptop hardlocks overnight
and loses hours of autonomous work." Every test runner in an autonomous pipeline should
have a memory ceiling that is well below the machine's total RAM.

### 4. Human pattern-matching still has a massive edge for novel failures

A human developer heard "jsdom test eating 8 GB" and immediately said "infinite
re-render loop" — a diagnosis that took under two minutes including reading the code
and writing the fix. Three agent sessions totaling ~2.5M input tokens and ~45 minutes
of wall clock time failed to reach the same conclusion. The agents had all the
information they needed; they lacked the heuristic that maps the symptom to the cause
across abstraction layers.

The CASS lesson we added is an attempt to encode this heuristic so future agents can
make the same leap. Whether it generalizes beyond this specific pattern (React +
jsdom + OOM) to other cross-layer debugging scenarios remains to be seen.

### 5. Overnight autonomous operation needs kill switches, not just retry logic

The Summoner had a 2-attempt-then-escalate pattern that worked correctly for logic
failures. But when the escalation target (Tower) generated sub-beads that triggered
the same physical failure, the system had no way to recognize the pattern and stop.
A circuit breaker that detects repeated process kills and pauses the affected bead
family would have prevented the hardlock entirely — the Summoner would have tagged
those beads as `needs-human` and continued working on unrelated beads.

## Timeline

| Time (approx) | Event |
|---|---|
| ~05:07 | Warden detects web test failures, creates P0 bead `tfzo` |
| ~05:16 | Warden creates `0vc3` for web Vitest stability |
| ~05:20 | Trench attempt 1 on `0vc3`: investigates Vitest config, escalates |
| ~05:33 | Trench attempt 2 on `0vc3`: tries worker isolation, reports 4-8 GB OOM, escalates |
| ~05:35 | Tower splits `0vc3` into `jce9`, `gso9`, `ofq4` |
| ~05:40 | Trench attempt 1 on `ofq4`: escalates |
| ~05:41 | `resetToMain` fails with ETIMEDOUT — memory pressure critical |
| ~05:41+ | Death loop: Scout bootstrap → timeout → retry → timeout |
| Unknown | Laptop hardlocks |
| ~06:50 | Human discovers hardlock, power cycles |
| ~07:00 | Human (with Trench) reads summoner log, diagnoses recovery path |
| ~07:08 | Human reads `planningReviewQueue.tsx`, identifies infinite loop in <2 min |
| ~07:10 | One-line fix applied, all 80 web tests pass in 660ms |
| ~07:15 | Heap cap, CASS lesson, and circuit-breaker bead created |
| ~07:25 | Summoner restarted, beads progressing normally |

## Cost

- **Wasted agent compute**: ~2.5M input tokens across 2 Trenches + 1 Tower on the
  wrong diagnosis, plus additional tokens on sub-bead attempts
- **Lost wall clock time**: ~2+ hours of autonomous work (from first OOM detection
  to hardlock, plus recovery time)
- **Human intervention time**: ~30 minutes (reading logs, diagnosing, fixing, restarting)
- **Risk**: Potential data loss from hardlock (mitigated by git — all committed work
  was preserved)
