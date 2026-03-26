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
    id: string;
    status: string;
    labels: string[] | null;
  }>;
  // Count completions from session data (source of truth for finished work)
  const completedBeadIds = new Set(
    sessions.filter((s) => s.outcome === "success" && s.beadId).map((s) => s.beadId as string),
  );
  // Total = current beads + completed beads that were closed/split by Tower
  const currentIds = new Set(beads.map((b) => b.id));
  const goneButCompleted = [...completedBeadIds].filter((id) => !currentIds.has(id));
  beadData.total = beads.length + goneButCompleted.length;
  beadData.closed = beads.filter((b) => b.status === "closed" || completedBeadIds.has(b.id)).length + goneButCompleted.length;
  beadData.inProgress = beads.filter((b) => b.status === "in_progress" && !completedBeadIds.has(b.id)).length;
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
        if (bead.status === "closed" || completedBeadIds.has(bead.id)) entry.closed++;
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
  const bvOutput = execFileSync("bv", ["--robot-graph", "--graph-format=mermaid"], {
    cwd: workspaceDir,
    timeout: 10_000,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  // bv outputs JSON with graph in a "graph" field — extract it
  try {
    const parsed = JSON.parse(bvOutput) as { graph?: string };
    mermaidGraph = parsed.graph ?? bvOutput;
  } catch {
    mermaidGraph = bvOutput;
  }
} catch {
  console.log("  Could not generate graph (bv not available)");
}

// Group graph nodes by phase using bead labels
if (mermaidGraph && beadData.phases.length > 0) {
  try {
    const brOutput = execFileSync("br", ["list", "--json"], {
      cwd: workspaceDir, timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
    const allBeads = JSON.parse(brOutput) as Array<{ id: string; labels: string[] | null }>;

    // Build phase → bead IDs mapping
    const phaseBeads = new Map<string, string[]>();
    for (const bead of allBeads) {
      for (const label of bead.labels ?? []) {
        if (label.startsWith("phase:")) {
          const list = phaseBeads.get(label) ?? [];
          list.push(bead.id);
          phaseBeads.set(label, list);
        }
      }
    }

    // Inject subgraph blocks after the first line (graph TD)
    const lines = mermaidGraph.split("\n");
    const header = lines[0] ?? "graph TD";
    const classLines = lines.filter((l) => l.trim().startsWith("classDef") || l.trim().startsWith("class "));
    const nodeLines = lines.filter((l) => !l.trim().startsWith("classDef") && !l.trim().startsWith("class ") && l.includes("["));
    const edgeLines = lines.filter((l) => l.includes("==>"));

    const grouped: string[] = [header, ...classLines.filter((l) => l.includes("classDef"))];

    for (const [phase, ids] of [...phaseBeads.entries()].sort()) {
      const idSet = new Set(ids);
      const phaseNodes = nodeLines.filter((l) => {
        const match = /^\s*(\S+)\[/.exec(l);
        return match?.[1] ? idSet.has(match[1]) : false;
      });
      const phaseClasses = classLines.filter((l) => {
        const match = /class\s+(\S+)\s/.exec(l);
        return match?.[1] ? idSet.has(match[1]) : false;
      });
      if (phaseNodes.length > 0) {
        grouped.push(`    subgraph ${phase.replace("phase:", "Phase: ")}`);
        grouped.push(...phaseNodes.map((l) => "    " + l.trim()));
        grouped.push(...phaseClasses.map((l) => "    " + l.trim()));
        grouped.push("    end");
      }
    }

    // Add ungrouped nodes
    const allGroupedIds = new Set([...phaseBeads.values()].flat());
    const ungrouped = nodeLines.filter((l) => {
      const match = /^\s*(\S+)\[/.exec(l);
      return match?.[1] ? !allGroupedIds.has(match[1]) : true;
    });
    if (ungrouped.length > 0) {
      grouped.push(...ungrouped);
    }
    const ungroupedClasses = classLines.filter((l) => {
      const match = /class\s+(\S+)\s/.exec(l);
      return match?.[1] ? !allGroupedIds.has(match[1]) : true;
    });
    grouped.push(...ungroupedClasses);

    grouped.push(...edgeLines);
    mermaidGraph = grouped.join("\n");
  } catch {
    // Fall back to ungrouped graph
  }
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
