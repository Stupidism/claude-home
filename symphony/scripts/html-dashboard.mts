/**
 * html-dashboard.mts — Render the poller dashboard as a self-contained HTML document.
 *
 * Pure render code lives here so it can be unit-tested without booting the poller.
 * `poll-tickets.mts` builds an `HtmlRow[]` from its in-memory state and pipes it through
 * `buildDashboardHtml`, then writes the result to a temp file on every tick when
 * the `--html` flag is set.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type HtmlStatusKind =
  | 'running'
  | 'merging'
  | 'inProgress'
  | 'humanReview'
  | 'rework'
  | 'todo'
  | 'blocked';

export interface HtmlRow {
  identifier: string;
  ticketUrl: string;
  statusLabel: string;
  statusKind: HtmlStatusKind;
  project: string;
  repo: string;
  summary: string;
  sessionId: string | null;
  runtimeLabel: string | null;
}

export interface HtmlDashboardInput {
  rows: HtmlRow[];
  updatedAt: string;
  runningAgents: number;
  maxConcurrent: number;
  boards: string[];
  pollIntervalSeconds: number;
}

/**
 * Claude Code remote-control sessions appear at this URL on claude.ai.
 * Exposed so the test suite can pin the format and the poll script can reuse it.
 */
export function sessionUrl(sessionId: string): string {
  return `https://claude.ai/agents/${sessionId}`;
}

/**
 * Read `.claude-session-id` from a worktree. Returns null when the file is missing
 * or empty — agents that haven't booted yet do not have a session id.
 */
export function readSessionId(worktreePath: string): string | null {
  try {
    const f = path.join(worktreePath, '.claude-session-id');
    if (!fs.existsSync(f)) return null;
    const id = fs.readFileSync(f, 'utf8').trim();
    return id || null;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}

function renderRow(row: HtmlRow): string {
  const statusInner = row.runtimeLabel
    ? `${escapeHtml(row.statusLabel)} <span class="dim">${escapeHtml(row.runtimeLabel)}</span>`
    : escapeHtml(row.statusLabel);

  const session = row.sessionId
    ? `<a class="session" href="${escapeHtml(sessionUrl(row.sessionId))}" target="_blank" rel="noopener">▶ open</a>`
    : '<span class="dim">—</span>';

  const ticket = row.ticketUrl
    ? `<a class="ticket" href="${escapeHtml(row.ticketUrl)}" target="_blank" rel="noopener">${escapeHtml(row.identifier)}</a>`
    : escapeHtml(row.identifier);

  return `      <tr data-status="${escapeHtml(row.statusKind)}">
        <td class="id">${ticket}</td>
        <td class="status status-${escapeHtml(row.statusKind)}">${statusInner}</td>
        <td>${escapeHtml(row.project)}</td>
        <td>${escapeHtml(row.repo)}</td>
        <td class="summary">${escapeHtml(row.summary)}</td>
        <td>${session}</td>
      </tr>`;
}

export function buildDashboardHtml(input: HtmlDashboardInput): string {
  const rowsHtml = input.rows.length
    ? input.rows.map(renderRow).join('\n')
    : `      <tr><td colspan="6" class="dim center">(no eligible tickets)</td></tr>`;

  const meta = [
    `Updated ${escapeHtml(input.updatedAt)}`,
    `agents ${input.runningAgents}/${input.maxConcurrent}`,
    `boards: ${escapeHtml(input.boards.join(', '))}`,
    `next poll in ${input.pollIntervalSeconds}s`,
  ].join('  •  ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="refresh" content="${Math.max(1, input.pollIntervalSeconds)}" />
<title>Symphony Poller — ${escapeHtml(input.boards.join(', '))}</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0d1117;
    --bg-alt: #161b22;
    --fg: #e6edf3;
    --fg-dim: #8b949e;
    --border: #30363d;
    --accent: #58a6ff;
    --green: #3fb950;
    --magenta: #d2a8ff;
    --red: #f85149;
    --yellow: #d29922;
    --cyan: #79c0ff;
  }
  body { background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "SF Mono", Menlo, monospace; margin: 24px; }
  h1 { font-size: 16px; margin: 0 0 12px; font-weight: 600; color: var(--fg); }
  .meta { color: var(--fg-dim); font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; background: var(--bg-alt); border: 1px solid var(--border); }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { background: #1c2128; font-weight: 600; color: var(--fg); text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
  tr:last-child td { border-bottom: none; }
  tr:hover { background: #1c2128; }
  td.id { font-weight: 600; }
  td.summary { color: var(--fg-dim); max-width: 480px; }
  a.ticket { color: var(--accent); text-decoration: none; }
  a.ticket:hover { text-decoration: underline; }
  a.session { color: var(--green); text-decoration: none; font-weight: 500; }
  a.session:hover { text-decoration: underline; }
  .dim { color: var(--fg-dim); }
  .center { text-align: center; }
  .status-running { color: var(--cyan); }
  .status-merging { color: var(--magenta); }
  .status-inProgress { color: var(--cyan); }
  .status-humanReview { color: var(--magenta); }
  .status-rework { color: var(--red); }
  .status-todo { color: var(--yellow); }
  .status-blocked { color: var(--fg-dim); }
</style>
</head>
<body>
  <h1>Symphony Poller — ${escapeHtml(input.boards.join(', '))}</h1>
  <div class="meta">${meta}</div>
  <table>
    <thead>
      <tr>
        <th>Ticket</th>
        <th>Status</th>
        <th>Project</th>
        <th>Repo</th>
        <th>Summary</th>
        <th>Session</th>
      </tr>
    </thead>
    <tbody>
${rowsHtml}
    </tbody>
  </table>
</body>
</html>
`;
}
