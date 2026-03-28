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
import { formatJudicarPrompt, gatherRecentGitLog, gatherOpenBeads, type TriageFailureContext } from "./judicar.js";

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

/** Generate a short branch-safe slug from a bead title. */
function slugify(title: string, maxLen = 40): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLen)
    .replace(/-$/, "");
}

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
  return brJson("list --limit 0") as Bead[];
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
 * Returns "merged" if new commits were introduced, "noop" if the branch
 * was already fully merged (no new commits), or "conflict" on failure.
 */
function mergeToMain(branchName: string): "merged" | "noop" | "conflict" {
  try {
    // Record HEAD before merge to detect no-op (already-merged) branches
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: WORKDIR, encoding: "utf-8", timeout: 5_000,
    }).trim();

    execFileSync(
      "git",
      ["merge", branchName, "--no-edit"],
      { cwd: WORKDIR, timeout: 30_000, stdio: "pipe" },
    );

    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: WORKDIR, encoding: "utf-8", timeout: 5_000,
    }).trim();

    if (headBefore === headAfter) {
      console.error(`  WARNING: Merge of ${branchName} was a no-op (already merged). Work may have been lost.`);
      return "noop";
    }

    console.log(`  Merged ${branchName} to main.`);
    return "merged";
  } catch {
    // Merge conflict — abort and report
    try {
      execFileSync("git", ["merge", "--abort"], { cwd: WORKDIR, timeout: 5_000, stdio: "pipe" });
    } catch { /* ignore */ }
    console.error(`  Merge conflict: ${branchName} could not be merged to main.`);
    return "conflict";
  }
}

/**
 * After a successful Trench exit in parallel mode: merge branch, close bead, sync.
 */
