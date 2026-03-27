import { execFile } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";

/** Labels that indicate a bead cannot be completed by a coding agent. */
const EXCLUDED_LABELS = ["human-only", "blocked"];

const parameters = z.object({
  beadId: z
    .string()
    .optional()
    .describe(
      "Force-claim a specific bead by ID. Skips bv/br ranking. " +
      "Use when the summoner assigns a specific emergency bead.",
    ),
  phaseLabel: z
    .string()
    .optional()
    .describe(
      "Filter to beads in this phase (e.g. 'phase:1-skeleton'). " +
      "Passed by summoner to keep work gated to the current phase.",
    ),
});

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
  async execute(params: z.infer<typeof parameters>, ctx: ToolContext): Promise<ToolResult> {
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

    // Force-claim path: summoner assigned a specific bead (e.g., emergency fix)
    if (params.beadId) {
      const claim = await run(`br update ${params.beadId} --claim`, ctx.workingDir);
      if (!claim.ok) {
        return { content: `Failed to claim ${params.beadId}: ${claim.output}`, isError: true };
      }
      ctx.setClaimedBeadId(params.beadId);
      ctx.log({
        type: "bead_claim",
        timestamp: new Date().toISOString(),
        beadId: params.beadId,
        title: "(force-assigned)",
      });
      const details = await run(`br show ${params.beadId} --json`, ctx.workingDir);

      // Query CASS for this specific task
      let cassContext = "";
      const cassResult = await run(
        `cm context ${JSON.stringify(params.beadId)} --workspace ${JSON.stringify(ctx.workingDir)} --json 2>/dev/null`,
        ctx.workingDir,
      );
      if (cassResult.ok) {
        try {
          const parsed: unknown = JSON.parse(cassResult.output);
          if (typeof parsed === "object" && parsed !== null && "data" in parsed) {
            const data = (parsed as Record<string, unknown>)["data"];
            if (typeof data === "object" && data !== null && "relevantBullets" in data) {
              const bullets = (data as Record<string, unknown>)["relevantBullets"];
              if (Array.isArray(bullets) && bullets.length > 0) {
                const lessons = bullets.slice(0, 3).map((b: unknown) => {
                  if (typeof b === "object" && b !== null && "content" in b) {
                    return `- ${String((b as Record<string, unknown>)["content"])}`;
                  }
                  return null;
                }).filter(Boolean).join("\n");
                if (lessons.length > 0) cassContext = `\n\n## Lessons from prior sessions (CASS)\n\n${lessons}`;
              }
            }
          }
        } catch { /* ignore */ }
      }

      return {
        content: `Claimed bead ${params.beadId} (force-assigned)\n\n${details.ok ? details.output : "(no details available)"}${cassContext}`,
      };
    }

    // Try bv --robot-next first (dependency-aware, graph-ranked)
    let pickId: string | null = null;
    let pickTitle: string | null = null;

    const bvLabel = params.phaseLabel ? ` --label ${params.phaseLabel}` : "";
    const bvResult = await run(`bv --robot-next${bvLabel} 2>/dev/null`, ctx.workingDir);
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
      const ready = await run(`br ready --json${bvLabel}`, ctx.workingDir);
      if (!ready.ok) {
        return {
          content: `No beads available. Both bv --robot-next and br ready failed.\n\nbv: ${bvResult.output.slice(0, 300)}\nbr: ${ready.output.slice(0, 300)}`,
          isError: true,
        };
      }

      try {
        let parsed: unknown = JSON.parse(ready.output);
        // br 0.1.34+ wraps output in { issues: [...] }
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "issues" in parsed) {
          parsed = (parsed as Record<string, unknown>)["issues"];
        }
        const beads = z.array(BeadSchema).parse(parsed);

        // Filter: exclude human-only, stale in_progress, and wrong phase
        const eligible = beads.filter((b) => {
          if (b.status === "in_progress") return false;
          const labels = b.labels ?? [];
          if (labels.some((l) => EXCLUDED_LABELS.includes(l))) return false;
          // Phase filter: if phaseLabel is set, only pick beads in that phase
          if (params.phaseLabel && !labels.includes(params.phaseLabel)) return false;
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

    // Query CASS for relevant lessons from prior sessions
    let cassContext = "";
    const cassResult = await run(
      `cm context ${JSON.stringify(pickTitle)} --workspace ${JSON.stringify(ctx.workingDir)} --json 2>/dev/null`,
      ctx.workingDir,
    );
    if (cassResult.ok && cassResult.output.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(cassResult.output);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "data" in parsed
        ) {
          const data = (parsed as Record<string, unknown>)["data"];
          if (typeof data === "object" && data !== null && "relevantBullets" in data) {
            const bullets = (data as Record<string, unknown>)["relevantBullets"];
            if (Array.isArray(bullets) && bullets.length > 0) {
              const lessons = bullets
                .slice(0, 5)
                .map((b: unknown) => {
                  if (typeof b === "object" && b !== null && "content" in b) {
                    return `- ${String((b as Record<string, unknown>)["content"])}`;
                  }
                  return null;
                })
                .filter(Boolean)
                .join("\n");
              if (lessons.length > 0) {
                cassContext = `\n\n## Lessons from prior sessions (CASS)\n\n${lessons}`;
              }
            }
          }
        }
      } catch {
        // CASS parse failed — continue without it
      }
    }

    return {
      content: `Claimed bead ${pickId}: ${pickTitle}\n\n${details.ok ? details.output : "(no details available)"}${cassContext}`,
    };
  },
};
