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

## Deliverables — Current Status

### Done (written, reviewed, committed)

| # | Deliverable | File |
|---|---|---|
| 1 | README.md | `README.md` — approach statement, setup guide, submission doc links |
| 2 | PRESEARCH.md | `PRESEARCH.md` — no changes needed |
| 3 | AI Cost Analysis | `docs/AI-COST-ANALYSIS.md` — corrected data, both cost layers |
| 4 | AI Development Log | `docs/AI-DEV-LOG.md` — all 5 sections, reviewed |
| 5 | Case studies | `docs/case-study-*.md` — OOM hardlock, polite trench, phase leak |

### Draft complete, needs review

| # | Deliverable | File | Notes |
|---|---|---|---|
| 6 | Demo Video Script | `notes/demo-video-script.md` | Chair needs to review, rehearse |
| 7 | LinkedIn Post | `notes/linkedin-post.md` | Chair needs to review, could sharpen with pipeline patterns |

### Needs work

| # | Deliverable | File | Notes |
|---|---|---|---|
| 8 | CODEAGENT.md | `CODEAGENT.md` | Submittable as-is. Want to update with case studies + latest run if time |
| 9 | ARCHITECTURE.md | `ARCHITECTURE.md` | Submittable as-is. Refresh if time |

### Blocked / Chair does manually

| # | Deliverable | Blocked on | Notes |
|---|---|---|---|
| 10 | Deploy Ship | Scuffy finishes current rebuild | nginx + certbot on Linode, ~15 min |
| 11 | Record demo video | Script review + deploy | Loom recording, ~30 min with rehearsal |
| 12 | Post LinkedIn | Review draft + screenshots | Copy-paste + attach screenshots |
| 13 | Push to both remotes | All files finalized | `git push` to GitLab + GitHub |
| 14 | Fill submission form | All links exist | Demo video, GitLab, LinkedIn, Ship app link, notes |

## Critical Path

```
Scuffy rebuild finishes
  → Deploy Ship to Linode (#10)
    → Take screenshots for LinkedIn (#12)
    → Record demo video (#11)
      → Upload to Loom
        → Fill submission form (#14)
          → Push to both remotes (#13)

In parallel:
  Review demo script (#6)
  Review + sharpen LinkedIn draft (#7)
  Update CODEAGENT.md if time (#8)
```

## What can be done RIGHT NOW (while waiting on rebuild)

1. **Review demo video script** — `notes/demo-video-script.md`
2. **Review LinkedIn post** — `notes/linkedin-post.md`
3. **Update CODEAGENT.md** — weave in case studies, sharpen architecture decisions
4. **Prep demo environment** — create the `demo/hello.ts` test file, verify REPL works, verify headless mode works
