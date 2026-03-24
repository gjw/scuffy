import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const DEFAULT_REFERENCE_DIR = "/Users/gjw/dev/FleetGraph";

const parameters = z.object({
  path: z.string().describe("File path relative to the reference project root."),
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-based line number to start reading from."),
  limit: z.number().int().positive().optional().describe("Maximum number of lines to read."),
});

export const readReferenceTool: Tool<typeof parameters> = {
  name: "readReference",
  description:
    "Read a file from the reference project (FleetGraph/Ship). Read-only — for consulting " +
    "the original implementation. Does not affect edit permissions or file tracking.",
  parameters,
  async execute(params: z.infer<typeof parameters>, _ctx: ToolContext): Promise<ToolResult> {
    const referenceDir = process.env["SCUFFY_REFERENCE_DIR"] ?? DEFAULT_REFERENCE_DIR;
    const resolved = path.resolve(referenceDir, params.path);

    if (!resolved.startsWith(path.resolve(referenceDir))) {
      return {
        content: `Error: path is outside the reference directory: ${params.path}`,
        isError: true,
      };
    }

    try {
      const raw = await readFile(resolved, "utf-8");
      const allLines = raw.split("\n");

      const startIndex = params.offset ? params.offset - 1 : 0;
      const endIndex = params.limit ? startIndex + params.limit : allLines.length;
      const lines = allLines.slice(startIndex, endIndex);

      const totalLines = allLines.length;
      const width = String(totalLines).length;
      const numbered = lines
        .map((line, i) => {
          const lineNum = String(startIndex + i + 1).padStart(width);
          return `${lineNum}\t${line}`;
        })
        .join("\n");

      const header = `[reference] ${params.path} (${String(totalLines)} lines)`;
      return { content: `${header}\n${numbered}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Error reading reference file: ${message}`, isError: true };
    }
  },
};
