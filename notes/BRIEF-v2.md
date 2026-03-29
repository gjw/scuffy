# Ship Rebuild v2 — Brief

## What is Ship?

Ship is a planning-first project management tool for small teams. It connects
planning (weekly plans, retros, reviews) to execution (issues, sprints) to
accountability (standups, activity feed, notifications) in a single workspace.

Ship includes **FleetGraph**, an embedded AI agent that proactively monitors
workspace health and surfaces findings — stale issues, scope creep, accountability
gaps, team overload — without a user asking. Users can also chat with FleetGraph
on demand to analyze whatever they're looking at.

## Technical stack

- **Monorepo:** `api/`, `web/`, `shared/`, `fleetgraph/` — npm workspaces
- **API:** Express 5, TypeScript ESM, Zod validation
- **Web:** React 19, React Router v7, Vite, **Tailwind CSS 4**
- **Database:** PostgreSQL 16 in Docker (docker-compose)
- **FleetGraph:** LangGraph.js, OpenAI API (GPT-4o reasoning, GPT-4o-mini classification)
- **Testing:** Vitest everywhere. API tests hit real in-memory repos via supertest.
  Web tests use Testing Library + jsdom. FleetGraph tests mock the Ship API client.
- **Dev:** `npm run dev` runs API + web + FleetGraph concurrently. Vite proxies
  API requests to Express.

## Non-negotiable requirements

These MUST be present from Slice 1. They are not optional. They are not "Phase 5
polish." Failure to include them from the start is a build failure.

1. **Tailwind CSS on every component.** Install `tailwindcss` and `@tailwindcss/vite`
   in Slice 1. Add `@import "tailwindcss"` to the root CSS file. Every component
   that renders content MUST have Tailwind utility classes. There is no unstyled
   HTML anywhere in the app. The design language is dense, data-rich, professional —
   think Bloomberg terminal meets clean web app. Neutral slate/gray palette with
   program colors as accents.

2. **Vite dev proxy.** Configure in `vite.config.ts` in Slice 1:
   ```typescript
   server: {
     proxy: {
       '/api': 'http://localhost:3000',
       '/auth': 'http://localhost:3000',
       '/health': 'http://localhost:3000',
     }
   }
   ```
   All API routes go through the proxy. The frontend uses relative URLs only.

3. **PostgreSQL from the start.** Docker-compose with Postgres 16. Schema migrations
   in `api/src/db.ts`. Every repository implemented against postgres. In-memory
   repos exist ONLY for test isolation. There is no in-memory production mode.
   `DATABASE_URL` env var drives the connection.

4. **Seed data for every slice.** Each slice adds seed data for its entities.
   `npm run db:seed -w api` populates the database. Seed data must be realistic
   and immediately demoable. Seeded workspace: `workspace-demo`.

5. **Every page handles loading, empty, error, and populated states.** No page
   may render only the happy path.

6. **Navigation must be complete.** Every nav link leads to a working page. Every
   list item is clickable and leads to a detail view. No dead ends. After login,
   the login link disappears and a logout button + user name appear.

## API conventions

- List endpoints: `GET /entity?workspaceId=...&limit=50&offset=0` → `{ items: T[], total: number }`
- Detail endpoints: `GET /entity/:id?workspaceId=...` → `{ item: T }`
- Create: `POST /entity` with JSON body → `{ item: T }` (201)
- Update: `PATCH /entity/:id` with JSON body → `{ item: T }`
- Errors: `{ error: string, code?: string }` with appropriate HTTP status
- All inputs validated with Zod
- All queries workspace-scoped
- Paginate every list endpoint with `limit` and `offset`

## Type safety

