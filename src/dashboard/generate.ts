import type { SessionSummary } from "./parse.js";

interface BeadSummary {
  total: number;
  open: number;
  closed: number;
  inProgress: number;
  phases: Array<{ name: string; total: number; closed: number }>;
}

export interface DashboardData {
  sessions: SessionSummary[];
  beads: BeadSummary;
  mermaidGraph: string;
  generatedAt: string;
  /** Cost per million tokens (input). Default $2.50 for gpt-5.4. */
  costPerMTokenIn?: number | undefined;
  /** Cost per million tokens (output). Default $10 for gpt-5.4. */
  costPerMTokenOut?: number | undefined;
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

function formatDollars(n: number): string {
  if (n < 0.01) return `<$0.01`;
  return `$${n.toFixed(2)}`;
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

function roleColor(role: string): string {
  if (role.includes("scout")) return "#3fb950";
  if (role.includes("tower")) return "#a371f7";
  if (role.includes("warden")) return "#d29922";
  return "#58a6ff"; // trench / unknown
}

// ─── Session Table ──────────────────────────────────────────────────────────

function renderSessionsTable(sessions: SessionSummary[]): string {
  if (sessions.length === 0) return "<p>No sessions found.</p>";

  const rows = sessions.map((s, i) => {
    const time = s.startTime ? new Date(s.startTime).toLocaleString() : "—";
    const bead = s.beadId ? `${escapeHtml(s.beadId)}<br><small>${escapeHtml(s.beadTitle ?? "")}</small>` : "—";
    const cacheHit = s.tokensIn > 0 ? `${((s.cacheRead / s.tokensIn) * 100).toFixed(0)}%` : "—";
    const escalation = s.escalationMessage
      ? `<br><small title="${escapeHtml(s.escalationMessage)}">${escapeHtml(s.escalationReason ?? "")}</small>`
      : "";

    return `<tr>
      <td>${String(i + 1)}</td>
      <td>${time}</td>
      <td><span class="role-badge" style="border-color:${roleColor(s.role)}">${escapeHtml(s.role)}</span></td>
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

// ─── Stats ───────────────────────────────────────────────────────────────────

function renderStats(sessions: SessionSummary[], costIn: number, costOut: number): string {
  const total = sessions.length;
  const successes = sessions.filter((s) => s.outcome === "success").length;
  const totalTokensIn = sessions.reduce((sum, s) => sum + s.tokensIn, 0);
  const totalTokensOut = sessions.reduce((sum, s) => sum + s.tokensOut, 0);
  const totalCacheRead = sessions.reduce((sum, s) => sum + s.cacheRead, 0);
  const avgToolCalls = total > 0 ? Math.round(sessions.reduce((sum, s) => sum + s.toolCalls, 0) / total) : 0;
  const totalDuration = sessions.reduce((sum, s) => sum + s.durationMs, 0);
  const totalCost = (totalTokensIn / 1_000_000) * costIn + (totalTokensOut / 1_000_000) * costOut;

  return `<div class="stats-grid">
    <div class="stat"><span class="stat-value">${String(total)}</span><span class="stat-label">Sessions</span></div>
    <div class="stat"><span class="stat-value">${total > 0 ? `${((successes / total) * 100).toFixed(0)}%` : "—"}</span><span class="stat-label">Success rate</span></div>
    <div class="stat"><span class="stat-value">${formatTokens(totalTokensIn + totalTokensOut)}</span><span class="stat-label">Total tokens</span></div>
    <div class="stat"><span class="stat-value">${formatTokens(totalCacheRead)}</span><span class="stat-label">Cache reads</span></div>
    <div class="stat"><span class="stat-value">${String(avgToolCalls)}</span><span class="stat-label">Avg tools/session</span></div>
    <div class="stat"><span class="stat-value">${formatDuration(totalDuration)}</span><span class="stat-label">Total runtime</span></div>
    <div class="stat"><span class="stat-value">${formatDollars(totalCost)}</span><span class="stat-label">Est. cost</span></div>
  </div>`;
}

// ─── Bead Summary ────────────────────────────────────────────────────────────

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

// ─── Timeline ────────────────────────────────────────────────────────────────

function renderTimeline(sessions: SessionSummary[]): string {
  const withTime = sessions.filter((s) => s.startTime && s.durationMs > 0);
  if (withTime.length === 0) return "<p>No session timing data available.</p>";

  const first = withTime[0];
  if (!first) return "<p>No session timing data available.</p>";
  const earliest = new Date(first.startTime).getTime();
  const latest = Math.max(
    ...withTime.map((s) => new Date(s.startTime).getTime() + s.durationMs),
  );
  const totalSpan = latest - earliest;
  if (totalSpan <= 0) return "<p>Insufficient timing data.</p>";

  const barHeight = 20;
  const gap = 3;
  const svgHeight = withTime.length * (barHeight + gap) + 40;
  const svgWidth = 900;
  const labelWidth = 100;
  const chartWidth = svgWidth - labelWidth - 20;

  const bars = withTime.map((s, i) => {
    const start = new Date(s.startTime).getTime();
    const x = labelWidth + ((start - earliest) / totalSpan) * chartWidth;
    const w = Math.max(2, (s.durationMs / totalSpan) * chartWidth);
    const y = i * (barHeight + gap) + 30;
    const color = roleColor(s.role);
    const label = s.beadId ? s.beadId.replace(/^ship-rebuild-/, "") : s.role;
    const tooltip = `${s.role} | ${s.beadId ?? "no bead"} | ${formatDuration(s.durationMs)} | ${s.outcome}`;

    return `<g>
      <title>${escapeHtml(tooltip)}</title>
      <rect x="${String(x)}" y="${String(y)}" width="${String(w)}" height="${String(barHeight)}" rx="3" fill="${color}" opacity="0.8"/>
      <text x="${String(x + 4)}" y="${String(y + 14)}" font-size="11" fill="#f0f6fc" pointer-events="none">${escapeHtml(label)}</text>
    </g>`;
  });

  // Time axis labels
  const tickCount = 5;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const t = earliest + (totalSpan * i) / tickCount;
    const x = labelWidth + (i / tickCount) * chartWidth;
    const date = new Date(t);
    const label = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    return `<text x="${String(x)}" y="20" font-size="10" fill="#8b949e" text-anchor="middle">${label}</text>`;
  });

  return `<div class="timeline-container">
    <svg width="100%" viewBox="0 0 ${String(svgWidth)} ${String(svgHeight)}" xmlns="http://www.w3.org/2000/svg">
      ${ticks.join("\n")}
      ${bars.join("\n")}
    </svg>
  </div>
  <div class="timeline-legend">
    <span class="legend-item"><span class="legend-dot" style="background:#58a6ff"></span>Trench</span>
    <span class="legend-item"><span class="legend-dot" style="background:#3fb950"></span>Scout</span>
    <span class="legend-item"><span class="legend-dot" style="background:#a371f7"></span>Tower</span>
    <span class="legend-item"><span class="legend-dot" style="background:#d29922"></span>Warden</span>
  </div>`;
}

// ─── Cost Breakdown ──────────────────────────────────────────────────────────

function renderCostBreakdown(sessions: SessionSummary[], costIn: number, costOut: number): string {
  // Per-bead costs
  const beadCosts = new Map<string, { title: string; tokensIn: number; tokensOut: number; sessions: number }>();
  for (const s of sessions) {
    const key = s.beadId ?? "(no bead)";
    const entry = beadCosts.get(key) ?? { title: s.beadTitle ?? key, tokensIn: 0, tokensOut: 0, sessions: 0 };
    entry.tokensIn += s.tokensIn;
    entry.tokensOut += s.tokensOut;
    entry.sessions++;
    beadCosts.set(key, entry);
  }

  const sorted = [...beadCosts.entries()]
    .map(([id, data]) => ({
      id,
      ...data,
      cost: (data.tokensIn / 1_000_000) * costIn + (data.tokensOut / 1_000_000) * costOut,
    }))
    .sort((a, b) => b.cost - a.cost);

  const rows = sorted.slice(0, 15).map((b) => `<tr>
    <td>${escapeHtml(b.id)}</td>
    <td><small>${escapeHtml(b.title)}</small></td>
    <td>${String(b.sessions)}</td>
    <td>${formatTokens(b.tokensIn + b.tokensOut)}</td>
    <td>${formatDollars(b.cost)}</td>
  </tr>`);

  return `<table>
    <thead><tr><th>Bead</th><th>Title</th><th>Sessions</th><th>Tokens</th><th>Est. cost</th></tr></thead>
    <tbody>${rows.join("\n")}</tbody>
  </table>
  <p><small>Pricing: ${formatDollars(costIn)}/M input, ${formatDollars(costOut)}/M output. Top 15 by cost.</small></p>`;
}

// ─── Error Analysis ──────────────────────────────────────────────────────────

function renderErrorAnalysis(sessions: SessionSummary[]): string {
  // Outcome breakdown
  const outcomes = new Map<string, number>();
  for (const s of sessions) {
    outcomes.set(s.outcome, (outcomes.get(s.outcome) ?? 0) + 1);
  }
  const outcomeRows = [...outcomes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([outcome, count]) => `<tr>
      <td class="${outcomeClass(outcome)}">${outcomeEmoji(outcome)} ${outcome}</td>
      <td>${String(count)}</td>
      <td>${((count / sessions.length) * 100).toFixed(0)}%</td>
    </tr>`);

  // Escalation reasons
  const reasons = new Map<string, number>();
  for (const s of sessions) {
    if (s.escalationReason) {
      reasons.set(s.escalationReason, (reasons.get(s.escalationReason) ?? 0) + 1);
    }
  }
  const reasonRows = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `<tr><td>${escapeHtml(reason)}</td><td>${String(count)}</td></tr>`);

  // Beads with most retries (multiple sessions claiming the same bead)
  const beadAttempts = new Map<string, number>();
  for (const s of sessions) {
    if (s.beadId) {
      beadAttempts.set(s.beadId, (beadAttempts.get(s.beadId) ?? 0) + 1);
    }
  }
  const retryRows = [...beadAttempts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([beadId, count]) => `<tr><td>${escapeHtml(beadId)}</td><td>${String(count)} attempts</td></tr>`);

  return `<div class="error-grid">
    <div>
      <h3>Outcome Breakdown</h3>
      <table><thead><tr><th>Outcome</th><th>Count</th><th>%</th></tr></thead>
      <tbody>${outcomeRows.join("\n")}</tbody></table>
    </div>
    <div>
      <h3>Escalation Reasons</h3>
      ${reasonRows.length > 0 ? `<table><thead><tr><th>Reason</th><th>Count</th></tr></thead><tbody>${reasonRows.join("\n")}</tbody></table>` : "<p>No escalations.</p>"}
    </div>
    <div>
      <h3>Most Retried Beads</h3>
      ${retryRows.length > 0 ? `<table><thead><tr><th>Bead</th><th>Attempts</th></tr></thead><tbody>${retryRows.join("\n")}</tbody></table>` : "<p>No retries.</p>"}
    </div>
  </div>`;
}

// ─── Main Generator ──────────────────────────────────────────────────────────

export function generateDashboard(data: DashboardData): string {
  const costIn = data.costPerMTokenIn ?? 2.50;
  const costOut = data.costPerMTokenOut ?? 10.00;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scuffy Factory Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; max-width: 1200px; margin: 0 auto; }
  h1 { color: #58a6ff; margin-bottom: 4px; }
  h2 { color: #8b949e; margin: 24px 0 12px; border-bottom: 1px solid #21262d; padding-bottom: 8px; }
  h3 { color: #8b949e; margin: 12px 0 8px; font-size: 14px; }
  .generated { color: #484f58; font-size: 12px; margin-bottom: 20px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 16px; }
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
  .timeline-container { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 16px; overflow-x: auto; }
  .timeline-legend { display: flex; gap: 16px; margin-top: 8px; font-size: 12px; color: #8b949e; }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .role-badge { border: 1px solid; border-radius: 4px; padding: 1px 6px; font-size: 11px; }
  .error-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 16px; }
  .error-grid table { font-size: 12px; }
  small { color: #8b949e; }
  a { color: #58a6ff; }
</style>
</head>
<body>
<h1>Scuffy Factory Dashboard</h1>
<p class="generated">Generated ${escapeHtml(data.generatedAt)}</p>

<h2>Cumulative Stats</h2>
${renderStats(data.sessions, costIn, costOut)}

<h2>Timeline</h2>
${renderTimeline(data.sessions)}

<h2>Bead Progress</h2>
${renderBeadSummary(data.beads)}

<h2>Dependency Graph</h2>
<div class="graph-container">
  <pre class="mermaid">
${escapeHtml(data.mermaidGraph || "graph LR\n  empty[No graph data]")}
  </pre>
</div>

<h2>Cost Breakdown</h2>
${renderCostBreakdown(data.sessions, costIn, costOut)}

<h2>Error Analysis</h2>
${renderErrorAnalysis(data.sessions)}

<h2>Sessions (${String(data.sessions.length)})</h2>
${renderSessionsTable(data.sessions)}

<script>
mermaid.initialize({ startOnLoad: true, theme: 'dark' });

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
