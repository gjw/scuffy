# LinkedIn Post Draft

## Post Text

Week 6 of Gauntlet for America. This one was different — instead of building an app, I built the thing that builds the app.

Scuffy is an autonomous coding agent. Custom TypeScript agent loop, no LangGraph, no LangChain. The interesting part isn't the agent itself — that's a while loop over the Claude API with some tools. The interesting part is the pipeline around it.

Five agent roles: a Summoner that orchestrates, a Scout that reads a business brief and generates work items, Trench agents that write code in parallel git worktrees, a Warden that audits their output, and a Judicar that triages failures and eliminates unnecessary work before it burns compute.

The part I spent the most time on: agents are not trusted to verify their own work. They run in a sandbox and cannot execute tests or commit code. When a Trench finishes, it calls a deterministic completion gate that runs typecheck, lint, and tests itself — then diffs the actual changed files against what the agent claimed it changed. If it under-reported, the submission is rejected. If the failures existed before the agent touched the code, they're accepted but a high-priority ticket is automatically created so the next agent picks them up. The agents never see the test results until after they've declared what they did.

Agents can also mail the human or other agents about ambiguous decisions — architecture choices, domain interpretation, API design tradeoffs. They don't block; they log what they decided and why, then keep working. Those reports feed into the next run's brief, so the pipeline gets smarter across restarts.

The integration test: point the pipeline at a business requirements brief for Ship and tell it to build the app from scratch. No technical spec, no original source code, just requirements. The agent chose its own stack, generated its own work items, and built the application autonomously across hundreds of sessions. I restarted the pipeline 30-50 times over the week — not patching the output, but improving the architecture and starting over each time.

Built during @GauntletAI Shipyard.

Submitted. But I have new ideas. Just one more build.

[ATTACH: Loom demo video link]
