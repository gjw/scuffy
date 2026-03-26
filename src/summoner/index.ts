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

/** Map role names to their agent mail identity. */
const ROLE_AGENT_NAMES: Record<string, string> = {
  scout: "SwiftScout",
  trench: "RedTrench",
  tower: "BoldTower",
  "warden-light": "BrightWarden",
  "warden-dark": "DarkWarden",
};

/**
 * Check an agent's inbox for unread messages from HumanOverseer.
 * Returns message bodies joined, or empty string if none.
 */
function fetchInbox(role: string): string {
  const agentName = ROLE_AGENT_NAMES[role] ?? role;
  try {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: "inbox",
      method: "tools/call",
      params: {
        name: "fetch_inbox",
        arguments: { project_key: PROJECT_KEY, agent_name: agentName },
      },
    });
    const raw = execFileSync(
      "curl",
      ["-sS", "--max-time", "5", "-X", "POST", MAIL_URL, "-H", "content-type: application/json", "-d", payload],
      { timeout: 10_000, encoding: "utf-8" },
    );
    const response: unknown = JSON.parse(raw);

    // MCP response: { result: { content: [{ type: "text", text: "..." }] } }
    if (
      typeof response === "object" &&
      response !== null &&
      "result" in response
    ) {
      const result = (response as Record<string, unknown>)["result"];
      if (typeof result === "object" && result !== null && "content" in result) {
        const content = (result as Record<string, unknown>)["content"];
        if (Array.isArray(content)) {
          const texts = content
            .filter(
              (c): c is { type: string; text: string } =>
                typeof c === "object" &&
                c !== null &&
                "type" in c &&
                (c as Record<string, unknown>)["type"] === "text" &&
                "text" in c &&
                typeof (c as Record<string, unknown>)["text"] === "string",
            )
            .map((c) => c.text);
          const combined = texts.join("\n").trim();
          if (combined.length > 0 && !combined.includes("No messages")) {
            console.log(`  Inbox for ${agentName}: ${String(texts.length)} message(s)`);
            return combined;
          }
        }
      }
    }
  } catch {
    // Mail not available — that's fine
  }
  return "";
}

function notifyChair(subject: string, body: string): void {
  try {
    const payload = JSON.stringify({
      jsonrpc: "2.0", id: "notify", method: "tools/call",
      params: { name: "send_message", arguments: {
        project_key: PROJECT_KEY, sender_name: "Summoner",
        to: ["HumanOverseer"], subject, body_md: body, importance: "high",
      }},
    });
    execFileSync("curl", ["-sS", "--max-time", "5", "-X", "POST", MAIL_URL,
      "-H", "content-type: application/json", "-d", payload],
      { timeout: 10_000, stdio: "pipe" });
  } catch {
    // Mail failures are non-blocking
  }
}

// ─── Git state management ────────────────────────────────────────────────────

/**
 * Ensure the working directory is on main with clean bead state before the
 * next spawn. Commits any stragglers, checks out main, syncs bead JSONL.
 *
 * Called at the top of the main loop — NOT before Tower interventions, because
 * Tower needs to see WIP on the branch after budget exceeded.
 */
function resetToMain(): void {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: WORKDIR,
      timeout: 5_000,
      encoding: "utf-8",
    }).trim();

    if (!branch || branch === "main") {
      // Already on main — just sync bead state
      syncBeadState();
      return;
    }

    // Safety commit: catch anything headless.ts or escalate missed
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: WORKDIR,
      timeout: 5_000,
      encoding: "utf-8",
    }).trim();
    if (status.length > 0) {
      execFileSync(
        "/bin/sh",
        ["-c", `git add -A && git commit -m "WIP: summoner safety commit before returning to main" --no-verify`],
        { cwd: WORKDIR, timeout: 10_000, stdio: "pipe" },
      );
      console.log(`  [safety commit on ${branch}]`);
    }

    // Checkout main
    execFileSync("git", ["checkout", "main"], {
      cwd: WORKDIR,
      timeout: 10_000,
      stdio: "pipe",
    });
    console.log(`=== Reset to main from ${branch} ===`);

    // Sync bead state (SQLite → JSONL on main)
    syncBeadState();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`resetToMain failed: ${msg}`);
    // Last resort: force checkout main (may discard uncommitted changes)
    try {
      execFileSync("git", ["checkout", "-f", "main"], {
        cwd: WORKDIR,
        timeout: 10_000,
        stdio: "pipe",
      });
      console.log("=== Force-reset to main ===");
      syncBeadState();
    } catch {
      console.error("CRITICAL: Cannot checkout main. Next session may inherit dirty state.");
    }
  }
}

