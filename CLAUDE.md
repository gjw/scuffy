# Scuffy

Autonomous coding agent — Gauntlet Shipyard project.

## Role Assignment

Your first message from Chair will be your role name.

- **TOWER** → Read `prompts/tower.md` for your full instructions.
- **SCOUT** → Read `prompts/tower.md` — Scout triggers Tower in cold-start mode (new project, no existing architecture).
- **TRENCH** → Read `prompts/trench.md`. Chair provides your task.

Read `CONTEXT.md` for constraints. Read `ARCHITECTURE.md` for system design.
Read `beads-agent-guide.md` for br commands.

## Commands

```bash
npm install              # Install dependencies
npm run build            # Compile TypeScript (tsc)
npm run typecheck        # Type-check without emit (tsc --noEmit)
npm run dev              # Run agent in dev mode
npm run test             # Run tests (vitest)
npm run lint             # Lint (eslint + prettier --check)
npm run lint:fix         # Auto-fix lint issues
```

## Conventions

- **Commits:** Imperative mood, include issue ID: `Add feature (sc-a1b2)`
- **Branches:** `task/{id}-{slug}` (e.g., `task/abc1-timer-widget`)
- **Markdown formatting:** Always leave a blank line between a heading (or bold line)
  and the first list item, table, or code block below it.

## Pointers

- Read `ARCHITECTURE.md` for system design.
- Run `br ready --json` for your task.
- See `beads-agent-guide.md` for br commands.
