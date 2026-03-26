import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";

/** Default max lines when no limit is specified. Forces targeted reads. */
const DEFAULT_MAX_LINES = 100;

const parameters = z.object({
  path: z.string().describe("File path relative to the working directory."),
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-based line number to start reading from."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Maximum number of lines to read. Defaults to ${String(DEFAULT_MAX_LINES)}. ` +
      "Use grep to find what you need, then readFile with offset/limit to read just those lines.",
    ),
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
    "Read a file with line numbers. Returns up to " + String(DEFAULT_MAX_LINES) + " lines by default. " +
    "For large files, use grep to locate what you need, then readFile with offset/limit " +
    "to read just the relevant section. Do NOT read entire large files — it wastes context.",
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
    const result = resolvePath(params.path, ctx.workingDir);
    if ("error" in result) {
      return { content: result.error, isError: true };
    }

    try {
      const raw = await readFile(result.resolved, "utf-8");
      const allLines = raw.split("\n");
      const totalLines = allLines.length;

      // Apply offset/limit (1-based) with default cap
      const startIndex = params.offset ? params.offset - 1 : 0;
      const maxLines = params.limit ?? DEFAULT_MAX_LINES;
      const endIndex = Math.min(startIndex + maxLines, allLines.length);
      const lines = allLines.slice(startIndex, endIndex);

      // Format with right-justified line numbers
      const width = String(totalLines).length;
      const numbered = lines
        .map((line, i) => {
          const lineNum = String(startIndex + i + 1).padStart(width);
          return `${lineNum}\t${line}`;
        })
        .join("\n");

      const shownFrom = startIndex + 1;
      const shownTo = startIndex + lines.length;
      let header = `${params.path} (lines ${String(shownFrom)}-${String(shownTo)} of ${String(totalLines)})`;

      // Warn if file was truncated
      if (endIndex < allLines.length && !params.limit) {
        header += `\n[Showing first ${String(DEFAULT_MAX_LINES)} lines. Use offset/limit to read more, or grep to find specific content.]`;
      }

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
