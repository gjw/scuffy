# Case Study: The Polite Trench — When an Agent Refused to Fix a One-Line Bug

## What Happened

During overnight autonomous operation on 2026-03-29, Phase 1 completed
successfully — 12 beads closed covering scaffold, API, auth, login page,
session management, and navigation. The final bead was a smoke test that
starts the full stack and curls every endpoint to verify the phase works
end-to-end.

The smoke test Trench started the stack and immediately hit a seeding failure:
the auth migration defined `auth_users.password_hash` as NOT NULL, but the
seed script was inserting into a `password` column. PostgreSQL rejected the
insert with a constraint violation. The app couldn't seed, so no endpoints
could be verified.

This was a one-line fix: change `password` to `password_hash` in the seed
script. A human would fix it in seconds.

## How the System Responded

**Smoke test Trench (attempt 1):** Read the error, correctly diagnosed the
schema/seed mismatch, then refused to fix it:

> "I have not changed code. Verification cannot proceed until Chair decides
> whether to reset/migrate the local DB to the current schema or route this
> as a code defect to the implementation agent."

The Trench treated itself as a read-only auditor. It escalated (exit code 1).

**Smoke test Trench (attempt 2):** Same bead, same error, same refusal.
Escalated again.

**Judicar:** Triaged after the second failure. Correctly identified the
schema/seed mismatch and created a fix bead (`ship-rebuild-m7q`). Good
decision, but too late — the fix bead was never worked.

**Circuit breaker:** By this point, 5 consecutive parallel failures had
accumulated (the smoke test attempts plus other beads hitting the same
broken-seed cascade). The circuit breaker triggered and **exited the summoner
entirely**. Judicar's fix bead existed in the queue but nobody was alive to
work on it.

**Result:** The machine sat idle from ~1:30 AM until the operator woke up
at ~8 AM. Six and a half hours of lost runtime over a one-column-name bug.

## Root Causes

**1. Smoke test prompt was ambiguous about code changes.** The prompt said
"fix anything broken" but also described the bead as a "verification" step.
The Trench interpreted "verification" as read-only and chose to escalate
rather than modify code. The prompt didn't explicitly say "you ARE allowed
to change code — that's the whole point."

**2. Circuit breaker was terminal.** The old circuit breaker did `break` on
5 consecutive failures, which exited the main summoner loop entirely. Even
though Judicar created a fix bead, the summoner was already dead. The
circuit breaker should have checked for new work before giving up.

**3. Schema/seed divergence is a classic integration gap.** Two different
Trench agents built the migration (with `password_hash`) and the seed
script (with `password`). Each passed its own tests in isolation. Neither
ran `npm run db:seed` against the real database. This is exactly what the
smoke test was designed to catch — and it did catch it. The failure was in
the response, not the detection.

## Fixes Applied

1. **Smoke test prompt updated:** Explicit instruction that the Trench must
   fix integration bugs it discovers. "You ARE allowed to modify code in
   this bead — that is the whole point. Do not escalate integration bugs.
   Fix them."

2. **Circuit breaker no longer exits.** After 5 failures, it drains active
   slots, then checks for ready beads. If Judicar created fix beads, the
   counter resets and work continues. The summoner only exits when there's
   genuinely no work left.

3. **Curl-only verification.** The smoke test prompt now explicitly bans
   Playwright/browser automation (a previous attempt escalated asking for
   Playwright). All checks use curl. Client-side-only behaviors are noted
   as limitations but don't block completion.

## Lesson

The most expensive failures aren't the hard bugs — they're the easy bugs
that nobody fixes. This entire incident was caused by a column name mismatch
that any agent could have resolved in one edit. But the system's response
cascade (polite refusal → retry → same refusal → Judicar creates fix →
circuit breaker kills summoner → 6.5 hours idle) turned a trivial bug into
an overnight outage.

When you build an autonomous system, the agents' default behavior when
confused matters more than their peak capability. A Trench that fixes a
one-line bug and moves on is worth more than a Trench that perfectly
diagnoses the problem and then stops.
