# Judicar — Decision Point Analysis

## Every decision point from today's build

| # | What happened | Who needed a decision | When | What should have happened | Needs instant response? |
|---|---|---|---|---|---|
| D1 | OOM crash — 3 agents misdiagnosed as Vitest config | Summoner (after 2 failures) | After Trench exits | "3 agents tried Vitest config. Stop. Read the React code." | No — summoner is between spawns |
| D2 | Warden created P2/P3 polish beads mid-sprint | Warden (proposing beads) | End of Warden session | "Only the P0 notification bug is worth a bead right now" | No — Warden has finished its audit |
| D3 | Bead too large, hit max iterations | Summoner (agent exited) | After Trench exits | "This is too big. Split into N smaller beads." | No — summoner is between spawns |
| D4 | finishBead rejected (metadata merge conflict) | Trench (mid-session, stuck) | During Trench session | "That's just .beads/issues.jsonl. Take theirs and continue." | YES — Trench is blocked |
| D5 | Agent output plan text and exited (no finishBead) | Summoner (agent exited oddly) | After Trench exits | "Exit 0 with no commits = something went wrong. Retry." | No — summoner is between spawns |
| D6 | Stale in-progress bead missed by idle loop | Summoner (thinks it's done) | Summoner idle | "Check for orphaned in-progress beads before concluding" | No — summoner is in its loop |
| D7 | Zero CSS — nobody ever checked the app | Nobody asked | Never | "After slice N, open the app and verify it looks right" | No — between slices |
| D8 | Tower created beads for already-done phases | Summoner (Tower produced junk) | After Tower exits | "Phases 1-5 are done. Only create Phase 6 beads." | No — summoner is between spawns |
| D9 | 429 rate limit burning through beads | Summoner (repeated failures) | After Trench exits | "Same error 5 times. This isn't a bead problem, it's infra." | No — summoner is between spawns |
| D10 | Branch work destroyed on retry (-B flag) | Summoner (retrying a bead) | Before Trench spawns | "Branch has commits. Preserve them." | No — summoner is between spawns |
| D11 | Warden bead fighting Vitest module loading (rquo) | Summoner (2 failures on P1 bead) | After Trench exits | "P1 test harness bead failed twice. Not worth Tower. Close." | No — summoner is between spawns |
| D12 | pg repos return different shapes than in-memory | Nobody asked | Never | "After converting repos to pg, curl the API and compare" | No — between beads |

## Pattern analysis

**11 of 12 decision points happen when the summoner is between spawns.**
Only D4 (finishBead rejected mid-session) needs an instant response while
a Trench is actively blocked.

And D4 was already fixed by the metadata auto-resolve in finishBead. So
with that fix in place, **zero remaining decision points require a
persistent always-on agent.**

## What the summoner is actually bad at

The summoner makes mechanical decisions:
- Exit 0 → merge
- Exit 1 → increment attempts, retry or Tower
- Exit 2 → budget exceeded, escalate

It has no judgment. It can't distinguish:
- "failed because the bead is too hard" vs "failed because of infra"
- "Warden found a real bug" vs "Warden found polish work"
- "Tower's 14 beads are reasonable" vs "Tower over-decomposed"
- "the build is done" vs "there's orphaned work"
- "the app works" vs "the app passes tests but is unusable"

Every one of these is a judgment call that happens **between spawns**, at
summoner decision points.

## Conclusion: on-demand Judicar, spawned by summoner

```
                          SUMMONER DECISION POINTS
                          ════════════════════════

  Trench exits ─────► Was it a failure? ─────► Spawn Judicar
                           │                   "Bead X failed with
                           │                    reason Y. Attempt N.
                           │                    Priority P. Decide:
                           │                    retry / split / defer
                           │                    / close."
                           │
                      Was it success? ────► Normal merge flow
                           │
  Warden exits ─────► Proposed N beads? ──► Spawn Judicar
                                             "Warden proposes these
                                              beads: [...]. Which
                                              are worth creating?
                                              We're in slice M of
                                              the build."

  Slice complete ───► All beads merged ───► Spawn Judicar
                                             "Slice N complete.
                                              Here's curl output
                                              for the demo flow.
                                              Ready for slice N+1?"

  No beads left ────► End of build? ──────► Spawn Judicar
                                             "No beads remain.
                                              Check for orphans,
                                              verify demo flow,
                                              confirm we're done."

  Tower exits ──────► Proposed beads? ────► Spawn Judicar
                                             "Tower split bead X
                                              into Y beads. Too
                                              many? Wrong scope?"
```

## Why on-demand, not persistent

| | Persistent | On-demand |
|---|---|---|
| Token cost | Burns tokens polling empty mailbox | Zero cost when not needed |
| Context | Accumulates project knowledge | Fresh each time (but small — just the decision context) |
| Latency | ~15-30 sec (poll interval) | ~10-15 sec (spawn + first response) |
| Complexity | Needs persistent loop, recycling, health monitoring | Just another spawn like Tower |
| State | Carries decision history | Stateless (reads from br/git) |
| Failure mode | Can go stale, context can get confused | Clean slate each time |

The latency difference is negligible. The token savings are significant —
the Judicar only runs when there's a decision to make, not 24/7.

**The persistent model's only real advantage is accumulated context** — a
Judicar that's seen 10 failures can pattern-match ("agents keep failing on
Vitest config, maybe the problem isn't Vitest config"). But CASS lessons
serve the same function across sessions, and the on-demand Judicar can read
recent git log + bead history to reconstruct patterns.

## Implementation cost

The on-demand Judicar is essentially a new summoner role, like Tower:

1. **Prompt** (`prompts/judicar.md`) — ~50 lines
2. **Summoner integration** — replace mechanical retry logic with Judicar
   spawn at 4-5 decision points (~100 lines)
3. **No new infrastructure** — uses existing spawn, br, bv tools

Estimated build time: 2-3 hours.

## Additional things a Judicar could catch that we handle poorly

Beyond the 12 decision points above:

**Bead description staleness:** Before assigning a bead, Judicar could
check if the bead description still matches reality (e.g., "add repo X"
when repo X already exists from a parallel bead).

**Repeated failure pattern detection:** "Beads A, B, C all failed with
similar errors. This might be a systemic issue, not individual bead
problems." Read from git log + bead close reasons.

**Token budget monitoring:** "This build has used N tokens across M
sessions. At this rate, we'll exhaust the budget before finishing."
Judicar could recommend cutting scope.

**Cross-bead integration check:** After a bead merges, Judicar could
curl the affected endpoints to verify they actually work, not just
typecheck.
