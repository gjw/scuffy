# P2: Trench agents should delegate to cheaper subagents

**Create as bead:** `br create --title="Trench subagent delegation: use cheaper models for reads/research" --type=feature --priority=2`

## Problem

Trench agents do all work themselves on gpt-5.4 — including file reads,
grep searches, and research that could be done by a cheaper model (gpt-5.4-mini
or gpt-5.4-nano). Zero subagent sessions were found across the entire build
run despite the task tool being registered.

## Why it matters

A large portion of tool calls are reads and searches (grep, readFile, listDir,
glob). These don't require the full model's reasoning — a cheaper model can
read a file and summarize it, grep for patterns, or explore directory structure.
At ~10x price difference between gpt-5.4 and gpt-5.4-nano, delegating read-heavy
work could reduce costs 30-50%.

## Proposed approach

1. Update Trench prompt to suggest delegation: "For research tasks (reading
   multiple files to understand a module, grepping for patterns across the
   codebase), consider spawning a subagent via the task tool with a focused
   prompt. Subagents use a cheaper model."

2. Configure the task tool to use a lighter model for subagents. Currently
   `createTaskTool(registry, config, provider)` passes the same config/model.
   Add a `SCUFFY_SUBAGENT_MODEL` env var that the task tool uses instead.

3. Common delegation patterns:
   - "Read these 5 files and summarize the API surface" → subagent
   - "Grep for all usages of FooInterface" → subagent
   - "List all test files and their describe blocks" → subagent
   - Actual code writing stays on the main agent

## Files involved

- `src/tools/task.ts` — use SCUFFY_SUBAGENT_MODEL for subagent config
- `prompts/trench.md` — add delegation guidance
- `src/config.ts` — add SCUFFY_SUBAGENT_MODEL env var
