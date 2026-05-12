import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildDashboardHtml, sessionUrl, type HtmlRow } from './html-dashboard.mts';

const baseInput = {
  updatedAt: '12:34:56',
  runningAgents: 1,
  maxConcurrent: 3,
  boards: ['WOR'],
  pollIntervalSeconds: 30,
};

function row(overrides: Partial<HtmlRow> = {}): HtmlRow {
  return {
    identifier: 'WOR-1',
    ticketUrl: 'https://linear.app/team/issue/WOR-1',
    statusLabel: 'Running',
    statusKind: 'running',
    project: 'symphony',
    repo: 'claude-home',
    summary: 'Add HTML visualizer',
    sessionId: 'abc-123',
    runtimeLabel: '12s',
    ...overrides,
  };
}

test('sessionUrl points at claude.ai agents', () => {
  assert.equal(sessionUrl('abc-123'), 'https://claude.ai/agents/abc-123');
});

test('renders ticket link, session link, and runtime when an agent is running', () => {
  const html = buildDashboardHtml({ ...baseInput, rows: [row()] });
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /href="https:\/\/linear\.app\/team\/issue\/WOR-1"/);
  assert.match(html, /href="https:\/\/claude\.ai\/agents\/abc-123"/);
  assert.match(html, />WOR-1</);
  assert.match(html, /Running/);
  assert.match(html, /12s/);
});

test('omits the session link when no session id is available', () => {
  const html = buildDashboardHtml({ ...baseInput, rows: [row({ sessionId: null, runtimeLabel: null })] });
  assert.doesNotMatch(html, /claude\.ai\/agents/);
});

test('shows an empty-state row when there are no rows', () => {
  const html = buildDashboardHtml({ ...baseInput, rows: [], runningAgents: 0 });
  assert.match(html, /\(no eligible tickets\)/);
});

test('escapes HTML in summaries, project names, and identifiers', () => {
  const html = buildDashboardHtml({
    ...baseInput,
    rows: [
      row({
        identifier: 'WOR-<2>',
        summary: '<script>alert(1)</script>',
        project: 'a & b',
      }),
    ],
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /a &amp; b/);
  assert.match(html, /WOR-&lt;2&gt;/);
});

test('embeds a meta-refresh so the file auto-reloads', () => {
  const html = buildDashboardHtml({ ...baseInput, rows: [row()] });
  assert.match(html, /<meta http-equiv="refresh" content="30"/);
});
