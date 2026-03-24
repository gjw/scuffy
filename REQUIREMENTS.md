# Scuffy — Requirements Extraction

Source: `shipyard_prd.pdf`

## Meta

- One-week sprint, three deadlines. **Project completion is required to move onto
  the next week.**
- "There is no prescribed architecture. There is a defensible one. Finding it,
  justifying it, and building it is the assignment."
- "A focused agent that surgical edits and runs continuously beats a feature-rich
  agent that rewrites files and crashes."

## Hard Gates

- **Pre-Search (4 hours after assignment)** — Complete before writing any code.
  Research real coding agent architectures, define approach, lock architecture
  decisions. Output becomes part of final submission.

- **MVP (Tue 2026-03-24 23:59)** — all 7 items must pass:

  1. Agent runs in a persistent loop, accepts new instructions without restarting
     (fire-and-forget invocations do not count)
  2. Surgical file editing implemented — agent makes targeted changes without
     rewriting entire files
  3. Context injection functional — agent accepts injected context at runtime and
     uses it in generation
  4. Tracing enabled — at least two shared trace links submitted showing different
     execution paths
  5. PRESEARCH.md submitted with research notes and all architecture artifacts
  6. Accessible via GitHub — runs locally, no deployment required at this stage
  7. CODEAGENT.md submitted with Agent Architecture and File Editing Strategy
     sections complete

- **Early Submission (Thu 2026-03-26 23:59)** — Ship rebuild complete, comparative
  analysis drafted, multi-agent coordination working

- **Final Submission (Sun 2026-03-29 23:59)** — all deliverables submitted,
  documentation complete, deployed

## Core Agent Requirements

| Requirement | What It Means |
|---|---|
| Continuous operation | Persistent loop, accepts new instructions without restarting. Fire-and-forget does not count. |
| Surgical file editing | Targeted changes to specific lines or blocks without rewriting entire files. See File Editing section. |
| Multi-agent coordination | Spawn and coordinate multiple agents in parallel or sequence, merge outputs correctly. |
| Context injection | External context (spec, schema, previous output, test result) injected at runtime and used in next action. |

## File Editing

This requirement gets its own section because it is the most commonly skipped or
faked. An agent that rewrites entire files on every change is a code generator with
a file system wrapper — evaluated accordingly.

**Strategies to research and choose from:**

- **Unified diff** (git-style patches): generate diffs, apply with standard patch
  tooling. Precise and auditable, but requires the LLM to produce well-formed
  diffs consistently.
- **Line-range replacement**: identify start and end line numbers, replace only
  that range. Simple to implement, fragile if line numbers drift.
- **AST-based editing**: parse file to AST, modify target node, serialize back.
  Maximally precise, language-specific and complex.
- **Anchor-based replacement**: use unique string anchors within the file to
  locate and replace specific blocks. More robust than line numbers, less complex
  than AST.

Pick one strategy, justify in PRESEARCH.md, implement correctly. **Switching
strategies mid-week because you did not think it through is a planning failure.**

## Multi-Agent Coordination

System must spawn and coordinate at least two agents. Document orchestration
model: how agents communicate, how outputs are merged, how conflicts are resolved.
LangGraph recommended; custom framework permitted if it produces equivalent run
traces.

## Ship App Rebuild

Once the agent is functional, use it to rebuild the Ship app — all current
features — from scratch. **You are directing your agent to build it**, not building
a clone by hand.

The rebuild serves two purposes:

1. **Integration test** — if the agent cannot complete a real build task, it is not done.
2. **Data for comparative analysis** — every shortcoming will surface. That is the point.

You are expected to intervene when the agent gets stuck, but **document every
intervention**. Interventions are data, not failures.

## Comparative Analysis

The **most heavily weighted deliverable**. All seven sections required. Honest,
specific analysis of a flawed agent scores higher than vague praise of a polished
one. **Vague analysis will be penalized.** Specific claims must cite evidence from
the rebuild log.

| Section | What to Cover |
|---|---|
| Executive Summary | One paragraph: what you built and how the rebuild went overall |
| Architectural Comparison | How does the agent-built version differ structurally from the original? Choices agent made that a human would not? |
| Performance Benchmarks | Measurable comparisons — code complexity, test coverage, load time, lines of code, or whatever is meaningful for Ship |
| Shortcomings | Where did the agent fail, produce incorrect output, or require intervention? List every intervention and what it reveals. |
| Advances | Where did the agent outperform or move faster than manual development? |
| Trade-off Analysis | For each major architecture decision, was it the right call? What would you change? |
| If You Built It Again | What would be different about the agent's architecture, file editing strategy, or context management? |

## Observability

Every agent run must be traceable. After any run, must be able to answer: what did
the agent do, in what order, with what inputs, and what did it produce at each
step? LangSmith recommended if using LangGraph; custom structured logging must
produce equivalent traces.

## Deliverables

| Deliverable | Requirements |
|---|---|
| GitHub Repository | Setup guide, architecture overview; another engineer can clone and run without asking questions |
| Demo Video (3-5 min) | Show agent making a surgical edit, completing a multi-agent task, and at least one example from the Ship rebuild |
| PRESEARCH.md | Completed pre-search checklist (13 questions across 3 phases) |
| CODEAGENT.md | All 8 sections complete — see structure below |
| AI Development Log | 1-page document using template below |
| AI Cost Analysis | Dev spend + projections at 100/1K/10K users |
| Deployed Application | Agent and agent-built Ship app both publicly accessible |
| Social Post | X or LinkedIn: description, features, demo or screenshots, tag @GauntletAI |

