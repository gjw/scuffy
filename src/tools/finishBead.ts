import { z } from "zod";
import { guardedRun } from "./dcgGuard.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

/** Glob patterns that identify test files. */
const TEST_FILE_PATTERNS = [".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx"];

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
  testChanges: z
    .array(
      z.object({
        file: z
          .string()
          .describe("Relative path to the test file that was modified or created."),
        reason: z
          .string()
          .describe(
            "Why this test was changed — e.g., 'new test for auth endpoint' or 'updated expected value after API contract change'.",
          ),
      }),
    )
    .optional()
    .describe(
      "Self-report of test files you modified, created, or deleted. The tool verifies this against git diff. Under-reporting is flagged.",
    ),
});

/** Run a shell command with DCG guard. */
const run = guardedRun;

/** Check if a filename is a test file. */
function isTestFile(filename: string): boolean {
  return TEST_FILE_PATTERNS.some((pattern) => filename.endsWith(pattern));
}

export const finishBeadTool: Tool<typeof parameters> = {
  name: "finishBead",
  description:
    "Deterministic completion gate. Runs quality checks, audits test changes, commits work, " +
    "closes the bead, and signals session exit. TEST AUDIT: This tool runs git diff to discover " +
    "which test files actually changed — including deletions. If you modified, created, or deleted " +
    "any test files, you MUST declare them in testChanges with a reason for each. Unreported " +
    "changes or deletions will be detected and this tool will reject your submission. " +
    "Your self-report is compared against git — discrepancies block completion.",
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

    // --- Test change audit ---

    // Detect deleted test files
    const deletedResult = await run(
      "git diff --name-only --diff-filter=D HEAD 2>/dev/null || true",
      ctx.workingDir,
    );
    const deletedTests = deletedResult.output
      .split("\n")
      .filter((f) => f.length > 0 && isTestFile(f));

    // Detect all changed/added test files via git diff
    const diffResult = await run(
      "git diff --name-only HEAD 2>/dev/null && git ls-files --others --exclude-standard 2>/dev/null || true",
      ctx.workingDir,
    );
    const actualTestChanges = [
      ...diffResult.output.split("\n").filter((f) => f.length > 0 && isTestFile(f)),
      ...deletedTests,
    ];

    // Compare self-report against actual changes (including deletions)
    const reportedFiles = new Set((params.testChanges ?? []).map((tc) => tc.file));
    const actualFiles = new Set(actualTestChanges);

    // Under-report: actual changes not declared by agent
    const unreported = actualTestChanges.filter((f) => !reportedFiles.has(f));

    if (unreported.length > 0) {
      ctx.log({
        type: "test_audit",
        timestamp: new Date().toISOString(),
        beadId: params.beadId,
        reportedChanges: params.testChanges ?? [],
        actualChanges: actualTestChanges,
        deletedTests,
        result: "unreported_changes",
      });
      return {
        content:
          `Test audit failed: unreported test changes in: ${unreported.join(", ")}. ` +
          `You must declare all test modifications, creations, and deletions in testChanges with a reason for each.`,
        isError: true,
      };
    }

    // Over-report: agent claims changes to files that didn't actually change (warn only)
    const overReported = (params.testChanges ?? []).filter((tc) => !actualFiles.has(tc.file));

    // Log the audit result
    ctx.log({
      type: "test_audit",
      timestamp: new Date().toISOString(),
      beadId: params.beadId,
      reportedChanges: params.testChanges ?? [],
      actualChanges: actualTestChanges,
      deletedTests,
      result: "clean",
    });

    // --- End test change audit ---

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

    // Build completion message with audit summary
    const auditNote =
      actualTestChanges.length > 0
        ? `\nTest audit: ${String(actualTestChanges.length)} test file(s) changed, all reported.` +
          (overReported.length > 0
            ? ` Warning: ${String(overReported.length)} over-reported file(s): ${overReported.map((tc) => tc.file).join(", ")}`
            : "")
        : "";

    return {
      content: `Bead ${params.beadId} complete: ${params.summary}${auditNote}`,
      metadata: { exit: true, exitCode: 0 },
    };
  },
};
