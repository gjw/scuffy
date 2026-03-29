# LinkedIn Post Draft

## Post Text

I built an autonomous coding agent from scratch in TypeScript, then pointed it at a real project and walked away.

Scuffy is a custom agent loop -- no LangChain, no LangGraph, just direct LLM calls with surgical file editing, JSONL observability, and a multi-agent pipeline. A Summoner dispatches work to parallel Trench agents. A Warden audits their output. A Tower plans and replans when things go wrong. The whole system runs against a dependency graph of work items, picking up tasks in the right order and resolving its own merge conflicts.

The real test: I gave Scuffy a business requirements brief for a project management application and told it to build the thing. It generated its own work items, chose its own architecture (React + Express + SQLite), and built 14,762 lines of functional code across 274 sessions. One human intervention was required -- an OOM hardlock that needed a process kill. Everything else was autonomous.

Two details I did not expect. First, the agent had a tool to read the original application's source code. It never used it. Not once. It worked entirely from the requirements brief. Second, without any instruction about UI density, it produced informationally dense dashboard views with inline editing, bulk actions, and contextual filtering. Nobody asked for that.

[SCREENSHOT: Ship rebuild dashboard showing the activity feed and planning board side by side]

This is not production-grade software engineering. The agent bypassed its own test failures more often than I would like, and Warden audits created polish work that consumed sessions better spent on features. But the core loop -- plan, build, test, audit, merge -- ran overnight and produced a working application by morning.

[SCREENSHOT: Scuffy's JSONL session log showing a Trench agent completing a bead in 3 minutes]

Built during @GauntletAI Shipyard.

[SCREENSHOT: Terminal showing Summoner dispatching two parallel Trench agents into git worktrees]

## Screenshot Plan

- **Dashboard UI**: The rebuilt Ship app's main dashboard, showing the activity feed and planning board to demonstrate the UI density the agent produced unprompted
- **Session log**: A JSONL log excerpt (formatted with jq) showing a single Trench session from claim to completion, highlighting the 2-5 minute cycle time
- **Summoner terminal**: The Summoner process dispatching parallel Trench agents, showing worktree creation and bead assignment -- demonstrates the multi-agent coordination
- **Bead graph (optional)**: A bv dependency graph (mermaid or dot format rendered) showing the work item structure the agent generated from the requirements brief
