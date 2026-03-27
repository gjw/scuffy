# Ship — Rebuild Context Brief

Compact reference extracted from the FleetGraph/Ship reference project. This is a
WHAT-not-HOW bundle for planning a rebuild.

## 1) Product Thesis

Ship is a project management system that combines:
- issue tracking,
- documentation/wiki content,
- project/program organization,
- weekly planning workflows,
- team visibility.

The original product philosophy was:
- "everything is a document"
- plans are the unit of intent
- weekly plans and retros matter as much as issue status
- documentation should support learning, not just compliance

Original README positioning:
- one place for docs, issues, projects, and team workload
- government-built but generally useful
- plan-driven weekly execution with retrospectives

## 2) Core Domain Model

### Workspace and identity
- **Workspace** is the top-level tenant.
- Users belong to workspaces with roles: **admin** or **member**.
- Data is workspace-scoped.
- **Person** is separate from User:
  - workspace-scoped profile
  - has email, role, capacity hours
  - may report to another person (`reports_to`)
  - may map to a user account, but is not the same concept

### Planning and work entities
- **Program**: required strategic top-level container for work.
  - has color, emoji
  - has RACI ownership: responsible/owner, accountable, consulted[], informed[]
- **Project**: belongs to exactly one program.
  - has ICE scoring: impact, confidence, ease (1–5 each)
  - has owner and RACI-like ownership
  - has approval workflows for plan and retro
- **Issue**: atomic work item.
  - belongs to exactly one program
  - optionally belongs to one project within that same program
  - optionally belongs to one sprint/week
  - optionally assigned to one person
  - has estimate, due date, optional rejection reason
  - priority: low, medium, high, urgent
  - state machine:
    - triage → backlog → todo → in_progress → in_review → done | cancelled
- **Sprint / Week**: thin time container owned by a program.
  - belongs to exactly one program
  - has sprint number and status: planning → active → completed
  - represents a time period for that program (e.g. "Engineering, Week 12")
  - multiple people contribute to the same sprint via their weekly plans
