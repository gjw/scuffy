import { readFile, writeFile, stat } from "node:fs/promises";
import { z } from "zod";
import { resolvePath } from "./readFile.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const parameters = z.object({
  path: z.string().describe("File path relative to the working directory."),
  old_string: z.string().describe("The exact string to find and replace."),
  new_string: z.string().describe("The replacement string."),
  replace_all: z
    .boolean()
    .optional()
    .describe("Replace all occurrences instead of requiring a unique match. Default false."),
});

/** Count non-overlapping occurrences of a substring. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let pos = 0;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- loop until break
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

export const editFileTool: Tool<typeof parameters> = {
  name: "editFile",
  description:
    "Replace an exact string in a file. The old_string must match exactly once " +
    "unless replace_all is true. The file must have been read first in this session.",
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
    const result = resolvePath(params.path, ctx.workingDir);
    if ("error" in result) {
      return { content: result.error, isError: true };
    }

    // Invariant 1: Read-before-edit
    const readTimestamp = ctx.fileReadTimestamps.get(result.resolved);
    if (readTimestamp === undefined) {
      return {
        content: `Error: file has not been read in this session. Use readFile first: ${params.path}`,
        isError: true,
      };
    }

    // Stale file detection
    try {
      const fileStat = await stat(result.resolved);
      if (fileStat.mtimeMs > readTimestamp) {
        return {
          content: `Error: file has been modified since last read. Re-read the file first: ${params.path}`,
          isError: true,
        };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Error checking file: ${message}`, isError: true };
    }

    // Validate old_string !== new_string
    if (params.old_string === params.new_string) {
      return {
        content: "Error: old_string and new_string are identical.",
        isError: true,
      };
    }

    try {
      const content = await readFile(result.resolved, "utf-8");

      // Invariant 2: Edit uniqueness
      const matchCount = countOccurrences(content, params.old_string);

      if (matchCount === 0) {
        return {
          content: `Error: old_string not found in ${params.path}`,
          isError: true,
        };
      }

      if (matchCount > 1 && !params.replace_all) {
        return {
          content:
            `Error: old_string matches ${String(matchCount)} times in ${params.path}. ` +
            "Provide more context to make a unique match, or set replace_all to true.",
          isError: true,
        };
      }

      // Perform replacement
      let newContent: string;
      if (params.replace_all) {
        newContent = content.split(params.old_string).join(params.new_string);
      } else {
        newContent = content.replace(params.old_string, params.new_string);
      }

      await writeFile(result.resolved, newContent, "utf-8");

      // Update read timestamp using new mtime
      const newStat = await stat(result.resolved);
      ctx.fileReadTimestamps.set(result.resolved, newStat.mtimeMs);

      const replacements = params.replace_all ? matchCount : 1;
      return {
        content: `Replaced ${String(replacements)} occurrence${replacements > 1 ? "s" : ""} in ${params.path}`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Error editing file: ${message}`, isError: true };
    }
  },
};
