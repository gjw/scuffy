import { glob } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolvePath } from "./readFile.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const parameters = z.object({
  pattern: z.string().describe("Glob pattern to match files (e.g. '**/*.ts', 'src/**/*.test.ts')."),
  path: z
    .string()
    .optional()
    .describe(
      "Directory to search in, relative to working directory. Defaults to working directory.",
    ),
});

export const globTool: Tool<typeof parameters> = {
  name: "glob",
  description:
    "Find files matching a glob pattern. Returns matching file paths relative to the working directory.",
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
    if (params.path) {
      const check = resolvePath(params.path, ctx.workingDir);
      if ("error" in check) {
        return { content: check.error, isError: true };
      }
    }

    const searchDir = params.path ? path.resolve(ctx.workingDir, params.path) : ctx.workingDir;

    try {
      const results: string[] = [];
      for await (const match of glob(params.pattern, { cwd: searchDir })) {
        // Return paths relative to workingDir
        const fullPath = path.join(searchDir, match);
        results.push(path.relative(ctx.workingDir, fullPath));
      }

      results.sort();

      if (results.length === 0) {
        return { content: "No files matched the pattern." };
      }

      return { content: results.join("\n") };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Error running glob: ${message}`, isError: true };
    }
  },
};
