import { z } from "zod";
import { guardedRun } from "./dcgGuard.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const parameters = z.object({
  reason: z.enum(["stuck", "need_replan", "blocked"]).describe("Why the agent is escalating."),
  message: z.string().describe("Human-readable explanation of the situation."),
});

/** Run a shell command with DCG guard. */
const run = guardedRun;

export const escalateTool: Tool<typeof parameters> = {
  name: "escalate",
  description:
    "Graceful exit without completion. Commits current work (if any), logs the escalation, " +
    "and signals session exit with error code. Summoner pauses for human review.",
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
    // Commit WIP if there are uncommitted changes
    const status = await run("git status --porcelain", ctx.workingDir);
    if (status.output.length > 0) {
      const commitMsg = `WIP: escalate — ${params.reason}: ${params.message}`;
      await run(`git add -A && git commit -m ${JSON.stringify(commitMsg)}`, ctx.workingDir);
    }

    // Notify human overseer via agent mail
    await ctx.notifyHuman(`ESCALATION (${params.reason}): ${params.message}`);

    // Record failure outcome to CASS memory
    await ctx.recordOutcome("failure", `${params.reason}: ${params.message}`);

    // Log escalation event
    ctx.log({
      type: "escalation",
      timestamp: new Date().toISOString(),
      reason: params.reason,
      message: params.message,
    });

    return {
      content: `Escalated (${params.reason}): ${params.message}`,
      metadata: { exit: true, exitCode: 1 },
    };
  },
};
