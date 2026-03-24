import { execFile } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const parameters = z.object({
  reason: z.enum(["stuck", "need_replan", "blocked"]).describe("Why the agent is escalating."),
  message: z.string().describe("Human-readable explanation of the situation."),
});

/** Run a shell command and return { ok, output }. */
function run(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        resolve({ ok: !error, output });
      },
    );
  });
}

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
