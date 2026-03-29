# Final Sprint Plan — 2026-03-29

Due: **Sunday 2026-03-29 23:59**

## Submission Form Fields

| Field | Value | Source |
|---|---|---|
| Demo video link | Loom URL | Record after script + rehearsal |
| GitLab repo | `ssh://git@labs.gauntletai.com:22022/gabrielwilkins/scuffy.git` | Final push |
| LinkedIn post link | LinkedIn URL | Post after writing |
| App link (Scuffy) | Placeholder / N/A | Not deploying Scuffy |
| Ship app link | `ship.foramerica.dev` (TBD) | Deploy latest rebuild to Linode |
| Additional notes | Credits, pointer to README, key docs | Written last |

## Deliverables Status

| # | Deliverable | File(s) | Status | Action |
|---|---|---|---|---|
| 1 | README.md | `README.md` | Not started | Write: setup guide, architecture overview, doc pointers |
| 2 | PRESEARCH.md | `PRESEARCH.md` | **Done** | No touch |
| 3 | CODEAGENT.md | `CODEAGENT.md` | Submittable | Improve if time: weave case studies, update with latest run |
| 4 | AI Development Log | `.claude/tracking/ai-dev-log.md` | Empty template | Write all 5 sections |
| 5 | AI Cost Analysis | `AI-COST-ANALYSIS.md` (new) | In CODEAGENT.md | Extract to standalone, pointer in CODEAGENT.md |
| 6 | Demo Video Script | `notes/demo-video-script.md` (new) | Not started | Write: scenes, blockquote narration, prep checklist |
| 7 | Demo Video | Loom recording | Not started | Chair records after script + rehearsal |
| 8 | Social Post (LinkedIn) | `notes/linkedin-post.md` (new) | Not started | Write draft |
| 9 | Deploy Ship | `ship.foramerica.dev` | Not deployed | Chair: nginx stanza + certbot on Linode |
| 10 | Push to both remotes | GitLab + GitHub | Not done | Final push after all files committed |
| 11 | Fill submission form | Gauntlet form | Not done | Chair fills after all links exist |

## Case Studies (for integration into deliverables)

| Case Study | File | Key Lesson | Integrate Into |
|---|---|---|---|
| OOM Hardlock | `notes/case-study-oom-hardlock.md` | Layer confusion: agents debug symptoms not causes | Dev Log, CODEAGENT shortcomings |
| Polite Trench | `notes/case-study-polite-trench.md` | Role ambiguity: agent refuses to fix diagnosed bug | Dev Log, CODEAGENT shortcomings |
| Phase Leak | `notes/case-study-phase-leak.md` | Phase gating must be enforced at claim level | CODEAGENT rebuild log |
| BUG-001 SQLite version | `docs/bug-001-investigation.md` | **Updated lesson:** dependency pinning — fix existed 23 days before we hit it; auto-update script would have prevented hours of debugging | Dev Log key learnings |
| BUG-002 B-tree corruption | `docs/bugs/bug-002-btree-corruption/` | Same as BUG-001: upstream fix existed, we ran stale version | Dev Log key learnings |

## Work Order

### Phase A — Write now (no dependency on running rebuild)

1. Extract AI Cost Analysis to standalone file
2. Write AI Development Log (needs Chair input on prompts + code %)
3. Write README.md
4. Write Demo Video Script
5. Write LinkedIn Post draft

### Phase B — Improve if time allows

6. Update CODEAGENT.md with case studies + latest run data
7. Refresh ARCHITECTURE.md

### Phase C — Chair does manually

8. Deploy Ship to Linode (nginx + certbot)
9. Record demo video from script
10. Post LinkedIn
11. Fill submission form
12. Final push to GitLab + GitHub

## Key Decisions

- **Not deploying Scuffy** — only Ship goes to `ship.foramerica.dev`
- **Ship rebuild still running** — deploy whichever version is best when ready
- **CODEAGENT.md is the floor** — submittable as-is, improve if time
- **BUG-001/002 lesson updated** — the real lesson is dependency version management, not SQLite corruption itself
