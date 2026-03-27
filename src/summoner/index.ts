/**
 * Summoner — role-aware spawn loop for headless Scuffy.
 *
 * TypeScript rewrite of scripts/summoner.sh. Spawns headless Scuffy
 * sessions with different roles based on bead state.
 *
 * Usage: npx tsx src/summoner/index.ts [workspace-dir]
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, createWriteStream } from "node:fs";
import path from "node:path";

// ─── Config ──────────────────────────────────────────────────────────────────

const SCUFFY_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const WORKDIR = path.resolve(process.argv[2] ?? "workspace/ship-rebuild");
const MAIL_URL = process.env["AGENT_MAIL_URL"] ?? "http://127.0.0.1:8765/mcp";
const PROJECT_KEY = SCUFFY_ROOT;
const PAUSE_FILE = path.join(WORKDIR, ".pause");
const ATTEMPTS_FILE = path.join(WORKDIR, ".summoner-attempts");
const WARDEN_INTERVAL = 8; // Run Warden audit every N completed beads
const MAX_PARALLEL_SLOTS = Number(process.env["SCUFFY_PARALLEL_SLOTS"] ?? "1");
const WORKTREES_DIR = path.join(WORKDIR, ".worktrees");

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
    // br 0.1.34+ wraps list output in { issues: [...] }
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === "object" && parsed !== null && "issues" in parsed) {
      const issues = (parsed as Record<string, unknown>)["issues"];
      if (Array.isArray(issues)) return issues;
    }
    return [];
  } catch {
    return [];
  }
}

interface Bead {
  id: string;
  status: string;
  title: string;
  issue_type: string;
  priority: number;
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

// ─── Phase detection ─────────────────────────────────────────────────────────

interface PhaseInfo {
  label: string;
  isPlaceholder: boolean;
  placeholderId: string | null;
}

/**
 * Detect the current active phase from open beads. Phases are labeled
 * "phase:N-name" where N determines ordering. Returns the lowest-numbered
 * phase that has open beads, and whether it's a placeholder awaiting Tower expansion.
 */