- **Weekly Plan**: per-person-per-sprint planning document. This is where
  individual planning lives:
  - has plan rich text, success criteria, confidence score (0–100)
  - has plan approval workflow (manager approves the person's plan)
  - one per person per sprint
- **Weekly Retro**: per-person-per-sprint retrospective document
- **Weekly Review**: per-person-per-sprint review document.
  - includes plan validation (`null | true | false`)
  - includes review rating 1–5 (individual performance for that sprint)
- **Standup**: daily status entry per person, optionally scoped to a sprint
- **Wiki**: free-form documentation page with rich text
- **Comment**: threaded discussion attachable to any entity

## 3) Two Independent Hierarchies

Ship has two orthogonal structures that meet at issues:

### Work hierarchy
- Program (required root)
- Project (optional grouping under a program)
- Issue
- Issues may also live directly under a program without a project

### Time/planning hierarchy
- Program → Sprint/Week (time container per program)
- Person → Weekly Plan (individual commitment within a sprint)
- Sprint → Issues (scheduled work for this period)

Important rule:
- issue→project and issue→sprint are independent associations
- but if an issue belongs to a project, the issue's program must match the project's program

## 4) Key Cardinalities and Constraints

- Issue → Program: exactly 1, required
- Issue → Project: 0 or 1, optional
- Issue → Sprint: 0 or 1, optional
- Issue → Assignee: 0 or 1, optional
- Project → Program: exactly 1, required
- Sprint → Program: exactly 1, required
- Person → reports_to Person: 0 or 1
- Standup → Person: exactly 1
- Standup → Sprint: 0 or 1
- Weekly Plan → Person + Sprint: exactly 1 each
- Weekly Retro → Person + Sprint: exactly 1 each
- Weekly Review → Person + Sprint: exactly 1 each
- Comment → target entity: exactly 1

Business constraints:
- no cross-program project membership for issues
- a person's "my week" view aggregates their issues across all program sprints
  for the current period

## 5) Important Behavioral Semantics

### Backlog is a filter, not a container
Backlog means:
- `sprint is null`
- and issue state is not terminal (`done`, `cancelled`)

Other important views are also filters:
- Triage: state = triage
- Completed: state in (done, cancelled)
- My work: assignee = current user and not terminal
- Program issues: program = X
- Project issues: project = Y

### Completed issues remain in sprint history
If an issue was in a sprint and becomes done/cancelled, it should remain associated to
that sprint so sprint completion metrics still make sense.

### Free-floating issues are normal
An issue with no project and no sprint is valid; it still belongs to a program.

### Soft deletion
Reference brief specifies soft delete via `deleted_at`, not hard delete.

### Visibility is required
Every entity has a visibility state: **private** (creator only) or **workspace**
(all workspace members can see it). This is must-have — users need to draft plans,
retros, and other content privately before sharing. Two states, per-entity, no
complex ACLs.

### Approval state semantics
Approval state tracks more than approved/not approved. Important states include:
- pending
- approved
- changed_since_approved
- changes_requested

Approval metadata should preserve:
- who approved
- when
- which version was approved
- whether content changed after approval

### UX pattern: cascade warnings
When closing a parent issue with incomplete children, original Ship warned and asked
for confirmation.

## 6) Original Architecture Notes from Reference

The original Ship implementation used a unified document model:
- a single `documents` table
- `document_type` / type enum to distinguish kinds
- JSONB `properties` for type-specific fields
- generic `document_associations` table for relationships

Benefits noted in reference:
- one CRUD model for many entity types
- easy extensibility for new document kinds
- unified history/audit behavior
- rich text worked consistently across document-like entities

Problems noted in reference:
- person/config/special concepts do not fit cleanly as generic documents
- generic associations allowed relationships without strong schema enforcement
- JSONB properties weakened database-level typing
- sprint ownership was per-person but sprint issues were cross-project, creating a
  confused hybrid; the rebuild clarifies this: sprints are per-program time
  containers, individual planning is in weekly plan artifacts

For the rebuild, this is reference context only, not a prescription.

## 7) Feature Checklist

### Must-have

#### Authentication and sessions
- email/password registration and login
- session creation, extension, revoke/logout
- inactivity timeout + absolute timeout
- workspace membership and roles

#### Issues
- CRUD
- full issue state machine
- priority levels
- assignment to people
- filtering by state, priority, assignee, sprint, project, program
- reject with reason

#### Sprints / weeks
- CRUD (per program)
- status lifecycle: planning → active → completed
- view sprint issues (all issues in this program's sprint, any assignee)
- view sprint standups
- "my week" view: aggregate current user's issues across all program sprints

#### Programs and projects
- CRUD programs with RACI ownership
- CRUD projects with ICE scoring
- project issue views
- program project views
- program issue views including free-floating issues

#### Team
- directory/grid of people with capacity and roles
- person profiles and reporting relationships
- person assigned-issue view

#### Dashboard
- my work view for current user
- team weekly progress overview

#### Visibility
- per-entity visibility: private (creator only) or workspace (all members)
- entities should default to one or the other (your call which)
- users must be able to toggle visibility

#### Workspace admin
- create workspace
- invite members by email
- change member roles
- remove members

### Should-have
- weekly plan approval workflow (manager approves person's plan for a sprint)
- weekly review with plan validation + rating (per person per sprint)
- project plan approval and retro approval
- approval state tracking
- real-time approval notifications: when a manager approves, requests changes, or
  rejects a plan/retro, the owner must be notified immediately without refreshing.
  This is critical to the approval workflow — the back-and-forth between owner and
  manager should not require polling.
- threaded comments on any entity
- full-text search across titles/content
- standups
- weekly plans, retros, reviews
- activity feed
- document/entity history audit trail
- proactive user notifications: beyond approvals, users benefit from immediate
  notification when, among others, (1) an issue is assigned to them, (2) a sprint
  transitions status (planning → active → completed), (3) upstream issue closures
  cascade to their assigned work. These are examples, not an exhaustive list —
  the goal is that users are proactively fed information that improves their
  ability to use Ship without requiring them to refresh or poll.

### Nice-to-have
- wiki pages
- org chart visualization
- status heatmap across programs/sprints
- reviews queue
- backlinks / reverse link graph
- action-item generation/accountability helpers
- document conversion (issue ↔ project)
- API tokens
- super-admin impersonation
- Yjs/CRDT real-time collaboration
- FleetGraph agent service (proactive monitoring agent — a separate system that
  watches for issues and creates findings)
- FleetGraph findings UI (displays agent findings, allows confirm/dismiss/snooze)
- AI analysis endpoints (send plan/retro text to an LLM for review feedback —
  simple request/response, not the full FleetGraph agent)

### Explicitly out of scope for rebuild parity
- PIV/CAC/X.509 auth
- CAIA OAuth
- S3/CDN storage (local file storage only if uploads are needed)

## 8) API Surface Summary from Reference Materials

Exact route parity is not required, but the reference app exposed concepts roughly like:

### Auth
- login
- logout
- session extension

### Issues
- list with filters
- get by id
- create
- update (including state/priority/assignment)
- reject

### Weeks / sprints
- get sprint detail (program, status, period)
- list by status or program
- get sprint issues
- get sprint standups
- "my week" aggregation across program sprints

### Weekly plans / retros / reviews
- get/create/update per person per sprint
- plan has rich text, confidence, success criteria
- plan approval (manager approves)
- review has validation + rating

### Projects
- list
- get with ICE scores
- update RACI, ICE, approval
- get project issues
- approve plan / retro

### Programs
- list
- get
- update RACI/color
- get program issues

### Team
- team grid
- lookup person by user

### Dashboard
- my work

### Admin
- create/archive workspace
- send invites
- manage member roles

### Comments
- create / update / delete on any entity

### Search
- full-text search over titles/content

### Activity
- recent changes with pagination

### Standups
- create
- list, optionally filtered by sprint

### Weekly artifacts
- get plan/retro/review per person per sprint
- plan approval workflow endpoints

### History
- per-entity audit trail

### Associations / links
Reference materials indicate add/remove relationship capabilities between entities such as:
- issue→project
- issue→sprint
- project→program
- and generic document associations in the old model

## 9) Frontend View Inventory

Reference brief identifies these main views:
- Login
- Dashboard
- Issues list (default backlog-style view)
- Programs list
- Projects list
- Entity detail
- My Week
- Team Directory
- Person's Issues
- Sprint Plan
- Sprint Review
- Team Planning Mode
- Workspace Admin
- Settings

Nice-to-have views:
- Org Chart
- Status Heatmap
- Reviews Queue
- Search results
- Converted Documents

## 10) Original Tech Stack and Operational Context

From reference repo documentation, original Ship was a monorepo with:
- `web/` React frontend
- `api/` Express backend
- `shared/` shared TypeScript types
- PostgreSQL database
- Vite on the frontend
- TailwindCSS
- TipTap editor
- WebSocket support
- Yjs collaboration in the original system

For rebuild planning, these stack details are historical context, not requirements.

## 11) Notable Product/Workflow Insights from Reference README

These matter for preserving product identity:
- Ship is not just a task tracker; it is intended to keep plans, execution, and learning connected.
- Weekly plans and retros are first-class artifacts, not side documents.
- Missing documentation should be visible and socially legible, but not necessarily blocking.
- Team views should help answer "who's doing what this week?"
- Projects answer "what are we building?" while docs answer "where is that knowledge?"

## 12) Agent Workflow Guidance

### Documentation structure

ARCHITECTURE.md should stay **high-level and scannable** — system design, directory layout,
key decisions, and component boundaries. When a topic needs implementation-level detail
(persistence strategy, frontend routing plan, API contract specifics), create a separate
doc in `docs/` and link to it from ARCHITECTURE.md as an appendix reference:

```
## Appendix references
- [Backend persistence and module boundaries](docs/backend-persistence.md)
- [Frontend routing and view architecture](docs/frontend-architecture.md)
```

This keeps ARCHITECTURE.md useful as a quick-reference while preserving detail for agents
that need it.

### Monorepo imports

This project uses npm workspaces (`api/`, `web/`, `shared/`). Cross-workspace imports
should use the package name (`@ship/shared`) rather than relative paths. Scout's scaffold
bead must configure workspace dependencies in each package.json:

```json
// api/package.json
{ "dependencies": { "@ship/shared": "*" } }
// web/package.json
{ "dependencies": { "@ship/shared": "*" } }
```

And tsconfig paths if needed for TypeScript resolution. Do NOT use deep relative paths
like `../../../../shared/src` — they break when files move and are hard to read.

### Bead dependency hygiene

When creating beads with dependencies, only reference bead IDs that were returned by
previous createBead calls in the same session. Do NOT guess or fabricate bead IDs —
the tool will reject invalid references. If you need to reference a bead you created
earlier, use the exact ID string from the tool's response.

## 13) Quality Standards

These are measurable standards, not aspirations. Warden audits against them. Trench
agents are expected to meet them on every bead.

### Category 1: Type Safety

The strength of TypeScript's type system as used in this codebase. Measured by:

- **Zero `any` types** — explicit or implicit. Use `unknown` + narrowing. If the
  compiler infers `any` (e.g., untyped parameters, missing return types), fix it.
- **Zero `as` type assertions** — unless preceded by a runtime check that proves the
  type. `as unknown as T` is never acceptable.
- **Zero `!` non-null assertions** — use optional chaining, nullish coalescing, or
  explicit narrowing instead.
- **Zero `@ts-ignore` / `@ts-expect-error`** — if TypeScript complains, fix the types.
- **Strict mode enabled** — `strict: true`, `noUncheckedIndexedAccess: true`,
  `exactOptionalPropertyTypes: true` in tsconfig.
- **All function parameters explicitly typed.** All exported functions have explicit
  return types.

Warden should be able to run `grep -r "as any\|: any\|@ts-ignore\|@ts-expect-error" src/`
and find zero matches.

### Category 2: Test Quality

Tests are a first-class deliverable, not an afterthought. Every bead that adds or
changes behavior must include or update tests.

- **All tests pass at all times.** A bead that breaks existing tests must fix them
  before completion. Never leave failing tests — finishBead rejects this.
- **Vertical test slices.** When adding an entity (e.g., Programs), write tests in
  the same bead: persistence tests, route tests, and a basic component render test.
  Do NOT defer tests to a separate "add tests" phase.
- **Every API route**: at least one happy-path test and one error/validation test.
- **Every persistence operation**: test with realistic multi-record data, not
  single-item trivial cases. Test workspace scoping, filtering, edge cases.
- **React components**: at minimum, a render test that doesn't crash. For interactive
  components, test user actions (click, submit).
- **Don't mock what you own.** The in-memory persistence IS the test double — test
  against it directly. Only mock external services.
- **Realistic test data.** Use diverse names, multiple entities in different states,
  edge cases (empty lists, max-length strings, special characters).

### Category 3: Design and UX

The build should look intentional, not generated. Every page should answer a question.

- **Information density.** Tufte's principle: maximize the data-ink ratio. Every pixel
  should communicate information. No decorative chrome, no empty cards, no spacer divs.
  Dashboards should be dense with actionable data.
- **Accessibility.** Target WCAG AA:
  - Semantic HTML: `<nav>`, `<main>`, `<article>`, `<section>`, `<button>` (not styled divs)
  - ARIA labels on interactive elements
  - Keyboard navigable (tab order, focus visible)
  - Sufficient color contrast (4.5:1 for text, 3:1 for large text)
- **All view states handled.** Every page must handle: loading, empty, error, and
  populated states. "No programs yet — create one" is better than a blank page.
  "Failed to load issues" with a retry button is better than a silent failure.
- **Consistent spacing and typography.** Use a spacing scale (4px, 8px, 16px, 24px,
  32px). Use a type scale (headings, body, small). Don't ad-hoc pixel values.
- **Responsive basics.** Works on desktop (1024+) and tablet (768+). Mobile is stretch.

### Category 4: Seed Data

The application ships with seeded demo data that tells a realistic story:

- **Multiple users** with different roles (admin, member) and reporting relationships
- **Multiple programs** at different stages (planning, active, completed)
- **Multiple sprints** with issues in every state (backlog, in progress, review, done)
- **Weekly plans and retros** in various approval states
- **Enough volume** to make dashboards meaningful (5-10 of each entity)
- **Diverse names and content** — not "Test User 1" or "Lorem ipsum"

Seed data should make a grader say "this feels like a real project management tool"
within 10 seconds of logging in.

### Category 5: Build Approach — Vertical Slices

Each bead should produce a visible, deployable increment. Build vertically (one entity
end-to-end: persistence + routes + tests + view) rather than horizontally (all
persistence, then all routes, then all views).

Good bead: "Add Programs list page with API route, persistence, and render test"
Bad bead: "Add persistence layer for all entities"

This means each bead can be demoed. The Docent (if present) can evaluate after any bead,
not just at phase boundaries. And if the build stops mid-way, every completed bead left
something usable behind.

### Category 6: Deployment Readiness

The application must be deployable from Phase 1 onward:

- Health check endpoint (`/health`) reporting service status
- Environment-based configuration (port, host, API URL via env vars, not hardcoded)
- Static frontend build (`vite build`) producing servable dist/ files
- A clear deploy path: what commands to run, what ports to expose

## 14) Rebuild Guardrails

When planning the rebuild, preserve these truths:
- programs are the required organizational root for work
- sprints/weeks are per-program time containers; individual planning lives in weekly plans
- issues are the join point between organizational structure and time planning
- backlog is a view, not a separate entity
- issue/project/program consistency rules must be enforced
- approvals should track change-after-approval state, not just approval booleans
- soft-delete and audit/history are part of the reference behavior
- per-entity visibility (private / workspace) is required, not optional
