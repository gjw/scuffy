import { execFile } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";

/** Labels that indicate a bead cannot be completed by a coding agent. */
const EXCLUDED_LABELS = ["human-only"];

const parameters = z.object({});

/** Run a shell command and return { ok, output }. */
function run(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        resolve({ ok: !error, output });
      },
    );
  });
}

/** Zod schema for a single bead from `br ready --json`. */
const BeadSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.string(),
  priority: z.number(),
  issue_type: z.string(),
  labels: z.array(z.string()).nullable().optional(),
});

type Bead = z.infer<typeof BeadSchema>;

export const claimBeadTool: Tool<typeof parameters> = {
  name: "claimBead",
  description:
    "Find and claim the next actionable bead. Filters out human-only and stale in_progress beads. " +
    "Returns full bead details. Call this once at session start — do not claim beads via bash.",
  parameters,
  async execute(_params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
    // Reject double-claim
    const existing = ctx.getClaimedBeadId();
    if (existing !== null) {
      return {
        content: `Already claimed bead ${existing}. Finish or escalate before claiming another.`,
        isError: true,
      };
    }

    // Ensure beads are initialized
    const initCheck = await run("br list --json", ctx.workingDir);
    if (!initCheck.ok && initCheck.output.includes("NOT_INITIALIZED")) {
      await run("br init", ctx.workingDir);
    }

    // Get ready beads
    const ready = await run("br ready --json", ctx.workingDir);
    if (!ready.ok) {
      return {
        content: `Failed to get ready beads: ${ready.output}\n\nHint: beads may not be initialized. Run 'br init' in the workspace, then create beads with 'br create'.`,
        isError: true,
      };
    }

    // Parse the output — br ready --json returns an array
    let beads: Bead[];
    try {
      const parsed: unknown = JSON.parse(ready.output);
      const arr = z.array(BeadSchema).parse(parsed);
      beads = arr;
    } catch {
      return {
        content: `Failed to parse bead list. Output was: ${ready.output.slice(0, 500)}\n\nThis may mean beads are not initialized. Use 'br init' then 'br create' to set up work items.`,
        isError: true,
      };
    }

    // Filter: exclude human-only labels and stale in_progress claims
    const eligible = beads.filter((b) => {
      if (b.status === "in_progress") return false;
      const labels = b.labels ?? [];
      if (labels.some((l) => EXCLUDED_LABELS.includes(l))) return false;
      return true;
    });

    if (eligible.length === 0) {
      return {
        content: "No actionable beads available. All ready beads are either in_progress or labeled human-only.",
        isError: true,
      };
    }

    // Pick the first eligible bead (br ready returns sorted by priority)
    const pick = eligible[0];
    if (!pick) {
      return { content: "No actionable beads available.", isError: true };
    }

    // Claim it
    const claim = await run(`br update ${pick.id} --claim`, ctx.workingDir);
    if (!claim.ok) {
      return { content: `Failed to claim ${pick.id}: ${claim.output}`, isError: true };
    }

    // Track in session state
    ctx.setClaimedBeadId(pick.id);

    // Log the claim
    ctx.log({
      type: "bead_claim",
      timestamp: new Date().toISOString(),
      beadId: pick.id,
      title: pick.title,
    });

    // Get full details for the agent
    const details = await run(`br show ${pick.id} --json`, ctx.workingDir);

    return {
      content: `Claimed bead ${pick.id}: ${pick.title}\n\n${details.ok ? details.output : pick.description ?? "(no description)"}`,
    };
  },
};
