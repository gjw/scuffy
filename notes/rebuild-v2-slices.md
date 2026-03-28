# Ship Rebuild v2 — Vertical Slice Plan

## Design principles

- Every slice is demoable when done
- Tailwind + Vite proxy from Slice 1
- Acceptance criteria are user actions, not code descriptions
- One page per bead, styling + data + routes together
- PostgreSQL from the start, in-memory only for tests
- 3 parallel Trenches, Judicar at decision points
- Warden at slice boundaries only

## Slice 1: Scaffold + Auth (estimated: 3-4 beads)

**What gets built:**
- Monorepo scaffold (api/, web/, shared/, docker-compose with Postgres 16)
- Tailwind CSS installed, Vite proxy configured, base layout component
- Auth schema + repo + routes (login, logout, session check)
- Login page styled with Tailwind
- App shell: nav with user name when logged in, logout button, nav links
- Seed: 3 demo accounts (Ava admin, Milo member, Priya member)
- Health endpoint with DB connectivity check

**Acceptance criteria:**
- User opens app → sees styled login page
- User logs in as Ava → nav shows "Ava Stone", logout button, no login link
- User clicks logout → returns to login page
- `/health` returns `{ status: "ok" }` with DB status

**Direction needed:** Medium. The scaffold and auth pattern are well-defined.
The key instruction: "Install Tailwind in the first bead. Every component
must have Tailwind classes. The app shell layout must look professional."

---

## Slice 2: Programs & Projects (estimated: 3-4 beads)

**What gets built:**
- Programs schema + CRUD repo + routes + styled list page + create form
- Projects schema + CRUD repo + routes
- Program detail page with project list + create project form
- Navigation: programs list → program detail → projects

**Acceptance criteria:**
- User sees 4 seeded programs with color + emoji in a card grid
- User creates a new program (name, description, color, emoji)
- User clicks a program → sees its projects
- User creates a project within a program

**Direction needed:** Low. Standard CRUD vertical slice.

---

## Slice 3: People & Team Directory (estimated: 2-3 beads)

**What gets built:**
- People schema + repo + routes
- Team directory page with styled table (name, role, capacity, reports-to)
- Person detail/workload view
- Seed: 5 people with manager hierarchy

**Acceptance criteria:**
- User navigates to team directory → sees 5 people in a styled table
- User clicks a person → sees their detail with reporting line and capacity
- Table shows reports-to hierarchy visually

**Direction needed:** Low. Standard read-heavy vertical slice.

---

## Slice 4: Sprints & Issues (estimated: 4-5 beads)

**What gets built:**
- Sprints schema + CRUD within programs
- Issues schema + CRUD with assignment, priority, state machine
- Sprint list within program detail
- Issues list page with filters (program, sprint, assignee, state, priority)
- Issue detail page with state transitions + assignment
- Issue create form

**Acceptance criteria:**
- User views sprints within a program
- User creates an issue, assigns it to a person, sets priority
- User changes issue state (triage → todo → in_progress → done)
- User filters issue list by sprint, assignee, state
- User clicks an issue → sees full detail with description

**Direction needed:** Medium. The state machine and filter UI need
explicit specification. Brief should list all valid states and transitions.

---

## Slice 5: Weekly Planning (estimated: 4-5 beads)

**What gets built:**
- Weekly plans, retros, reviews schemas + CRUD
- Weekly plan page: create/edit plan with confidence slider
- Planning review queue: approval workflow (approve, request changes)
- Retro and review submission forms
- Approval state display with badges

**Acceptance criteria:**
- Priya submits a weekly plan with goals and confidence %
- Ava (manager) opens planning review queue → sees pending plans
- Ava approves Priya's plan → state changes to approved, shows badge
- Ava requests changes → plan shows "changes requested"
- Priya edits and resubmits

**Direction needed:** High. The approval workflow has specific states
and transitions. The brief must spell out the state machine and who can
do what. The confidence slider is a nice UX touch that needs explicit
mention or the agent will just use a text input.

---

## Slice 6: Coordination (estimated: 3-4 beads)

**What gets built:**
- Standups schema + CRUD
- Activity feed (read-only, aggregates events across entities)
- Notifications (list, mark read, mark all read)
- Comments (threaded, on any entity)
- Dashboard page: "my week" view + activity feed

**Acceptance criteria:**
- User submits a standup (yesterday, today, blockers)
- Dashboard shows recent activity across the workspace
- User has unread notification badge → clicks → sees notification list
- User marks notification as read
- User adds a comment on an issue

