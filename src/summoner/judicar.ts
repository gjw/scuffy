/**
 * Judicar — on-demand triage agent spawned by the summoner at decision points.
 *
 * The Judicar makes judgment calls that the summoner currently handles
 * mechanically (retry after N failures, always accept warden beads, etc).
 * It reads context, acts via br commands, and exits.
 */

import { execFileSync } from "node:child_process";

export interface TriageFailureContext {
  type: "TRIAGE_FAILURE";
  beadId: string;
  beadTitle: string;
  beadPriority: number;
  beadLabels: string[];
  attemptCount: number;
  exitCode: number;
  failureOutput: string;
  recentGitLog: string;
}

export interface TriageWardenContext {
  type: "TRIAGE_WARDEN";
  wardenSummary: string;
  proposedBeads: Array<{
    id: string;
    title: string;
    priority: number;
    description: string;
  }>;
  currentSlice: string | null;
}

export interface TriageSliceContext {
  type: "TRIAGE_SLICE";
  sliceNumber: number;
  sliceName: string;
  acceptanceCriteria: string;
  curlResults: string;
  completedBeads: string[];
}

export interface TriageCompleteContext {
  type: "TRIAGE_COMPLETE";
  openBeads: string;
  recentGitLog: string;
  curlResults: string;
}

export type JudicarContext =
  | TriageFailureContext
  | TriageWardenContext
  | TriageSliceContext
  | TriageCompleteContext;

function formatFailurePrompt(ctx: TriageFailureContext): string {
  const exitDesc =
    ctx.exitCode === 2
      ? "EXIT CODE 2: Agent hit max iterations or budget — bead is likely too large."
      : ctx.exitCode === 1
        ? "EXIT CODE 1: Agent escalated or exited without completing."
        : `EXIT CODE ${String(ctx.exitCode)}`;

  return (
    `TRIAGE_FAILURE: Bead ${ctx.beadId} failed.\n\n` +
    `Title: ${ctx.beadTitle}\n` +
    `Priority: P${String(ctx.beadPriority)}\n` +
    `Labels: ${ctx.beadLabels.join(", ") || "none"}\n` +
    `Attempt: ${String(ctx.attemptCount)}\n` +
    `${exitDesc}\n\n` +
    `Failure output (last 2000 chars):\n${ctx.failureOutput.slice(-2000)}\n\n` +
    `Recent git log:\n${ctx.recentGitLog}\n\n` +
    `Decide: retry (with hint), split, defer (set P5), or close. ` +
    `Act via br commands, then exit.`
  );
}

function formatWardenPrompt(ctx: TriageWardenContext): string {
  const beadList = ctx.proposedBeads
    .map(
      (b) =>
        `- ${b.id}: [P${String(b.priority)}] ${b.title}\n  ${b.description.slice(0, 200)}`,
    )
    .join("\n");

  return (
    `TRIAGE_WARDEN: Warden completed an audit and proposes these beads:\n\n` +
    `${beadList}\n\n` +
    (ctx.currentSlice
      ? `Current build slice: ${ctx.currentSlice}\n\n`
      : "") +
    `Warden summary:\n${ctx.wardenSummary.slice(0, 1500)}\n\n` +
    `For each bead: approve at stated priority, approve at P5 (defer to polish), ` +
    `or reject (close immediately). Act via br commands, then exit.`
  );
}

function formatSlicePrompt(ctx: TriageSliceContext): string {
  return (
    `TRIAGE_SLICE: Slice ${String(ctx.sliceNumber)} (${ctx.sliceName}) just completed.\n\n` +
    `Acceptance criteria:\n${ctx.acceptanceCriteria}\n\n` +
    `Completed beads: ${ctx.completedBeads.join(", ")}\n\n` +
    `API endpoint check results:\n${ctx.curlResults}\n\n` +
    `Decide: proceed to next slice, or fix first (create P0 beads for blocking issues). ` +
    `Act via br commands, then exit.`
  );
}

function formatCompletePrompt(ctx: TriageCompleteContext): string {
  return (
    `TRIAGE_COMPLETE: No beads remain. Is the build done?\n\n` +
    `Open beads:\n${ctx.openBeads}\n\n` +
    `Recent git log:\n${ctx.recentGitLog}\n\n` +
    `Demo flow check:\n${ctx.curlResults}\n\n` +
    `Decide: confirm done, or create beads for missing work. ` +
    `Act via br commands, then exit.\n\n` +
    `CRITICAL: Do NOT close phase placeholder beads (labeled "phase-placeholder"). ` +
    `Those are expanded by Tower, not by you. If you see open placeholders, the build ` +
    `is NOT done — there are still phases to expand and implement. Only confirm done ` +
    `if no placeholders remain and all implemented phases pass their acceptance criteria.`
  );
}

export function formatJudicarPrompt(ctx: JudicarContext): string {
  switch (ctx.type) {
    case "TRIAGE_FAILURE":
      return formatFailurePrompt(ctx);
    case "TRIAGE_WARDEN":
      return formatWardenPrompt(ctx);
    case "TRIAGE_SLICE":
      return formatSlicePrompt(ctx);
    case "TRIAGE_COMPLETE":
      return formatCompletePrompt(ctx);
  }
}

/**
 * Gather common context for Judicar decisions.
 */
export function gatherRecentGitLog(workdir: string, count = 15): string {
  try {
    return execFileSync("git", ["log", "--oneline", `-${String(count)}`], {
      cwd: workdir,
      timeout: 5000,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "(git log unavailable)";
  }
}

export function gatherOpenBeads(workdir: string): string {
  try {
    return execFileSync("br", ["list", "--status=open"], {
      cwd: workdir,
      timeout: 10_000,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "(br list unavailable)";
  }
}
