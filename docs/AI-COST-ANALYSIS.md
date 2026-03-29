# AI Cost Analysis — Scuffy

## Development and Testing Costs

Development used a **Gauntlet-provided OpenAI API key** (GPT-5.4) for the
vast majority of runs. Two early runs (~Mon–Tue) used the Anthropic API
(Claude Sonnet 4.6); all subsequent runs (~28 of ~30 total) used OpenAI.
We have no billing dashboard access for the Gauntlet key, so cost estimates
are derived from surviving session logs and instructor-posted API request
counts.

### Hard data

**Gauntlet dashboard (instructor-posted, OpenAI API requests):**

| Date | API Requests | Delta |
|---|---|---|
| Thu 2026-03-26 ~5pm | 1,066 | — (Mon noon → Thu, pre-parallelism) |
| Fri 2026-03-27 ~5pm | 9,644 | +8,578 in ~24h (parallelism active) |

**Surviving session logs (376 sessions across 5 of ~30 runs):**

| Item | Amount |
|---|---|
| Sessions with LLM calls | 376 |
| Total LLM API requests | 6,302 |
| Total input tokens | 143.8M |
| Total output tokens | 1.2M |
| Cache read tokens | 15.3M |
| Avg LLM calls per session | 16.8 |
| Avg input tokens per session | 383K |
| Avg output tokens per session | 3.1K |

### Extrapolated totals

Most workspaces (and their session logs) were destroyed during pipeline
restarts. Extrapolation from surviving data and the API request counts:

| Item | Estimate | Method |
|---|---|---|
| Total API requests (full week) | ~15,000–25,000 | Dashboard trajectory + 2 more days |
| Total sessions | ~1,200–1,500 | API requests / 16.8 calls per session |
| Total input tokens | ~460M–575M | Sessions × 383K avg |
| Total output tokens | ~3.7M–4.6M | Sessions × 3.1K avg |

### Claude Code (development tool)

All Scuffy development — architecture, planning, implementation, debugging,
documentation — was done via Claude Code on Claude Opus 4.6. This is the
cost of *building* the agent, not running it.

| Item | Amount |
|---|---|
| Sessions | 19 |
| Prompts (tool calls + messages) | 5,503 |
| Cache write tokens | 17.5M |
| Cache read tokens | 1,071.6M |
| Output tokens | 1.16M |
| Active time | 14h 47m |
| Cache read share | 98.3% of all tokens |
| **Estimated cost (Opus 4.6 API pricing)** | **$2,023** |

The 98.3% cache read rate reflects long sessions where the same context
(CLAUDE.md, ARCHITECTURE.md, source files) was re-sent on every turn. On
the Max plan this is a flat subscription; at API pricing it would dominate
the bill.

| Date | Cost | Notes |
|---|---|---|
| Mon 03-23 | $84 | Initial architecture, first agent code |
| Tue 03-24 | $95 | MVP push |
| Wed 03-25 | $433 | Heavy development, pipeline iteration |
| Thu 03-26 | $451 | Parallelism, summoner rewrites |
| Fri 03-27 | $583 | Largest day — pipeline stabilization |
| Sat 03-28 | $211 | OOM hardlock debugging, case studies |
| Sun 03-29 | $168 | Final submission prep (ongoing) |

### What it would have cost (total)

| Item | Amount |
|---|---|
| Claude Code / Opus 4.6 (development tool, Max plan) | ~$2,023 |
| OpenAI GPT-5.4 input (~500M tokens @ $2.50/MTok) | ~$1,250 |
| OpenAI GPT-5.4 output (~4M tokens @ $10/MTok) | ~$40 |
| Anthropic Claude Sonnet (2 early pipeline runs) | ~$60–80 |
| **Estimated total if all API-priced** | **~$3,400** |

In practice: Claude Code was on a Max subscription ($200/month). The OpenAI
API spend was on a Gauntlet-provided key. Actual out-of-pocket: **$200**.

The input-to-output token ratio (~125:1) reflects the fundamental cost
structure of a coding agent: it reads far more than it writes. The ts-morph
exploration tools (describeModule, listNamespace) reduced per-session read
cost by ~5.7x compared to raw file reads — without them, total input token
usage would have been substantially higher.

## Production Cost Projections

| 100 Users | 1,000 Users | 10,000 Users |
|---|---|---|
| $50–100/month | $500–1,000/month | $5,000–10,000/month |

**Important caveat:** Scuffy is a software factory — it builds applications,
not serves end users. The meaningful cost unit is **per project build**, not
per user per month. The table above reflects projects built per month.

**Per-project cost breakdown:** A full application rebuild (like Ship) costs
roughly $200–500 in API spend across 200–400 sessions depending on
complexity and pipeline maturity. A smaller task (single feature, bug fix)
costs $0.50–5.00 across 5–30 sessions. The dominant cost driver is input
tokens — the agent reads far more than it writes.

## Assumptions

- Average agent invocations per user per day: 1–3 project builds (factory
  model) or 5–15 single-task invocations (assistant model)
- Average tokens per invocation (input / output): ~383K / ~3.1K (measured
  from 376 surviving sessions)
- Model: OpenAI GPT-5.4 at $2.50 / $10 per MTok (input / output)
- Per-project cost scales linearly with codebase size and task complexity
- Cache hit rates improve with longer runs (same files re-read across sessions)
- Extrapolation assumes surviving sessions are representative of destroyed ones
