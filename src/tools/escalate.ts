import { z } from "zod";
import { guardedRun } from "./dcgGuard.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const parameters = z.object({
  reason: z.enum(["stuck", "need_replan", "blocked", "bead_too_large"]).describe("Why the agent is escalating. Use 'bead_too_large' if the bead scope is clearly too big for one session — summoner will invoke Tower to split it."),
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
    // Release claimed bead so the next session doesn't re-grab it
    const claimedId = ctx.getClaimedBeadId();
    if (claimedId !== null) {
      await run(`br update ${claimedId} --status=open`, ctx.workingDir);
      ctx.setClaimedBeadId(null);
    }

    // Commit WIP if there are uncommitted changes
    const status = await run("git status --porcelain", ctx.workingDir);
    if (status.output.length > 0) {
      const commitMsg = `WIP: escalate — ${params.reason}: ${params.message}`;
      await run(`git add -A && git commit -m ${JSON.stringify(commitMsg)}`, ctx.workingDir);
    }

    // Notify human overseer via agent mail
    await ctx.notifyHuman(`ESCALATION (${params.reason}): ${params.message}`);

    // Record failure outcome to CASS
    await run(
      `cm outcome failure "" --text ${JSON.stringify(`${params.reason}: ${params.message}`)} 2>/dev/null`,
      ctx.workingDir,
    );
    await ctx.recordOutcome("failure", `${params.reason}: ${params.message}`);

    // Flush beads to JSONL (single export per session)
    await run("br sync --flush-only", ctx.workingDir);

    // Log escalation event
    ctx.log({
      type: "escalation",
      timestamp: new Date().toISOString(),
      reason: params.reason,
      message: params.message,
    });

    // bead_too_large uses exit code 2 (same as budget exceeded → Tower splits)
    const exitCode = params.reason === "bead_too_large" ? 2 : 1;
    const beadInfo = claimedId ? ` bead=${claimedId}` : "";

    return {
      content: params.reason === "bead_too_large"
        ? `BUDGET_EXCEEDED${beadInfo} tools=0 tokens=0/0. Agent self-reported: ${params.message}`
        : `Escalated (${params.reason}): ${params.message}`,
      metadata: { exit: true, exitCode },
    };
  },
};
