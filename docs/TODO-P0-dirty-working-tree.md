# P0: Fix dirty working tree from budget-exceeded sessions

**Create this as a bead in the morning:** `br create --title="Fix dirty working tree from budget-exceeded sessions" --type=bug --priority=0`

## Problem

Budget-exceeded sessions leave uncommitted files on disk. The budget guard
in loop.ts returns directly — no commit, no escalate, no cleanup. The next
Trench inherits the dirty working tree and fails on pre-existing broken tests.

This is the root cause of the "pre-existing test failures" that multiple
Trench agents have complained about.

## The tension

We WANT to preserve partial work from budget-exceeded sessions so that:
- Tower can examine what was done when splitting the bead
- A retry can continue from partial work (prepare_branch logic)

But we DON'T want the next DIFFERENT bead to inherit dirty files from a
failed session on a completely unrelated bead.

## Proposed approaches (NEEDS CAREFUL DESIGN)

**Option A:** Budget guard commits WIP (like escalate does).
- Pro: preserves work, clean tree for next session
- Con: commits broken code that fails tests

**Option B:** Summoner does git stash before each spawn.
- Pro: clean tree guaranteed
- Con: stashes pile up, unnamed, easy to lose

**Option C:** Summoner does git checkout main before each spawn.
- Pro: clean known state
- Con: loses all uncommitted work

**Option D (probably right):** Budget guard commits WIP on the bead's branch,
THEN summoner checks out main before spawning the next Trench.
- Pro: partial work preserved on branch, next Trench starts clean
- Con: branches accumulate, need cleanup

## Key design question

If we commit WIP + checkout main, the prepare_branch logic (attempt 1 keeps
branch for continuation, attempt 2 deletes for fresh start) needs to be ported
from the old bash summoner to the TypeScript summoner.

## Files involved

- `src/agent/loop.ts` — budget guard exit path
- `src/summoner/index.ts` — git checkout main before spawn, prepare_branch
