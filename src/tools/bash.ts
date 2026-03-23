import { execFile } from "node:child_process";
import { z } from "zod";
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

export const bashTool: Tool<typeof parameters> = {
  name: "bash",
  description:
    "Execute a shell command and capture its output. " + "Returns exit code, stdout, and stderr.",
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
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

          const output = parts.join("\n");

          resolve({
            content: `[exit code: ${String(exitCode)}]\n${output}`,
            isError: exitCode !== 0,
          });
        },
      );
    });
  },
};
