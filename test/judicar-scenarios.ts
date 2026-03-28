/**
 * Judicar scenario tests — contrived decision points from real failures.
 *
 * Each scenario sets up a bead state, formats the Judicar prompt, and
 * verifies the prompt contains the right context. For end-to-end testing
 * (actual LLM calls), run with --live flag.
 *
 * Usage:
 *   npx tsx test/judicar-scenarios.ts          # prompt verification only
 *   npx tsx test/judicar-scenarios.ts --live    # spawns real Judicar sessions
 */

import { formatJudicarPrompt, type JudicarContext } from "../src/summoner/judicar.js";

const LIVE = process.argv.includes("--live");

interface Scenario {
  name: string;
  context: JudicarContext;
  /** Strings that MUST appear in the formatted prompt */
  promptMustInclude: string[];
  /** What a correct Judicar decision looks like (for --live verification) */
  expectedDecision: string;
}

// ─── Scenario 1: Repeated OOM-type failure ──────────────────────────────────
// Three agents tried to fix a Vitest OOM by adjusting config. All failed.
// The Judicar should recognize the pattern and close/defer.

const scenario1_repeatedOOM: Scenario = {
  name: "Repeated OOM failure — same error pattern across attempts",
  context: {
    type: "TRIAGE_FAILURE",
    beadId: "test-oom-bead",
    beadTitle: "Fix: add web test runner stability for full workspace npm test",
    beadPriority: 1,
    beadLabels: ["warden"],
    attemptCount: 2,
    exitCode: 1,
    failureOutput:
      "Escalated (blocked): Blocked on test-oom-bead. I reproduced the root failure: " +
      "the web Vitest suite crashes with OOM and ERR_IPC_CHANNEL_CLOSED after running " +
      "tests. I tried stabilizing runner config in web/vitest.config.ts (single worker, " +
      "disabled file parallelism, disabled isolation) and raising Node heap, but even " +
      "running only one test still balloons to 4-8 GB and dies. This indicates the " +
      "issue is not workspace orchestration alone; a specific web test/module likely " +
      "has a runaway memory pattern.",
    recentGitLog:
      "abc1234 WIP: session ended with exit 1\n" +
      "def5678 WIP: session ended with exit 1\n" +
      "ghi9012 Add notification routes (ship-rebuild-ismg)",
  },
  promptMustInclude: [
    "TRIAGE_FAILURE",
    "test-oom-bead",
    "Attempt: 2",
    "warden",
    "OOM",
    "4-8 GB",
  ],
  expectedDecision: "close or defer — P1 warden bead failed twice on same OOM pattern",
};

// ─── Scenario 2: Warden proposes mixed-priority beads ───────────────────────
// Warden found a real bug (P0), a test coverage gap (P2), and docs drift (P3).
// Judicar should approve the P0, defer the rest to P5.

const scenario2_wardenFilter: Scenario = {
  name: "Warden triage — filter P0 bug from P2/P3 polish",
  context: {
    type: "TRIAGE_WARDEN",
    wardenSummary:
      "Audit complete. npm run typecheck passed. npm run test passed (185 tests). " +
      "Found 3 issues: one integration bug where the notification mark-all-read " +
      "endpoint returns { item: { updatedCount } } but the frontend expects a list " +
      "envelope; one test coverage gap in activity filter forwarding; one stale " +
      "ARCHITECTURE.md section.",
    proposedBeads: [
      {
        id: "warden-p0-notif",
        title: "Fix notification mark-all-read envelope mismatch",
        priority: 0,
        description:
          "The web client validates POST /notifications/read-all as a list envelope " +
          "but the API returns { item: { updatedCount } }. This will break in production.",
      },
      {
        id: "warden-p2-activity",
        title: "Add direct route-level tests for activity filter forwarding",
        priority: 2,
        description:
          "Activity filter forwarding is covered through createApp integration tests " +
          "but has no narrow route-level test.",
      },
      {
        id: "warden-p3-docs",
        title: "Update ARCHITECTURE.md persistence inventory",
        priority: 3,
        description:
          "ARCHITECTURE.md still claims in-memory repos are the default. Should " +
          "reflect postgres as the production persistence layer.",
      },
    ],
    currentSlice: "Slice 4: Weekly Planning",
  },
  promptMustInclude: [
    "TRIAGE_WARDEN",
    "mark-all-read",
    "envelope mismatch",
    "filter forwarding",
    "ARCHITECTURE.md",
    "Slice 4",
  ],
  expectedDecision:
    "approve warden-p0-notif at P0, set warden-p2-activity to P5, set warden-p3-docs to P5",
};

