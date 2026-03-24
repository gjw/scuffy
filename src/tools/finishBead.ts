import { execFile } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const CHECK_TIMEOUT_MS = 60_000;

const parameters = z.object({
  beadId: z.string().describe("The bead ID to close (e.g. 'ship-a1b2')."),
  summary: z
    .string()
    .describe("One-sentence summary of what was built. Used as commit message and close reason."),
  checks: z
    .array(z.enum(["typecheck", "lint", "test"]))
    .optional()
    .describe(
      "Quality checks to run. Defaults to ['typecheck', 'lint']. Each maps to `npm run <check>`.",
    ),
});

/** Run a shell command and return { ok, output }. */
function run(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, timeout: CHECK_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        resolve({ ok: !error, output });
      },
    );
  });
}

export const finishBeadTool: Tool<typeof parameters> = {
  name: "finishBead",
  description:
    "Deterministic completion gate. Runs quality checks, commits work, closes the bead, " +
    "and signals session exit. Call this when you have finished a bead's work.",
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
    const checks = params.checks ?? ["typecheck", "lint"];

    // Run quality checks sequentially — fail fast
    for (const check of checks) {
      const result = await run(`npm run ${check}`, ctx.workingDir);
      if (!result.ok) {
        return {
          content: `Check failed: npm run ${check}\n\n${result.output}`,
          isError: true,
        };
      }
    }

    // Commit if there are uncommitted changes
    const status = await run("git status --porcelain", ctx.workingDir);
    if (status.output.length > 0) {
      const commitMsg = `${params.summary} (${params.beadId})`;
      const commit = await run(
        `git add -A && git commit -m ${JSON.stringify(commitMsg)}`,
        ctx.workingDir,
      );
      if (!commit.ok) {
        return { content: `Git commit failed:\n\n${commit.output}`, isError: true };
      }
    }

    // Close the bead
    const close = await run(
      `br close ${params.beadId} --reason ${JSON.stringify(params.summary)}`,
      ctx.workingDir,
    );
    if (!close.ok) {
      return { content: `br close failed:\n\n${close.output}`, isError: true };
    }

    // Log completion event
    ctx.log({
      type: "bead_complete",
      timestamp: new Date().toISOString(),
      beadId: params.beadId,
      summary: params.summary,
    });

    return {
      content: `Bead ${params.beadId} complete: ${params.summary}`,
      metadata: { exit: true, exitCode: 0 },
    };
  },
};
