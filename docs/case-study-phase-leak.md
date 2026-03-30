# Case Study: Phase Leak — When a Trench Got Handed an Epic

## What Happened

During a parallel Trench run with the progressive scan architecture, `preClaimBead`
assigned a **phase placeholder bead** (`ship-rebuild-ilg: "Phase 3: Weekly planning
system"`) to a Trench slot. Phase placeholders are single-paragraph epic descriptions
meant for Tower to expand into 8-15 detailed beads — not for Trench to implement.

This happened because `preClaimBead` queried `br ready` for eligible beads but didn't
filter out beads labeled `phase-placeholder` or enforce that only beads from the
current phase (Phase 2) should be assigned. Phase 3's placeholder was technically
"ready" (no unresolved dependencies), so it got picked.

## How the System Responded

**Trench (slot-0):** Received the placeholder, read it, and immediately recognized
the problem. Instead of attempting to implement an entire planning system in one
session, it:
1. Flagged Chair via `flagForChair`: "Assigned bead is a phase placeholder, not an
   implementable right-sized task"
2. Escalated with `bead_too_large`

**Tower:** Received the split request, reviewed the bead, and created three sub-beads:
- `ship-rebuild-0lc`: Phase 3A — define weekly planning shared contracts
- `ship-rebuild-d4d`: Phase 3B — add in-memory weekly planning API repository
- `ship-rebuild-5cy`: Phase 3C — build weekly planning web flows

Tower correctly sequenced them with dependencies (3B depends on 3A, 3C depends on 3B).

**Trench (slot-0, next iteration):** Claimed 3A and began implementing shared
contracts for Phase 3 — even though Phase 2 still had open beads.

**Trench (slot-1):** Was assigned 3B, discovered its dependency on 3A was unresolved,
and correctly escalated as `blocked`.

**Trench (another slot):** Was assigned 3C in the other parallel slot. Phase 3 work
was now running alongside unfinished Phase 2 work.

## What Went Wrong

1. **`preClaimBead` had no phase gating.** It used `br ready` which returns any
   unblocked bead regardless of phase. The phase detection logic in the main loop
   (`detectCurrentPhase`) correctly identified Phase 2 as current, but that check
   ran before the slot-filling loop — `preClaimBead` itself didn't enforce it.

2. **Phase placeholders weren't filtered.** The `phase-placeholder` label existed
   on the bead but `preClaimBead` didn't check for it.

3. **Tower expanded without codebase context for Phase 3.** Tower's split was based
   on the placeholder description, not on what Phase 2 had actually built. The
   resulting sub-beads had assumptions about shared contracts that didn't exist yet.

## What Went Right

1. **Trench's self-awareness.** The agent immediately recognized "this is a placeholder,
   not an implementable task" and escalated instead of attempting the impossible.

2. **Tower's split was structurally correct.** The three sub-beads were properly
   sequenced with dependencies. The approach (contracts → API → web) was sound.

3. **Dependency gating caught the ordering problem.** When 3B was assigned before
   3A was done, the Trench correctly identified the unresolved dependency and
   escalated as blocked.

4. **The system recovered autonomously.** No human intervention was needed. The
   pipeline flagged, split, dependency-blocked, and continued — it just wasted
   ~4 sessions doing work that shouldn't have started yet.

## The Fix

Two changes to `preClaimBead` in the summoner:
1. Filter out beads labeled `phase-placeholder` (Tower expands these, not Trench)
2. Only pick beads matching the current phase label

This enforces the progressive scan invariant: Phase N must complete before Phase N+1
begins. Tower expands the next phase's placeholder only when the summoner detects
that the current phase is fully closed.

## Lessons for Agent System Design

- **Phase gating must be enforced at the claim level**, not just the planning level.
  It's not enough for the main loop to detect phases correctly — the bead selector
  must also respect phase boundaries.
- **Placeholders need explicit labels**, not just naming conventions. The system
  used `phase-placeholder` as a label, which made filtering deterministic.
- **Agents are surprisingly good at recognizing scope problems.** Trench didn't
  blindly attempt the epic — it read the description, compared it to the sizing
  guidance, and escalated. The quality standards in CLAUDE.md gave it the vocabulary
  to articulate why the bead was too big.
- **Multi-agent recovery works but is expensive.** The system self-healed through
  4 sessions (~$20-30 in tokens). Prevention (phase gating) is cheaper than recovery.
