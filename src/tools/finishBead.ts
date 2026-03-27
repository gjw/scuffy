import { z } from "zod";
import { guardedRun } from "./dcgGuard.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

/** When set, finishBead skips merge-to-main and bead close — summoner handles those. */
const PARALLEL_MODE = process.env["SCUFFY_PARALLEL"] === "1";

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

// ---------------------------------------------------------------------------
// Pre-existing failure detection
// ---------------------------------------------------------------------------

interface CheckFailure {
  check: string;
  output: string;
}

/** Strip ANSI escape codes from command output. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Extract file paths from check output. Handles tsc, eslint, and vitest formats.
 * Returns relative paths (strips workingDir prefix from absolute paths).
 */
function extractFailingFiles(output: string, workingDir: string): Set<string> {
  const files = new Set<string>();
  const clean = stripAnsi(output);

  for (const line of clean.split("\n")) {
    // tsc format: src/file.ts(10,5): error TS...
    const tscMatch = /^(\S+\.tsx?)\(\d+,\d+\):/.exec(line);
    if (tscMatch?.[1]) {
      files.add(tscMatch[1]);
      continue;
    }

    // eslint format: /absolute/path/to/file.ts (standalone line)
    const trimmed = line.trim();
    if (/^\/\S+\.tsx?$/.test(trimmed)) {
      const prefix = workingDir + "/";
      files.add(trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed);
      continue;
    }

    // vitest format: ❯ src/file.test.ts > ... or FAIL src/file.test.ts
    const vitestMatch = /(?:FAIL|❯)\s+(\S+\.tsx?)/.exec(line);
    if (vitestMatch?.[1]) {
      files.add(vitestMatch[1]);
      continue;
    }
  }

  return files;
}