// ─── Scenario 3: Bead too large — hit max iterations ────────────────────────
// Agent burned 6M tokens and 150 tool calls trying to convert 12 repos.
// Judicar should split it.

const scenario3_tooLarge: Scenario = {
  name: "Max iterations — bead too large for one session",
  context: {
    type: "TRIAGE_FAILURE",
    beadId: "test-large-bead",
    beadTitle: "Convert all repository interfaces to async and implement postgres backends",
    beadPriority: 0,
    beadLabels: [],
    attemptCount: 1,
    exitCode: 2,
    failureOutput:
      "Error: agent loop exceeded maximum iterations or encountered an unexpected state.\n" +
      "Plan:\n" +
      "- Convert personRepository (done)\n" +
      "- Convert authRepository (done)\n" +
      "- Convert weeklyPlanRepository (in progress)\n" +
      "- Convert weeklyRetroRepository (not started)\n" +
      "- Convert weeklyReviewRepository (not started)\n" +
      "- Convert standupRepository (not started)\n" +
      "- [6 more repositories not started]",
    recentGitLog:
      "abc1234 Fix require-await lint\n" +
      "def5678 Add PostgreSQL infrastructure",
  },
  promptMustInclude: [
    "TRIAGE_FAILURE",
    "EXIT CODE 2",
    "max iterations",
    "12",
    "not started",
  ],
  expectedDecision: "split — bead covers 12 repos, only 2 completed. Split into smaller beads.",
};

// ─── Scenario 4: Slice boundary — broken endpoint ──────────────────────────
// Slice 2 (Programs & Projects) is done, but /programs/:id/projects returns 500.

const scenario4_brokenSlice: Scenario = {
  name: "Slice boundary — critical endpoint returns 500",
  context: {
    type: "TRIAGE_SLICE",
    sliceNumber: 2,
    sliceName: "Programs & Projects",
    acceptanceCriteria:
      "User can view program list, create a program, view program detail with " +
      "projects, create a project within a program. All styled with Tailwind.",
    curlResults:
      "GET /programs?workspaceId=workspace-demo → 200 OK (4 items)\n" +
      "POST /programs → 201 Created\n" +
      "GET /programs/program-foundation → 200 OK\n" +
      "GET /programs/program-foundation/projects?workspaceId=workspace-demo → 500 Internal Server Error\n" +
      "  Error: Expected string column total",
    completedBeads: ["slice2-programs-crud", "slice2-projects-crud", "slice2-program-detail-page"],
  },
  promptMustInclude: [
    "TRIAGE_SLICE",
    "Slice 2",
    "500 Internal Server Error",
    "Expected string column total",
    "proceed to next slice, or fix first",
  ],
  expectedDecision: "fix first — program-projects endpoint returns 500, will break program detail page",
};

// ─── Scenario 5: Slice boundary — all clean ────────────────────────────────

const scenario5_cleanSlice: Scenario = {
  name: "Slice boundary — all acceptance criteria met",
  context: {
    type: "TRIAGE_SLICE",
    sliceNumber: 1,
    sliceName: "Auth & Identity",
    acceptanceCriteria:
      "User can log in with demo credentials, see their name in the nav, log out. " +
      "Login/register links hidden after auth. All styled with Tailwind.",
    curlResults:
      "POST /auth/login {email: ava@demo.ship, password: ava-demo-password} → 200 OK (session created)\n" +
      "GET /health → 200 OK\n" +
      "All acceptance endpoints responding correctly.",
    completedBeads: ["slice1-auth-schema", "slice1-login-page", "slice1-session-nav"],
  },
  promptMustInclude: [
    "TRIAGE_SLICE",
    "Slice 1",
    "200 OK",
    "proceed to next slice",
  ],
  expectedDecision: "proceed — all endpoints healthy, acceptance criteria met",
};

