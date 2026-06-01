/**
 * Pure helpers used by poll-tickets.mts to reclaim orphaned agent processes
 * after a poller is SIGKILL'd / OOM'd / crashes (UP-789).
 *
 * Kept in a separate module so the heavy import-time side effects in
 * poll-tickets.mts (singleton lock, main loop) don't have to be triggered
 * just to unit-test the pure scan/match logic.
 */

import * as child_process from 'node:child_process';

export type PsRow = { pid: number; command: string };

/**
 * Snapshot every process on the system with its full command line.
 * `-A` = all processes; `-ww` = no column-width truncation (so long worktree
 * paths in argv survive the dump). Errors return an empty list — callers
 * treat "no orphans" as the safe default.
 */
export function snapshotPsByCommand(): PsRow[] {
  try {
    const out = child_process.execSync('ps -A -ww -o pid=,command=', {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return parsePsOutput(out);
  } catch {
    return [];
  }
}

/** Pure for tests — split out from snapshotPsByCommand. */
export function parsePsOutput(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    if (!isNaN(pid)) rows.push({ pid, command: m[2] });
  }
  return rows;
}

/**
 * Pick out PIDs whose command line references any of the given worktree-path
 * prefixes. Skips PIDs in `skipPids` — used to keep the live poller and its
 * tracked agents out of the kill list.
 */
export function findOrphanPidsByWorktreePrefix(
  rows: PsRow[],
  worktreePrefixes: string[],
  skipPids: Set<number>,
): PsRow[] {
  if (worktreePrefixes.length === 0) return [];
  return rows.filter(({ pid, command }) => {
    if (skipPids.has(pid)) return false;
    return worktreePrefixes.some((prefix) => command.includes(prefix));
  });
}

/**
 * Pick out nx daemon processes from a ps snapshot. nx forks the daemon via
 * `node ... nx[.js] daemon` and the daemon calls setsid, so it never shares a
 * PGID with the agent that spawned it — explicit cleanup is the only way to
 * stop them.
 *
 * `scopePrefixes` constrains the match to daemons whose argv references one
 * of the given path prefixes (typically configured worktree / repo dirs).
 * Without scoping, this scan would reap nx daemons belonging to unrelated
 * workspaces the developer happens to have open. Pass `[]` to disable the
 * scope check entirely (only ever appropriate for tests).
 */
export function findNxDaemonPids(
  rows: PsRow[],
  scopePrefixes: string[],
): number[] {
  // Match the nx binary followed by the "daemon" subcommand. Tolerates both
  // `.../nx.js daemon` (Node-script invocation) and `.../nx daemon` (newer
  // direct-binary invocation). The intermediate `[^\n]*` allows for `--start`,
  // `--workers=N`, etc. between the binary and `daemon`.
  const re = /\bnode\b[^\n]*\bnx(\.js)?\b\s+daemon\b/;
  return rows
    .filter(({ command }) => re.test(command))
    .filter(({ command }) =>
      scopePrefixes.length === 0 || scopePrefixes.some((p) => command.includes(p)),
    )
    .map(({ pid }) => pid);
}

/**
 * Identify tracked agents whose child process has already died but whose
 * `exit` handler never fired (e.g. a PTY-wrapper edge case after SIGKILL,
 * UP-826). Such a "phantom" entry otherwise lingers in the runningAgents map
 * forever — it counts against MAX_CONCURRENT (starving Todo claims) and makes
 * the active-state sweep SIGTERM an already-dead PID every poll cycle.
 *
 * Returns the identifiers that should be pruned. Entries whose pid is
 * `undefined` (spawn produced no pid) are skipped — the spawn 'error' handler
 * owns those.
 */
export function findDeadAgentIdentifiers(
  agents: Array<{ identifier: string; pid: number | undefined }>,
  isAlive: (pid: number) => boolean,
): string[] {
  const dead: string[] = [];
  for (const { identifier, pid } of agents) {
    if (pid === undefined) continue;
    if (!isAlive(pid)) dead.push(identifier);
  }
  return dead;
}