function detectCurrentPhase(beads: Bead[]): PhaseInfo | null {
  // Collect phases from open beads
  const phases = new Map<string, { beadCount: number; placeholderId: string | null }>();

  for (const bead of beads) {
    if (bead.status === "closed") continue;
    const labels = bead.labels ?? [];
    for (const label of labels) {
      if (label.startsWith("phase:")) {
        const entry = phases.get(label) ?? { beadCount: 0, placeholderId: null };
        entry.beadCount++;
        if (labels.includes("phase-placeholder")) {
          entry.placeholderId = bead.id;
        }
        phases.set(label, entry);
      }
    }
  }

  if (phases.size === 0) return null;

  // Sort by phase label (phase:1-x < phase:2-y) to get lowest numbered
  const sorted = [...phases.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const [label, data] = sorted[0] ?? [null, null];
  if (!label || !data) return null;

  // A phase is a "placeholder" if it has exactly one bead and that bead is the placeholder
  const isPlaceholder = data.beadCount === 1 && data.placeholderId !== null;

  return {
    label,
    isPlaceholder,
    placeholderId: data.placeholderId,
  };
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

// ─── Worktree management ─────────────────────────────────────────────────────

/**
 * Ensure a worktree slot exists and is reset to current main.
 * Creates the worktree on first use, resets it on subsequent uses.
 * Symlinks .beads/, node_modules/, and .scuffy/ to the main workspace.
 */
function ensureWorktree(slot: number): string {
  const wtPath = path.join(WORKTREES_DIR, `slot-${String(slot)}`);
  const branchName = `wt-slot-${String(slot)}`;

  if (!existsSync(wtPath)) {
    // Create the worktree
    mkdirSync(WORKTREES_DIR, { recursive: true });
    execFileSync("git", ["worktree", "add", "--detach", wtPath], {
      cwd: WORKDIR,
      timeout: 15_000,
      stdio: "pipe",
    });

    // Symlink shared resources
    const symlinks: Array<[string, string]> = [
      [path.join(WORKDIR, ".beads"), path.join(wtPath, ".beads")],
      [path.join(WORKDIR, ".scuffy"), path.join(wtPath, ".scuffy")],
    ];

    // node_modules at root and in each workspace
    if (existsSync(path.join(WORKDIR, "node_modules"))) {
      symlinks.push([path.join(WORKDIR, "node_modules"), path.join(wtPath, "node_modules")]);
    }
    for (const ws of ["api", "web", "shared"]) {
      const nmPath = path.join(WORKDIR, ws, "node_modules");
      if (existsSync(nmPath)) {
        mkdirSync(path.join(wtPath, ws), { recursive: true });
        symlinks.push([nmPath, path.join(wtPath, ws, "node_modules")]);
      }
    }

    for (const [target, link] of symlinks) {
      try {
        execFileSync("ln", ["-sfn", target, link], { timeout: 5_000, stdio: "pipe" });
      } catch {
        // Symlink failed — non-fatal, Trench will just use its own copy
      }
    }

    console.log(`  Created worktree slot-${String(slot)} at ${wtPath}`);
  }

  // Reset worktree to current main HEAD
  try {
    execFileSync("git", ["checkout", "--detach", "main"], {
      cwd: wtPath,
      timeout: 10_000,
      stdio: "pipe",
    });
    // Clean any leftover files from previous Trench
    execFileSync("git", ["clean", "-fd"], {
      cwd: wtPath,
      timeout: 10_000,
      stdio: "pipe",
    });
    execFileSync("git", ["checkout", "--", "."], {
      cwd: wtPath,
      timeout: 10_000,
      stdio: "pipe",
    });
  } catch {
    // Reset failed — try removing and recreating
    try {
      execFileSync("git", ["worktree", "remove", "--force", wtPath], {
        cwd: WORKDIR,
        timeout: 10_000,
        stdio: "pipe",
      });
    } catch { /* ignore */ }
    return ensureWorktree(slot); // Recurse once to recreate
  }

  return wtPath;
}

/**
 * Merge a Trench's completed branch into main from the main worktree.
 * Returns true if merge succeeded, false if conflict.
 */
function mergeToMain(branchName: string): boolean {
  try {
    execFileSync(
      "git",
      ["merge", branchName, "--no-edit"],
      { cwd: WORKDIR, timeout: 30_000, stdio: "pipe" },
    );
    console.log(`  Merged ${branchName} to main.`);
    return true;
  } catch {
    // Merge conflict — abort and report
    try {
      execFileSync("git", ["merge", "--abort"], { cwd: WORKDIR, timeout: 5_000, stdio: "pipe" });
    } catch { /* ignore */ }
    console.error(`  Merge conflict: ${branchName} could not be merged to main.`);
    return false;
  }
}

/**
 * After a successful Trench exit in parallel mode: merge branch, close bead, sync.
 */
function handleParallelSuccess(branchName: string, beadId: string, summary: string): void {
  const merged = mergeToMain(branchName);
  if (!merged) {
    // Merge conflict — the work is good, main just changed under it.
    // Release to open for retry. On the next attempt, the Trench starts
    // from updated main and the conflict resolves naturally.
    console.log(`  Merge conflict for ${beadId} — releasing for retry on updated main.`);
    br(`update ${beadId} --status=open --no-auto-flush`);
  } else {
    br(`close ${beadId} --reason ${JSON.stringify(summary)}`);
  }
  br("sync --flush-only");
}

/**
 * After a failed Trench exit in parallel mode: release bead, sync.
 */
function handleParallelFailure(beadId: string): void {
  br(`update ${beadId} --status=open --no-auto-flush`);
  br("sync --flush-only");
}

// ─── Spawning ────────────────────────────────────────────────────────────────

interface SpawnResult {
  exitCode: number;
  output: string;
}

function spawnRoleClean(role: string, instruction?: string, worktreePath?: string): SpawnResult {
  const workdir = worktreePath ?? WORKDIR;
  const slotLabel = worktreePath ? ` [${path.basename(worktreePath)}]` : "";
  console.log(`\n=== Spawning Scuffy as ${role}${slotLabel} ===`);

  // Check agent inbox — inject any messages from Chair into the instruction
  const inbox = fetchInbox(role);
  if (inbox.length > 0) {
    const mailContext = `\n\n--- Messages from Chair ---\n${inbox}\n--- End messages ---\n\n`;
    instruction = instruction ? instruction + mailContext : mailContext + "Process these messages, then proceed with your default task.";
  }

  const args = [path.join(SCUFFY_ROOT, "dist/index.js"), "--headless", "--workdir", workdir, "--role", role];
  if (instruction) args.push("--instruction", instruction);

  const logFile = path.join(WORKDIR, ".scuffy", "last-session.log");

  // Set SCUFFY_PARALLEL for worktree spawns so finishBead/escalate skip merge/close
  const envPrefix = worktreePath ? "SCUFFY_PARALLEL=1 " : "";

  // Use shell to tee output and capture exit code
  const cmd = `${envPrefix}node ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")} 2>&1 | tee '${logFile}'; exit \${PIPESTATUS[0]}`;

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

// ─── Async spawn (for parallel slots) ─────────────────────────────────────────

interface SlotState {
  slotId: number;
  beadId: string;
  worktree: string;
  promise: Promise<SpawnResult>;
}

/**
 * Spawn a Trench asynchronously in a worktree. Returns a promise that resolves
 * when the process exits. Non-blocking — multiple can run concurrently.
 */
function spawnRoleAsync(role: string, instruction: string | undefined, worktreePath: string): Promise<SpawnResult> {
  const workdir = worktreePath;
  const slotLabel = path.basename(worktreePath);
  console.log(`\n=== Spawning Scuffy as ${role} [${slotLabel}] ===`);

  const inbox = fetchInbox(role);
  if (inbox.length > 0) {
    const mailContext = `\n\n--- Messages from Chair ---\n${inbox}\n--- End messages ---\n\n`;
    instruction = instruction ? instruction + mailContext : mailContext + "Process these messages, then proceed with your default task.";
  }

  const args = [path.join(SCUFFY_ROOT, "dist/index.js"), "--headless", "--workdir", workdir, "--role", role];
  if (instruction) args.push("--instruction", instruction);

  const logFile = path.join(WORKDIR, ".scuffy", `last-session-${slotLabel}.log`);

  return new Promise((resolve) => {
    const logStream = createWriteStream(logFile);
    const child = spawn("/bin/bash", ["-c",
      `SCUFFY_PARALLEL=1 node ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")} 2>&1`],
      { cwd: SCUFFY_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SCUFFY_PARALLEL: "1", SCUFFY_SLOT_ID: slotLabel } },
    );

    let output = "";
    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      process.stdout.write(`[${slotLabel}] ${text}`);
      logStream.write(text);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      process.stderr.write(`[${slotLabel}] ${text}`);
      logStream.write(text);
    });

    child.on("close", (code) => {
      logStream.end();
      resolve({ exitCode: code ?? 1, output });
    });

    // Safety timeout: 10 minutes
    setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }, 600_000);
  });
}

