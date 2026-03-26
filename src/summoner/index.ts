/**
 * Summoner — role-aware spawn loop for headless Scuffy.
 *
 * TypeScript rewrite of scripts/summoner.sh. Spawns headless Scuffy
 * sessions with different roles based on bead state.
 *
 * Usage: npx tsx src/summoner/index.ts [workspace-dir]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// ─── Config ──────────────────────────────────────────────────────────────────

const SCUFFY_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const WORKDIR = path.resolve(process.argv[2] ?? "workspace/ship-rebuild");
const MAIL_URL = process.env["AGENT_MAIL_URL"] ?? "http://127.0.0.1:8765/mcp";
const PROJECT_KEY = SCUFFY_ROOT;
const PAUSE_FILE = path.join(WORKDIR, ".pause");
const ATTEMPTS_FILE = path.join(WORKDIR, ".summoner-attempts");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function br(args: string): string {
  try {
    return execFileSync("/bin/sh", ["-c", `br ${args}`], {
      cwd: WORKDIR, timeout: 15_000, encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

function brJson(args: string): unknown[] {
  const out = br(`${args} --json --no-auto-flush`);
  try {
    const parsed: unknown = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

interface Bead {
  id: string;
  status: string;
  title: string;
  labels: string[] | null;
}

function listBeads(): Bead[] {
  return brJson("list") as Bead[];
}

function readyBeads(): Bead[] {
  return brJson("ready") as Bead[];
}

// ─── Attempt tracking ────────────────────────────────────────────────────────

function loadAttempts(): Map<string, number> {
  const map = new Map<string, number>();
  if (!existsSync(ATTEMPTS_FILE)) return map;
  const lines = readFileSync(ATTEMPTS_FILE, "utf-8").split("\n");
  for (const line of lines) {
    const [id, count] = line.split("=");
    if (id && count) map.set(id, parseInt(count, 10));
  }
  return map;
}

function saveAttempts(map: Map<string, number>): void {
  const lines = [...map.entries()].map(([id, count]) => `${id}=${String(count)}`);
  writeFileSync(ATTEMPTS_FILE, lines.join("\n") + "\n");
}

const attempts = loadAttempts();

function incrementAttempts(beadId: string): number {
  const count = (attempts.get(beadId) ?? 0) + 1;
  attempts.set(beadId, count);
  saveAttempts(attempts);
  return count;
}

function resetAttempts(beadId: string): void {
  attempts.delete(beadId);
  saveAttempts(attempts);
}

// ─── Agent mail ──────────────────────────────────────────────────────────────

function notifyChair(subject: string, body: string): void {
  try {
    const payload = JSON.stringify({
      jsonrpc: "2.0", id: "notify", method: "tools/call",
      params: { name: "send_message", arguments: {
        project_key: PROJECT_KEY, from_agent: "RedTrench",
        to_agent: "HumanOverseer", subject, body, priority: "high",
      }},
    });
    execFileSync("curl", ["-sS", "--max-time", "5", "-X", "POST", MAIL_URL,
      "-H", "content-type: application/json", "-d", payload],
      { timeout: 10_000, stdio: "pipe" });
  } catch {
    // Mail failures are non-blocking
  }
}

// ─── Spawning ────────────────────────────────────────────────────────────────

interface SpawnResult {
  exitCode: number;
  output: string;
}

function spawnRoleClean(role: string, instruction?: string): SpawnResult {
  console.log(`\n=== Spawning Scuffy as ${role} ===`);

  const args = [path.join(SCUFFY_ROOT, "dist/index.js"), "--headless", "--workdir", WORKDIR, "--role", role];
  if (instruction) args.push("--instruction", instruction);

  const logFile = path.join(WORKDIR, ".scuffy", "last-session.log");

  // Use shell to tee output and capture exit code
  const cmd = `node ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")} 2>&1 | tee '${logFile}'; exit \${PIPESTATUS[0]}`;

  try {
    execFileSync("/bin/bash", ["-c", cmd], {
      cwd: SCUFFY_ROOT,
      stdio: "inherit",
      timeout: 600_000, // 10 minute max per session
    });
    // Exit 0
    const output = existsSync(logFile) ? readFileSync(logFile, "utf-8") : "";
    return { exitCode: 0, output };
  } catch (err: unknown) {
    const exitCode = (err as { status?: number }).status ?? 1;
    const output = existsSync(logFile) ? readFileSync(logFile, "utf-8") : "";
    return { exitCode, output };
  }
}

// ─── Bead ID extraction ─────────────────────────────────────────────────────

function extractBeadId(output: string): string | null {
  // Try BUDGET_EXCEEDED format
  const budgetMatch = /BUDGET_EXCEEDED bead=(\S+)/.exec(output);
  if (budgetMatch?.[1] && budgetMatch[1] !== "unknown") return budgetMatch[1];

  // Try "Claimed bead X" format
  const claimMatch = /Claimed bead (\S+)/.exec(output);
  if (claimMatch?.[1]) return claimMatch[1];

  return null;
}

// ─── Stale bead recovery ─────────────────────────────────────────────────────

function recoverStaleBeads(): void {
  const beads = listBeads();
  for (const bead of beads) {
    if (bead.status === "in_progress") {
      // Don't recover beads that were halted (labeled "blocked")
      const labels = bead.labels ?? [];
      if (labels.includes("blocked")) {
        continue;
      }
      console.log(`=== Recovering stale bead: ${bead.id} ===`);
      br(`update ${bead.id} --status=open --no-auto-flush`);
    }
  }
}

// ─── Phase detection ─────────────────────────────────────────────────────────

function closingPhase(): string | null {
  const beads = listBeads();
  const phaseMap = new Map<string, { total: number; open: number; hasWarden: boolean }>();

  for (const bead of beads) {
    const labels = bead.labels ?? [];
    for (const label of labels) {
      if (label.startsWith("phase:")) {
        const entry = phaseMap.get(label) ?? { total: 0, open: 0, hasWarden: false };
        entry.total++;
        if (bead.status !== "closed") entry.open++;
        if (labels.includes("warden")) entry.hasWarden = true;
        phaseMap.set(label, entry);
      }
    }
  }

  for (const [phase, data] of phaseMap) {
    if (data.open === 0 && !data.hasWarden && data.total > 0) {
      return phase;
    }
  }
  return null;
}

// ─── Tower interventions ─────────────────────────────────────────────────────

function splitBead(beadId: string): void {
  console.log(`=== Budget exceeded on ${beadId}. Invoking Tower to split. ===`);
  notifyChair(`Budget exceeded: ${beadId}`, `Bead ${beadId} hit token budget. Invoking Tower to split.`);
  br(`update ${beadId} --status=open --no-auto-flush`);
  spawnRoleClean("tower",
    `Bead ${beadId} exceeded the token budget and could not complete in one session. ` +
    `Read the bead description with br show ${beadId}. Examine any partial work on disk. ` +
    `Use the createBead tool to split this bead into 2-3 smaller beads. ` +
    `Then use the closeBead tool to close the original. Call escalate when done.`);
}

function towerReviewBead(beadId: string): void {
  console.log(`=== Bead ${beadId} failed twice. Invoking Tower to review. ===`);
  notifyChair(`Repeated failure: ${beadId}`, `Bead ${beadId} failed twice. Invoking Tower to review.`);
  br(`update ${beadId} --status=open --no-auto-flush`);
  spawnRoleClean("tower",
    `Bead ${beadId} has failed twice. Trench could not complete it. ` +
    `Read the bead description with br show ${beadId} and examine the codebase. ` +
    `Is the description wrong? Is it too big? Does it conflict with existing code? ` +
    `Either: (1) use createBead to split it into smaller beads and closeBead to close the original, ` +
    `(2) update the description if it's wrong, or (3) closeBead it if it's no longer needed. ` +
    `Call escalate when done.`);
}

function haltBead(beadId: string): void {
  console.log(`=== Bead ${beadId} failed 3 times. Halting. ===`);
  notifyChair(`HALTED: ${beadId}`, `Bead ${beadId} failed 3 times and has been halted. Manual intervention needed.`);
  br(`update ${beadId} --labels=blocked --no-auto-flush`);
}

// ─── Phase close sequence ────────────────────────────────────────────────────

function runPhaseClose(phase: string): void {
  console.log(`=== Phase closing: ${phase} ===`);

  spawnRoleClean("warden-dark", `Audit phase ${phase}. Focus on code completed with label ${phase}.`);
  drainWardenBeads();
  spawnRoleClean("warden-light", `Audit phase ${phase}. Focus on code completed with label ${phase}.`);
  drainWardenBeads();

  console.log(`=== Phase ${phase} closed. Invoking Tower for replan. ===`);
  spawnRoleClean("tower", `Phase ${phase} is complete. Review remaining work, reprioritize, create new beads if needed.`);
}

function drainWardenBeads(): void {
  for (;;) {
    const beads = listBeads();
    const wardenBeads = beads.filter((b) =>
      b.status !== "closed" && (b.labels ?? []).includes("warden")
    );
    if (wardenBeads.length === 0) break;
    console.log(`=== ${String(wardenBeads.length)} warden bead(s) to fix ===`);
    const result = spawnRoleClean("trench");
    handleExit(result);
  }
}

// ─── Exit handling ───────────────────────────────────────────────────────────

function handleExit(result: SpawnResult): void {
  const beadId = extractBeadId(result.output);

  switch (result.exitCode) {
    case 0:
      console.log("=== Bead complete. ===");
      if (beadId) resetAttempts(beadId);
      break;

    case 1: {
      console.log("=== Scuffy escalated. ===");
      if (beadId) {
        const count = incrementAttempts(beadId);
        console.log(`  Bead ${beadId}: attempt ${String(count)}`);
        if (count >= 3) {
          haltBead(beadId);
        } else if (count >= 2) {
          towerReviewBead(beadId);
        }
      }
      break;
    }

    case 2: {
      console.log("=== Budget exceeded. ===");
      if (beadId && beadId !== "unknown") {
        const count = incrementAttempts(beadId);
        if (count >= 3) {
          haltBead(beadId);
        } else {
          splitBead(beadId);
        }
      } else {
        console.log("  Could not identify bead from output.");
      }
      break;
    }

    default:
      console.log(`=== Unexpected exit (${String(result.exitCode)}). ===`);
      break;
  }
}

// ─── Main loop ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Summoner started — workspace: ${WORKDIR}`);
  mkdirSync(path.join(WORKDIR, ".scuffy"), { recursive: true });

  for (;;) {
    // Brake check
    if (existsSync(PAUSE_FILE)) {
      console.log(`Paused. Remove ${PAUSE_FILE} to resume.`);
      while (existsSync(PAUSE_FILE)) {
        await new Promise((r) => setTimeout(r, 5000));
      }
      console.log("Resumed.");
    }

    // Recover stale beads
    recoverStaleBeads();

    const allBeads = listBeads();
    const ready = readyBeads();

    // 1. No beads → Scout
    if (allBeads.length === 0) {
      console.log("\n=== No beads found. Running Scout to bootstrap. ===");
      spawnRoleClean("scout");
      console.log("=== Scout done. ===");
      continue;
    }

    // 2. Phase closing?
    const phase = closingPhase();
    if (phase) {
      runPhaseClose(phase);
      continue;
    }

    // 3. Ready beads → Trench
    if (ready.length > 0) {
      const result = spawnRoleClean("trench");
      handleExit(result);
      continue;
    }

    // 4. Nothing to do
    console.log("No beads ready. Done.");
    break;
  }

  console.log("Summoner finished.");
}

main().catch((err: unknown) => {
  console.error("Summoner fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
