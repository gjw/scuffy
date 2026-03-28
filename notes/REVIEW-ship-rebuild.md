# Ship Rebuild Review — 2026-03-28

## Build Overview

Full autonomous rebuild of Ship (FleetGraph PM app) using Scuffy's Summoner
with 2 parallel slots. Phases 1–4 completed overnight, Phase 5 (production
polish) in progress. One critical incident (OOM hardlock, see
`case-study-oom-hardlock.md`) required human intervention; otherwise fully
autonomous.

## Tooling Assessment

### Clearly valuable — keep and refine

**Parallel slots + worktrees.** Roughly doubled throughput. Most beads
completed in 2–5 minutes wall clock. Merge conflict resolution (spawn a
Trench to merge) worked reliably — every conflict was resolved automatically
across the entire build.

**Warden audits.** Caught real bugs that would have shipped silently:
- Unmounted weekly review router (API routes existed but `app.ts` didn't
  mount them — tests passed because they were mocked)
- Person ID mismatches between seeds (`person-ava-stone` vs `person-ava`)
  causing dangling cross-entity references
- Missing test coverage for error paths

**finishBead quality gates.** Typecheck + test gates at bead completion are
load-bearing. Without them, the bypass cascade would have been invisible and
broken code would have accumulated on main.

**CASS lesson injection.** 3 context-relevant lessons injected per session
from a pool of 25–49 (varies by task relevance). The OOM incident proved the
system works — the new lesson would have prevented the entire failure chain.
Lessons are the closest thing to institutional memory across sessions.

**Bead system (br) + bv triage.** Dependency-aware work ordering meant
beads were picked up in the right sequence. `br ready` + summoner's
`preClaimBead` mostly got this right. Phase placeholders were correctly
detected and expanded by Tower.

### Overkill or net-negative ROI — rethink for next build

**Warden creating P3 polish beads mid-sprint.** Warden found real bugs
(good) but also created beads like:
- "Add direct route-level tests for activity filter forwarding" (P3 polish)
- "Split PlanningReviewQueuePage for maintainability" (P2 chore)
- "Align notification mark-all-read docs/API" (P2 docs)

Each consumed a full Trench session (~100K–500K input tokens) that could
have been building features. **Recommendation:** During a rebuild sprint,
Warden should only create beads for P0/P1 correctness issues. Log polish
items in `WARDEN_NOTES.md` as deferred work, don't create beads.

**Tower replanning after 2 failures.** The 2-attempt → Tower escalation
pattern works for logic failures but failed catastrophically for the OOM.
Tower's splits also tend to generate many beads (14 for Phase 4, 12 for
Phase 5). Some may be too granular — Tower biases toward many small beads
when fewer medium beads would reduce merge conflict overhead and session
startup costs. **Recommendation:** Tower should split into 5–8 beads per
phase, not 12–14. Let Trench sessions handle slightly larger vertical
slices.

**The bypass → emergency P0 → drain cycle frequency.** Counted at least 5
bypass completions in the Phase 4 log alone, each creating an emergency P0
that had to be drained before feature work resumed. The mechanism exists as
a safety valve but was acting as a primary workflow pattern — that's a smell.
With correct token budgets, agents should fix their own test failures inline
instead of bypassing. **Recommendation:** Monitor bypass rate in next build
to see if budget fix reduces it. If bypasses are still frequent, investigate
why agents choose bypass over fixing.

### Probably unnecessary — artifacts of the fake token limit

**Excessive escalations as "stuck."** With the artificially constrained
token budget, agents would run out of room and escalate rather than finish
the work. The dashboard bead (`s60c`) took 3 sessions (~10M input tokens
across attempts). With correct budgets, that's probably 1–2 sessions.

**Overly conservative bead sizing.** The sizing lessons in CLAUDE.md say
"keep beads narrow to one file family." This was learned during the
budget-constrained era when agents couldn't handle anything larger. With
proper budgets, slightly larger beads (repo + routes + tests as one bead)
would reduce merge conflicts and session startup overhead. The constant
merge conflicts on `app.ts` (the route mounting file) are a direct
consequence of splitting "add repo" and "mount routes" into separate beads
that both edit the same file.