**Direction needed:** Medium. Activity feed aggregation and notification
kinds need specification. Comments threading UI needs explicit direction.

---

## Slice 7: Wiki (estimated: 2 beads)

**What gets built:**
- Wiki pages schema + CRUD
- Wiki browser: list page with search
- Wiki page detail with rendered content
- Wiki page create/edit form

**Acceptance criteria:**
- User browses wiki → sees 2 seeded pages
- User creates a new wiki page with title, slug, content
- User edits an existing page
- Wiki content renders with basic formatting

**Direction needed:** Low. Simple CRUD.

---

## Slice 8: FleetGraph Agent (estimated: 5-6 beads)

**What gets built:**
- FleetGraph service (separate Express server or route namespace)
- LangGraph-based reasoning pipeline: fetch → reason → classify → notify
- Finding types: scope_creep, stale_triage, accountability_debt, blocked_chain,
  overloaded_member, missing_estimate
- Findings stored as documents in postgres (finding_type, severity, status,
  affected_entity, reasoning, proposed_action)
- Chat UI panel: toggleable, pre-defined prompts per document type
- Findings panel: severity-coded cards with acknowledge/snooze/approve
- WebSocket listener for real-time Ship events (with poll fallback)
- HITL decision flow (acknowledge, snooze, approve)

**Acceptance criteria:**
- User clicks "Analyze this sprint" → FleetGraph scans and surfaces findings
- Finding shows severity badge, reasoning, and affected entity link
- User acknowledges a finding → badge clears
- User approves a proposed action → action is executed
- Proactive mode: agent detects a stale triage issue and creates a finding
  without user interaction

**Direction needed:** Very high. This is the most complex slice and the
one most likely to be incorrectly scoped. The brief must include:
- The graph node inventory and conditional edges
- The finding type definitions (what triggers each)
- The dual auth model (service token for proactive, user session for on-demand)
- The WebSocket reconnection strategy
- The HITL decision flow
- Which LLM to use (GPT-4o for reasoning, GPT-4o-mini for classification —
  or whatever's available)
- The finding dedup strategy

This slice might need to be split into sub-slices:
- 8a: FleetGraph service + finding types + reasoning pipeline (backend only)
- 8b: Chat UI + findings panel (frontend)
- 8c: WebSocket listener + proactive scans
- 8d: HITL decision flow

---

## Slice 9: Polish & Demo Readiness (estimated: 3-4 beads)

**What gets built:**
- Full demo flow verification (curl every endpoint, load every page)
- Fix any broken interactions, 500s, dead links
- Seed data completeness (every entity type has realistic demo data)
- Loading states, error states, empty states on all pages
- Responsive layout (desktop + tablet minimum)

**Acceptance criteria:**
- A grader can walk the entire demo flow without hitting errors
- Every page has loading, empty, error, and populated states
- The app looks like a professional tool, not a prototype

**Direction needed:** Low-medium. Mostly cleanup. But the brief should
include the exact demo script the grader will follow.

---

## Estimated totals

| Slice | Beads | Parallelizable? |
|---|---|---|
| 1: Scaffold + Auth | 3-4 | Partially (scaffold serial, auth parallel) |
| 2: Programs & Projects | 3-4 | Yes (programs + projects independent) |
| 3: People & Team | 2-3 | Yes |
| 4: Sprints & Issues | 4-5 | Partially (sprints → issues dependency) |
| 5: Weekly Planning | 4-5 | Partially (artifacts → approval flow) |
| 6: Coordination | 3-4 | Yes (standups, activity, notifications independent) |
| 7: Wiki | 2 | Yes |
| 8: FleetGraph Agent | 5-6 | Partially (backend → frontend → websocket) |
| 9: Polish | 3-4 | Yes |
| **Total** | **~30-40** | |

With 3 parallel Trenches and ~30min per bead average: **10-15 hours**.
Within the 16-22h overnight window.

## Questions to resolve before writing the brief

1. Do we include FleetGraph (Slice 8) or defer it? It's 5-6 beads and
   the most complex feature. If we defer it, we have a solid PM tool
   without the agent. If we include it, we have the differentiator but
   risk running out of time.

2. Which LLM for FleetGraph reasoning? OpenAI (GPT-4o/mini) or can we
   use whatever SCUFFY_MODEL is set to?

3. How detailed should the FleetGraph brief be? Should we include the
   actual graph node implementations, or let Tower/Trenches figure it out
   from the finding type definitions?

4. Should we run Slices 1-3 as a quick test before committing to the
   full build?