/**
 * Wait for any one slot to finish. Returns the finished slot.
 */
async function waitForOneSlot(slots: Map<number, SlotState>): Promise<{ slotId: number; beadId: string; worktree: string; result: SpawnResult }> {
  const entries = [...slots.entries()];
  const result = await Promise.race(
    entries.map(([id, state]) =>
      state.promise.then((r) => ({ slotId: id, beadId: state.beadId, worktree: state.worktree, result: r })),
    ),
  );
  slots.delete(result.slotId);
  return result;
}

/**
 * Wait for ALL active slots to finish. Used before Warden/Tower/Scout (run alone).
 */
async function drainAllSlots(slots: Map<number, SlotState>): Promise<void> {
  while (slots.size > 0) {
    const finished = await waitForOneSlot(slots);
    console.log(`  Slot ${String(finished.slotId)} finished (bead ${finished.beadId}, exit ${String(finished.result.exitCode)})`);
    if (finished.result.exitCode === 0) {
      const branchName = extractBranchFromOutput(finished.result.output);
      if (branchName) {
        handleParallelSuccess(branchName, finished.beadId, "Completed");
      }
    } else {
      handleParallelFailure(finished.beadId);
    }
    handleExit(finished.result);
  }
}

/** Extract branch name from Trench output (finishBead includes it in metadata). */
function extractBranchFromOutput(output: string): string | null {
  // Look for git branch from "Switched to a new branch 'task/...'" or current branch
  const branchMatch = /(?:Switched to.*branch|On branch)\s+'?(task\/\S+)'?/i.exec(output);
  if (branchMatch?.[1]) return branchMatch[1];

  // Fallback: look for task branch in git output
  const taskMatch = /task\/[\w-]+/.exec(output);
  return taskMatch?.[0] ?? null;
}

