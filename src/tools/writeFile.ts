import { writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolvePath } from "./readFile.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const parameters = z.object({
  path: z.string().describe("File path relative to the working directory."),
  content: z.string().describe("The full content to write to the file."),
});

export const writeFileTool: Tool<typeof parameters> = {
  name: "writeFile",
  description:
    "Write content to a file. Creates the file and parent directories if they " +
    "don't exist. Overwrites existing files.",
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
    const result = resolvePath(params.path, ctx.workingDir);
    if ("error" in result) {
      return { content: result.error, isError: true };
    }

    try {
      // Create parent directories if needed
      await mkdir(path.dirname(result.resolved), { recursive: true });

      await writeFile(result.resolved, params.content, "utf-8");

      // Record mtime so editFile can work on newly written files
      const fileStat = await stat(result.resolved);
      ctx.fileReadTimestamps.set(result.resolved, fileStat.mtimeMs);

      return { content: `Wrote ${params.path}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Error writing file: ${message}`, isError: true };
    }
  },
};
