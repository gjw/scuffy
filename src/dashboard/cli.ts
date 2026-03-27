/**
 * Dashboard CLI — parse sessions + beads, generate HTML, write to disk.
 *
 * Usage: npx tsx src/dashboard/cli.ts [workspace-dir]
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseAllSessions } from "./parse.js";
import { generateDashboard } from "./generate.js";

const workspaceDir = path.resolve(process.argv[2] ?? "workspace/ship-rebuild");

console.log(`Parsing sessions from ${workspaceDir}...`);
const sessions = parseAllSessions(workspaceDir);
console.log(`  Found ${String(sessions.length)} sessions`);

// Query beads via br
console.log("Querying beads...");
const beadData = { total: 0, open: 0, closed: 0, inProgress: 0, phases: [] as Array<{ name: string; total: number; closed: number }> };
try {
  // Query both open and closed beads for accurate counts
  const openOutput = execFileSync("br", ["list", "--json"], {
    cwd: workspaceDir, timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
  });
  const closedOutput = execFileSync("br", ["list", "--status=closed", "--json"], {
    cwd: workspaceDir, timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
  });

  let openParsed: unknown = JSON.parse(openOutput);
  if (typeof openParsed === "object" && openParsed !== null && !Array.isArray(openParsed) && "issues" in openParsed) {
    openParsed = (openParsed as Record<string, unknown>)["issues"];
  }
  let closedParsed: unknown = JSON.parse(closedOutput);
  if (typeof closedParsed === "object" && closedParsed !== null && !Array.isArray(closedParsed) && "issues" in closedParsed) {
    closedParsed = (closedParsed as Record<string, unknown>)["issues"];
  }
  const openBeads = openParsed as Array<{ id: string; status: string; labels: string[] | null }>;
  const closedBeads = closedParsed as Array<{ id: string; status: string; labels: string[] | null }>;
  const allBeads = [...openBeads, ...closedBeads];

  beadData.total = allBeads.length;
  beadData.closed = closedBeads.length;
  beadData.inProgress = openBeads.filter((b) => b.status === "in_progress").length;
  beadData.open = openBeads.filter((b) => b.status === "open").length;

  // Extract phases from ALL beads (open + closed)
  // Beads without phase labels go into "warden" or "fixes" buckets
  const phaseMap = new Map<string, { total: number; closed: number }>();
  for (const bead of allBeads) {
    const labels = bead.labels ?? [];
    const phaseLabel = labels.find((l) => l.startsWith("phase:"));
    if (phaseLabel) {
      const entry = phaseMap.get(phaseLabel) ?? { total: 0, closed: 0 };
      entry.total++;
      if (bead.status === "closed") entry.closed++;
      phaseMap.set(phaseLabel, entry);
    } else {
      // No phase label — bucket by type
      const isWarden = labels.includes("warden");
      const bucket = isWarden ? "warden fixes" : "maintenance";
      const entry = phaseMap.get(bucket) ?? { total: 0, closed: 0 };
      entry.total++;
      if (bead.status === "closed") entry.closed++;
      phaseMap.set(bucket, entry);
    }
  }
  beadData.phases = [...phaseMap.entries()]
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log(`  ${String(beadData.total)} beads (${String(beadData.closed)} closed, ${String(beadData.open)} open, ${String(beadData.inProgress)} in progress)`);
} catch {
  console.log("  Could not query beads (br not available or beads not initialized)");
}

// Generate per-phase dependency SVGs via bv --export-graph
console.log("Generating phase graphs...");
import { readFileSync as readFileSyncFs } from "node:fs";
import { tmpdir } from "node:os";
import type { PhaseGraph } from "./generate.js";

const phaseGraphs: PhaseGraph[] = [];
const phaseLabels = beadData.phases
  .map((p) => p.name)
  .filter((n) => n.startsWith("phase:"))
  .sort();

// Determine current phase (lowest-numbered with open beads)
const currentPhase = phaseLabels.find((label) => {
  const phase = beadData.phases.find((p) => p.name === label);
  return phase && phase.closed < phase.total;
}) ?? phaseLabels[0] ?? null;

for (const label of phaseLabels) {
  const svgPath = path.join(tmpdir(), `bv-phase-${label.replace(/[^a-z0-9-]/gi, "_")}.svg`);
  try {
    execFileSync("bv", ["--export-graph", svgPath, "--label", label], {
      cwd: workspaceDir, timeout: 15_000, stdio: ["pipe", "pipe", "pipe"],
    });
    const svg = readFileSyncFs(svgPath, "utf-8");
    const nodeMatch = /(\d+) nodes/.exec(
      execFileSync("bv", ["--export-graph", svgPath, "--label", label], {
        cwd: workspaceDir, timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    phaseGraphs.push({
      label,
      svg,
      nodeCount: nodeMatch ? Number(nodeMatch[1]) : 0,
      isCurrent: label === currentPhase,
    });
    console.log(`  ${label}: OK`);
  } catch {
    console.log(`  ${label}: no graph`);
  }
}

// Fallback mermaid for unlabeled beads
let mermaidGraph = "";

// Generate HTML
const html = generateDashboard({
  sessions,
  beads: beadData,
  mermaidGraph,
  phaseGraphs: phaseGraphs.length > 0 ? phaseGraphs : undefined,
  generatedAt: new Date().toISOString(),
});

const outputPath = path.join(workspaceDir, "dashboard.html");
writeFileSync(outputPath, html);
console.log(`\nDashboard written to ${outputPath}`);

// Open in browser on macOS
try {
  execFileSync("open", [outputPath]);
} catch {
  console.log("Open the file in your browser manually.");
}