### CODEAGENT.md Structure

| Section | Due |
|---|---|
| Agent Architecture | MVP |
| File Editing Strategy | MVP |
| Multi-Agent Design | MVP |
| Trace Links | MVP |
| Architecture Decisions | Final |
| Ship Rebuild Log | Final |
| Comparative Analysis | Final |
| Cost Analysis | Final |

### AI Development Log Sections

| Section | Content |
|---|---|
| Tools & Workflow | Which AI coding tools you used and how you integrated them |
| Effective Prompts | 3-5 prompts that worked well — the actual prompts, not descriptions |
| Code Analysis | Rough percentage of AI-generated vs. hand-written code |
| Strengths & Limitations | Where tools excelled and fell short on this specific project |
| Key Learnings | What you would do differently when using coding agents next time |

### AI Cost Analysis Structure

**Development costs:** Claude API costs (input/output token breakdown), number of
agent invocations during development, total development spend.

**Production projections:** monthly costs at 100 / 1,000 / 10,000 users.

**Assumptions to state:** average agent invocations per user per day, average
tokens per invocation (input/output), cost per invocation.

## Build Strategy (Priority Order)

1. Persistent loop — agent accepts instructions and runs continuously
2. Basic tool calls — read_file and edit_file working end-to-end
3. Surgical file editing — implement and verify chosen strategy
4. Context injection — external context accepted and used
5. Multi-agent coordination — spawn two agents, merge outputs
6. Ship rebuild — direct agent at Ship, document everything
7. Comparative analysis — write the full seven-section report

## Critical Guidance

- Get surgical file editing working completely before moving to multi-agent
- Test your edit strategy against files of varying size — behavior often breaks
  above 200 lines
- Document every intervention during the Ship rebuild — this is your analysis data
- Add tracing early — you need visibility to debug agent behavior
- Do not mock responses at any stage — run against real code

## Key Constraints

- Must use **Claude API** (Anthropic SDK required)
- LangGraph recommended for agent framework (custom loop permitted)
- LangSmith recommended for tracing (custom structured logging permitted)
- **TypeScript** or **Python** stack (PRD offers both: Node.js/Express or
  Python/FastAPI)
- Must research 2+ open source agents before coding (OpenCode, LangChain Open
  Engineer, Claude Code docs)
- File editing strategy must be chosen and justified upfront

## Deployment Plan

- **Host:** Existing Linode VPS, subdomains of `foramerica.dev`
- **Agent:** Web frontend (WebSocket chat UI) around Scuffy's REPL at e.g.
  `scuffy.foramerica.dev`. Auth-gated, sandboxed workspace, token budget cap.
- **Ship rebuild:** Deployed normally at e.g. `ship.foramerica.dev`
- **Scope:** Final Submission only. MVP runs locally.

## Pre-Search Checklist (13 Questions)

### Phase 1: Open Source Research

1. For each agent studied: which agent, which source parts read, file editing
   mechanism/tradeoffs/failure modes, context management across turns, failed tool
   call handling, what to take, what to do differently and why
2. Which file editing strategy are you adopting and why? Failure modes and how to
   handle them?

### Phase 2: Architecture Design

3. System diagram — full flow from user instruction through agent loop to output,
   including at least one error branch (Mermaid or image)
4. File editing strategy — step by step mechanism, what happens when location is wrong
5. Multi-agent design — orchestration model, communication, output merging
6. Context injection spec — what types of context, in what format, at what point
   in the loop
7. Context injection spec — (duplicate in PRD, likely meant to be a second aspect)
8. Any additional tools needed — list with one-sentence descriptions

### Phase 3: Stack and Operations

9. Framework for agent loop and multi-agent coordination, and why
10. Where does persistent loop run? How is it kept alive between instructions?
11. Token budget per invocation? Where are the cost cliffs?
12. What does agent do on bad edit? How does it detect and recover?
13. What gets logged? Describe a complete run trace for a typical edit.

## Clarification Coverage

| Category | Status |
|---|---|
| Functional scope | Clear — 4 core capabilities well-defined, MVP gates explicit |
| Data model | Resolved — Ship is FleetGraph (PM app, ~360 files, pnpm monorepo). Tiered access: schema+contracts+tests injected, source readable on demand |
| Integration & deps | Clear — Anthropic SDK, local for MVP, Linode VPS + foramerica.dev for final |
| Non-functional qualities | Clear — "breaks above 200 lines" is the key threshold; no other perf targets specified |
| Edge cases & failure | Clear — PRD asks us to define recovery strategies, not prescribe them |
| Constraints & tradeoffs | Clear — TypeScript, Claude API, research-first, no mocking, file edit strategy locked upfront |
| Terminology | Resolved — "shared trace links" = committed JSONL session logs linked from CODEAGENT.md (pending instructor confirmation) |
| Acceptance criteria | Resolved — MVP crisp (7 checkboxes); "deployed" = Linode VPS with web frontend for agent + rebuilt Ship app |