**Bypass/emergency-P0 pipeline overuse.** With correct budgets, agents
have room to fix their own test failures. The bypass mechanism should exist
but fire rarely, not on every other bead.

## Incident Summary

### OOM Hardlock (see `case-study-oom-hardlock.md`)

- **Root cause:** Infinite React re-render loop in `usePlanningReviewQueue`
  (unstable useCallback deps)
- **Impact:** Laptop hardlocked overnight, ~2 hours lost
- **Why agents failed:** All three (2 Trenches + Tower) diagnosed it as a
  Vitest config problem, never looked at the React code
- **Fix:** One-line dep array change + heap cap + CASS lesson
- **Systemic fix needed:** Summoner circuit-breaker for OOM (bead `sc-93g`)

## Concrete Changes for Next Build

### Already done
- [x] Token budget measures conversation length, not cumulative input
- [x] Heap cap on web tests (`--max-old-space-size=2048`)
- [x] CASS lesson: jsdom OOM → check React infinite loops first
- [x] Summoner circuit-breaker bead created (`sc-93g`)
- [x] Launch script (`scripts/2scuffy4u.sh`) with proper .env handling

### To do before next build
- [ ] Warden severity threshold: only create beads for P0/P1 correctness
  issues during rebuild sprints; log polish items separately
- [ ] Bead sizing: allow slightly larger vertical slices (repo + routes +
  tests in one bead) to reduce merge conflicts on shared wiring files
- [ ] Tower expansion target: 5–8 beads per phase, not 12–14
- [ ] Parallel slot awareness: serialize beads that touch the same files
  (especially `app.ts`) instead of parallelizing them
- [ ] Review bypass rate with correct budgets — if still high, investigate
- [ ] Summoner: graceful wind-down when work drains (see below)

### Summoner wind-down behavior (N slots, M beads)

The summoner runs N parallel slots (currently 2, may go to 3+). It needs
correct behavior as work drains, not just when work is plentiful.

**Slot filling (M < N):** When fewer beads are available than slots, fill
what you can and leave remaining slots idle. Do not spin trying to fill
empty slots — wait for active slots to finish, then re-check. This must
work for any N, not just 2. If N=3 and 1 bead remains, run 1 slot.

**Drain detection (M = 0 after all slots finish):** When all active slots
drain and no new beads are found:

1. Run a final warden audit if one hasn't run since the last completed bead.
   Warden may create new beads — if so, continue the loop.
2. Check for orphaned in-progress beads — anything marked `in_progress` that
   isn't actively running in a slot. These are crash survivors from previous
   sessions. Reclaim them as ready work. (This is the bug that caused `sfai`
   to be missed: it was `in_progress` from a crashed session, `br ready`
   didn't return it, and the summoner went into an idle loop instead of
   reclaiming it.)
3. If truly zero work (no ready beads, no orphans, warden created nothing),
   log `All beads complete. Summoner exiting.` and exit 0.

**What went wrong this build:** The summoner had 0 ready beads but 1
orphaned in-progress bead (`sfai`). It didn't check for orphans, so it
entered a tight typecheck loop forever. A fresh restart found the orphan
via "Recovering stale bead" — but that recovery only runs at startup, not
during the main loop. The fix is step 2 above: check for orphans before
concluding there's no work left.

### Critical brief gaps — must be in next rebuild from the start

**PostgreSQL persistence is a grading requirement, not a Phase 5 nice-to-have.**
The grader flagged the lack of durable persistence on early turn-in. The brief
must include postgres from Phase 1 so the entire app is built against real
tables, not in-memory stubs that get "migrated later." Specific requirements
for the brief:

- [ ] Docker-compose with Postgres 16 as part of the initial scaffold (Phase 1)
- [ ] Schema migrations run on startup or via npm script
- [ ] All repositories implemented against postgres from the start — no
  in-memory-first approach that defers the hard part
- [ ] In-memory repos exist ONLY for test isolation, never as the production
  path
- [ ] Seed data loads into postgres (not hardcoded in repository constructors)
- [ ] `DATABASE_URL` env var drives connection; health endpoint verifies DB
  connectivity
- [ ] Brief should state: "Every repository must persist to PostgreSQL.
  In-memory implementations are test-only. There is no in-memory production
  mode."