/** Flush bead SQLite DB to git-tracked JSONL and commit if changed. */
function syncBeadState(): void {
  try {
    br("sync --flush-only");
    const beadStatus = execFileSync("git", ["status", "--porcelain", ".beads/"], {
      cwd: WORKDIR,
      timeout: 5_000,
      encoding: "utf-8",
    }).trim();
    if (beadStatus.length > 0) {
      execFileSync(
        "/bin/sh",
        ["-c", `git add .beads/ && git commit -m "Sync bead state"`],
        { cwd: WORKDIR, timeout: 10_000, stdio: "pipe" },
      );
    }
  } catch {
    // Non-fatal: bead JSONL may be slightly stale but SQLite is authoritative
  }
}

// ─── Spawning ────────────────────────────────────────────────────────────────

interface SpawnResult {
  exitCode: number;
  output: string;
}

function spawnRoleClean(role: string, instruction?: string): SpawnResult {
  console.log(`\n=== Spawning Scuffy as ${role} ===`);

  // Check agent inbox — inject any messages from Chair into the instruction
  const inbox = fetchInbox(role);
  if (inbox.length > 0) {
    const mailContext = `\n\n--- Messages from Chair ---\n${inbox}\n--- End messages ---\n\n`;
    instruction = instruction ? instruction + mailContext : mailContext + "Process these messages, then proceed with your default task.";
  }

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

// ─── Main health check ───────────────────────────────────────────────────────

/**
 * Run a quick typecheck on main before spawning Trench. If main is broken,
 * ensure a P0 emergency fix bead exists so Trench fixes it first instead of
 * wasting a whole session on unrelated work only to hit the same failures.
 *
 * Returns true if main is healthy (or we created an emergency bead).
 * Returns false only if we couldn't determine state.
 */
function ensureMainHealth(): void {
  console.log("=== Checking main health (typecheck) ===");
  try {
    execFileSync("/bin/sh", ["-c", "npm run typecheck"], {
      cwd: WORKDIR,
      timeout: 120_000,
      stdio: "pipe",
    });
    console.log("  Main is healthy.");
  } catch (err: unknown) {
    console.log("  Main has typecheck failures.");

    // Check if an emergency fix bead already exists
    const beads = listBeads();
    const hasEmergency = beads.some(
      (b) =>
        b.status !== "closed" &&
        (b.title.includes("pre-existing") || b.title.includes("Pre-existing")),
    );

    if (hasEmergency) {
      console.log("  Emergency fix bead already exists. Trench will pick it up.");
      return;
    }

    // Extract error summary from stderr/stdout
    const rawOutput =
      (err as { stdout?: Buffer | string }).stdout?.toString() ??
      (err as { stderr?: Buffer | string }).stderr?.toString() ??
      "typecheck failed";
    const summary = rawOutput.slice(0, 800).replace(/['\x00-\x1f]/g, (c: string) =>
      c === "\n" ? "\n" : " ",
    );

    console.log("  Creating P0 emergency fix bead.");
    br(
      `create --no-auto-flush --title='Fix pre-existing typecheck failures on main' ` +
      `--type=bug --priority=0 --description='Typecheck fails on main. This blocks all Trench agents.\n\n${summary.replace(/'/g, "'\\''")}'`,
    );
    br("sync --flush-only");

    notifyChair(
      "Main health check failed",
      "Typecheck fails on main. Created P0 emergency bead. Next Trench will attempt fix.",
    );
  }
}

// ─── Main loop ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Summoner started — workspace: ${WORKDIR}`);
  mkdirSync(path.join(WORKDIR, ".scuffy"), { recursive: true });

  for (;;) {
    // Ensure clean starting state: return to main, sync bead state
    resetToMain();

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
      // Health check: ensure main is clean before wasting a session
      ensureMainHealth();

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
