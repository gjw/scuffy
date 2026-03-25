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
  const brOutput = execFileSync("br", ["list", "--json"], {
    cwd: workspaceDir,
    timeout: 10_000,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const beads = JSON.parse(brOutput) as Array<{
    status: string;
    labels: string[] | null;
  }>;
  beadData.total = beads.length;
  beadData.closed = beads.filter((b) => b.status === "closed").length;
  beadData.inProgress = beads.filter((b) => b.status === "in_progress").length;
  beadData.open = beadData.total - beadData.closed - beadData.inProgress;

  // Extract phases
  const phaseMap = new Map<string, { total: number; closed: number }>();
  for (const bead of beads) {
    const labels = bead.labels ?? [];
    for (const label of labels) {
      if (label.startsWith("phase:")) {
        const phase = label;
        const entry = phaseMap.get(phase) ?? { total: 0, closed: 0 };
        entry.total++;
        if (bead.status === "closed") entry.closed++;
        phaseMap.set(phase, entry);
      }
    }
  }
  beadData.phases = [...phaseMap.entries()]
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log(`  ${String(beadData.total)} beads (${String(beadData.closed)} closed, ${String(beadData.open)} open, ${String(beadData.inProgress)} in progress)`);
} catch {
  console.log("  Could not query beads (br not available or beads not initialized)");
}

// Query mermaid graph via bv
console.log("Generating dependency graph...");
let mermaidGraph = "";
try {
  mermaidGraph = execFileSync("bv", ["--robot-graph", "--graph-format=mermaid"], {
    cwd: workspaceDir,
    timeout: 10_000,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
} catch {
  console.log("  Could not generate graph (bv not available)");
}

// Generate HTML
const html = generateDashboard({
  sessions,
  beads: beadData,
  mermaidGraph,
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