/**
 * Pre-claim a bead for a parallel slot. Uses bv --robot-next with phase filter,
 * excluding already-claimed IDs.
 */
function preClaimBead(phaseLabel: string | null, excludeIds: Set<string>): { id: string; title: string } | null {
  // Use br ready (dependency-aware) as the ONLY source — never fall back to
  // br list which includes beads with unresolved blockers.
  const readyResult = br("--no-auto-flush ready --json");
  try {
    let rawReady: unknown = JSON.parse(readyResult);
    if (typeof rawReady === "object" && rawReady !== null && !Array.isArray(rawReady) && "issues" in rawReady) {
      rawReady = (rawReady as Record<string, unknown>)["issues"];
    }
    if (!Array.isArray(rawReady)) return null;
    const ready = rawReady as Array<{ id: string; title: string; issue_type: string; priority: number; labels: string[] | null }>;

    // Filter: not already claimed, not emergency P0 bugs (handled separately),
    // not beads with 2+ failed attempts (Fix 6)
    const currentAttempts = loadAttempts();
    const eligible = ready.filter((b) =>
      !excludeIds.has(b.id) &&
      !(b.issue_type === "bug" && b.priority === 0) &&
      (currentAttempts.get(b.id) ?? 0) < 2,
    );
    if (eligible.length === 0) return null;

    const pick = eligible[0];
    if (pick) {
      br(`update ${pick.id} --claim --no-auto-flush`);
      return { id: pick.id, title: pick.title };
    }
  } catch { /* ignore */ }
  return null;
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
  let consecutiveFailures = 0;
  for (;;) {
    const beads = listBeads();
    const wardenBeads = beads.filter((b) =>
      b.status !== "closed" && (b.labels ?? []).includes("warden")
    );
    if (wardenBeads.length === 0) break;
    if (consecutiveFailures >= 3) {
      console.log(
        `=== Circuit breaker: ${String(consecutiveFailures)} consecutive failures ` +
        `draining warden beads. ${String(wardenBeads.length)} remain. ===`,
      );
      notifyChair("Circuit breaker tripped",
        `${String(consecutiveFailures)} consecutive Trench failures draining warden beads. Likely a connection or provider issue.`);
      break;
    }
    // Pick the first warden bead and force-assign it
    const wardenBead = wardenBeads[0];
    if (!wardenBead) break;
    console.log(`=== ${String(wardenBeads.length)} warden bead(s) to fix. Assigning ${wardenBead.id}. ===`);
    br(`update ${wardenBead.id} --claim --no-auto-flush`);
    const result = spawnRoleClean("trench",
      `Fix warden issue. Call claimBead with beadId="${wardenBead.id}". ` +
      `Read the bead description and fix the issue, then call finishBead.`);
    handleExit(result, wardenBead.id);
    if (result.exitCode !== 0) {
      consecutiveFailures++;
    } else {
      consecutiveFailures = 0;
    }
  }
}

// ─── Exit handling ───────────────────────────────────────────────────────────

let completedSinceWarden = 0;

