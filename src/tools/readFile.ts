import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const parameters = z.object({
  path: z.string().describe("File path relative to the working directory."),
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-based line number to start reading from."),
  limit: z.number().int().positive().optional().describe("Maximum number of lines to read."),
});

/** Resolve and validate a file path against the working directory boundary. */
export function resolvePath(
  filePath: string,
  workingDir: string,
): { resolved: string } | { error: string } {
  const resolved = path.resolve(workingDir, filePath);
  if (!resolved.startsWith(path.resolve(workingDir))) {
    return { error: `Error: path is outside the working directory: ${filePath}` };
  }
  return { resolved };
}

export const readFileTool: Tool<typeof parameters> = {
  name: "readFile",
  description:
    "Read a file with line numbers. Supports offset/limit for pagination. " +
    "Lines are numbered starting at 1.",
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
    const result = resolvePath(params.path, ctx.workingDir);
    if ("error" in result) {
      return { content: result.error, isError: true };
    }

    try {
      const raw = await readFile(result.resolved, "utf-8");
      const allLines = raw.split("\n");

      // Apply offset/limit (1-based)
      const startIndex = params.offset ? params.offset - 1 : 0;
      const endIndex = params.limit ? startIndex + params.limit : allLines.length;
      const lines = allLines.slice(startIndex, endIndex);

      // Format with right-justified line numbers
      const totalLines = allLines.length;
      const width = String(totalLines).length;
      const numbered = lines
        .map((line, i) => {
          const lineNum = String(startIndex + i + 1).padStart(width);
          return `${lineNum}\t${line}`;
        })
        .join("\n");

      const header = `${params.path} (${String(totalLines)} lines)`;

      // Record read timestamp using file's mtime to avoid race conditions
      const fileStat = await stat(result.resolved);
      ctx.fileReadTimestamps.set(result.resolved, fileStat.mtimeMs);

      return { content: `${header}\n${numbered}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Error reading file: ${message}`, isError: true };
    }
  },
};
