import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Role definitions for headless Scuffy agents.
 *
 * Each role maps to a system prompt file, an agent mail identity,
 * a default instruction, and an optional model override for heavier tasks.
 */

export type RoleName = "scout" | "trench" | "tower" | "warden-light" | "warden-dark";

export interface RoleConfig {
  /** System prompt file path relative to repo root prompts/ dir. */
  promptFile: string;
  /** Agent mail identity name. */
  agentName: string;
  /** Default instruction if none provided via --instruction. */
  defaultInstruction: string;
  /** Model override for this role. Undefined = use default from config. */
  modelOverride?: string | undefined;
}

/**
 * Heavy model for planning roles (Scout, Tower). Read from SCUFFY_HEAVY_MODEL
 * env var. If not set, no override is applied — uses the default model from config.
 * This avoids hardcoding a provider-specific model ID.
 */
const HEAVY_MODEL: string | undefined = process.env["SCUFFY_HEAVY_MODEL"] ?? undefined;

const ROLES: Record<RoleName, RoleConfig> = {
  scout: {
    promptFile: "prompts/scout.md",
    agentName: "SwiftScout",
    defaultInstruction:
      "Read BRIEF.md. Break the work into beads using br create via bash. " +
      "Set up dependency graph and phase labels. Call escalate when done planning.",
    modelOverride: HEAVY_MODEL,
  },
  trench: {
    promptFile: "prompts/trench.md",
    agentName: "RedTrench",
    defaultInstruction:
      "Call claimBead to get your assignment, implement it, " +
      "then call finishBead when done. If stuck or blocked, call escalate.",
  },
  tower: {
    promptFile: "prompts/tower.md",
    agentName: "BoldTower",
    defaultInstruction:
      "Review the current bead state with bv --robot-triage. " +
      "Replan, reprioritize, and create/close beads as needed. " +
      "Call escalate when done replanning.",
    modelOverride: HEAVY_MODEL,
  },
  "warden-light": {
    promptFile: "prompts/warden.md",
    agentName: "BrightWarden",
    defaultInstruction:
      "Run quality checks on recent work. Review code for polish, test coverage, " +
      "and cleanup opportunities. Create beads for issues found. " +
      "Call escalate when done auditing.",
  },
  "warden-dark": {
    promptFile: "prompts/warden.md",
    agentName: "DarkWarden",
    defaultInstruction:
      "Adversarial audit of recent work. Challenge assumptions, find bugs, " +
      "test edge cases, look for missing error handling and security issues. " +
      "Create beads for issues found. Call escalate when done auditing.",
  },
};

export function isValidRole(role: string): role is RoleName {
  return role in ROLES;
}

export function getRoleConfig(role: RoleName): RoleConfig {
  return ROLES[role];
}

/** Load the system prompt for a role from its prompt file. */
export function loadRolePrompt(role: RoleName, repoRoot: string): string {
  const config = ROLES[role];
  const promptPath = path.join(repoRoot, config.promptFile);
  try {
    return readFileSync(promptPath, "utf-8");
  } catch {
    throw new Error(`Role prompt not found: ${promptPath}`);
  }
}

/** Get all valid role names. */
export function getAllRoles(): RoleName[] {
  return Object.keys(ROLES) as RoleName[];
}
