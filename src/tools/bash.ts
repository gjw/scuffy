import { execFile } from "node:child_process";
import { z } from "zod";
import { checkDcg } from "./dcgGuard.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

const parameters = z.object({
  command: z.string().describe("Shell command to execute."),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Timeout in milliseconds. Default 30000 (30s), max 300000 (5m)."),
});

/** Git write subcommands blocked in parallel mode. Reads (status, diff, log, show, ls-files) are allowed. */
const GIT_WRITE_PATTERN = /\bgit\s+(checkout|switch|merge|rebase|reset|clean|stash|push|pull|fetch|commit|add|rm|mv|cherry-pick|revert)\b|\bgit\s+branch\s+(?!--show-current|--list|-a\b|-r\b|-v\b)|\bgit\s+tag\s+(?!-l\b|--list)/;

export const bashTool: Tool<typeof parameters> = {
  name: "bash",
  description:
    "Execute a shell command and capture its output. " + "Returns exit code, stdout, and stderr.",
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
    // In parallel mode, block git write operations — summoner and tools own all git writes.
    // Read-only git (status, diff, log, show, branch --show-current) is allowed.
    if (process.env["SCUFFY_PARALLEL"] === "1" && GIT_WRITE_PATTERN.test(params.command)) {
      return {
        content:
          "Git write operations are not available in parallel mode. " +
          "Branch creation, commits, and merges are handled by the summoner and finishBead tool. " +
          "Read-only git commands (status, diff, log, show) are allowed.",
        isError: true,
      };
    }

    // DCG guard — block destructive commands before execution
    const dcg = await checkDcg(params.command, ctx.workingDir);
    if (!dcg.allowed) {
      return {
        content: `Command blocked by DCG: ${dcg.reason ?? "destructive command"}`,
        isError: true,
      };
    }

    const timeout = Math.min(params.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    return new Promise((resolve) => {
      execFile(
        "/bin/sh",
        ["-c", params.command],
        {
          cwd: ctx.workingDir,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          killSignal: "SIGTERM",
        },
        (error, stdout, stderr) => {
          let exitCode = 0;
          if (error) {
            if ("killed" in error && error.killed) {
              resolve({
                content: `Error: command timed out after ${String(timeout)}ms`,
                isError: true,
              });
              return;
            }
            exitCode = "code" in error && typeof error.code === "number" ? error.code : 1;
          }

          const parts: string[] = [];
          if (stdout) parts.push(stdout);
          if (stderr) parts.push(`[stderr]\n${stderr}`);
          if (parts.length === 0) parts.push("(no output)");

          let output = parts.join("\n");

          // Cap output to prevent context bloat (keep first + last lines)
          const MAX_OUTPUT_CHARS = 8000;
          if (output.length > MAX_OUTPUT_CHARS) {
            const lines = output.split("\n");
            const headLines = lines.slice(0, 40);
            const tailLines = lines.slice(-20);
            const omitted = lines.length - 60;
            output = headLines.join("\n") +
              `\n\n[... ${String(omitted)} lines omitted — showing first 40 and last 20 of ${String(lines.length)} lines ...]\n\n` +
              tailLines.join("\n");
          }

          resolve({
            content: `[exit code: ${String(exitCode)}]\n${output}`,
            isError: exitCode !== 0,
          });
        },
      );
    });
  },
};
