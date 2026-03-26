# P1: Scuffy agents check agent mail inbox at session start

**Create as bead:** `br create --title="Check agent mail inbox at session start" --type=feature --priority=1`

## Problem

Agents don't read messages from Chair or other agents. Agent mail queues
messages correctly, but no agent ever checks its inbox. The headless
preamble says to SEND messages via mail, but never says to READ them.

This means:
- Chair can't send instructions that get picked up between sessions
- Tower can't message Trench with context about a split bead
- Warden can't flag specific concerns for the next Trench
- The entire agent mail investment is one-directional

## Proposed approach

In the headless preamble or role prompts, tell agents: "At session start,
if mcp_mail_fetch_inbox is available, check your inbox. If there are unread
messages from HumanOverseer, read them and incorporate their instructions
(they override your default task). Mark them read after processing."

This could also be done deterministically in the agent loop or in
claimBead — before claiming, check inbox and inject any messages into
the conversation as context.

### Option A: Prompt-based (simple)

Add to headless preamble: "Before claiming a bead, check your inbox
with the fetch_inbox MCP tool. Messages from HumanOverseer are high
priority instructions — follow them."

Pro: no code change, just prompt
Con: LLM might skip it, non-deterministic

### Option B: Tool-based (deterministic)

claimBead checks inbox before claiming. If there are unread messages
from HumanOverseer, return them as the tool result instead of claiming
a bead. The agent processes the instructions first.

Pro: guaranteed to be seen, deterministic
Con: couples claimBead to agent mail, more complex

### Option C: Summoner injects messages as instruction

Summoner checks inbox before spawning, appends any messages to the
--instruction flag. Agent receives them as part of its initial context.

Pro: agent doesn't need to know about mail, clean separation
Con: summoner becomes mail-aware, messages only checked between sessions

## Recommendation

Option C for Chair → agent messages (most reliable, deterministic).
Option A for agent → agent messages (nice to have, not critical).

## Files involved

- `src/summoner/index.ts` — check inbox before spawn, inject into instruction
- `src/roles.ts` — update headless preamble (option A)
- `src/tools/claimBead.ts` — check inbox before claim (option B)
