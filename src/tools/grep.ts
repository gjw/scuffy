import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { resolvePath } from "./readFile.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const parameters = z.object({
  pattern: z.string().describe("Regex pattern to search for in file contents."),
  glob: z
    .string()
    .optional()
    .describe("Glob pattern to filter which files to search (e.g. '*.ts', '*.{js,jsx}')."),
  path: z
    .string()
    .optional()
    .describe(
      "Directory to search in, relative to working directory. Defaults to working directory.",
    ),
  output_mode: z
    .enum(["files", "content"])
    .optional()
    .describe(
      "'files' returns matching file paths (default). 'content' returns matching lines with line numbers.",
    ),
});

/** Run ripgrep and return its output. */
function runRg(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile("rg", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error && "code" in error ? (error.code as number) : error ? 1 : 0;
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export const grepTool: Tool<typeof parameters> = {
  name: "grep",
  description:
    "Search file contents using regex patterns via ripgrep. " +
    "Returns matching file paths (default) or matching lines with line numbers.",
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
    if (params.path) {
      const check = resolvePath(params.path, ctx.workingDir);
      if ("error" in check) {
        return { content: check.error, isError: true };
      }
    }

    const searchDir = params.path ? path.resolve(ctx.workingDir, params.path) : ctx.workingDir;

    const args: string[] = [];

    if (params.output_mode !== "content") {
      args.push("--files-with-matches");
    } else {
      args.push("--line-number");
    }

    if (params.glob) {
      args.push("--glob", params.glob);
    }

    args.push("--", params.pattern, ".");

    const { stdout, stderr, exitCode } = await runRg(args, searchDir);

    // rg exit code 1 = no matches (not an error)
    if (exitCode === 1) {
      return { content: "No matches found." };
    }

    // rg exit code 2+ = actual error
    if (exitCode > 1) {
      return { content: `Error running grep: ${stderr || "unknown error"}`, isError: true };
    }

    const trimmed = stdout.trim();
    if (trimmed === "") {
      return { content: "No matches found." };
    }

    return { content: trimmed };
  },
};
