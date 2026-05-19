/**
 * orphan-cleanup.test.mts — verify the pure helpers used by
 * cleanupOrphanedAgentsByPidFiles (UP-789).
 *
 * Run with:
 *   node --experimental-strip-types --test symphony/scripts/orphan-cleanup.test.mts
 *
 * Side effects in poll-tickets.mts (singleton lock, watcher, network) make
 * importing the production module from a test impractical; these helpers live
 * in orphan-cleanup.mts precisely so they can be exercised in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePsOutput,
  findOrphanPidsByWorktreePrefix,
  findNxDaemonPids,
} from './orphan-cleanup.mts';

// ── parsePsOutput ────────────────────────────────────────────────────────────

test('parsePsOutput extracts pid + full command from each row', () => {
  const out = [
    '  1234 /usr/bin/node /Users/x/foo.js',
    '   42 bash /Users/x/run.sh UP-1',
    'header line that should be skipped',
    '',
    '   7 ',
  ].join('\n');
  const rows = parsePsOutput(out);
  assert.deepEqual(rows, [
    { pid: 1234, command: '/usr/bin/node /Users/x/foo.js' },
    { pid: 42, command: 'bash /Users/x/run.sh UP-1' },
    { pid: 7, command: '' },
  ]);
});

// ── findOrphanPidsByWorktreePrefix ───────────────────────────────────────────

test('findOrphanPidsByWorktreePrefix matches by worktree-path substring', () => {
  const rows = [
    { pid: 100, command: 'bash /Users/sun/symphony/scripts/run-ticket.sh UP-1' },
    { pid: 101, command: 'python3 /Users/sun/symphony/scripts/pty-wrapper.py /tmp/x' },
    { pid: 102, command: 'claude --remote-control (cwd=/Users/sun/Documents/claude-home-worktrees/feat-UP-1-foo)' },
    { pid: 103, command: 'node /Users/sun/Documents/workstream-mono-worktrees/feat-WOR-2/foo.js' },
    { pid: 999, command: 'some-unrelated-process' },
  ];
  const prefixes = [
    '/Users/sun/Documents/claude-home-worktrees',
    '/Users/sun/Documents/workstream-mono-worktrees',
  ];

  const orphans = findOrphanPidsByWorktreePrefix(rows, prefixes, new Set());
  assert.deepEqual(orphans.map((r) => r.pid), [102, 103]);
});

test('findOrphanPidsByWorktreePrefix honours the skip set', () => {
  const rows = [
    { pid: 100, command: '/Users/sun/Documents/claude-home-worktrees/feat-UP-1/foo' },
    { pid: 101, command: '/Users/sun/Documents/claude-home-worktrees/feat-UP-2/bar' },
  ];
  const orphans = findOrphanPidsByWorktreePrefix(
    rows,
    ['/Users/sun/Documents/claude-home-worktrees'],
    new Set([100]),
  );
  assert.deepEqual(orphans.map((r) => r.pid), [101]);
});

test('findOrphanPidsByWorktreePrefix returns empty when no prefixes configured', () => {
  const rows = [{ pid: 1, command: 'anything' }];
  assert.deepEqual(findOrphanPidsByWorktreePrefix(rows, [], new Set()), []);
});

test('findOrphanPidsByWorktreePrefix exposes live-agent descendants — callers must filter', () => {
  // Documenting expected contract: the helper itself only skips by exact PID,
  // so live-agent descendants (claude / python / nested tool processes) under
  // the worktree path of a tracked agent will be returned. poll-tickets.mts is
  // responsible for filtering them out via liveAgentWorktreePaths().
  const rows = [
    { pid: 100, command: 'bash /Users/sun/Documents/claude-home-worktrees/feat-UP-789/run-ticket.sh' },
    { pid: 101, command: 'claude --resume xxx (cwd=/Users/sun/Documents/claude-home-worktrees/feat-UP-789)' },
    { pid: 102, command: 'python3 /Users/sun/symphony/scripts/pty-wrapper.py /tmp/x' }, // matches by symphony path
  ];
  // skip only the tracked bash; the claude descendant is intentionally NOT
  // skipped at this layer — and must be excluded by the caller.
  const orphans = findOrphanPidsByWorktreePrefix(
    rows,
    ['/Users/sun/Documents/claude-home-worktrees'],
    new Set([100]),
  );
  assert.deepEqual(orphans.map((r) => r.pid), [101]);
});

// ── findNxDaemonPids ─────────────────────────────────────────────────────────

test('findNxDaemonPids matches node nx.js daemon invocations under configured prefixes', () => {
  const rows = [
    { pid: 200, command: '/usr/local/bin/node /Users/sun/Documents/workstream-mono-worktrees/feat-WOR-1/node_modules/nx/bin/nx.js daemon --start' },
    { pid: 201, command: 'node /Users/sun/Documents/workstream-mono/node_modules/.pnpm/nx@21.0.0/node_modules/nx/bin/nx.js daemon' },
    { pid: 202, command: 'node /Users/x/.nx/cache/run.js' }, // unrelated nx child
    { pid: 203, command: 'bash /tmp/run-ticket.sh' },        // not nx
    { pid: 204, command: '/usr/bin/node /Users/sun/Documents/workstream-mono-worktrees/feat-WOR-2/nx daemon --workers 8' },
    { pid: 205, command: '/usr/bin/node /Users/elsewhere/other-workspace/nx.js daemon' }, // unrelated workspace
  ];
  const prefixes = [
    '/Users/sun/Documents/workstream-mono-worktrees',
    '/Users/sun/Documents/workstream-mono',
  ];
  const pids = findNxDaemonPids(rows, prefixes);
  assert.deepEqual(pids.sort(), [200, 201, 204]);
});

test('findNxDaemonPids skips daemons outside the configured prefixes', () => {
  const rows = [
    { pid: 300, command: '/usr/bin/node /Users/somebody-else/work/node_modules/nx/bin/nx.js daemon' },
  ];
  assert.deepEqual(findNxDaemonPids(rows, ['/Users/sun/Documents/workstream-mono-worktrees']), []);
});

test('findNxDaemonPids with empty prefixes disables scoping (test escape hatch)', () => {
  const rows = [
    { pid: 400, command: '/usr/bin/node /any/path/nx.js daemon' },
  ];
  assert.deepEqual(findNxDaemonPids(rows, []), [400]);
});

test('findNxDaemonPids ignores plain "daemon" or unrelated nx subcommands', () => {
  const rows = [
    { pid: 500, command: 'node /Users/x/nx.js graph' },
    { pid: 501, command: '/usr/sbin/mDNSResponderHelper' },     // contains "daemon"-adjacent words
    { pid: 502, command: 'launchd' },
  ];
  assert.deepEqual(findNxDaemonPids(rows, []), []);
});