function handleExit(result: SpawnResult, knownBeadId?: string): void {
  const beadId = knownBeadId ?? extractBeadId(result.output);

  switch (result.exitCode) {
    case 0:
      console.log("=== Bead complete. ===");
      completedSinceWarden++;
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
 * ensure a P0 emergency fix bead exists and return its ID so the summoner
 * can force-assign it to the next Trench.
 *
 * Returns the emergency bead ID if main is broken, null if healthy.
 */
function ensureMainHealth(): string | null {
  console.log("=== Checking main health (typecheck) ===");
  try {
    execFileSync("/bin/sh", ["-c", "npm run typecheck"], {
      cwd: WORKDIR,
      timeout: 120_000,
      stdio: "pipe",
    });
    console.log("  Main is healthy.");
    return null;
  } catch (err: unknown) {
    console.log("  Main has typecheck failures.");

    // Check if an emergency fix bead already exists (any open P0 bug).
    // Emergency beads are created as type=bug priority=0. Scout creates
    // P0 tasks/features, not bugs, so this won't match scaffold beads.
    const beads = listBeads();
    const emergency = beads.find(
      (b) => b.status !== "closed" && b.issue_type === "bug" && b.priority === 0,
    );

    if (emergency) {
      console.log(`  Emergency fix bead exists: ${emergency.id}. Forcing assignment.`);
      return emergency.id;
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
    const createOutput = br(
      `create --no-auto-flush --title='Fix pre-existing typecheck failures on main' ` +
      `--type=bug --priority=0 --description='Typecheck fails on main. This blocks all Trench agents.\n\n${summary.replace(/'/g, "'\\''")}'`,
    );
    br("sync --flush-only");

    // Extract the new bead ID
    const idMatch = /Created\s+(\S+):/.exec(createOutput);
    const newId = idMatch?.[1] ?? null;

    notifyChair(
      "Main health check failed",
      "Typecheck fails on main. Created P0 emergency bead. Next Trench will attempt fix.",
    );

    if (newId) {
      console.log(`  Created emergency bead: ${newId}. Forcing assignment.`);
    }
    return newId;
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

    // 3. Warden audit if enough beads completed since last audit
    if (completedSinceWarden >= WARDEN_INTERVAL) {
      console.log(`\n=== ${String(completedSinceWarden)} beads completed since last audit. Running Warden. ===`);
      spawnRoleClean("warden-dark", `Audit the last ${String(completedSinceWarden)} completed beads. Focus on code quality, test coverage, and integration issues.`);
      drainWardenBeads();
      spawnRoleClean("warden-light", `Review the last ${String(completedSinceWarden)} completed beads for polish, cleanup, and documentation.`);
      drainWardenBeads();
      completedSinceWarden = 0;
      continue;
    }

    // 4. Ready beads → Trench (phase-gated)
    if (ready.length > 0) {
      // Health check: if main is broken, force-assign the emergency fix bead
      const emergencyId = ensureMainHealth();

      if (emergencyId) {
        const result = spawnRoleClean("trench",
          `URGENT: Main has typecheck failures. Call claimBead with beadId="${emergencyId}" ` +
          `to claim the emergency fix bead. Fix the failures, then call finishBead.`);
        handleExit(result);
        continue;
      }

      // Detect current phase: find the lowest-numbered phase with open beads
      const currentPhase = detectCurrentPhase(allBeads);

      // If the current phase is a placeholder, send Tower to expand it
      if (currentPhase?.isPlaceholder) {
        console.log(`=== Phase placeholder detected: ${currentPhase.label}. Invoking Tower to expand. ===`);
        spawnRoleClean("tower",
          `Expand phase placeholder bead ${currentPhase.placeholderId}. ` +
          `Read the bead description for scope and exit criteria. Read the current codebase ` +
          `to understand what exists. Create 8-15 detailed implementation beads labeled ` +
          `"${currentPhase.label}". Then close the placeholder bead using closeBead. ` +
          `Call escalate when done.`);
        continue;
      }

      // Normal Trench spawn with phase filter
      const phaseArg = currentPhase ? ` Call claimBead with phaseLabel="${currentPhase.label}".` : "";
      const result = spawnRoleClean("trench",
        phaseArg.length > 0
          ? `Work on the current phase.${phaseArg}`
          : undefined);
      handleExit(result);

      // Broken Windows: if bead completed via bypass, force-drain the P0 before
      // resuming feature work.
      if (result.exitCode === 0 && /WARNING: Pre-existing .* bypassed/.test(result.output)) {
        console.log("=== Bypass detected — draining emergency P0 before resuming. ===");
        const beads = listBeads();
        const openP0 = beads.find(
          (b) => b.status !== "closed" && b.issue_type === "bug" && b.priority === 0,
        );
        if (openP0) {
          console.log(`  Forcing P0 bead ${openP0.id}.`);
          const fixResult = spawnRoleClean("trench",
            `URGENT: Pre-existing test/lint failures from a bypass. ` +
            `Call claimBead with beadId="${openP0.id}". Fix the failures, then call finishBead.`);
          handleExit(fixResult);
        }
      }
      continue;
    }

    // 4. Nothing to do
    console.log("No beads ready. Done.");
    break;
  }

  console.log("Summoner finished.");
}

// ─── Parallel main loop ──────────────────────────────────────────────────────

async function mainParallel(): Promise<void> {
  console.log(`Summoner started (parallel, ${String(MAX_PARALLEL_SLOTS)} slots) — workspace: ${WORKDIR}`);
  mkdirSync(path.join(WORKDIR, ".scuffy"), { recursive: true });

  const activeSlots = new Map<number, SlotState>();
  const claimedIds = new Set<string>();
  let consecutiveParallelFailures = 0;

  for (;;) {
    // Brake check
    if (existsSync(PAUSE_FILE)) {
      console.log(`Paused. Remove ${PAUSE_FILE} to resume.`);
      if (activeSlots.size > 0) {
        console.log(`  Draining ${String(activeSlots.size)} active slot(s) before pausing...`);
        await drainAllSlots(activeSlots);
        claimedIds.clear();
      }
      while (existsSync(PAUSE_FILE)) {
        await new Promise((r) => setTimeout(r, 5000));
      }
      console.log("Resumed.");
      resetToMain();
    }

    // Only reset to main when no slots are active (main worktree must be free)
    if (activeSlots.size === 0) {
      resetToMain();
      recoverStaleBeads();
    }

    const allBeads = listBeads();
    const ready = readyBeads();

    // 1. No beads → Scout (run alone)
    if (allBeads.length === 0) {
      await drainAllSlots(activeSlots);
      claimedIds.clear();
      console.log("\n=== No beads found. Running Scout to bootstrap. ===");
      spawnRoleClean("scout");
      console.log("=== Scout done. ===");
      continue;
    }

    // 2. Phase closing? (run alone)
    const phase = closingPhase();
    if (phase) {
      await drainAllSlots(activeSlots);
      claimedIds.clear();
      runPhaseClose(phase);
      continue;
    }

    // 3. Warden audit (run alone)
    if (completedSinceWarden >= WARDEN_INTERVAL) {
      await drainAllSlots(activeSlots);
      claimedIds.clear();
      console.log(`\n=== ${String(completedSinceWarden)} beads completed since last audit. Running Warden. ===`);
      spawnRoleClean("warden-dark", `Audit the last ${String(completedSinceWarden)} completed beads. Focus on code quality, test coverage, and integration issues.`);
      drainWardenBeads();
      spawnRoleClean("warden-light", `Review the last ${String(completedSinceWarden)} completed beads for polish, cleanup, and documentation.`);
      drainWardenBeads();
      completedSinceWarden = 0;
      continue;
    }

    // 4. Ready beads → fill parallel Trench slots
    if (ready.length > 0) {
      // Health check: if main is broken, only one slot for emergency fix
      const emergencyId = ensureMainHealth();
      if (emergencyId) {
        await drainAllSlots(activeSlots);
        claimedIds.clear();
        const result = spawnRoleClean("trench",
          `URGENT: Main has typecheck failures. Call claimBead with beadId="${emergencyId}" ` +
          `to claim the emergency fix bead. Fix the failures, then call finishBead.`);
        handleExit(result);
        continue;
      }

      // Detect current phase
      const currentPhase = detectCurrentPhase(allBeads);
      if (currentPhase?.isPlaceholder) {
        await drainAllSlots(activeSlots);
        claimedIds.clear();
        console.log(`=== Phase placeholder detected: ${currentPhase.label}. Invoking Tower to expand. ===`);
        spawnRoleClean("tower",
          `Expand phase placeholder bead ${currentPhase.placeholderId ?? "unknown"}. ` +
          `Read the bead description for scope and exit criteria. Read BRIEF.md for product vision. ` +
          `Read the current codebase to understand what exists. Create 8-15 detailed implementation ` +
          `beads labeled "${currentPhase.label}". Then close the placeholder bead using closeBead. ` +
          `Call escalate when done.`);
        continue;
      }

      // Fill empty slots
      while (activeSlots.size < MAX_PARALLEL_SLOTS) {
        const slotId = findEmptySlotId(activeSlots);
        const bead = preClaimBead(currentPhase?.label ?? null, claimedIds);
        if (!bead) break;

        claimedIds.add(bead.id);
        const wt = ensureWorktree(slotId);
        const phaseArg = currentPhase ? ` Call claimBead with phaseLabel="${currentPhase.label}".` : "";
        const promise = spawnRoleAsync("trench",
          `Work on bead ${bead.id}: ${bead.title}.${phaseArg}` +
          ` Call claimBead with beadId="${bead.id}" to register your session.`,
          wt);
        activeSlots.set(slotId, { slotId, beadId: bead.id, worktree: wt, promise });
        console.log(`  Slot ${String(slotId)}: bead ${bead.id} — ${bead.title.slice(0, 50)}`);
      }
    }

    // Nothing to spawn and nothing running → done
    if (activeSlots.size === 0 && ready.length === 0) {
      console.log("No beads ready. Done.");
      break;
    }

    // Wait for any slot to finish
    if (activeSlots.size > 0) {
      const finished = await waitForOneSlot(activeSlots);
      claimedIds.delete(finished.beadId);
      console.log(`\n=== Slot ${String(finished.slotId)} finished: bead ${finished.beadId} (exit ${String(finished.result.exitCode)}) ===`);

      if (finished.result.exitCode === 0) {
        // Find the task branch in the worktree. git branch --show-current may
        // return empty (detached HEAD), so also search for task/* branches.
        let branchName: string | null = null;
        try {
          branchName = execFileSync("git", ["branch", "--show-current"], {
            cwd: finished.worktree, encoding: "utf-8", timeout: 5_000,
          }).trim() || null;
        } catch { /* ignore */ }
        if (!branchName) {
          // Detached HEAD — find the most recent task/ branch
          try {
            const branches = execFileSync("git", ["branch", "--sort=-committerdate"], {
              cwd: finished.worktree, encoding: "utf-8", timeout: 5_000,
            }).trim();
            const taskBranch = branches.split("\n")
              .map((b) => b.trim().replace(/^\* /, ""))
              .find((b) => b.startsWith("task/"));
            if (taskBranch) branchName = taskBranch;
          } catch { /* ignore */ }
        }

        if (branchName && branchName !== "main") {
          handleParallelSuccess(branchName, finished.beadId, "Completed");
        } else {
          console.log(`  WARNING: Could not find task branch for bead ${finished.beadId} in ${finished.worktree}. Work may not be merged.`);
          br(`close ${finished.beadId} --reason "Completed (branch not found for merge)"`);
        }
        completedSinceWarden++;
        resetAttempts(finished.beadId);
        consecutiveParallelFailures = 0;

        // Broken Windows: if this bead completed via bypass (pre-existing
        // failures), force-drain the P0 emergency bead before resuming
        // feature work. This prevents broken windows from compounding.
        if (/WARNING: Pre-existing .* bypassed/.test(finished.result.output)) {
          console.log("=== Bypass detected — draining emergency P0 before resuming. ===");
          await drainAllSlots(activeSlots);
          claimedIds.clear();
          const p0Id = ensureMainHealth();
          if (p0Id) {
            const fixResult = spawnRoleClean("trench",
              `URGENT: Pre-existing test/typecheck failures must be fixed before new work. ` +
              `Call claimBead with beadId="${p0Id}" to claim the emergency fix bead. ` +
              `Fix the failures, then call finishBead.`);
            handleExit(fixResult);
          } else {
            // ensureMainHealth only checks typecheck — also check for open P0 bugs
            const beads = listBeads();
            const openP0 = beads.find(
              (b) => b.status !== "closed" && b.issue_type === "bug" && b.priority === 0,
            );
            if (openP0) {
              console.log(`  Forcing P0 bead ${openP0.id} (test/lint failures).`);
              const fixResult = spawnRoleClean("trench",
                `URGENT: Pre-existing test/lint failures from a bypass. ` +
                `Call claimBead with beadId="${openP0.id}". Fix the failures, then call finishBead.`);
              handleExit(fixResult);
            }
          }
        }
      } else {
        handleParallelFailure(finished.beadId);
        handleExit(finished.result, finished.beadId);
        consecutiveParallelFailures++;
        if (consecutiveParallelFailures >= 5) {
          console.log(`=== Circuit breaker: ${String(consecutiveParallelFailures)} consecutive parallel failures. Pausing. ===`);
          notifyChair("Parallel circuit breaker tripped",
            `${String(consecutiveParallelFailures)} consecutive Trench failures. Likely a systemic issue.`);
          await drainAllSlots(activeSlots);
          break;
        }
      }
    }
  }

  console.log("Summoner finished (parallel).");
}

/** Find the lowest unused slot ID. */
function findEmptySlotId(slots: Map<number, SlotState>): number {
  for (let i = 0; i < MAX_PARALLEL_SLOTS; i++) {
    if (!slots.has(i)) return i;
  }
  return MAX_PARALLEL_SLOTS; // shouldn't happen
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const entry = MAX_PARALLEL_SLOTS > 1 ? mainParallel : main;
entry().catch((err: unknown) => {
  console.error("Summoner fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
