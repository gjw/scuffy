# Scuffy — Requirements Extraction

Source: `shipyard_prd.pdf`

## Hard Gates

- **MVP (Tue 2026-03-25 23:59)** — all 7 items must pass:

  1. Agent runs in a persistent loop, accepts new instructions without restarting
  2. Surgical file editing — agent makes targeted changes without rewriting entire files
  3. Context injection functional — accepts external context at runtime, uses it in generation
  4. Tracing enabled — at least 2 shared trace links showing different execution paths
  5. PRESEARCH.md submitted with research notes and architecture artifacts
  6. Accessible via GitHub — runs locally
  7. CODEAGENT.md with Agent Architecture and File Editing Strategy sections complete

- **Early Submission (Thu 2026-03-27 23:59)** — Ship rebuild complete, comparative
  analysis drafted, multi-agent coordination working

- **Final Submission (Sun 2026-03-30 23:59)** — all deliverables, deployed

## Deliverables

| Deliverable | Notes |
|---|---|
| GitHub repo | Setup guide, clone-and-run |
| Demo video (3-5 min) | Surgical edit, multi-agent task, Ship rebuild example |
| PRESEARCH.md | Pre-search checklist (13 questions across 3 phases) |
| CODEAGENT.md | 8 sections, filled progressively |
| AI Development Log | 1-page: tools, prompts, code analysis, learnings |
| AI Cost Analysis | Dev spend + projections at 100/1K/10K users |
| Deployed application | Agent + agent-built Ship app publicly accessible |
| Social post | X or LinkedIn, tag @GauntletAI |

## Success Criteria

- Agent makes **surgical edits** reliably (most heavily evaluated capability)
- Agent handles files >200 lines without breaking
- Multi-agent: spawn 2+ agents, merge outputs, resolve conflicts
- Comparative analysis is the **highest-weighted deliverable** — 7 sections, evidence-backed, honest
- Every intervention during Ship rebuild is documented (interventions = data, not failures)
- Full observability — every run traceable end-to-end

## Key Constraints

- Must use **Claude API** (Anthropic SDK required)
- LangGraph recommended for agent framework (custom loop permitted)
- LangSmith recommended for tracing (custom structured logging permitted)
- **TypeScript** stack (per project manifest)
- Must research 2+ open source agents before coding (OpenCode, LangChain Open Engineer, Claude Code docs)
- File editing strategy must be chosen and justified upfront — switching mid-week is a planning failure
