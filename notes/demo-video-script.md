# Demo Video Script — Scuffy

**Target length:** 3-5 minutes
**Recording tool:** Loom (laptop)
**Style:** Narrated screen recording with scene breaks

---

## Preparation Checklist

Before starting Loom:

- [ ] Terminal window open, clean, large font (14pt+), dark theme
- [ ] `cd ~/dev/scuffy` in terminal
- [ ] `npm run build` completed (no errors)
- [ ] A test file ready to edit (create `demo/hello.ts` with a simple function)
- [ ] Ship rebuild workspace visible (`workspace/ship-rebuild/`)
- [ ] Dashboard or session logs accessible (if you have a web dashboard running)
- [ ] Browser tab: GitLab repo page
- [ ] Browser tab: Ship app deployed at `ship.foramerica.dev` (if deployed)
- [ ] Close all notifications, Slack, email

### Create demo file before recording

```bash
mkdir -p demo
cat > demo/hello.ts << 'EOF'
export function greet(name: string): string {
  return "Hello, " + name;
}

export function add(a: number, b: number): number {
  return a + b;
}
EOF
```

---

## Scene 1: Introduction (30 seconds)

**[ACTION: Show terminal with the Scuffy repo open. Maybe `tree -L 1` for context.]**

> This is Scuffy — an autonomous coding agent I built for Gauntlet Shipyard.
> It's a custom TypeScript agent loop, no LangGraph, no LangChain.
> The core is simple: assemble messages, call Claude, execute tool calls, repeat.
> What makes it interesting is the orchestration pipeline around it.
> Let me show you what it can do.

**[PAUSE — switch scene]**

---

## Scene 2: Surgical File Editing (60 seconds)

**[ACTION: Start the REPL with `npm run dev`. Wait for the `scuffy>` prompt.]**

> First, surgical file editing — the core requirement. I'll ask the agent to
> make a targeted change to a file without rewriting it.

**[ACTION: Type this instruction into the REPL:]**

```
Read demo/hello.ts, then change the greet function to use template literals instead of string concatenation.
```

**[ACTION: Let the agent work. It should: readFile → editFile (surgical replacement of the concatenation) → readFile to verify. Narrate as it runs:]**

> Watch the tool calls. First it reads the file — that's the read-before-edit
> invariant. Now it calls editFile with an exact string match for the old code
> and the new template literal version. It only touches the specific line, not
> the whole file. And it re-reads to verify the change.

**[ACTION: After it finishes, show the diff:]**

```bash
git diff demo/hello.ts
```

> You can see in the diff — only the one line changed. The add function below
> it is untouched. That's anchor-based string replacement.

**[PAUSE — switch scene]**

---

## Scene 3: Multi-Agent Coordination (60 seconds)

**[ACTION: Still in the REPL. Type this instruction:]**

```
Use the task tool to spawn a subagent. Have it read demo/hello.ts and write a test file at demo/hello.test.ts with vitest tests for both functions.
```

**[ACTION: Let the agent work. It should spawn a subagent via the task tool. Narrate:]**

> Now multi-agent coordination. I'm asking the main agent to delegate work to a
> subagent. Watch — it calls the task tool, which spawns an ephemeral child
> agent with its own session and its own trace log.

**[ACTION: After it completes, show the test file:]**

```bash
cat demo/hello.test.ts
```

> The subagent read the source, wrote tests, and returned. The parent got
> the result as a tool response. Each agent has its own JSONL session log —
> full observability for both.

**[PAUSE — switch scene]**

---

## Scene 4: Ship Rebuild + Autonomous Pipeline (90 seconds)

**[ACTION: Switch to showing the Ship rebuild workspace and/or the deployed Ship app.]**

> The real integration test is the Ship rebuild. I pointed Scuffy at a business
> requirements brief for a project management application and told it to build
> it from scratch.

**[ACTION: Show the workspace structure:]**

```bash
ls workspace/ship-rebuild/
```

> The agent chose its own architecture — TypeScript monorepo, React frontend,
> Express API, shared types. It generated its own work items, prioritized them
> by dependency graph, and built the application autonomously.

**[ACTION: Show the deployed app in the browser if available, or show code files:]**

```bash
wc -l workspace/ship-rebuild/web/src/**/*.tsx workspace/ship-rebuild/api/src/**/*.ts 2>/dev/null | tail -1
```

> This was built by a five-agent pipeline: Summoner orchestrates, Scout plans,
> Trench codes, Warden audits. The latest run produced thousands of lines of
> functional code — CRUD, filtering, sprint planning, user management — all
> from a brief, with zero manual code interventions.

**[ACTION: If deployed, show the app in the browser. Click through a few pages.]**

> It's not perfect. The comparative analysis documents every shortcoming
> honestly — the agent under-tests, it can't estimate complexity, and it
> never once consulted the original source code despite having a tool to do
> so. But it runs, it builds real software, and the pipeline stabilized to
> the point where failures became inefficiencies, not crashes.

**[PAUSE — switch scene]**

---

## Scene 5: Observability (30 seconds)

**[ACTION: Show a session log:]**

```bash
cat .scuffy/sessions/ | head -1 | python3 -m json.tool
```

**Or better, show the traces directory:**

```bash
ls traces/
head -5 traces/trace-1-normal-edit.jsonl | python3 -m json.tool
```

> Every agent run produces a structured JSONL trace. You can see the tool
> calls, token counts, timing — everything needed to debug agent behavior
> and calculate costs. These traces are the primary observability layer.

**[PAUSE — switch scene]**

---

## Scene 6: Closing (20 seconds)

**[ACTION: Show terminal or the repo.]**

> Scuffy is a custom TypeScript agent with middleware-based architecture,
> anchor-based surgical editing, a multi-agent pipeline, and structured
> JSONL tracing. The full source, documentation, and comparative analysis
> are in the repo. Thanks for watching.

**[END RECORDING]**

---

## Post-Recording

- [ ] Trim dead air at scene transitions
- [ ] Verify total is 3-5 minutes
- [ ] Upload to Loom
- [ ] Copy share link for submission form