This was the single biggest gap in the current build. Everything else
(features, tests, types, accessibility) was solid. The brief never explicitly
required durable persistence in early phases, so Tower planned all repos as
in-memory with postgres as a future migration — which never happened because
Phase 5 "production polish" focused on docs, lazy loading, and route coverage
instead.

### Factory architecture: priority-aware retry and the Judicar concept

**Near-term (next build): priority-aware Tower reviews.** When Tower is
invoked after 2 failed attempts, it should check the bead's priority and
labels FIRST, before doing a full code review. For warden P2+ beads that
escalated as "stuck" on test harness or docs issues, Tower should be able
to close them in 30 seconds with "deferred — not worth the session cost"
rather than spending 300K+ tokens on a full replan. This is a prompt
change in Tower, not a code change.

**Eventual (v2 factory): persistent Judicar agent.** Instead of cold-start
Tower invocations, dedicate a slot to a persistent decision-maker agent
that never writes code — it just reads and directs. Trenches mail it in
real-time when they're struggling ("this bead is fighting Vitest module
loading, worth pursuing?"). Warden mails it with proposed beads before
creating them ("I found 3 issues, which deserve beads?"). The Judicar
responds immediately from warm context: close it, split it, defer it,
reprioritize it.

The core insight: Tower's problem isn't intelligence, it's latency and
context cost. It makes good decisions but takes 5+ minutes and 300K-700K
tokens to boot. A warm Judicar with persistent project context could make
the same calls in seconds via mail. The tradeoff is one permanently
occupied slot, but it would eliminate:
- Wasted retry sessions on beads that should have been closed
- Warden creating low-ROI beads that consume Trench sessions
- Tower cold-starts for simple triage decisions
- Agents burning tokens on work that a human would immediately say
  "don't bother" about

### App review findings (2026-03-28 evening)

**The app was never loaded in a browser by any agent.** Every frontend
interaction was validated through jsdom mocks with mocked fetch. The
result is an app that passes 300+ tests and is completely unusable.

**Zero CSS until Phase 6.** The brief said "semantic HTML" and "avoid
decorative chrome" — 40 agents interpreted this as "no styling." Phase 6
added Tailwind but the result is still rough. Next build: install Tailwind
in Phase 1 and require styling in every bead.

**No Vite proxy.** Frontend used relative URLs (`/auth/login`) but API
was on port 3000. Every API call 404'd until we manually added the proxy.
Next build: proxy config in Phase 1 scaffold.

**Broken data flows.** Frontend runtime guards were written against
in-memory repo response shapes. Postgres repos return slightly different
shapes. "Person response had an unexpected shape" everywhere. The guards
were never tested against real API responses.

**Dead-end routes everywhere:**
- Clicking issues navigates to `/issues/:id` — no route exists
- Team directory showed "Open person view" as text, not links
- Program detail pages 500'd (pg COUNT returned number, guard expected string)
- No way to create issues, edit wiki pages, or associate projects to programs
- No logout button, login/register stay in nav after auth
- Debug text in header ("Global shell — Every route now inherits...")

**Missing CRUD operations:**
- Programs: can create but no validation (duplicate names allowed)
- Projects: can view but no create
- Issues: can list but no create or detail view
- Wiki: can browse but no edit
- No emoji picker for program creation
- No way to associate projects to programs from the UI

**What this means for the next build brief:**
- [ ] Require Tailwind + Vite proxy in Phase 1 scaffold
- [ ] Every frontend bead must include a "load in browser and verify"
  step — not just jsdom tests
- [ ] Brief must specify CRUD operations per entity: list, create, detail,
  edit, delete. If the brief says "add issues page" without specifying
  create/edit, agents will build read-only list views
- [ ] Brief must specify navigation: "after login, hide login link, show
  logout button, show user name"
- [ ] Brief must specify the demo flow as acceptance criteria, not just
  feature descriptions
- [ ] Frontend guards must be tested against the real API (via proxy),
  not mocked fetch
- [ ] Seed data must cover every entity shown in the demo flow
- [ ] The brief was built for the hobbled token budget — agents rushed,
  skipped UI work, focused on tests. The next build with correct budgets
  should produce significantly better frontend output
