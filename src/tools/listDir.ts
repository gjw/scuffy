import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const parameters = z.object({
  path: z
    .string()
    .optional()
    .describe(
      "Directory path to list, relative to the working directory. " +
        "Defaults to the working directory root.",
    ),
});

/**
 * List directory contents. Marks directories with a trailing `/`.
 * Rejects paths outside the working directory.
 */
export const listDirTool: Tool<typeof parameters> = {
  name: "listDir",
  description:
    "List files and directories at the given path. " + "Directories are marked with a trailing /.",
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
    const targetPath = params.path ? path.resolve(ctx.workingDir, params.path) : ctx.workingDir;

    // Reject paths outside workingDir
    const resolved = path.resolve(targetPath);
    if (!resolved.startsWith(path.resolve(ctx.workingDir))) {
      return {
        content: `Error: path is outside the working directory: ${String(params.path)}`,
        isError: true,
      };
    }

    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      const lines = entries
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort();

      if (lines.length === 0) {
        return { content: "(empty directory)" };
      }

      return { content: lines.join("\n") };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Error listing directory: ${message}`, isError: true };
    }
  },
};
