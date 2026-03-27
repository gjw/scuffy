import { execFile } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";

/** Run a shell command directly (bypasses DCG — approved bead operation). */
function run(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { cwd, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      resolve({ ok: !error, output });
    });
  });
}

const parameters = z.object({
  beadId: z.string().describe("ID of the bead to close."),
  reason: z.string().describe("Why the bead is being closed (e.g. 'Split into sub-beads', 'Superseded by X', 'No longer needed')."),
  force: z.boolean().optional().describe("Close even if blocked by open dependencies. Use when splitting a bead into replacements."),
});

export const closeBeadTool: Tool<typeof parameters> = {
  name: "closeBead",
  description:
    "Close a bead without completing it. Use this when splitting an oversized bead, " +
    "closing a duplicate, or removing a bead that's no longer needed. " +
    "This is NOT for completing work — use finishBead for that.",
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
    const reasonEscaped = params.reason.replace(/'/g, "'\\''");
    const forceFlag = params.force ? " --force" : "";
    const result = await run(
      `br close --no-auto-flush${forceFlag} ${params.beadId} --reason='${reasonEscaped}'`,
      ctx.workingDir,
    );

    if (!result.ok) {
      return { content: `Failed to close ${params.beadId}: ${result.output}`, isError: true };
    }

    return { content: `Closed bead ${params.beadId}: ${params.reason}` };
  },
};
