import { execFile } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";

function run(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { cwd, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      resolve({ ok: !error, output });
    });
  });
}

const parameters = z.object({
  beadId: z.string().describe("The bead to modify (the child/dependent bead)."),
  dependsOnId: z.string().describe("The dependency to remove (the parent/blocker bead)."),
});

export const removeDepTool: Tool<typeof parameters> = {
  name: "removeDep",
  description:
    "Remove a dependency from a bead. Use when splitting a bead: remove the old dependency, " +
    "add new dependencies on the replacement beads, then close the original. " +
    "Example: X depends on A. A is split into B, C, D. Remove X→A, add X→B, X→C, X→D, close A.",
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
    const result = await run(
      `br dep remove --no-auto-flush ${params.beadId} ${params.dependsOnId}`,
      ctx.workingDir,
    );

    if (!result.ok) {
      return { content: `Failed to remove dependency ${params.beadId} → ${params.dependsOnId}: ${result.output}`, isError: true };
    }

    return { content: `Removed dependency: ${params.beadId} no longer depends on ${params.dependsOnId}` };
  },
};
