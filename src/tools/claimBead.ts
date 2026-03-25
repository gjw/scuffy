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

/**
 * Schema for bv --robot-next JSON output.
 * bv returns a single object with the top pick, not an array.
 */
const BvNextSchema = z.object({
  id: z.string(),
  title: z.string(),
  score: z.number().optional(),
  reasons: z.array(z.string()).optional(),
  claim_command: z.string().optional(),
});

/** Fallback: schema for beads from br ready --json (array). */
const BeadSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.string(),
  priority: z.number(),
  issue_type: z.string(),
  labels: z.array(z.string()).nullable().optional(),
});

export const claimBeadTool: Tool<typeof parameters> = {
  name: "claimBead",
  description:
    "Find and claim the next actionable bead using dependency-aware triage. " +
    "Filters out human-only and stale in_progress beads. " +
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

    // Try bv --robot-next first (dependency-aware, graph-ranked)
    let pickId: string | null = null;
    let pickTitle: string | null = null;

    const bvResult = await run("bv --robot-next 2>/dev/null", ctx.workingDir);
    if (bvResult.ok && bvResult.output.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(bvResult.output);
        const pick = BvNextSchema.parse(parsed);
        pickId = pick.id;
        pickTitle = pick.title;
      } catch {
        // bv parse failed — fall through to br ready
      }
    }

    // Fallback to br ready --json if bv didn't work
    if (pickId === null) {
      const ready = await run("br ready --json", ctx.workingDir);
      if (!ready.ok) {
        return {
          content: `No beads available. Both bv --robot-next and br ready failed.\n\nbv: ${bvResult.output.slice(0, 300)}\nbr: ${ready.output.slice(0, 300)}`,
          isError: true,
        };
      }

      try {
        const parsed: unknown = JSON.parse(ready.output);
        const beads = z.array(BeadSchema).parse(parsed);

        // Filter: exclude human-only and stale in_progress
        const eligible = beads.filter((b) => {
          if (b.status === "in_progress") return false;
          const labels = b.labels ?? [];
          if (labels.some((l) => EXCLUDED_LABELS.includes(l))) return false;
          return true;
        });

        if (eligible.length === 0) {
          return {
            content: "No actionable beads available. All beads are either in_progress or labeled human-only.",
            isError: true,
          };
        }

        const first = eligible[0];
        if (first) {
          pickId = first.id;
          pickTitle = first.title;
        }
      } catch {
        return {
          content: `Failed to parse bead list. Output: ${ready.output.slice(0, 500)}`,
          isError: true,
        };
      }
    }

    if (pickId === null || pickTitle === null) {
      return { content: "No actionable beads available.", isError: true };
    }

    // Claim it
    const claim = await run(`br update ${pickId} --claim`, ctx.workingDir);
    if (!claim.ok) {
      return { content: `Failed to claim ${pickId}: ${claim.output}`, isError: true };
    }

    // Track in session state
    ctx.setClaimedBeadId(pickId);

    // Log the claim
    ctx.log({
      type: "bead_claim",
      timestamp: new Date().toISOString(),
      beadId: pickId,
      title: pickTitle,
    });

    // Get full details for the agent
    const details = await run(`br show ${pickId} --json`, ctx.workingDir);

    return {
      content: `Claimed bead ${pickId}: ${pickTitle}\n\n${details.ok ? details.output : "(no details available)"}`,
    };
  },
};
