# Early Submission Video Script (~3-4 min)

## 1. Intro (30 sec)

"This is Scuffy, an autonomous coding agent built in TypeScript. It doesn't use
LangGraph or LangChain — it's a custom agent loop with a multi-agent pipeline
that can take a project brief and build an entire application autonomously."

Show: The repo in terminal, quick `ls` of the top-level structure.

## 2. The Pipeline (45 sec)

"The pipeline has four roles. Summoner is a state machine that orchestrates
everything. Scout reads the project brief and creates work items. Trench is the
coding agent that claims and implements work items. Warden does quality patrols
and creates new work items for anything it finds."

Show: Quick scroll through the Summoner state machine code or a diagram.
Show: `br list --status=open` or `br list --status=closed` to show the volume
of work items that were created and completed autonomously.

## 3. The Dashboard (30 sec)

"Here's the dashboard from the latest run. 274 sessions, 103 million tokens,
$247 in API cost, 197 minutes of runtime. The agent built the entire application
you're about to see."

Show: The Scuffy Factory Dashboard screenshot/page.

## 4. Ship Rebuild — The Result (45-60 sec)

"And here's what it built. This is live, deployed, zero human-written code."

Open https://scuffys-ship.foramerica.dev/#/dashboard

Ad hoc clickthrough — just show screens and react naturally:
- Issues view with filtering and prioritization
- Programs view — note the agent created dummy programs on its own
- Click into a program, show projects nested under it
- Sprint view, user management, whatever else is there
- Don't narrate a workflow, just click through and point out what exists

Key talking point: "All of this came from a business-requirements brief.
The agent chose the stack, the architecture, the UI layout, the data model,
everything."

## 5. Agent Mail / Human Intervention (45 sec)

"One of the interesting problems with autonomous agents is ambiguity. When
Scuffy encounters something the brief doesn't specify, it doesn't block — it
mails me, logs the decision it made, and keeps going."

Show: Open agent mail inbox, scroll through a few messages.
Show: "And I can inject context back. The next time an agent spawns, it reads
its mailbox first, so I can redirect without stopping the pipeline."
Show: An example of sending a message back.

## 6. Surgical Editing / Context Efficiency (30 sec)

"The biggest engineering challenge was context management. We built two
ts-morph-powered tools — describeModule and listNamespace — that let agents
explore code structure without reading entire files. This cut context usage
by roughly 5.7x."

Show: Quick example of `describeModule` output vs a full file read, or just
mention it over the dashboard numbers.

## 7. Wrap (15 sec)

"The rebuild is at about 70% completion — everything works in-memory, database
persistence is next. Zero human-written code in the output. The full comparative
analysis and cost breakdown are in CODEAGENT.md."
