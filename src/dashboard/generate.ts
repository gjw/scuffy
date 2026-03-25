import type { SessionSummary } from "./parse.js";

interface BeadSummary {
  total: number;
  open: number;
  closed: number;
  inProgress: number;
  phases: Array<{ name: string; total: number; closed: number }>;
}

interface DashboardData {
  sessions: SessionSummary[];
  beads: BeadSummary;
  mermaidGraph: string;
  generatedAt: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${String(secs)}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${String(mins)}m ${String(remainSecs)}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function outcomeEmoji(outcome: string): string {
  switch (outcome) {
    case "success": return "&#9989;";
    case "escalate": return "&#9888;&#65039;";
    case "budget": return "&#128165;";
    case "crash": return "&#10060;";
    default: return "?";
  }
}

function outcomeClass(outcome: string): string {
  switch (outcome) {
    case "success": return "outcome-success";
    case "escalate": return "outcome-escalate";
    case "budget": return "outcome-budget";
    case "crash": return "outcome-crash";
    default: return "";
  }
}

function renderSessionsTable(sessions: SessionSummary[]): string {
  if (sessions.length === 0) return "<p>No sessions found.</p>";

  const rows = sessions.map((s, i) => {
    const time = s.startTime ? new Date(s.startTime).toLocaleString() : "—";
    const bead = s.beadId ? `${escapeHtml(s.beadId)}<br><small>${escapeHtml(s.beadTitle ?? "")}</small>` : "—";
    const cacheHit = s.tokensIn > 0 ? `${((s.cacheRead / s.tokensIn) * 100).toFixed(0)}%` : "—";
    const escalation = s.escalationMessage ? `<br><small title="${escapeHtml(s.escalationMessage)}">${escapeHtml(s.escalationReason ?? "")}</small>` : "";

    return `<tr>
      <td>${String(i + 1)}</td>
      <td>${time}</td>
      <td>${escapeHtml(s.role)}</td>
      <td>${bead}</td>
      <td>${formatTokens(s.tokensIn)} / ${formatTokens(s.tokensOut)}</td>
      <td>${cacheHit}</td>
      <td>${String(s.toolCalls)}</td>
      <td>${s.errors > 0 ? `<span class="error-count">${String(s.errors)}</span>` : "0"}</td>
      <td>${formatDuration(s.durationMs)}</td>
      <td class="${outcomeClass(s.outcome)}">${outcomeEmoji(s.outcome)} ${s.outcome}${escalation}</td>
    </tr>`;
  });

  return `<table id="sessions-table">
    <thead><tr>
      <th>#</th><th>Time</th><th>Role</th><th>Bead</th>
      <th>Tokens (in/out)</th><th>Cache</th><th>Tools</th>
      <th>Errors</th><th>Duration</th><th>Outcome</th>
    </tr></thead>
    <tbody>${rows.join("\n")}</tbody>
  </table>`;
}

function renderStats(sessions: SessionSummary[]): string {
  const total = sessions.length;
  const successes = sessions.filter((s) => s.outcome === "success").length;
  const totalTokensIn = sessions.reduce((sum, s) => sum + s.tokensIn, 0);
  const totalTokensOut = sessions.reduce((sum, s) => sum + s.tokensOut, 0);
  const totalCacheRead = sessions.reduce((sum, s) => sum + s.cacheRead, 0);
  const avgToolCalls = total > 0 ? Math.round(sessions.reduce((sum, s) => sum + s.toolCalls, 0) / total) : 0;
  const totalDuration = sessions.reduce((sum, s) => sum + s.durationMs, 0);

  return `<div class="stats-grid">
    <div class="stat"><span class="stat-value">${String(total)}</span><span class="stat-label">Sessions</span></div>
    <div class="stat"><span class="stat-value">${total > 0 ? `${((successes / total) * 100).toFixed(0)}%` : "—"}</span><span class="stat-label">Success rate</span></div>
    <div class="stat"><span class="stat-value">${formatTokens(totalTokensIn + totalTokensOut)}</span><span class="stat-label">Total tokens</span></div>
    <div class="stat"><span class="stat-value">${formatTokens(totalCacheRead)}</span><span class="stat-label">Cache reads</span></div>
    <div class="stat"><span class="stat-value">${String(avgToolCalls)}</span><span class="stat-label">Avg tools/session</span></div>
    <div class="stat"><span class="stat-value">${formatDuration(totalDuration)}</span><span class="stat-label">Total runtime</span></div>
  </div>`;
}

function renderBeadSummary(beads: BeadSummary): string {
  const phaseRows = beads.phases.map((p) => {
    const pct = p.total > 0 ? Math.round((p.closed / p.total) * 100) : 0;
    return `<tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${String(p.closed)}/${String(p.total)}</td>
      <td><div class="progress-bar"><div class="progress-fill" style="width:${String(pct)}%"></div></div></td>
    </tr>`;
  });

  return `<div class="bead-summary">
    <div class="stats-grid">
      <div class="stat"><span class="stat-value">${String(beads.total)}</span><span class="stat-label">Total beads</span></div>
      <div class="stat outcome-success"><span class="stat-value">${String(beads.closed)}</span><span class="stat-label">Closed</span></div>
      <div class="stat"><span class="stat-value">${String(beads.open)}</span><span class="stat-label">Open</span></div>
      <div class="stat outcome-escalate"><span class="stat-value">${String(beads.inProgress)}</span><span class="stat-label">In progress</span></div>
    </div>
    ${phaseRows.length > 0 ? `<table class="phase-table"><thead><tr><th>Phase</th><th>Progress</th><th></th></tr></thead><tbody>${phaseRows.join("\n")}</tbody></table>` : ""}
  </div>`;
}

export function generateDashboard(data: DashboardData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scuffy Factory Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
  h1 { color: #58a6ff; margin-bottom: 4px; }
  h2 { color: #8b949e; margin: 24px 0 12px; border-bottom: 1px solid #21262d; padding-bottom: 8px; }
  .generated { color: #484f58; font-size: 12px; margin-bottom: 20px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .stat { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 16px; text-align: center; }
  .stat-value { display: block; font-size: 24px; font-weight: 700; color: #f0f6fc; }
  .stat-label { display: block; font-size: 12px; color: #8b949e; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 13px; }
  th { background: #161b22; color: #8b949e; text-align: left; padding: 8px 10px; border-bottom: 2px solid #21262d; cursor: pointer; user-select: none; }
  th:hover { color: #58a6ff; }
  td { padding: 6px 10px; border-bottom: 1px solid #21262d; vertical-align: top; }
  tr:hover { background: #161b22; }
  .error-count { color: #f85149; font-weight: 700; }
  .outcome-success { color: #3fb950; }
  .outcome-escalate { color: #d29922; }
  .outcome-budget { color: #f85149; }
  .outcome-crash { color: #f85149; }
  .progress-bar { background: #21262d; border-radius: 4px; height: 16px; overflow: hidden; width: 100%; min-width: 120px; }
  .progress-fill { background: #3fb950; height: 100%; transition: width 0.3s; }
  .phase-table { max-width: 500px; }
  .graph-container { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 20px; overflow-x: auto; }
  .mermaid { text-align: center; }
  small { color: #8b949e; }
  a { color: #58a6ff; }
</style>
</head>
<body>
<h1>Scuffy Factory Dashboard</h1>
<p class="generated">Generated ${escapeHtml(data.generatedAt)}</p>

<h2>Cumulative Stats</h2>
${renderStats(data.sessions)}

<h2>Bead Progress</h2>
${renderBeadSummary(data.beads)}

<h2>Dependency Graph</h2>
<div class="graph-container">
  <pre class="mermaid">
${escapeHtml(data.mermaidGraph || "graph LR\n  empty[No graph data]")}
  </pre>
</div>

<h2>Sessions (${String(data.sessions.length)})</h2>
${renderSessionsTable(data.sessions)}

<script>
mermaid.initialize({ startOnLoad: true, theme: 'dark' });

// Sortable table headers
document.querySelectorAll('#sessions-table th').forEach((th, i) => {
  th.addEventListener('click', () => {
    const table = th.closest('table');
    const tbody = table.querySelector('tbody');
    const rows = [...tbody.querySelectorAll('tr')];
    const dir = th.dataset.sort === 'asc' ? 'desc' : 'asc';
    th.dataset.sort = dir;
    rows.sort((a, b) => {
      const aVal = a.children[i].textContent;
      const bVal = b.children[i].textContent;
      const aNum = parseFloat(aVal.replace(/[^0-9.-]/g, ''));
      const bNum = parseFloat(bVal.replace(/[^0-9.-]/g, ''));
      if (!isNaN(aNum) && !isNaN(bNum)) return dir === 'asc' ? aNum - bNum : bNum - aNum;
      return dir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    });
    rows.forEach(r => tbody.appendChild(r));
  });
});
</script>
</body>
</html>`;
}