- Zero `any`, zero `@ts-ignore`, zero `@ts-expect-error`
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` enabled
- All function parameters explicitly typed
- Repository interfaces return `Promise<T>` (async-first for postgres)
- In-memory test repos use `Promise.resolve()`, NOT `async` keyword
  (the codebase uses `@typescript-eslint/require-await`)

## Testing

- Every behavior-changing bead must add or update tests
- API route tests use supertest against the in-memory app (not postgres)
- Web component tests use Testing Library with jsdom
- Do NOT mock code we own — use in-memory repos directly
- Web test heap cap: `NODE_OPTIONS='--max-old-space-size=2048'` in web/package.json

## Seeded demo accounts

| Account | Email | Password | Role | Person |
|---|---|---|---|---|
| Ava Stone | `ava@demo.ship` | `ava-demo-password` | admin | person-ava-stone |
| Milo Rivera | `milo@demo.ship` | `milo-demo-password` | member | person-milo-rivera |
| Priya Narang | `priya@demo.ship` | `priya-demo-password` | member | person-priya-narang |

Additional people (no login): Daniel Kim (member), Lena Ortiz (member).
Ava → Milo (reports to), Milo → Priya, Daniel (reports to), Ava → Lena.

---

## Slices

Build these in order. Each slice is a vertical feature from database to styled UI.
Each slice MUST be demoable when complete. Do not start Slice N+1 until Slice N
passes its acceptance criteria.

### Slice 1: Scaffold + Auth

**Build:**
- Monorepo with npm workspaces: api/, web/, shared/
- docker-compose.yml with Postgres 16 (user: ship, password: ship, db: ship)
- api/src/db.ts — connection pool + migration runner
- Tailwind CSS installed in web/ with @tailwindcss/vite plugin
- Vite proxy for all API routes
- App shell component: header with app name, nav links, user info area
- Auth schema (auth_users table), auth repo, auth routes (POST /auth/login,
  POST /auth/logout)
- Login page: email + password form, styled with Tailwind, error display
- Session persistence in sessionStorage
- Nav updates after login: show user name + logout button, hide login link
- Health endpoint: GET /health → { item: { status: "ok" } }
- Seed: 3 demo accounts

**Acceptance — a user will:**
1. Open the app and see a professional-looking landing page with a Sign In link
2. Click Sign In and see a clean login form
3. Sign in as Ava Stone and see her name in the top nav, with a Sign Out button.
   The Sign In link is no longer visible.
4. Click Sign Out and return to the signed-out state
5. Try signing in with a wrong password and see a clear error message

---

### Slice 2: Programs & Projects

**Build:**
- programs table + programRepository + pgProgramRepository
- projects table + projectRepository + pgProjectRepository
- Program routes: GET /programs, POST /programs, GET /programs/:id
- Project routes: GET /programs/:id/projects, POST /programs/:id/projects
- Programs list page: card grid showing name, description, color, emoji
- Program create form: name, description, color picker, emoji input
- Program detail page: header with program info, project list below
- Project create form within program detail
- Navigation: programs list → program detail → back
- Seed: 4 programs, 3 projects

**Acceptance — a user will:**
1. Go to Programs and see four program cards, each with its color and emoji
2. Create a new program by filling in a name, description, picking a color, and
   typing an emoji. The new program appears in the list immediately.
3. Click into a program and see its description, projects, and a way to add a
   new project
4. Create a project inside that program. It appears in the project list.
5. Navigate back to the programs list from the detail page

---

### Slice 3: People & Team Directory

**Build:**
- people table + personRepository + pgPersonRepository
- Person routes: GET /people, GET /people/:id
- Team directory page: styled table with name, email, role, capacity hours,
  reporting line
- Person detail view: full profile with reporting hierarchy
- Seed: 5 people with manager relationships

**Acceptance — a user will:**
1. Go to Team Directory and see all five team members in a clean table
2. See each person's name, email, role, weekly capacity, and who they report to
3. Click someone's name and see their full profile — job info, capacity, and
   where they sit in the reporting chain
4. Understand at a glance that Ava leads the team, Milo and Lena report to her,
   and Priya and Daniel report to Milo

---

### Slice 4: Sprints & Issues

**Build:**
- sprints table + sprintRepository + pgSprintRepository
- Sprint routes: GET /programs/:id/sprints, POST /programs/:id/sprints
- issues table + issueRepository + pgIssueRepository
- Issue routes: GET /issues (with filters), POST /issues, GET /issues/:id,
  PATCH /issues/:id
- Sprint list within program detail page
- Issues list page with filter bar: program, sprint, assignee, state, priority
- Issue detail page: title, description, state badge, priority badge, assignee,
  sprint, state transition buttons
- Issue create form: title, description, program, project, sprint, assignee,
  priority
- Valid issue states: triage → backlog → todo → in_progress → in_review → done.
  Also: cancelled (from any state). No other transitions.
- Valid priorities: low, medium, high, urgent
- Seed: 5 issues in various states across programs

**Acceptance — a user will:**
1. Go to Issues and see a list of existing issues with colored state and
   priority badges that are immediately readable
2. Use the filter bar to narrow the list by state, sprint, or assignee — the
   list updates instantly
3. Create a new issue by filling in a title, choosing a program, assigning it
   to someone, and setting a priority. It appears in the list.
4. Click an issue to see its full detail — description, who it's assigned to,
   what sprint it's in, and its current state
5. Move an issue forward (e.g., click "Start Work" on a to-do issue) and see
   the state badge update
6. From a program's detail page, see its sprints with dates and status

---

### Slice 5: Weekly Planning

**Build:**
- weekly_plans, weekly_retros, weekly_reviews tables + repos + pg repos
- Plan routes: GET /weekly-plans, POST /weekly-plans, GET /weekly-plans/:id,
  POST /weekly-plans/:id/approval-transitions
- Same pattern for retros and reviews
- Weekly plan page: list of plans with status, create/edit form
- Plan form: plan text, success criteria, confidence percent (range slider 0-100
  with color bands: red 0-30, yellow 31-60, green 61-100)
- Planning review queue page: manager view of pending plans/retros/reviews
- Approval actions: approve, request changes (available to any user with a
  personId in session scope)
- Approval states: pending → approved | changes_requested.
  After edit: changed_since_approved. No other transitions.
- Retro form: free text retro
- Review form: review text, plan validation (yes/no/not recorded), rating (1-5 stars)
- Seed: 2 plans, 2 retros, 2 reviews in pending state

**Acceptance — a user will:**
1. Sign in as Priya, go to Weekly Plans, and see her existing plans
2. Create a new weekly plan: write what she'll do this week, define success
   criteria, and slide the confidence bar to 75% (the bar turns from red to
   yellow to green as confidence increases)
3. Sign in as Ava (Priya's manager), go to the Planning Review Queue, and
   see Priya's plan waiting for approval
4. Approve the plan — it immediately shows an "Approved" badge with Ava's name
5. On a different item, click "Request Changes" — it shows "Changes Requested"
   and the submitter would see that status on their plans page

---

### Slice 6: Coordination

**Build:**
- standups table + repo + pg repo
- activity_feed table + repo + pg repo (read-only, populated by triggers or seeds)
- notifications table + repo + pg repo
- comments table + repo + pg repo
- Standup routes: GET /standups, POST /standups
- Activity routes: GET /activity (paginated, filterable by actor/entity)
- Notification routes: GET /notifications, POST /notifications/:id/read,
  POST /notifications/read-all
- Comment routes: GET /comments?parentKind=...&parentId=..., POST /comments
- Dashboard page: two sections — "My Week" summary + activity feed
- Notification indicator in nav (unread count badge)
- Notification dropdown or page: list with mark-read
- Comment section component: embeddable on issue detail, plan detail, etc.
- Seed: activity entries, notifications, comments, standups

**Acceptance — a user will:**
1. Go to the Dashboard and see two things: a "My Week" summary of what's on
   their plate, and a scrollable feed of recent activity across the workspace
2. Notice a red badge on the notification bell in the nav — click it and see
   a list of unread notifications (e.g., "Your weekly plan was approved")
3. Mark a notification as read and see the badge count go down
4. Open an issue and scroll down to the comments section. Write a comment.
   It appears immediately with their name and timestamp.
5. Go to Standups and see what the team reported — who did what yesterday,
   what they're doing today, and what's blocking them

---

### Slice 7: Wiki

**Build:**
- wiki_pages table + repo + pg repo
- Wiki routes: GET /wiki, GET /wiki/:slug, POST /wiki, PATCH /wiki/:slug
- Wiki browser page: list of pages with title, summary, last updated
- Wiki detail page: full content rendered (treat as plain text with paragraph breaks)
- Wiki create form: title, slug (auto-generated from title), content
- Wiki edit: inline edit on detail page
- Seed: 2 wiki pages

**Acceptance — a user will:**
1. Go to the Wiki and see a list of knowledge base articles with titles,
   summaries, and when they were last updated
2. Click an article and read its full content
3. Create a new article by giving it a title and writing content. It appears
   in the wiki list.
4. Edit an existing article and see the changes saved

---

### Slice 8: FleetGraph Agent

**Build in sub-slices:**

#### Slice 8a: FleetGraph service + finding model (backend)
- fleetgraph/ workspace in monorepo
- FleetGraph Express server (port 3100 or mounted under /api/fleetgraph on main API)
- findings table: id, workspace_id, finding_type, severity (info/warning/critical),
  status (active/acknowledged/snoozed/resolved), affected_entity_id,
  affected_entity_type, reasoning, proposed_action (JSONB), human_decision,
  snooze_until, created_at, updated_at
- Finding types enum: scope_creep, stale_triage, accountability_debt,
  blocked_chain, overloaded_member, missing_estimate
- LangGraph pipeline: trigger → fetch (parallel: issues, sprints, team) →
  reasoning (LLM) → classify → route (clean/notify/action-propose)
- POST /api/fleetgraph/chat — on-demand analysis
- GET /api/fleetgraph/findings — list findings
- Ship API client for reading workspace data
- Seed: 2-3 pre-generated findings for demo

#### Slice 8b: FleetGraph UI (frontend)
- Chat panel component: toggleable panel at bottom of page
- Pre-defined prompt buttons: "Analyze this sprint", "What's blocking?",
  "Check accountability"
- Findings panel: severity-coded cards (blue=info, orange=warning, red=critical)
- Each finding shows: type badge, severity, reasoning text, affected entity link
- HITL actions: Acknowledge, Snooze (with duration picker), Approve (if proposed action)
- POST /api/fleetgraph/findings/:id/decide endpoint for HITL

#### Slice 8c: Proactive monitoring
- WebSocket client connecting to Ship's /events endpoint
- Event listener with 30-second debounce batching
- Hot scan: triggers on issue state changes, sprint scope changes
- Poll safety net: 5-minute interval catches missed WebSocket events
- Proactive findings persisted to database automatically

**Acceptance — a user will:**
1. Notice a small FleetGraph toggle at the bottom of the screen on any page
2. Click it and see a chat panel slide up with quick-action buttons like
   "Analyze this sprint" and "What's blocking progress?"
3. Click "Analyze this sprint" — after a moment, FleetGraph shows its findings:
   cards with severity colors (blue for info, orange for warning, red for critical),
   each explaining what it found and which entity is affected
4. Click "Acknowledge" on a finding — the card dims, indicating it's been seen
5. See a pre-existing finding from FleetGraph's proactive monitoring (it found
   something on its own, without being asked)

---

### Slice 9: Polish & Demo Readiness

**Build:**
- Walk the full demo flow, fix every broken interaction
- Verify all seed data is realistic and complete
- Ensure loading/empty/error states on every page
- Verify all navigation links work
- Responsive layout check (desktop + tablet minimum)
- Fix any console errors, 500s, dead routes

**Acceptance — a user walks through the entire app without hitting an error:**
1. Open the app. It looks professional and intentional.
2. Sign in as Ava. Her name appears in the nav.
3. Browse Programs. See four cards. Click into Foundation Refresh and see its
   projects and sprints.
4. Go to Team Directory. See five people. Click Priya and see her profile,
   who she reports to, and her capacity.
5. Go to Issues. See a list with colored badges. Filter by state. Create a new
   issue, assign it to Daniel, set it as high priority. Click into it and move
   it to "In Progress."
6. Sign out. Sign in as Priya. Go to Weekly Plans. Create a plan for this
   week with a confidence slider. Submit it.
7. Sign out. Sign in as Ava. Go to Planning Review Queue. See Priya's pending
   plan. Approve it. See the "Approved" badge.
8. Go to the Dashboard. See what's happening this week and recent activity.
9. Check notifications. Mark one as read.
10. Go to the Wiki. Read an article. Create a new one.
11. Open FleetGraph. Click "Analyze this sprint." See findings with severity
    colors. Acknowledge one.
12. Sign out. Done.

---

## Bead sizing rules

- **One page per bead maximum.** Include styling + data + routes + tests for
  that page in the same bead.
- **Do NOT split styling from functionality.** They touch the same files.
- **Do NOT create separate "add repo" and "add routes" beads.** One bead
  owns the full vertical: schema → repo → routes → page → tests.
- **Each bead must pass typecheck, lint, and tests before closing.**
- **Target: 3-5 beads per slice, max 5.** If a slice needs more than 5 beads,
  the slice is too big — split the slice.

## What NOT to build

- No real authentication (OAuth, JWT). Placeholder password comparison is fine.
- No real-time WebSocket from API to browser (except FleetGraph events).
- No file uploads or attachments.
- No email notifications.
- No mobile-responsive layouts (desktop + tablet only).
- No dark mode.
- No i18n.
