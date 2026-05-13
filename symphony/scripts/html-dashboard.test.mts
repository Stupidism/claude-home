import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildDashboardHtml, sessionUrl, type HtmlRow } from './html-dashboard.mts';

const baseInput = {
  updatedAt: '12:34:56',
  runningAgents: 1,
  maxConcurrent: 3,
  boards: ['WOR'],
  pollIntervalSeconds: 30,
  remoteControl: true,
};

function row(overrides: Partial<HtmlRow> = {}): HtmlRow {
  return {
    identifier: 'WOR-1',
    ticketUrl: 'https://linear.app/team/issue/WOR-1',
    statusLabel: 'Running',
    statusKind: 'running',
    project: 'symphony',
    projectUrl: 'https://linear.app/team/project/symphony',
    repo: 'claude-home',
    repoUrl: 'https://github.com/Stupidism/claude-home',
    summary: 'Add HTML visualizer',
    sessionId: 'abc-123',
    spawnedAtMs: 1700000000000,
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
  const html = buildDashboardHtml({ ...baseInput, rows: [row({ sessionId: null, runtimeLabel: null, spawnedAtMs: null })] });
  assert.doesNotMatch(html, /claude\.ai\/agents/);
});

test('renders session id as plain text when remote control is off', () => {
  const html = buildDashboardHtml({ ...baseInput, remoteControl: false, rows: [row()] });
  assert.doesNotMatch(html, /claude\.ai\/agents/);
  assert.match(html, /class="session-id dim"/);
  assert.match(html, /abc-123/);
});

test('renders project and repo as links when URLs are provided', () => {
  const html = buildDashboardHtml({ ...baseInput, rows: [row()] });
  assert.match(html, /href="https:\/\/linear\.app\/team\/project\/symphony"/);
  assert.match(html, /href="https:\/\/github\.com\/Stupidism\/claude-home"/);
});

test('falls back to plain text for project and repo when URLs are missing', () => {
  const html = buildDashboardHtml({ ...baseInput, rows: [row({ projectUrl: null, repoUrl: null })] });
  assert.doesNotMatch(html, /href="https:\/\/linear\.app\/team\/project/);
  assert.doesNotMatch(html, /href="https:\/\/github\.com\/Stupidism\/claude-home"/);
});

test('embeds a client-side ticker so runtime and countdown update between refreshes', () => {
  const html = buildDashboardHtml({ ...baseInput, rows: [row()] });
  assert.match(html, /data-spawned-at="1700000000000"/);
  assert.match(html, /id="next-poll">30</);
  assert.match(html, /id="updated-at">12:34:56</);
  assert.match(html, /setInterval\(tick, 1000\)/);
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