/** Get all files the agent has changed (modified, added, deleted, untracked). */
async function getAgentChangedFiles(workingDir: string): Promise<Set<string>> {
  const files = new Set<string>();

  // Tracked changes (modified, added, deleted) vs HEAD
  const diff = await run("git diff --name-only HEAD 2>/dev/null || true", workingDir);
  for (const f of diff.output.split("\n")) {
    if (f.length > 0) files.add(f);
  }

  // Untracked new files
  const untracked = await run(
    "git ls-files --others --exclude-standard 2>/dev/null || true",
    workingDir,
  );
  for (const f of untracked.output.split("\n")) {
    if (f.length > 0) files.add(f);
  }

  return files;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

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

    // ── Run all quality checks, collect failures ──
    const failures: CheckFailure[] = [];
    for (const check of checks) {
      const result = await run(`npm run ${check}`, ctx.workingDir);
      if (!result.ok) {
        failures.push({ check, output: result.output });
      }
    }

    // ── Determine fault if checks failed ──
    let isBypass = false;
    let bypassFailingFiles = new Set<string>();

    if (failures.length > 0) {
      // Gold-standard fault detection: run the same checks on the parent commit.
      // If the parent also fails the same checks, the failures are truly pre-existing.
      // If the parent passes, the agent's changes caused the failures (even transitively).
      const failedCheckNames = failures.map((f) => f.check);
      let parentAlsoFails = false;

      const stash = await run("git stash --include-untracked", ctx.workingDir);
      if (stash.ok) {
        // Run failing checks on the clean parent
        let parentFailed = false;
        for (const check of failedCheckNames) {
          const parentResult = await run(`npm run ${check}`, ctx.workingDir);
          if (!parentResult.ok) {
            parentFailed = true;
            // Collect failing files from parent for the emergency bead description
            for (const file of extractFailingFiles(parentResult.output, ctx.workingDir)) {
              bypassFailingFiles.add(file);
            }
          }
        }
        parentAlsoFails = parentFailed;

        // Restore agent's changes
        await run("git stash pop", ctx.workingDir);
      }

      if (!parentAlsoFails) {
        // Agent's fault — parent was clean, agent's changes broke it (directly or transitively)
        const firstFailure = failures[0];
        if (firstFailure) {
          return {
            content: `Check failed: npm run ${firstFailure.check}\n\n${firstFailure.output}`,
            isError: true,
          };
        }
        return { content: "Quality checks failed.", isError: true };
      }

      // Truly pre-existing — parent commit has the same failures
      isBypass = true;

      const changedFiles = await getAgentChangedFiles(ctx.workingDir);
      ctx.log({
        type: "preexisting_bypass",
        timestamp: new Date().toISOString(),
        beadId: params.beadId,
        failedChecks: failedCheckNames,
        failingFiles: [...bypassFailingFiles],
        agentChangedFiles: [...changedFiles],
      });
    }

    // ── Test change audit (shared: normal + bypass paths) ──

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

    // ── Commit (shared: normal + bypass) ──

    const status = await run("git status --porcelain", ctx.workingDir);
    if (status.output.length > 0) {
      const suffix = isBypass ? " [bypass: pre-existing failures]" : "";
      const commitMsg = `${params.summary} (${params.beadId})${suffix}`;
      const commit = await run(
        `git add -A && git commit -m ${JSON.stringify(commitMsg)}`,
        ctx.workingDir,
      );
      if (!commit.ok) {
        return { content: `Git commit failed:\n\n${commit.output}`, isError: true };
      }
    }

    // ── Integrate latest main and re-check (catches parallel merge conflicts) ──

    const currentBranch = await run("git branch --show-current", ctx.workingDir);
    const branchName = currentBranch.output.trim();
    if (branchName && branchName !== "main" && !isBypass) {
      const mergeMain = await run("git merge main --no-edit", ctx.workingDir);
      if (!mergeMain.ok) {
        return {
          content:
            `Merge conflict with main:\n\n${mergeMain.output.slice(0, 500)}\n\n` +
            `Your branch has diverged from main. Resolve conflicts and retry finishBead.`,
          isError: true,
        };
      }

      // Re-run quality checks after integrating main (no-op in single-Trench,
      // catches integration failures when parallel Trenches merge concurrently)
      for (const check of checks) {
        const recheck = await run(`npm run ${check}`, ctx.workingDir);
        if (!recheck.ok) {
          return {
            content:
              `Integration check failed after merging main: npm run ${check}\n\n${recheck.output}\n\n` +
              `Your code passes alone but conflicts with recent changes on main. Fix and retry.`,
            isError: true,
          };
        }
      }
    }

    // ── Merge to main + close bead ──
    // In parallel mode, the summoner handles these (can't checkout main from a worktree,
    // and bead DB writes must be sequential). finishBead just exits with metadata.

    if (!PARALLEL_MODE) {
      if (branchName && branchName !== "main") {
        const merge = await run(
          `git checkout main && git merge ${branchName} --no-edit && git checkout ${branchName}`,
          ctx.workingDir,
        );
        if (!merge.ok) {
          ctx.log({
            type: "escalation",
            timestamp: new Date().toISOString(),
            reason: "flag" as const,
            message: `Merge to main failed for branch ${branchName}: ${merge.output.slice(0, 200)}`,
          });
        }
      }

      let close = await run(
        `br close ${params.beadId} --reason ${JSON.stringify(params.summary)}`,
        ctx.workingDir,
      );
      if (!close.ok) {
        // If blocked by deps, force-close — the work is done, tests pass,
        // the dependency is stale bookkeeping from a split that wasn't rewired.
        close = await run(
          `br close --force ${params.beadId} --reason ${JSON.stringify(params.summary)}`,
          ctx.workingDir,
        );
        if (!close.ok) {
          return { content: `br close failed:\n\n${close.output}`, isError: true };
        }
      }
    }

    ctx.log({
      type: "bead_complete",
      timestamp: new Date().toISOString(),
      beadId: params.beadId,
      summary: params.summary,
    });

    // ── Bypass: create emergency bead and pause pipeline ──

    if (isBypass) {
      const failedCheckNames = failures.map((f) => f.check).join(", ");
      const failingFilesList = [...bypassFailingFiles].slice(0, 10).join(", ");
      const errorSummary = failures
        .map((f) => {
          const clean = stripAnsi(f.output).slice(0, 500);
          return `${f.check}:\n${clean}`;
        })
        .join("\n\n");

      // Create P0 emergency bead (only if one doesn't already exist)
      const emergencyTitle = `Fix pre-existing ${failedCheckNames} failures`;
      const beadList = await run("br list --json", ctx.workingDir);
      let emergencyExists = false;
      try {
        let beads: unknown = JSON.parse(beadList.output);
        // br 0.1.34+ wraps output in { issues: [...] }
        if (typeof beads === "object" && beads !== null && !Array.isArray(beads) && "issues" in beads) {
          beads = (beads as Record<string, unknown>)["issues"];
        }
        if (Array.isArray(beads)) {
          emergencyExists = beads.some(
            (b: unknown) =>
              typeof b === "object" &&
              b !== null &&
              "status" in b &&
              (b as Record<string, unknown>)["status"] !== "closed" &&
              "issue_type" in b &&
              (b as Record<string, unknown>)["issue_type"] === "bug" &&
              "priority" in b &&
              (b as Record<string, unknown>)["priority"] === 0,
          );
        }
      } catch {
        // Can't parse — create the bead to be safe
      }

      // In parallel mode, summoner creates emergency beads (sequential DB writes).
      // In single mode, finishBead creates them directly.
      if (!PARALLEL_MODE && !emergencyExists) {
        const emergencyDesc =
          `Pre-existing failures detected during finishBead for bead ${params.beadId}.\n\n` +
          `Failing files: ${failingFilesList}\n\n${errorSummary}\n\n` +
          `These failures are in files NOT modified by the agent. Fix them to unblock the pipeline.`;
        const titleEsc = emergencyTitle.replace(/'/g, "'\\''");
        const descEsc = emergencyDesc.replace(/['\x00-\x1f]/g, (c) =>
          c === "'" ? "'\\''" : " ",
        );

        await run(
          `br create --no-auto-flush --title='${titleEsc}' --type=bug --priority=0 --description='${descEsc}'`,
          ctx.workingDir,
        );
      }

      await ctx.notifyHuman(
        `PRE-EXISTING FAILURES bypassed for bead ${params.beadId}. ` +
        `Failing: ${failedCheckNames} in ${failingFilesList}. ` +
        `Emergency P0 bead created.`,
      );

      if (!PARALLEL_MODE) {
        await run("br sync --flush-only", ctx.workingDir);
      }
      await run(
        `cm outcome success "" --text ${JSON.stringify(`${params.summary} (bypass: pre-existing failures)`)} 2>/dev/null`,
        ctx.workingDir,
      );
      await ctx.recordOutcome("success", `${params.summary} (bypassed pre-existing failures)`);

      return {
        content:
          `Bead ${params.beadId} complete (bypass): ${params.summary}\n\n` +
          `WARNING: Pre-existing ${failedCheckNames} failures in ${failingFilesList} bypassed.\n` +
          `Emergency P0 bead created. Next Trench will fix it.`,
        metadata: { exit: true, exitCode: 0, branch: branchName, bypass: true },
      };
    }

    // ── Normal completion ──

    const auditNote =
      actualTestChanges.length > 0
        ? `\nTest audit: ${String(actualTestChanges.length)} test file(s) changed, all reported.` +
          (overReported.length > 0
            ? ` Warning: ${String(overReported.length)} over-reported file(s): ${overReported.map((tc) => tc.file).join(", ")}`
            : "")
        : "";

    if (!PARALLEL_MODE) {
      await run("br sync --flush-only", ctx.workingDir);
    }
    await run(
      `cm outcome success "" --text ${JSON.stringify(params.summary)} 2>/dev/null`,
      ctx.workingDir,
    );
    await ctx.recordOutcome("success", params.summary);

    return {
      content: `Bead ${params.beadId} complete: ${params.summary}${auditNote}`,
      metadata: { exit: true, exitCode: 0, branch: branchName },
    };
  },
};
