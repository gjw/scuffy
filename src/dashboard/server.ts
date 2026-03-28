/**
 * Live dashboard server.
 *
 * Serves the factory dashboard with auto-refresh. Watches the workspace
 * for new session files and pushes updates to connected clients.
 *
 * Usage: npx tsx src/dashboard/server.ts [workspace-dir] [--port N]
 */

import { execFileSync } from "node:child_process";
import { watch } from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { parseAllSessions, type SessionSummary } from "./parse.js";
import { generateDashboard, type DashboardData } from "./generate.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let workspaceDir = "workspace/ship-rebuild";
let port = 3001;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--port" && i + 1 < args.length) {
    i++;
    port = Number(args[i]);
  } else if (arg && !arg.startsWith("--")) {
    workspaceDir = arg;
  }
}
workspaceDir = path.resolve(workspaceDir);

// ─── Data fetching ───────────────────────────────────────────────────────────

function fetchBeadData(_sessions: SessionSummary[]): DashboardData["beads"] {
  const beadData = { total: 0, open: 0, closed: 0, inProgress: 0, phases: [] as Array<{ name: string; total: number; closed: number }> };
  try {
    const openOutput = execFileSync("br", ["list", "--json", "--limit", "0"], {
      cwd: workspaceDir, timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
    const closedOutput = execFileSync("br", ["list", "--status=closed", "--json", "--limit", "0"], {
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
    const openBeads = (openParsed ?? []) as Array<{ id: string; status: string; labels: string[] | null }>;
    const closedBeads = (closedParsed ?? []) as Array<{ id: string; status: string; labels: string[] | null }>;
    const allBeads = [...openBeads, ...closedBeads];

    beadData.total = allBeads.length;
    beadData.closed = closedBeads.length;
    beadData.inProgress = openBeads.filter((b) => b.status === "in_progress").length;
    beadData.open = openBeads.filter((b) => b.status === "open").length;

    const phaseMap = new Map<string, { total: number; closed: number }>();
    for (const bead of allBeads) {
      const labels = bead.labels ?? [];
      const phaseLabel = labels.find((l: string) => l.startsWith("phase:"));
      if (phaseLabel) {
        const entry = phaseMap.get(phaseLabel) ?? { total: 0, closed: 0 };
        entry.total++;
        if (bead.status === "closed") entry.closed++;
        phaseMap.set(phaseLabel, entry);
      } else {
        const isWarden = labels.includes("warden");
        const bucket = isWarden ? "warden fixes" : "maintenance";
        const entry = phaseMap.get(bucket) ?? { total: 0, closed: 0 };
        entry.total++;
        if (bead.status === "closed") entry.closed++;
        phaseMap.set(bucket, entry);
      }
    }
    beadData.phases = [...phaseMap.entries()].map(([name, data]) => ({ name, ...data })).sort((a, b) => a.name.localeCompare(b.name));
  } catch { /* ignore */ }
  return beadData;
}

function fetchMermaidGraph(): string {
  try {
    const raw = execFileSync("bv", ["--robot-graph", "--graph-format=mermaid"], {
      cwd: workspaceDir, timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    try {
      const parsed = JSON.parse(raw) as { graph?: string };
      return parsed.graph ?? raw;
    } catch {
      return raw;
    }
  } catch {
    return "";
  }
}

function buildDashboardData(): { data: DashboardData; sessions: SessionSummary[] } {
  const sessions = parseAllSessions(workspaceDir);
  const data: DashboardData = {
    sessions,
    beads: fetchBeadData(sessions),
    mermaidGraph: fetchMermaidGraph(),
    generatedAt: new Date().toISOString(),
  };
  return { data, sessions };
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/dashboard") {
    const { data } = buildDashboardData();
    // Inject auto-refresh script
    let html = generateDashboard(data);
    html = html.replace("</body>", `
<script>
  // Auto-refresh every 15 seconds
  setTimeout(() => location.reload(), 15000);

  // WebSocket for instant refresh on new session
  const wsUrl = "ws://" + location.host + "/ws";
  let ws;
  function connectWs() {
    ws = new WebSocket(wsUrl);
    ws.onmessage = (e) => {
      if (e.data === "refresh") location.reload();
    };
    ws.onclose = () => setTimeout(connectWs, 3000);
  }
  connectWs();
</script>
</body>`);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.url === "/api/sessions") {
    const sessions = parseAllSessions(workspaceDir);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(sessions));
    return;
  }

  if (req.url === "/api/beads") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const beadSessions = parseAllSessions(workspaceDir);
    res.end(JSON.stringify(fetchBeadData(beadSessions)));
    return;
  }

  if (req.url === "/api/graph") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(fetchMermaidGraph());
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ─── WebSocket ───────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

function notifyClients(): void {
  for (const ws of clients) {
    try { ws.send("refresh"); } catch { /* ignore dead sockets */ }
  }
}

// ─── File watcher ────────────────────────────────────────────────────────────

const sessionsDir = path.join(workspaceDir, ".scuffy", "sessions");
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

try {
  watch(sessionsDir, { recursive: false }, () => {
    // Debounce — sessions write many events rapidly
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      notifyClients();
    }, 2000);
  });
} catch {
  console.log(`Warning: could not watch ${sessionsDir} — auto-refresh will use polling only`);
}

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(port, () => {
  console.log(`Dashboard live at http://localhost:${String(port)}/dashboard`);
  console.log(`Workspace: ${workspaceDir}`);
  console.log(`API: /api/sessions, /api/beads, /api/graph`);
  console.log(`WebSocket: ws://localhost:${String(port)}/ws`);
});
