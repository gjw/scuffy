# Tool Efficiency Investigation: Why Scuffy Burns 10x More Context Than Claude Code

## The Problem

Claude Code agent fixed 4 bugs in 41 tool calls / 92K tokens.
Scuffy Trench agents failed the same task across 3 sessions totaling ~2.5M tokens.

Across the full Ship rebuild run:
- 27% bead success rate
- ~$160 spent, roughly half wasted on retries and budget blowups
- Every 2nd-3rd bead hits the 800K token budget
- Tower splits happening constantly (20 beads → 126 beads)

## Known Inefficiencies

### 1. readFile reads too much (PARTIALLY FIXED)

**Status:** Default cap of 100 lines added, but agents override it.

Agents pass explicit `limit: 260` to read 260 lines at a time, effectively
reading entire files in 2-3 paginated calls. The cap is a default, not a hard
limit. Claude Code reads 10-20 targeted lines per call.

**Evidence:** Session `72ec18f9` (test fix attempt): 21 readFile calls with
limits of 120-260 lines. Many files read 2-3 times.

**Potential fix:** Hard cap on readFile output (not just default). Or reduce
the default to 50 lines. Or add a cost annotation to the tool description
that says "each line costs ~4 tokens of context budget."

### 2. No file content caching across tool calls

Claude Code internally tracks what it's already read. Scuffy re-reads the
same files multiple times because the LLM doesn't remember exact contents
from earlier reads (they're far back in context).

The read-edit-verify cycle is the worst offender:
1. readFile (full file → context)
2. editFile (small diff)
3. readFile again "to verify" (full file → context AGAIN)

Claude Code skips step 3 — trusts the edit tool.

**Evidence:** The headless preamble says "Do NOT re-read files to verify edits"
but agents ignore it.

**Potential fix:** editFile could return a few lines of context around the edit
(showing the edit landed correctly), eliminating the need for verification reads.

### 3. Full test suite runs on every check

`npm run test` runs ALL workspace tests (~128 tests). Each run produces
output that goes into context. Agents run tests 3-4 times per session
(implement → test → fix → test → fix → test).

Claude Code runs targeted tests: `npm run test tests/specific-file.test.ts`.

**Evidence:** Session `72ec18f9`: ran `npm run test` 2x full suite. Session
before that: 3x full suite. Each adds 2-8K of output to context.

**Potential fix:**
- Teach agents to run targeted tests in the preamble
- Or: finishBead runs the full suite, but during development the agent
  should run only the relevant test file
- The bash output cap (8K) helps but doesn't solve the accumulation

### 4. Verbose tool call arguments

Scuffy's LLM (gpt-5.4) produces more verbose tool call JSON than Claude.
File write calls include the FULL file content as a tool call argument,
which goes into the assistant message. Then the tool result says "Wrote file."
But the full content is already in the conversation from the tool call.

**Potential fix:** Could the tool strip large `content` fields from the
logged tool call? Or summarize writeFile inputs in the session history?

### 5. No conversation summarization / compaction

The ARCHITECTURE.md lists `SummarizationMiddleware` as post-MVP. It was
never built. Claude Code compacts old messages (user disputes this — they
say they haven't compacted, but something about Claude Code's context
management is clearly more efficient).

Without compaction, every tool result stays at full size in the message
array forever. By iteration 40, the model is re-reading 600K of stale
context from iteration 3.

**Note:** The user explicitly says they have NOT compacted in their Claude
Code session and are at 700K after vastly more work. This suggests Claude
Code's tools themselves are more context-efficient, not that compaction
is doing the heavy lifting.

### 6. No subagent delegation

Zero subagent usage across the entire build run. All work done on gpt-5.4.
Read-heavy research (grepping, file exploration) could be delegated to
gpt-5.4-nano at ~10x less cost.

**Evidence:** `ls .scuffy/sessions/sub-*` returns 0 files.

**Potential fix:** Documented in docs/TODO-P2-subagent-delegation.md.

### 7. Beads too large (BEING ADDRESSED)

Scout creates beads that are too big for one session. Tower splits them,
but each failed attempt + split burns ~$11 ($8 failed session + $3 Tower).

20 initial beads → 126 after splits. ~35 splits × $11 = ~$385 wasted.

**Status:** Scout prompt updated with size guidance. Emergency replan
in progress to resize remaining beads.

## Session Logs

Session data is in the workspace's `.scuffy/sessions/` directory.
(If the workspace was moved from `workspace/ship-rebuild` to another
location, update the path accordingly.)

Key sessions to examine:
- `72ec18f9` — test fix attempt, 40 tool calls, budget exceeded. Good
  example of readFile abuse (21 reads, limits 120-260).
- `26b95b3b` — successful bead completion at 746K tokens. Shows the
  ceiling for a "normal" bead — barely fit.
- `624fe460` — budget exceeded on first attempt, Tower split worked.
  Shows the split/retry cycle.

## Comparison: Claude Code Agent vs Scuffy Trench

| Metric | Claude Code (subagent) | Scuffy Trench |
|---|---|---|
| Task | Fix 4 failing tests | Fix 4 failing tests |
| Tool calls | 41 | 40+ × 3 sessions = 120+ |
| Tokens | 92K | ~2.5M |
| readFile calls | Targeted (20-30 lines) | Full pages (120-260 lines) |
| Test runs | Targeted file | Full suite |
| Re-reads to verify | None | Multiple |
| Outcome | Fixed in 1 session | Failed 3 sessions, fixed by Claude Code |

## Recommended Investigation Order

1. **Instrument readFile** — log the actual token count of each readFile
   result. Quantify how much context is burned on reads vs edits vs bash.
2. **Compare tool call patterns** — diff a Claude Code session trace against
   a Scuffy session trace for similar tasks. What does Claude Code do
   differently in tool selection and parameterization?
3. **Test the hard cap** — set readFile max to 50 lines (not 100), see if
   it forces more targeted reads without breaking agents.
4. **editFile context return** — have editFile return 5 lines around the
   edit to eliminate verification re-reads.
5. **Targeted test guidance** — update preamble to say "run only the
   specific test file during development, not the full suite."
