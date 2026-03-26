# P0: describeModule tool — structured code introspection to replace bulk file reads

**Create as bead:** `br create --title="describeModule tool: structured TypeScript introspection via ts-morph" --type=feature --priority=0`

## Problem

Scuffy agents read entire files (200-320 lines) just to understand what a
module exports. This is the #1 cause of context bloat — a single session
makes 20+ readFile calls at 100-300 lines each, burning 800K tokens on
implementation details when all the agent needed was the API surface.

Claude Code (and Clojure REPLs) solve this by providing structured metadata
queries: "what does this module export?" returns signatures, not source.

## Solution

A new Scuffy tool: `describeModule` that returns structured API surface
information for a TypeScript file without reading the implementation.

### Core capabilities (must have)

```
describeModule({ path: "src/services/planning.ts" })
→
  Exports:
    function createPlanningService(deps: PlanningDependencies): PlanningService

  interface PlanningService {
    getMyWeek(workspaceId: string, userId: string): MyWeekView
    getSprintPlanningView(workspaceId: string, sprintId: string, personId: string): SprintPlanningView
    applyWeeklyPlanApprovalAction(workspaceId: string, planId: string, request: ApprovalActionRequest): WeeklyPlanRecord
    createWeeklyPlan(request: WeeklyPlanCreateRequest): WeeklyPlanRecord
    updateWeeklyPlan(workspaceId: string, planId: string, updates: Partial<WeeklyPlanRecord>): WeeklyPlanRecord
    deleteWeeklyPlan(workspaceId: string, planId: string): void
    ...
  }

  Types: MyWeekView, SprintPlanningView, WeeklyPlanRecord, ...

  File: 320 lines. Use readFile with offset/limit to read specific functions.
```

### Clojure REPL equivalents to implement

| Clojure | Tool | What it returns |
|---|---|---|
| `(ns-publics 'ns)` | `describeModule({ path })` | All exports with signatures |
| `(doc fn)` | `describeModule({ path, symbol: "fn" })` | JSDoc + signature for one symbol |
| `(source fn)` | `readFile` with offset/limit | Still needed for actual implementation |
| `(spec/describe ::spec)` | `describeModule({ path })` | Zod schemas, interfaces, type aliases |
| `(ns-refers 'ns)` | `describeModule({ path, imports: true })` | What this module imports and from where |

### Additional capabilities (investigate during implementation)

- **`listNamespace`** — list all .ts files in a directory with their export
  counts. Like `ls` but for code: "src/services/ has 12 files, planning.ts
  exports 3 functions and 8 types, issues.ts exports 2 functions and 5 types."

- **`findReferences`** — "who calls this function?" Returns file:line pairs.
  Eliminates the grep-then-readFile pattern.

- **`getCallGraph`** — for a function, show what it calls and what calls it.
  Helps the agent understand impact of changes without reading files.

- **`describeTests`** — for a test file, list describe blocks and test names
  without reading the implementation. Agent knows what's tested without
  reading 500 lines of test code.

- **`typeOf`** — given a symbol path (e.g., "PlanningService.getMyWeek"),
  return its full type signature including parameter types resolved through
  generics. Like hovering in an IDE.

## Implementation

### Library: ts-morph

`ts-morph` wraps the TypeScript compiler API with a cleaner interface.
Install in Scuffy's package.json (NOT the workspace's).

```typescript
import { Project } from "ts-morph";

const project = new Project({
  tsConfigFilePath: path.join(workspaceDir, "tsconfig.json"),
});

const sourceFile = project.getSourceFile("src/services/planning.ts");
const exports = sourceFile.getExportedDeclarations();

for (const [name, declarations] of exports) {
  for (const decl of declarations) {
    console.log(`${name}: ${decl.getType().getText()}`);
  }
}
```

### Performance consideration

ts-morph loads the full TypeScript project on first use. This is slow
(1-3 seconds) but can be cached across tool calls within a session.
The Project instance should be created once and reused.

Store the Project instance in ToolContext or as a module-level singleton
keyed by workspace path.

### Alternative: tsc --declaration

Simpler approach: run `tsc --declaration --emitDeclarationOnly` and read
the generated `.d.ts` files. These contain exactly the API surface.

Pro: no new dependency, uses existing tsc
Con: requires a build step, slower, generates files on disk

**Recommendation: ts-morph for the tool, with .d.ts generation as a
fallback if ts-morph is unavailable.**

## Impact estimate

Current: 20 readFile calls × 200 lines avg = 4000 lines ≈ 80K tokens of
file content per session.

With describeModule: 15 describeModule calls × 30 lines avg + 5 targeted
readFile calls × 50 lines avg = 700 lines ≈ 14K tokens.

**~5.7x reduction in file-read context per session.** This should bring
most beads under 400K tokens, well within budget.

## Files to create/modify

- `npm install ts-morph` in Scuffy's package.json
- `src/tools/describeModule.ts` — new tool
- `src/index.ts` — register the tool
- `src/roles.ts` — update headless preamble: "Use describeModule to
  understand a module's API before reading its implementation"
- `prompts/trench.md` — add guidance on when to use describeModule vs readFile

## Integration with headless preamble

Update the Context Budget section:

```
- **Use describeModule FIRST** to understand what a module exports. Only use
  readFile when you need to see the implementation of a SPECIFIC function.
- describeModule returns type signatures and exports. readFile returns source.
  Most tool calls should be describeModule, not readFile.
```