// ─── Scenario 6: Stale bead description ─────────────────────────────────────
// Bead says "add personRepository" but it already exists from a parallel bead.

const scenario6_staleBead: Scenario = {
  name: "Stale bead — work already done by another bead",
  context: {
    type: "TRIAGE_FAILURE",
    beadId: "test-stale-bead",
    beadTitle: "Add in-memory person repository and people routes",
    beadPriority: 2,
    beadLabels: ["phase:4-team-coordination"],
    attemptCount: 1,
    exitCode: 1,
    failureOutput:
      "Escalated (blocked): The bead asks me to create personRepository.ts and " +
      "routes/people.ts, but both files already exist with full implementations " +
      "including seeded data, workspace scoping, and pagination. The person " +
      "repository was already created by bead ship-rebuild-pzf7 in a parallel " +
      "slot. There is nothing to implement.",
    recentGitLog:
      "abc1234 Add shared coordination contracts (ship-rebuild-pzf7)\n" +
      "def5678 Add in-memory people repository (ship-rebuild-y3up)",
  },
  promptMustInclude: [
    "TRIAGE_FAILURE",
    "already exist",
    "nothing to implement",
    "parallel",
  ],
  expectedDecision: "close — work already done by another bead",
};

// ─── Scenario 7: Operational failure (429 rate limit) ───────────────────────

const scenario7_operational: Scenario = {
  name: "Operational failure — API rate limit, not a bead problem",
  context: {
    type: "TRIAGE_FAILURE",
    beadId: "test-429-bead",
    beadTitle: "Add comment repository and generic comment routes",
    beadPriority: 2,
    beadLabels: ["phase:4-team-coordination"],
    attemptCount: 2,
    exitCode: 1,
    failureOutput:
      "Fatal: 429 You exceeded your current quota, please check your plan and " +
      "billing details. For more information on this error, read the docs: " +
      "https://platform.openai.com/docs/guides/error-codes/api-errors.",
    recentGitLog:
      "abc1234 Add standup repository (ship-rebuild-cpn1)\n" +
      "def5678 Resolve merge for activity repos (ship-rebuild-qbz4)",
  },
  promptMustInclude: [
    "TRIAGE_FAILURE",
    "429",
    "quota",
    "Attempt: 2",
  ],
  expectedDecision: "retry — this is an API rate limit, not a bead problem. Reset attempt count.",
};

// ─── Runner ─────────────────────────────────────────────────────────────────

const scenarios: Scenario[] = [
  scenario1_repeatedOOM,
  scenario2_wardenFilter,
  scenario3_tooLarge,
  scenario4_brokenSlice,
  scenario5_cleanSlice,
  scenario6_staleBead,
  scenario7_operational,
];

let passed = 0;
let failed = 0;

for (const scenario of scenarios) {
  const prompt = formatJudicarPrompt(scenario.context);
  const missing = scenario.promptMustInclude.filter((s) => !prompt.includes(s));

  if (missing.length > 0) {
    console.error(`FAIL: ${scenario.name}`);
    console.error(`  Missing from prompt: ${missing.join(", ")}`);
    failed++;
  } else {
    console.log(`PASS: ${scenario.name}`);
    passed++;
  }

  if (LIVE) {
    console.log(`\n--- Judicar prompt for: ${scenario.name} ---`);
    console.log(prompt);
    console.log(`--- Expected decision: ${scenario.expectedDecision} ---\n`);
    // TODO: actually spawn Judicar and verify br state changes
  }
}

console.log(`\n${String(passed)} passed, ${String(failed)} failed out of ${String(scenarios.length)} scenarios`);

if (failed > 0) {
  process.exit(1);
}
