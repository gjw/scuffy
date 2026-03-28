# Judicar Design — Questions First

## Who asks, what they ask, how urgently they need an answer

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   TRENCH    │         │   WARDEN    │         │  SUMMONER   │
│  (working)  │         │ (auditing)  │         │ (managing)  │
└──────┬──────┘         └──────┬──────┘         └──────┬──────┘
       │                       │                       │
       │ SYNC                  │ SYNC                  │ SYNC
       │ "I'm stuck, should    │ "I found these 3      │ "Trench failed
       │  I keep going?"       │  issues. Which ones    │  twice. Replan,
       │                       │  deserve beads?"       │  defer, or close?"
       │ SYNC                  │                        │
       │ "finishBead failed    │ ASYNC                  │ SYNC
       │  after merging main.  │ "Here's my full        │ "All beads done.
       │  Integration issue    │  audit report.         │  Is the slice
       │  or real bug?"        │  Review when ready."   │  demoable?"
       │                       │                        │
       │ ASYNC                 │                        │ ASYNC
       │ "This bead feels      │                        │ "Slice 3 just
       │  too big. Heads up,   │                        │  finished. Here's
       │  might escalate."     │                        │  the demo status."
       │                       │                        │
       ▼                       ▼                        ▼
┌──────────────────────────────────────────────────────────────┐
│                        JUDICAR                               │
│                  (always running)                             │
│                                                              │
│  Reads: mail, br, bv, git log, curl                          │
│  Writes: br commands (close/update/create beads), mail       │
│  Never: edits code, touches files, runs tests                │
└──────────────────────────────────────────────────────────────┘
```

## Question catalog

### From Trench (sync — Trench is blocked waiting for answer)

| # | Question | Context | Judicar decides | Acts via |
|---|----------|---------|-----------------|----------|
| T1 | "Should I keep trying or give up?" | Trench hit a wall — test harness issue, module loading, environment problem | Keep going with hint / abandon and close bead / defer bead | mail reply to Trench + optionally br close/update |
| T2 | "finishBead rejected after merging main. What do I do?" | Integration conflict with concurrent work, not the Trench's fault | Fix specific files / abandon and let next Trench handle / close as done-enough | mail reply with specific guidance |
| T3 | "This bead description doesn't match reality. Code already exists / is different than described." | Stale bead from a previous phase, or bead was partially done by a crashed session | Close as already-done / update bead description / tell Trench what to actually do | mail reply + br update |
| T4 | "I'm about to exceed my budget. Should I commit what I have or escalate?" | Trench is 80% through a large bead | Commit partial work and escalate / push through / split remainder into new bead | mail reply + optionally br create for remainder |

### From Warden (sync — Warden wants approval before creating beads)

| # | Question | Context | Judicar decides | Acts via |
|---|----------|---------|-----------------|----------|
| W1 | "I found N issues. Which deserve beads?" | Warden audit results — mix of P0 bugs, P1 fixes, P2 polish | Approve P0s, defer P2+, judgment call on P1s | mail reply with approved list; Warden only creates approved beads |
| W2 | "Audit is clean. No issues found." | Nothing wrong | Acknowledge, no action | mail reply |

### From Summoner (sync — Summoner is at a decision point)

| # | Question | Context | Judicar decides | Acts via |
|---|----------|---------|-----------------|----------|
| S1 | "Trench failed N times. What now?" | Repeated failures on same bead | Close / defer / split / one more try with specific hint | br close/update + mail reply |
| S2 | "Slice N just finished. Move to Slice N+1?" | Between vertical slices | Yes / no, fix these gaps first | mail reply; if no, br create fix beads |
| S3 | "No beads left. Are we done?" | End of build | Check demo flow, verify completeness, exit or create final polish beads | br create if needed, or confirm exit |

### From Tower (async — Tower is replanning)

| # | Question | Context | Judicar decides | Acts via |
|---|----------|---------|-----------------|----------|
| Tw1 | "I split bead X into Y beads. Reasonable?" | Tower replan after failure | Approve / too many beads, consolidate / wrong decomposition | mail reply |

## Sync vs Async

**Sync questions** (T1-T4, W1, S1-S3): The asker is blocked or at a decision
point. The Judicar must respond quickly — within one poll cycle (15-30 sec).
The asker either waits for the reply or the summoner checks the Judicar's
br actions before proceeding.

**Async questions** (Tw1, status updates): Informational. The Judicar reads
them when it polls, responds when convenient. No one is blocked.

## How sync responses work in practice

```
Trench                    Judicar                   Summoner
  │                         │                         │
  │ mail: "stuck on X"      │                         │
  ├────────────────────────►│                         │
  │                         │ (polls mail, sees msg)  │
  │                         │ reads br show X         │
  │                         │ reads git log           │
  │                         │ decides: close it       │
  │                         │ br close X              │
  │   mail: "closed X,      │                         │
  │    not worth it"        │                         │
  │◄────────────────────────┤                         │
  │                         │                         │
  │ (reads reply, exits     │                         │
  │  with escalation)       │                         │
  │                         │                         │
  │─────────────────────────────────────────────────►│
  │  exit code 1                                      │
  │                                                   │
  │                         │  (summoner sees bead    │
  │                         │   already closed by     │
  │                         │   Judicar, moves on)    │
```

## Open design questions

1. **Does the Judicar need to respond via mail, or is acting via br enough?**
   If Judicar closes a bead, the Trench could detect that via br show. But
   a mail reply with reasoning helps the Trench exit gracefully and helps
   future agents understand why.

2. **What's the poll interval?** 15 seconds means fast response but burns
   tokens on empty polls. 60 seconds means less waste but Trenches wait
   longer. Could adapt: poll every 15s when slots are active, every 60s
   when idle.

3. **What context does the Judicar need on startup?** It needs to understand
   the project, the brief, the current slice, and what's been done. A
   startup prompt with: brief summary, current slice number, recent git
   log, br ready output. Maybe 10K tokens.

4. **When the Judicar is recycled (400K context), what carries over?** A
   summary of decisions made so far. "Closed beads X, Y, Z for reasons
   A, B, C. Deferred D, E. Current slice is 4." Maybe written to a file
   the next Judicar instance reads on startup.

5. **Should the Judicar proactively monitor, or only respond to mail?**
   Proactive: periodically run br ready, check for stale in-progress beads,
   curl the app to verify demo flow. Reactive: only act when asked. Proactive
   is more powerful but burns more tokens. Start reactive, add proactive
   checks between slices.

6. **Who tells the Judicar about slices?** The brief defines slices. The
   Judicar reads the brief on startup. The summoner mails it when a slice
   completes. The Judicar verifies demo-ability before approving the next
   slice.