function handleParallelSuccess(branchName: string, beadId: string, summary: string): void {
  const mergeResult = mergeToMain(branchName);
  if (mergeResult === "conflict") {
    // Merge conflict — the work is good, main just changed under it.
    // Release to open for retry. On the next attempt, the Trench starts
    // from updated main and the conflict resolves naturally.
    console.log(`  Merge conflict for ${beadId} — releasing for retry on updated main.`);
    br(`update ${beadId} --status=open --no-auto-flush`);
  } else if (mergeResult === "noop") {
    // Branch was already merged — stale branch detected. Don't close bead.
    console.error(`  Stale branch ${branchName} for bead ${beadId} — releasing for retry.`);
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
  branchName: string;
  worktree: string;
  promise: Promise<SpawnResult>;
}

/**
 * Spawn a Trench asynchronously in a worktree. Returns a promise that resolves
 * when the process exits. Non-blocking — multiple can run concurrently.
 */
interface SpawnEnv {
  branchName?: string;
  beadId?: string;
}

function spawnRoleAsync(role: string, instruction: string | undefined, worktreePath: string, extra?: SpawnEnv): Promise<SpawnResult> {
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

  const spawnEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    SCUFFY_PARALLEL: "1",
    SCUFFY_SLOT_ID: slotLabel,
  };
  if (extra?.branchName) spawnEnv["SCUFFY_BRANCH"] = extra.branchName;
  if (extra?.beadId) spawnEnv["SCUFFY_BEAD_ID"] = extra.beadId;

  return new Promise((resolve) => {
    const logStream = createWriteStream(logFile);
    const child = spawn("/bin/bash", ["-c",
      `SCUFFY_PARALLEL=1 node ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")} 2>&1`],
      { cwd: SCUFFY_ROOT, stdio: ["ignore", "pipe", "pipe"], env: spawnEnv },
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
async function waitForOneSlot(slots: Map<number, SlotState>): Promise<{ slotId: number; beadId: string; branchName: string; worktree: string; result: SpawnResult }> {
  const entries = [...slots.entries()];
  const result = await Promise.race(
    entries.map(([id, state]) =>
      state.promise.then((r) => ({ slotId: id, beadId: state.beadId, branchName: state.branchName, worktree: state.worktree, result: r })),
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
      // Use deterministic branch name from slot state
      handleParallelSuccess(finished.branchName, finished.beadId, "Completed");
    } else {
      handleParallelFailure(finished.beadId);
    }
    handleExit(finished.result);
  }
}

/** Read branch from the structured exit file written by headless.ts. */
function readBranchFromExitFile(worktreePath: string): string | null {
  const slotLabel = path.basename(worktreePath);
  try {
    const exitFileSlot = path.join(worktreePath, ".scuffy", `exit-${slotLabel}.json`);
    const exitFileGeneric = path.join(worktreePath, ".scuffy", "exit.json");
    const exitFilePath = existsSync(exitFileSlot) ? exitFileSlot : exitFileGeneric;
    const exitMeta: unknown = JSON.parse(readFileSync(exitFilePath, "utf-8"));
    if (typeof exitMeta === "object" && exitMeta !== null && "branch" in exitMeta) {
      const branch = (exitMeta as Record<string, unknown>)["branch"];
      return typeof branch === "string" && branch.length > 0 ? branch : null;
    }
  } catch { /* ignore */ }
  return null;
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

    // br ready doesn't include labels — enrich from br list which does
    const allBeads = listBeads();
    const labelMap = new Map<string, string[]>();
    for (const b of allBeads) {
      labelMap.set(b.id, b.labels ?? []);
    }
    for (const b of ready) {
      if (b.labels === null || b.labels === undefined) {
        b.labels = labelMap.get(b.id) ?? [];
      }
    }

    // Filter: not already claimed, not emergency P0 bugs (handled separately),
    // not beads with 2+ failed attempts, not phase placeholders,
    // and only beads in the current phase (if specified)
    const currentAttempts = loadAttempts();
    const eligible = ready.filter((b) => {
      if (excludeIds.has(b.id)) return false;
      if (b.issue_type === "bug" && b.priority === 0) return false;
      if ((currentAttempts.get(b.id) ?? 0) >= 2) return false;
      const labels = b.labels ?? [];
      if (labels.includes("phase-placeholder")) return false;
      // Phase gating: pick beads from the current phase OR unlabeled beads
      // (emergency fixes, warden beads, conflict resolution have no phase label)
      const hasAnyPhaseLabel = labels.some((l) => l.startsWith("phase:"));
      if (phaseLabel && hasAnyPhaseLabel && !labels.includes(phaseLabel)) return false;
      return true;
    });
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

/**
 * Spawn a Judicar to make a triage decision about a failed bead.
 * The Judicar reads the context, acts via br commands, and exits.
 * Falls back to Tower if SCUFFY_USE_JUDICAR is not set.
 */
function judicarTriageFailure(beadId: string, result: SpawnResult, attemptCount: number): void {
  if (process.env["SCUFFY_USE_JUDICAR"] !== "1") {
    // Feature flag off — use legacy Tower path
    if (result.exitCode === 2) {
      splitBead(beadId);
    } else {
      towerReviewBead(beadId);
    }
    return;
  }

  // Gather bead info
  let beadTitle = beadId;
  let beadPriority = 2;
  let beadLabels: string[] = [];
  try {
    const beadJson = br(`show ${beadId} --json`);
    const parsed: unknown = JSON.parse(beadJson);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const bead = parsed[0] as Record<string, unknown>;
      beadTitle = (bead["title"] as string) ?? beadId;
      beadPriority = (bead["priority"] as number) ?? 2;
      beadLabels = (bead["labels"] as string[]) ?? [];
    }
  } catch { /* use defaults */ }

  const ctx: TriageFailureContext = {
    type: "TRIAGE_FAILURE",
    beadId,
    beadTitle,
    beadPriority,
    beadLabels,
    attemptCount,
    exitCode: result.exitCode,
    failureOutput: result.output,
    recentGitLog: gatherRecentGitLog(WORKDIR),
  };

  const prompt = formatJudicarPrompt(ctx);
  console.log(`=== Spawning Judicar to triage ${beadId} ===`);
  spawnRoleClean("judicar", prompt);
}

function haltBead(beadId: string): void {
  console.log(`=== Bead ${beadId} failed 3 times. Halting. ===`);
  notifyChair(`HALTED: ${beadId}`, `Bead ${beadId} failed 3 times and has been halted. Manual intervention needed.`);
  br(`update ${beadId} --labels=blocked --no-auto-flush`);
}

/**
 * Spawn Judicar to filter warden-proposed beads.
 * Judicar reviews open warden-labeled beads and may close, reprioritize, or approve them.
 */
function judicarTriageWarden(): void {
  const beads = listBeads();
  const wardenBeads = beads.filter((b) =>
    b.status !== "closed" && (b.labels ?? []).includes("warden")
  );
  if (wardenBeads.length === 0) return;

  const proposed = wardenBeads.map((b) => {
    let description = "";
    try {
      const detail = br(`show ${b.id} --json`);
      const parsed: unknown = JSON.parse(detail);
      if (Array.isArray(parsed) && parsed.length > 0) {
        description = ((parsed[0] as Record<string, unknown>)["description"] as string ?? "").slice(0, 200);
      }
    } catch { /* use empty */ }
    return {
      id: b.id,
      title: b.title,
      priority: b.priority,
      description,
    };
  });

  // Get the warden's summary from the last session output
  const wardenSummary = "(See warden audit output above)";

  const ctx = {
    type: "TRIAGE_WARDEN" as const,
    wardenSummary,
    proposedBeads: proposed,
    currentSlice: null,
  };

  const prompt = formatJudicarPrompt(ctx);
  console.log(`=== Spawning Judicar to filter ${String(wardenBeads.length)} warden bead(s) ===`);
  spawnRoleClean("judicar", prompt);
}

/**
 * Spawn Judicar to check if the build is truly complete.
 * Returns true if Judicar confirms done, false if it created new beads.
 */
function judicarTriageComplete(): boolean {
  const openBeads = gatherOpenBeads(WORKDIR);
  const gitLog = gatherRecentGitLog(WORKDIR);

  // Quick curl check of key endpoints
  let curlResults = "";
  const endpoints = [
    "/health",
    "/programs?workspaceId=workspace-demo&limit=5&offset=0",
    "/people?workspaceId=workspace-demo&limit=5&offset=0",
  ];
  for (const ep of endpoints) {
    try {
      const out = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `http://localhost:3000${ep}`], {
        timeout: 5000,
        encoding: "utf-8",
      }).trim();
      curlResults += `GET ${ep} → ${out}\n`;
    } catch {
      curlResults += `GET ${ep} → (curl failed)\n`;
    }
  }

  const ctx = {
    type: "TRIAGE_COMPLETE" as const,
    openBeads,
    recentGitLog: gitLog,
    curlResults,
  };

  const prompt = formatJudicarPrompt(ctx);
  console.log("=== Spawning Judicar to verify build completion ===");
  spawnRoleClean("judicar", prompt);

  // Check if Judicar created any new beads
  const afterBeads = readyBeads();
  return afterBeads.length === 0;
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
    // Check for pause
    if (existsSync(PAUSE_FILE)) {
      console.log("=== Paused during warden drain. ===");
      break;
    }
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
          judicarTriageFailure(beadId, result, count);
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
          judicarTriageFailure(beadId, result, count);
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
    if (process.env["SCUFFY_USE_JUDICAR"] === "1") {
      console.log("No beads ready. Spawning Judicar to verify completion.");
      const isDone = judicarTriageComplete();
      if (isDone) {
        console.log("Judicar confirms build is complete.");
        break;
      }
      console.log("Judicar created new beads. Continuing.");
      continue;
    }
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

      // Judicar filters warden beads before draining
      if (process.env["SCUFFY_USE_JUDICAR"] === "1") {
        judicarTriageWarden();
      }

      drainWardenBeads();
      spawnRoleClean("warden-light", `Review the last ${String(completedSinceWarden)} completed beads for polish, cleanup, and documentation.`);

      if (process.env["SCUFFY_USE_JUDICAR"] === "1") {
        judicarTriageWarden();
      }

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

        // Deterministic branch creation — summoner owns the branch, not the agent.
        // Use plain checkout if the branch already has commits (retry after escalation)
        // to preserve previous work. Only use -B (reset) for fresh branches.
        const branchName = `task/${bead.id}-${slugify(bead.title)}`;
        let branchCreated = false;
        let branchHasWork = false;
        try {
          // Check if branch already has commits beyond main
          try {
            const ahead = execFileSync("git", ["rev-list", "--count", `main..${branchName}`], {
              cwd: wt, timeout: 10_000, encoding: "utf-8", stdio: "pipe",
            }).trim();
            branchHasWork = Number(ahead) > 0;
          } catch {
            // Branch doesn't exist yet — that's fine, we'll create it
          }

          if (branchHasWork) {
            execFileSync("git", ["checkout", branchName], {
              cwd: wt, timeout: 10_000, stdio: "pipe",
            });
          } else {
            execFileSync("git", ["checkout", "-B", branchName], {
              cwd: wt, timeout: 10_000, stdio: "pipe",
            });
          }
          branchCreated = true;
        } catch {
          // Branch may be checked out in another worktree. Skip this bead.
          console.error(`  Branch ${branchName} unavailable for slot ${String(slotId)} (likely in use by another slot). Skipping.`);
          claimedIds.add(bead.id); // keep in claimed set so we don't retry it this cycle
        }
        if (!branchCreated) continue;

        const phaseArg = currentPhase ? ` Call claimBead with phaseLabel="${currentPhase.label}".` : "";
        const retryHint = branchHasWork
          ? ` NOTE: A previous Trench already implemented this bead but finishBead` +
            ` rejected it due to integration failures after merging main. The code` +
            ` is likely done — check for type/test failures, fix them, and call finishBead.`
          : "";
        const promise = spawnRoleAsync("trench",
          `Work on bead ${bead.id}: ${bead.title}.${phaseArg}` +
          ` You are on branch \`${branchName}\`. Do NOT create a new branch.` +
          ` Call claimBead with beadId="${bead.id}" to register your session.${retryHint}`,
          wt, { branchName, beadId: bead.id });
        activeSlots.set(slotId, { slotId, beadId: bead.id, branchName, worktree: wt, promise });
        console.log(`  Slot ${String(slotId)}: bead ${bead.id} — ${bead.title.slice(0, 50)}`);
      }
    }

    // Nothing to spawn and nothing running → check if truly done
    if (activeSlots.size === 0 && ready.length === 0) {
      if (process.env["SCUFFY_USE_JUDICAR"] === "1") {
        console.log("No beads ready. Spawning Judicar to verify completion.");
        const isDone = judicarTriageComplete();
        if (isDone) {
          console.log("Judicar confirms build is complete.");
          break;
        }
        console.log("Judicar created new beads. Continuing.");
        continue;
      }
      console.log("No beads ready. Done.");
      break;
    }

    // Wait for any slot to finish
    if (activeSlots.size > 0) {
      const finished = await waitForOneSlot(activeSlots);
      claimedIds.delete(finished.beadId);
      console.log(`\n=== Slot ${String(finished.slotId)} finished: bead ${finished.beadId} (exit ${String(finished.result.exitCode)}) ===`);

      if (finished.result.exitCode === 0) {
        // Branch is known deterministically — summoner created it before spawn.
        const branchName = finished.branchName;
        console.log(`  Merging branch: ${branchName}`);
        const mergeResult = mergeToMain(branchName);
        if (mergeResult === "merged") {
          br(`close ${finished.beadId} --reason "Completed"`);
          br("sync --flush-only");
        } else if (mergeResult === "noop") {
          // Agent completed but didn't commit to the branch. Release for retry.
          console.error(`  No new commits on ${branchName} for bead ${finished.beadId} — releasing for retry.`);
          br(`update ${finished.beadId} --status=open --no-auto-flush`);
          br("sync --flush-only");
        } else {
          // Merge conflict — spawn a focused Trench to resolve it
          console.log(`  Merge conflict for ${branchName}. Spawning resolution Trench.`);
          const resolveResult = spawnRoleClean("trench",
            `MERGE CONFLICT: Branch ${branchName} (bead ${finished.beadId}) cannot merge to main cleanly. ` +
            `Checkout main, run git merge ${branchName}, resolve ALL conflicts, run npm run typecheck to verify, ` +
            `commit the merge, then call finishBead with beadId="${finished.beadId}".`);
          handleExit(resolveResult, finished.beadId);
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
