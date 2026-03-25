import { execFile } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";

/** Run a shell command directly (bypasses DCG — these are approved bead operations). */
function run(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { cwd, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      resolve({ ok: !error, output });
    });
  });
}

const parameters = z.object({
  title: z.string().describe("Short title for the bead."),
  description: z.string().describe("Plain text description. NO terminal output, NO ANSI codes, NO copy-pasted command results."),
  priority: z.number().int().min(0).max(4).describe("0=critical, 1=high, 2=medium, 3=low, 4=backlog"),
  type: z.enum(["task", "bug", "feature", "chore"]).describe("Bead type."),
  labels: z.array(z.string()).optional().describe("Labels (e.g. 'phase:api', 'warden'). Phase labels should start with 'phase:'."),
  dependsOn: z.array(z.string()).optional().describe("Bead IDs this depends on. These beads must be completed BEFORE this one. The tool handles the argument order for br dep add — you just list the parent IDs."),
});


/** Validate description contains only printable text. */
function validateDescription(desc: string): string | null {
  // Reject ANSI escape codes (ESC + [)
  // eslint-disable-next-line no-control-regex
  if (/\x1b\[/.test(desc)) return "Description contains ANSI escape codes. Write plain text only.";
  // Reject control characters (except newline \x0a, carriage return \x0d, tab \x09)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(desc)) return "Description contains control characters. Write plain text only.";
  return null;
}

export const createBeadTool: Tool<typeof parameters> = {
  name: "createBead",
  description:
    "Create a new bead with optional dependencies. Handles br dep add argument order correctly — " +
    "you just list the parent bead IDs in dependsOn and the tool does the rest. " +
    "Always use this instead of running br create or br dep add via bash.",
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
    // Validate description
    const descError = validateDescription(params.description);
    if (descError) {
      return { content: descError, isError: true };
    }

    // Build br create command
    const labelArgs = (params.labels ?? []).map((l) => `--labels=${l}`).join(" ");
    const descEscaped = params.description.replace(/'/g, "'\\''");
    const titleEscaped = params.title.replace(/'/g, "'\\''");

    const createCmd = `br create --no-auto-flush --title='${titleEscaped}' --type=${params.type} --priority=${String(params.priority)} ${labelArgs} --description='${descEscaped}'`;

    const createResult = await run(createCmd, ctx.workingDir);
    if (!createResult.ok) {
      return { content: `Failed to create bead: ${createResult.output}`, isError: true };
    }

    // Extract the created bead ID from output like "✓ Created ship-rebuild-abc: Title"
    const idMatch = /Created\s+(\S+):/.exec(createResult.output);
    if (!idMatch?.[1]) {
      return { content: `Bead created but could not parse ID from: ${createResult.output}`, isError: true };
    }
    const newId = idMatch[1];

    // Add dependencies: newId depends on each parent
    const depResults: string[] = [];
    const depErrors: string[] = [];

    for (const parentId of params.dependsOn ?? []) {
      // CHILD depends on PARENT: br dep add <CHILD> <PARENT>
      const depResult = await run(
        `br dep add --no-auto-flush ${newId} ${parentId}`,
        ctx.workingDir,
      );
      if (depResult.ok) {
        depResults.push(`${newId} → ${parentId}`);
      } else if (depResult.output.includes("CYCLE_DETECTED")) {
        depErrors.push(`${parentId}: skipped (would create cycle)`);
      } else {
        depErrors.push(`${parentId}: ${depResult.output.slice(0, 100)}`);
      }
    }

    // Log the creation
    ctx.log({
      type: "bead_claim",
      timestamp: new Date().toISOString(),
      beadId: newId,
      title: params.title,
    });

    const parts = [`Created bead ${newId}: ${params.title}`];
    if (depResults.length > 0) parts.push(`Dependencies: ${depResults.join(", ")}`);
    if (depErrors.length > 0) parts.push(`Dependency warnings: ${depErrors.join("; ")}`);

    return { content: parts.join("\n") };
  },
};
