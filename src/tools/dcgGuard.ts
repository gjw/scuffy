import { execFile } from "node:child_process";

const DCG_TIMEOUT_MS = 5_000;
const DEFAULT_RUN_TIMEOUT_MS = 60_000;

interface DcgResult {
  allowed: boolean;
  reason?: string | undefined;
}

/**
 * Check a command against DCG (destructive_command_guard).
 * Fails open — if dcg is not installed or errors, the command is allowed.
 */
export function checkDcg(command: string, cwd?: string): Promise<DcgResult> {
  return new Promise((resolve) => {
    execFile(
      "dcg",
      ["test", "--format", "json", command],
      { timeout: DCG_TIMEOUT_MS, cwd },
      (error, stdout) => {
        if (!error) {
          // Exit 0 = allowed
          resolve({ allowed: true });
          return;
        }

        // Exit 1 = denied (dcg outputs JSON to stdout)
        if ("code" in error && error.code === 1 && stdout) {
          try {
            const parsed: unknown = JSON.parse(stdout);
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              "decision" in parsed &&
              (parsed as Record<string, unknown>)["decision"] === "deny"
            ) {
              const reason =
                "reason" in parsed && typeof (parsed as Record<string, unknown>)["reason"] === "string"
                  ? ((parsed as Record<string, unknown>)["reason"] as string)
                  : "Command blocked by DCG";
              resolve({ allowed: false, reason });
              return;
            }
          } catch {
            // JSON parse failed — fail open
          }
        }

        // dcg not found, crashed, timed out, or unexpected output — fail open
        resolve({ allowed: true });
      },
    );
  });
}

/**
 * Run a shell command with DCG guard. If DCG denies the command, returns
 * an error result without executing. Otherwise executes normally.
 */
export async function guardedRun(
  command: string,
  cwd: string,
  timeout?: number,
): Promise<{ ok: boolean; output: string }> {
  const dcg = await checkDcg(command, cwd);
  if (!dcg.allowed) {
    return { ok: false, output: `DCG blocked: ${dcg.reason ?? "destructive command"}` };
  }

  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, timeout: timeout ?? DEFAULT_RUN_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        resolve({ ok: !error, output });
      },
    );
  });
}
