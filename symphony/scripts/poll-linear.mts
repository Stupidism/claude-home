#!/usr/bin/env node --experimental-strip-types
/**
 * poll-linear.mts — Poll all configured boards for eligible tickets and run Claude Code agents
 *
 * Reads config from ~/.claude/symphony/config/symphony.json and config/boards/*.json
 * Secrets from ~/.claude/symphony/secrets.env (gitignored)
 *
 * Usage:
 *   node --experimental-strip-types ~/.claude/symphony/scripts/poll-linear.mts
 *   node --experimental-strip-types ~/.claude/symphony/scripts/poll-linear.mts --dry-run
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as child_process from 'node:child_process';
import * as readline from 'node:readline';
import chalk from 'chalk';
import Table from 'cli-table3';

// ── Paths ─────────────────────────────────────────────────────────────────────

const SYMPHONY_ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG_DIR = path.join(SYMPHONY_ROOT, 'config');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Config types ──────────────────────────────────────────────────────────────

interface RepoConfig {
  name: string;
  path: string;
  worktreesDir: string;
  defaultBranch: string;
  github: string;
  isMono: boolean;
  setup: {
    symlinkNodeModules: boolean;
    installCommand: string;
    installCheck: string;
  };
}

interface ProjectConfig {
  linearProjectId: string;
  name: string;
  primaryRepo: string;
  repos: Array<{ name: string; path: string }>;
}

interface BoardConfig {
  teamId: string;
  name: string;
  ticketPrefix: string;
  ticketSystem: string;
  /** Optional comment to post on a PR to trigger an external AI review bot.
   *  When set, the poller posts this comment instead of having Claude review the diff itself.
   *  If absent, AI review is skipped entirely for this board. */
  'code-review-comment'?: string;
  states: {
    backlog: string;
    todo: string;
    inProgress: string;
    humanReview: string;
    inReview: string;
    rework: string;
    merging: string;
    done: string;
  };
  defaultRepo: string;
  repos: RepoConfig[];
  projects: ProjectConfig[];
}

interface SymphonyConfig {
  assigneeId: string;
  maxConcurrent: number;
  pollIntervalSeconds: number;
  remoteControl: boolean;
  preferences: {
    personalLanguage: string;
    workLanguage: string;
    neverUseLanguage: string;
  };
}

// ── Load config ───────────────────────────────────────────────────────────────

function loadSecrets(): void {
  const secretsFile = path.join(SYMPHONY_ROOT, 'secrets.env');
  if (!fs.existsSync(secretsFile)) return;
  for (const line of fs.readFileSync(secretsFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadSecrets();

const LINEAR_API_KEY = process.env['LINEAR_API_KEY'] ?? '';
if (!LINEAR_API_KEY) {
  console.error(chalk.red('ERROR: LINEAR_API_KEY not set in ~/.claude/symphony/secrets.env'));
  process.exit(1);
}

const symphonyConfig: SymphonyConfig = JSON.parse(
  fs.readFileSync(path.join(CONFIG_DIR, 'symphony.json'), 'utf8')
);

const boards: BoardConfig[] = fs
  .readdirSync(path.join(CONFIG_DIR, 'boards'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'boards', f), 'utf8')));

// Build lookup: linearProjectId → { project, repo }
interface ProjectResolvedConfig {
  project: ProjectConfig;
  primaryRepo: RepoConfig;
  board: BoardConfig;
}

const projectMap = new Map<string, ProjectResolvedConfig>();
for (const board of boards) {
  const repoMap = new Map<string, RepoConfig>(board.repos.map((r) => [r.name, r]));
  for (const project of board.projects) {
    const primaryRepo = repoMap.get(project.primaryRepo);
    if (!primaryRepo) {
      console.warn(chalk.yellow(`[config] Project "${project.name}" references unknown repo "${project.primaryRepo}" in board "${board.name}"`));
      continue;
    }
    projectMap.set(project.linearProjectId, { project, primaryRepo, board });
  }
}

const MAX_CONCURRENT = symphonyConfig.maxConcurrent;
const POLL_INTERVAL_MS = symphonyConfig.pollIntervalSeconds * 1000;
const REMOTE_CONTROL = symphonyConfig.remoteControl;
const ASSIGNEE_ID = symphonyConfig.assigneeId;

// ── Linear API ────────────────────────────────────────────────────────────────

interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  project: { id: string; name: string } | null;
  state: { id: string; name: string };
  assignee: { id: string; name: string } | null;
}

async function linearQuery<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: LINEAR_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join(', '));
  return json.data;
}

async function fetchTicketsByState(teamId: string, stateId: string): Promise<Issue[]> {
  const filter: Record<string, unknown> = { state: { id: { eq: stateId } } };
  if (ASSIGNEE_ID) filter['assignee'] = { id: { eq: ASSIGNEE_ID } };

  const data = await linearQuery<{ team: { issues: { nodes: Issue[] } } }>(
    `query GetTickets($teamId: String!, $filter: IssueFilter) {
      team(id: $teamId) {
        issues(filter: $filter, orderBy: createdAt, first: 50) {
          nodes { id identifier title description url
            state { id name }
            assignee { id name }
            project { id name }
          }
        }
      }
    }`,
    { teamId, filter }
  );
  return data.team.issues.nodes;
}

async function fetchTicketStateId(board: BoardConfig, identifier: string): Promise<string | null> {
  const data = await linearQuery<{ team: { issues: { nodes: { state: { id: string } }[] } } }>(
    `query GetTicketState($teamId: String!, $identifier: String!) {
      team(id: $teamId) {
        issues(filter: { identifier: { eq: $identifier } }, first: 1) {
          nodes { state { id name } }
        }
      }
    }`,
    { teamId: board.teamId, identifier }
  );
  return data.team.issues.nodes[0]?.state?.id ?? null;
}

async function fetchTicketByIdentifier(board: BoardConfig, identifier: string): Promise<Issue | null> {
  const data = await linearQuery<{ team: { issues: { nodes: Issue[] } } }>(
    `query GetTicketByIdentifier($teamId: String!, $identifier: String!) {
      team(id: $teamId) {
        issues(filter: { identifier: { eq: $identifier } }, first: 1) {
          nodes {
            id identifier title description url
            state { id name }
            assignee { id name }
            project { id name }
          }
        }
      }
    }`,
    { teamId: board.teamId, identifier }
  );
  return data.team.issues.nodes[0] ?? null;
}

// ── Resolve ticket → repo ─────────────────────────────────────────────────────

function resolveRepo(ticket: Issue, board: BoardConfig): RepoConfig {
  const repoMap = new Map<string, RepoConfig>(board.repos.map((r) => [r.name, r]));
  if (ticket.project) {
    const resolved = projectMap.get(ticket.project.id);
    if (resolved) return resolved.primaryRepo;
  }
  return repoMap.get(board.defaultRepo) ?? board.repos[0];
}

function resolveProjectPath(ticket: Issue, board: BoardConfig): string {
  if (ticket.project) {
    const resolved = projectMap.get(ticket.project.id);
    if (resolved?.project.repos[0]?.path) {
      return resolved.project.repos[0].path.replace(/^~/, process.env['HOME'] ?? '~');
    }
  }
  return '';
}

function isEligible(ticket: Issue, board: BoardConfig): boolean {
  // A ticket is eligible if its project is in the board's projects list,
  // OR if it has no project (falls back to defaultRepo)
  if (!ticket.project) return true;
  return board.projects.some((p) => p.linearProjectId === ticket.project!.id);
}

// ── Linear mutations ──────────────────────────────────────────────────────────

async function moveToState(board: BoardConfig, issueId: string, identifier: string, stateKey: keyof BoardConfig['states'], label: string, color: (s: string) => string): Promise<void> {
  await linearQuery(
    `mutation UpdateState($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`,
    { id: issueId, stateId: board.states[stateKey] }
  );
  log(color(`[symphony] ${identifier} → ${label}`));
}

const moveToInProgress = (b: BoardConfig, id: string, ident: string) =>
  moveToState(b, id, ident, 'inProgress', 'In Progress', chalk.cyan);
const moveToHumanReview = (b: BoardConfig, id: string, ident: string) =>
  moveToState(b, id, ident, 'humanReview', 'Human Review', chalk.magenta);
const moveToDone = (b: BoardConfig, id: string, ident: string) =>
  moveToState(b, id, ident, 'done', 'Done ✓', chalk.green);
const moveToInReview = (b: BoardConfig, id: string, ident: string) =>
  moveToState(b, id, ident, 'inReview', 'In Review', chalk.blue);
const moveToTodo = (b: BoardConfig, id: string, ident: string) =>
  moveToState(b, id, ident, 'todo', 'Todo (reset from Rework)', chalk.cyan);

/**
 * Handle a Rework ticket: close the old PR, delete the Linear workpad comment,
 * remove the local worktree, then move the ticket back to Todo.
 * The next poll cycle will pick it up as a normal Todo ticket and spawn fresh.
 */
async function resetReworkTicket(issue: Issue, board: BoardConfig): Promise<void> {
  const { identifier } = issue;
  log(chalk.red(`[${timestamp()}] ↩ Rework: resetting ${chalk.bold(identifier)}`));

  const repo = resolveRepo(issue, board);
  const repoPath = repo.path.replace(/^~/, process.env['HOME'] ?? '~');
  const worktreesDir = repo.worktreesDir.replace(/^~/, process.env['HOME'] ?? '~');
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/-$/, '');
  const branch = `feat/${identifier}-${slug}`;
  const worktreePath = path.join(worktreesDir, branch.replace(/\//g, '--'));

  // 1. Close the open PR (best-effort)
  try {
    const listResult = child_process.spawnSync(
      'gh', ['pr', 'list', '--head', branch, '--json', 'number', '--jq', '.[0].number'],
      { encoding: 'utf8', cwd: repoPath }
    );
    if (listResult.status !== 0) {
      log(chalk.yellow(`[symphony] gh pr list failed for ${identifier}: ${listResult.stderr?.trim() || 'unknown error'}`));
    }
    const prNumber = listResult.stdout.trim();
    if (prNumber && prNumber !== 'null') {
      const closeResult = child_process.spawnSync('gh', ['pr', 'close', prNumber, '--delete-branch'], { encoding: 'utf8', cwd: repoPath });
      if (closeResult.status === 0) {
        log(chalk.dim(`[symphony] Closed PR #${prNumber} for ${identifier}`));
      } else {
        log(chalk.yellow(`[symphony] Failed to close PR #${prNumber} for ${identifier}: ${closeResult.stderr?.trim()}`));
      }
    }
  } catch { /* best-effort */ }

  // 2. Delete stale lock comments + workpad on Linear (best-effort)
  try {
    const data = await linearQuery<{ issue: { comments: { nodes: { id: string; body: string }[] } } }>(
      `query GetComments($id: String!) { issue(id: $id) { comments { nodes { id body } } } }`,
      { id: issue.id }
    );
    const staleComments = data.issue.comments.nodes.filter((c) =>
      c.body.includes('## Claude Workpad') ||
      c.body.startsWith('[symphony] aiReviewRequested:') ||
      c.body.startsWith('[symphony] developerApproved:')
    );
    await Promise.all(
      staleComments.map((c) =>
        linearQuery(`mutation DeleteComment($id: String!) { commentDelete(id: $id) { success } }`, { id: c.id })
      )
    );
    if (staleComments.length) {
      log(chalk.dim(`[symphony] Deleted ${staleComments.length} stale comment(s) for ${identifier}`));
    }
  } catch { /* best-effort */ }

  // 3. Remove local worktree (best-effort)
  try {
    if (fs.existsSync(worktreePath)) {
      const removeResult = child_process.spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { encoding: 'utf8', cwd: repoPath });
      if (removeResult.status === 0) {
        child_process.spawnSync('git', ['worktree', 'prune'], { encoding: 'utf8', cwd: repoPath });
        log(chalk.dim(`[symphony] Removed worktree for ${identifier}`));
      } else {
        log(chalk.yellow(`[symphony] Failed to remove worktree for ${identifier}: ${removeResult.stderr?.trim()}`));
      }
    }
  } catch { /* best-effort */ }

  // 4. Move ticket back to Todo — next poll cycle picks it up fresh
  await moveToTodo(board, issue.id, identifier);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

interface AgentEntry {
  proc: child_process.ChildProcess;
  project: string;
  issueId: string;
  boardName: string;
  ticket: Issue;
  spawnedAt: number;
  spawnedForMerging: boolean;
  worktreePath: string;
  board: BoardConfig;
}

const runningAgents = new Map<string, AgentEntry>();
let isShuttingDown = false;
let lastDashboardLines = 0;
let lastEligibleAll: { ticket: Issue; board: BoardConfig }[] = [];
let lastBlockedAll: { ticket: Issue; board: BoardConfig }[] = [];

function buildDashboard(updatedAt: string): string {
  const stats = new Map<string, { todo: string[]; running: string[]; board: string }>();

  const getOrCreate = (name: string, boardName: string) => {
    if (!stats.has(name)) stats.set(name, { todo: [], running: [], board: boardName });
    return stats.get(name)!;
  };

  for (const { ticket, board } of lastEligibleAll) {
    const name = ticket.project?.name ?? '(no project)';
    const row = getOrCreate(name, board.name);
    if (runningAgents.has(ticket.identifier)) {
      row.running.push(ticket.identifier);
    } else {
      row.todo.push(ticket.identifier);
    }
  }

  for (const [id, { project, boardName }] of runningAgents) {
    const row = getOrCreate(project, boardName);
    if (!row.running.includes(id)) row.running.push(id);
  }

  const table = new Table({
    head: [chalk.bold.white('Project'), chalk.bold.dim('Board'), chalk.bold.yellow('Todo'), chalk.bold.cyan('Running')],
    colWidths: [26, 14, 20, 20],
    style: { head: [], border: ['gray'] },
  });

  for (const [project, { todo, running, board }] of stats) {
    table.push([
      project,
      chalk.dim(board),
      todo.length ? chalk.yellow(`${todo.length}  `) + chalk.dim(`(${todo.join(', ')})`) : chalk.dim('—'),
      running.length ? chalk.cyan(`${running.length}  `) + chalk.dim(`(${running.join(', ')})`) : chalk.dim('—'),
    ]);
  }

  if (!stats.size) table.push([chalk.dim('(none)'), chalk.dim('—'), chalk.dim('—'), chalk.dim('—')]);

  let out = table.toString();

  if (lastBlockedAll.length) {
    const grouped = new Map<string, number>();
    for (const { ticket } of lastBlockedAll) {
      const k = ticket.project?.name ?? '(no project)';
      grouped.set(k, (grouped.get(k) ?? 0) + 1);
    }
    const summary = [...grouped.entries()].map(([n, c]) => `${n}×${c}`).join(', ');
    out += `\n  ${chalk.dim(`Not eligible: ${chalk.yellow(lastBlockedAll.length)} (${summary})`)}`;
  }

  out += `\n  ${chalk.dim(`Updated ${updatedAt}  •  agents ${runningAgents.size}/${MAX_CONCURRENT}  •  boards: ${boards.map((b) => b.ticketPrefix).join(', ')}  •  next poll in ${POLL_INTERVAL_MS / 1000}s`)}`;
  out += `\n  ${chalk.dim(`Type ${chalk.white('resume <id>')} to force-open a session  •  ${chalk.white('help')} for commands`)}`;
  return out;
}

function renderDashboard(): void {
  const ts = new Date().toTimeString().slice(0, 8);
  const dashboard = buildDashboard(ts);
  const lines = dashboard.split('\n');
  if (lastDashboardLines > 0) process.stdout.write(`\x1b[${lastDashboardLines}A\x1b[0J`);
  process.stdout.write(dashboard + '\n');
  lastDashboardLines = lines.length;
}

function log(msg: string): void {
  if (lastDashboardLines > 0) {
    process.stdout.write(`\x1b[${lastDashboardLines}A\x1b[0J`);
    lastDashboardLines = 0;
  }
  console.log(msg);
}

function timestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Force-resume command ──────────────────────────────────────────────────────

/**
 * Find the board responsible for a ticket by matching its prefix (e.g. "WOR" → WOR board).
 */
function boardForIdentifier(identifier: string): BoardConfig | null {
  const prefix = identifier.split('-')[0]?.toUpperCase() ?? '';
  return boards.find((b) => b.ticketPrefix.toUpperCase() === prefix) ?? null;
}

/**
 * Force-open a session for any ticket by identifier, regardless of current Linear state.
 *   - Already running → no-op (logged)
 *   - Human Review / In Review / Rework → moves to In Progress, spawns in feedback mode
 *   - In Progress (no agent) → spawns in continue mode
 *   - Any other state → moves to In Progress, spawns in continue mode
 */
async function forceResumeTicket(identifier: string): Promise<void> {
  const upper = identifier.toUpperCase();

  if (runningAgents.has(upper)) {
    log(chalk.yellow(`[${timestamp()}] ⏭ ${upper} already has a running agent — skipping`));
    return;
  }

  const board = boardForIdentifier(upper);
  if (!board) {
    log(chalk.red(`[${timestamp()}] ✗ No board found for prefix of "${upper}" — check config`));
    return;
  }

  let ticket: Issue | null;
  try {
    ticket = await fetchTicketByIdentifier(board, upper);
  } catch (err) {
    log(chalk.red(`[${timestamp()}] ✗ Failed to fetch ${upper}: ${err}`));
    return;
  }

  if (!ticket) {
    log(chalk.red(`[${timestamp()}] ✗ Ticket ${upper} not found in board "${board.name}"`));
    return;
  }

  const stateName = ticket.state.name;
  log(chalk.cyan(`[${timestamp()}] ▶ Force-resuming`) + ` ${chalk.bold(upper)} (state: ${stateName})`);

  // Clear previous failure count so the agent gets a fresh attempt
  failureCounts.delete(upper);

  // Move to In Progress if not already there
  if (ticket.state.id !== board.states.inProgress) {
    try {
      await moveToInProgress(board, ticket.id, ticket.identifier);
    } catch (err) {
      log(chalk.red(`[${timestamp()}] ✗ Failed to move ${upper} to In Progress: ${err}`));
      return;
    }
  }

  // Use feedback mode when coming from a review state so the agent reads all comments
  const fromReview = stateName === 'Human Review' || stateName === 'In Review' || stateName === 'Rework';
  const mode: SpawnMode = fromReview ? 'feedback' : 'continue';

  spawnAgent(ticket, board, mode);
}

/**
 * Set up a readline-based interactive command handler on stdin.
 * Only active when stdin is a TTY (not piped/redirected).
 *
 * Commands:
 *   resume <id>   — force-open a session (e.g. resume WOR-53)
 *   r <id>        — shorthand for resume
 *   <id>          — bare ticket ID (e.g. WOR-53)
 *   help / h / ?  — show available commands
 */
function setupInteractiveCommands(): void {
  if (!process.stdin.isTTY) return;

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false, // don't echo or add readline's own prompt
  });

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const resumeMatch =
      trimmed.match(/^(?:resume|r)\s+([A-Z]+-\d+)$/i) ??
      trimmed.match(/^([A-Z]+-\d+)$/i);

    if (resumeMatch) {
      await forceResumeTicket(resumeMatch[1]);
      renderDashboard();
      return;
    }

    if (trimmed === 'help' || trimmed === 'h' || trimmed === '?') {
      log(chalk.bold.white('Interactive commands:'));
      log(`  ${chalk.cyan('resume <id>')}  Force-open a session  (e.g. ${chalk.cyan('resume WOR-53')})`);
      log(`  ${chalk.cyan('r <id>')}       Shorthand for resume`);
      log(`  ${chalk.cyan('<id>')}         Bare ticket ID  (e.g. ${chalk.cyan('WOR-53')})`);
      log(`  ${chalk.cyan('Ctrl+C')}       Shut down poller`);
      renderDashboard();
      return;
    }

    log(chalk.dim(`[symphony] Unknown command: "${trimmed}" — type "help" for commands`));
    renderDashboard();
  });

  // Don't let readline close the process when stdin ends
  rl.on('close', () => {});
}

// ── Poller singleton lock ─────────────────────────────────────────────────────

{
  const logsDir = path.join(SYMPHONY_ROOT, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const lockFile = path.join(logsDir, 'symphony-poller.pid');

  if (fs.existsSync(lockFile)) {
    const existingPid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
    if (!isNaN(existingPid) && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0);
        console.error(chalk.red(`[symphony] Already running (PID ${existingPid}). Kill it first: kill ${existingPid}`));
        process.exit(1);
      } catch {
        fs.rmSync(lockFile, { force: true });
      }
    }
  }

  try {
    const { execSync } = await import('child_process');
    const out = execSync('pgrep -f "symphony/scripts/poll-linear"', { encoding: 'utf8' }).trim();
    const pids = out.split('\n').map(Number).filter((p) => p && p !== process.pid);
    if (pids.length > 0) {
      console.error(chalk.red(`[symphony] Another poller already running (PID ${pids.join(', ')}). Kill it first: kill ${pids.join(' ')}`));
      process.exit(1);
    }
  } catch { /* pgrep exits non-zero when no matches */ }

  if (!DRY_RUN) fs.writeFileSync(lockFile, String(process.pid));
  const cleanupLock = () => fs.rmSync(lockFile, { force: true });
  process.on('exit', cleanupLock);
}

const MAX_RETRIES = 3;
const failureCounts = new Map<string, number>();
const lastKnownState = new Map<string, string>();
const RATE_LIMIT_PATTERN = /You've hit your limit|rate.?limit/i;

// Set when a rate-limit is detected; the main loop sleeps until this time.
let rateLimitPausedUntil: Date | null = null;

interface PausedSession {
  ticket: Issue;
  board: BoardConfig;
  sessionId: string;
  worktreePath: string;
}
let rateLimitPausedSessions: PausedSession[] = [];

/**
 * Parse the reset time from a Claude Code rate-limit message.
 * Handles: "You've hit your limit · resets 6pm (Asia/Shanghai)", "resets 18:00 (UTC)", etc.
 * Returns the next occurrence of that clock time (today or tomorrow) + 5-minute buffer,
 * or null if parsing fails.
 */
function parseRateLimitResetTime(logContent: string): Date | null {
  const match = logContent.match(
    /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i
  );
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const ampm = match[3]?.toLowerCase();
  const timezone = match[4]?.trim() ?? 'UTC';

  if (ampm === 'pm' && hours !== 12) hours += 12;
  else if (ampm === 'am' && hours === 12) hours = 0;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  try { Intl.DateTimeFormat(undefined, { timeZone: timezone }); } catch { return null; }

  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)!.value, 10);

  const currentSec = get('hour') * 3600 + get('minute') * 60 + get('second');
  const resetSec = hours * 3600 + minutes * 60;
  let diffSec = resetSec - currentSec;
  if (diffSec <= 0) diffSec += 86400;

  // Add 5-minute buffer after the reset time
  return new Date(now.getTime() + diffSec * 1000 + 5 * 60 * 1000);
}

// ── Agent runner ──────────────────────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

type SpawnMode = 'fresh' | 'feedback' | 'continue';

function spawnAgent(ticket: Issue, board: BoardConfig, mode: SpawnMode = 'continue', forMerging = false): void {
  if (DRY_RUN) {
    const repo = resolveRepo(ticket, board);
    const projectPath = resolveProjectPath(ticket, board);
    log(chalk.dim(`[dry-run] Would spawn: ${ticket.identifier} → repo=${repo.name} projectPath=${projectPath || '(repo root)'} mode=${mode}`));
    return;
  }

  const fresh = mode === 'fresh';
  const logsDir = path.join(SYMPHONY_ROOT, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const activePidFile = path.join(logsDir, `agent-pid-${ticket.identifier}.pid`);

  if (!fresh && fs.existsSync(activePidFile)) {
    const existingPid = parseInt(fs.readFileSync(activePidFile, 'utf8').trim(), 10);
    if (!isNaN(existingPid) && isPidAlive(existingPid)) {
      log(chalk.yellow(`[${timestamp()}] ⏭ Agent already running`) + ` ${chalk.bold(ticket.identifier)} (PID: ${existingPid}) — skipping`);
      return;
    }
    fs.unlinkSync(activePidFile);
  }

  const repo = resolveRepo(ticket, board);
  const projectPath = resolveProjectPath(ticket, board);
  const repoPath = repo.path.replace(/^~/, process.env['HOME'] ?? '~');
  const worktreesDir = repo.worktreesDir.replace(/^~/, process.env['HOME'] ?? '~');

  const slug = ticket.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/-$/, '');
  const branch = `feat/${ticket.identifier}-${slug}`;
  const folder = branch.replace(/\//g, '--');
  const worktreePath = path.join(worktreesDir, folder);

  const logFile = path.join(logsDir, `symphony-${ticket.identifier}.log`);
  const logFd = fs.openSync(logFile, 'a');
  const stdio: child_process.StdioOptions = ['ignore', logFd, logFd];

  const modeFlag = mode === 'fresh' ? '--fresh' : mode === 'feedback' ? '--feedback' : '';
  const args = [
    ticket.identifier,
    ticket.title,
    ticket.description ?? '(no description provided)',
    ...(modeFlag ? [modeFlag] : []),
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Repo config
    REPO_PATH: repoPath,
    WORKTREES_DIR: worktreesDir,
    DEFAULT_BRANCH: repo.defaultBranch,
    GITHUB_REPO: repo.github,
    IS_MONO: String(repo.isMono ?? false),
    PROJECT_PATH: projectPath,
    // Setup config
    SETUP_SYMLINK_NODE_MODULES: String(repo.setup?.symlinkNodeModules ?? false),
    SETUP_INSTALL_COMMAND: repo.setup?.installCommand ?? '',
    SETUP_INSTALL_CHECK: repo.setup?.installCheck ?? '',
    // Board state IDs
    STATE_BACKLOG: board.states.backlog,
    STATE_TODO: board.states.todo,
    STATE_IN_PROGRESS: board.states.inProgress,
    STATE_HUMAN_REVIEW: board.states.humanReview,
    STATE_IN_REVIEW: board.states.inReview,
    STATE_REWORK: board.states.rework,
    STATE_MERGING: board.states.merging,
    STATE_DONE: board.states.done,
    // Ticket system
    TICKET_SYSTEM: board.ticketSystem,
    // Symphony root
    SYMPHONY_ROOT,
    // Language preferences
    PERSONAL_PREFERRED_LANGUAGE: symphonyConfig.preferences.personalLanguage,
    WORK_PREFERRED_LANGUAGE: symphonyConfig.preferences.workLanguage,
    NEVER_USE_LANGUAGE: symphonyConfig.preferences.neverUseLanguage,
    // Remote control
    REMOTE_CONTROL: String(REMOTE_CONTROL),
  };

  const child = child_process.spawn(
    path.join(SYMPHONY_ROOT, 'scripts/run-ticket.sh'),
    args,
    { stdio, env, detached: false }
  );

  if (child.pid !== undefined) fs.writeFileSync(activePidFile, String(child.pid));

  runningAgents.set(ticket.identifier, {
    proc: child,
    project: ticket.project?.name ?? '(no project)',
    issueId: ticket.id,
    boardName: board.name,
    ticket,
    spawnedAt: Date.now(),
    spawnedForMerging: forMerging,
    worktreePath,
    board,
  });

  log(chalk.green(`[${timestamp()}] ▶ Agent started`) + ` ${chalk.bold(ticket.identifier)} (PID: ${child.pid}) → logs/symphony-${ticket.identifier}.log`);

  child.on('error', (err) => {
    fs.rmSync(activePidFile, { force: true });
    runningAgents.delete(ticket.identifier);
    const failures = (failureCounts.get(ticket.identifier) ?? 0) + 1;
    failureCounts.set(ticket.identifier, failures);
    log(chalk.red(`[${timestamp()}] ✗ Spawn error:`) + ` ${chalk.bold(ticket.identifier)} — ${err.message} (attempt ${failures}/${MAX_RETRIES})`);
    renderDashboard();
  });

  child.on('exit', (code, signal) => {
    fs.rmSync(activePidFile, { force: true });
    const agent = runningAgents.get(ticket.identifier);
    runningAgents.delete(ticket.identifier);

    if (isShuttingDown) {
      log(chalk.yellow(`[${timestamp()}] ⚠ Agent interrupted:`) + ` ${chalk.bold(ticket.identifier)}`);
    } else if (code !== 0 && signal == null) {
      // Skip rate-limit check for signal-killed processes (SIGTERM from our own cleanup)
      const agentLog = path.join(SYMPHONY_ROOT, 'logs', `symphony-${ticket.identifier}.log`);
      let hitRateLimit = false;
      let logTail = '';
      try {
        const fd = fs.openSync(agentLog, 'r');
        const stat = fs.fstatSync(fd);
        const readSize = Math.min(4096, stat.size);
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
        fs.closeSync(fd);
        logTail = buf.toString();
        hitRateLimit = RATE_LIMIT_PATTERN.test(logTail);
      } catch { /* unreadable */ }

      if (hitRateLimit) {
        const resetDate = parseRateLimitResetTime(logTail);

        // Collect session info for all running agents before killing them
        rateLimitPausedSessions = [];
        for (const [id, agentEntry] of runningAgents) {
          const sessionFile = path.join(agentEntry.worktreePath, '.claude-session-id');
          if (fs.existsSync(sessionFile)) {
            const sessionId = fs.readFileSync(sessionFile, 'utf8').trim();
            if (sessionId) {
              rateLimitPausedSessions.push({
                ticket: agentEntry.ticket,
                board: agentEntry.board,
                sessionId,
                worktreePath: agentEntry.worktreePath,
              });
            }
          }
          void id; // suppress unused warning
        }
        // Also include the current (already-exited) agent's session
        if (!runningAgents.has(ticket.identifier)) {
          const sessionFile = path.join(agent?.worktreePath ?? '', '.claude-session-id');
          if (agent?.worktreePath && fs.existsSync(sessionFile)) {
            const sessionId = fs.readFileSync(sessionFile, 'utf8').trim();
            if (sessionId) rateLimitPausedSessions.push({ ticket, board, sessionId, worktreePath: agent.worktreePath });
          }
        }

        for (const { proc } of runningAgents.values()) proc.kill('SIGTERM');

        if (resetDate) {
          const pauseMs = Math.max(0, resetDate.getTime() - Date.now());
          log(chalk.yellow(`[${timestamp()}] ⏸ Rate limit hit: ${chalk.bold(ticket.identifier)} — pausing until ${resetDate.toLocaleTimeString()} (~${Math.ceil(pauseMs / 60000)}min, incl. +5min buffer)`));
          rateLimitPausedUntil = resetDate;
        } else {
          log(chalk.red(`[${timestamp()}] ⛔ Rate limit hit: ${ticket.identifier} — could not parse reset time, stopping poller`));
          process.exit(1);
        }
      } else {
        const failures = (failureCounts.get(ticket.identifier) ?? 0) + 1;
        failureCounts.set(ticket.identifier, failures);
        log(chalk.red(`[${timestamp()}] ✗ Agent failed:`) + ` ${chalk.bold(ticket.identifier)} (exit ${code ?? signal}, attempt ${failures}/${MAX_RETRIES})`);
      }
    } else {
      failureCounts.delete(ticket.identifier);
      log(chalk.green(`[${timestamp()}] ✓ Agent done:`) + ` ${chalk.bold(ticket.identifier)}`);
      if (agent?.spawnedForMerging && code === 0) {
        moveToDone(agent.board, agent.issueId, ticket.identifier).catch(() => {});
      } else if (agent) {
        moveToHumanReview(agent.board, agent.issueId, ticket.identifier).catch(() => {});
      }
    }
    renderDashboard();
  });
}

// ── Human Review helpers ──────────────────────────────────────────────────────

const AI_REVIEW_LOCK_PREFIX = '[symphony] aiReviewRequested:';
const APPROVAL_LOCK_PREFIX = '[symphony] developerApproved:';

async function checkHumanReviewApproval(issue: Issue) {
  const data = await linearQuery<{ issue: { comments: { nodes: { body: string }[] } } }>(
    `query GetComments($id: String!) { issue(id: $id) { comments { nodes { body } } } }`,
    { id: issue.id }
  );
  const bodies = data.issue.comments.nodes.map((c) => c.body);
  const alreadyHandled = bodies.some((b) => b.startsWith(APPROVAL_LOCK_PREFIX));
  const aiReviewed = bodies.some((b) => b.startsWith(AI_REVIEW_LOCK_PREFIX));
  const approvalPattern = /\b(lgtm|approved?|looks good( to me)?|ship it|✅)\b/i;
  const prPattern = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;
  const approved = bodies.some((b) => approvalPattern.test(b));
  const prUrl = bodies.map((b) => b.match(prPattern)?.[0]).find(Boolean) ?? null;
  return { alreadyHandled, aiReviewed, approved, prUrl };
}

async function postComment(issueId: string, body: string): Promise<void> {
  await linearQuery(
    `mutation PostComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`,
    { issueId, body }
  );
}

function spawnNotifyReview(issue: Issue, board: BoardConfig, prUrl: string): Promise<string | null> {
  const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? '';
  const repoConfig = resolveRepo(issue, board);
  const repoPath = repoConfig.path.replace(/^~/, process.env['HOME'] ?? '~');

  const prompt = `Post a code review request to Slack for PR ${prUrl}.

## Steps

1. Run \`gh pr view ${prNumber} --json title,changedFiles\` to get PR info and changed file paths.

2. Determine which code owners to mention by matching changed file paths against this CODEOWNERS table:
   - /apps/payroll/, /apps/payroll-backend/, /libs/payroll-*  → @helloworld1812/budai
   - /apps/time-off/, /apps/time-off-back-end/, /libs/time-off-*  → @helloworld1812/time_shift
   - /apps/hris/, /libs/hris-*  → @helloworld1812/hris
   - /apps/talent-network*, /libs/talent-network-*  → @helloworld1812/hiring-sourcing
   - /apps/ws-mfe-parent  → @SunStupic @markduan-ws
   - /libs/ws-router, /libs/ws-components  → @SunStupic @Wenkang-ws
   - /apps/hiring  → @SunStupic
   - /apps/on-demand-interviews, /routes/hr-on-demand-*  → @SunStupic
   If no specific match, use the PR author's team or skip mentions.

3. Post to the **#e-code-review** Slack channel (channel ID: CRBPABGHY) using the Slack MCP \`slack_send_message\` tool:
   - Message format: ":code-review: Please review this PR: ${prUrl} — ${issue.identifier}: ${issue.title}. CC: [code owner GitHub handles from step 2]"

4. Print the Slack message permalink if available.

If Slack MCP is not available, print the composed message so it can be copied manually.`;

  return new Promise((resolve) => {
    const child = child_process.spawn(
      'claude',
      ['--dangerously-skip-permissions', '--print', prompt],
      { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], detached: false }
    );
    let output = '';
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      if (code === 0) {
        const slackMatch = output.match(/https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+/);
        resolve(slackMatch?.[0] ?? prUrl);
      } else {
        resolve(null);
      }
    });
  });
}

function spawnAIReview(issue: Issue, board: BoardConfig, prUrl: string): void {
  const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];
  if (!prNumber) return;
  const codeReviewComment = board['code-review-comment'];
  if (!codeReviewComment) return; // no review configured for this board — skip
  const repoConfig = resolveRepo(issue, board);
  const repoPath = repoConfig.path.replace(/^~/, process.env['HOME'] ?? '~');

  // Write the review-trigger comment to a temp file to avoid any shell escaping issues.
  const tmpCommentFile = `/tmp/symphony-review-comment-${prNumber}.txt`;
  const prompt = `You are monitoring an automated code review request for a GitHub PR.

## PR
${prUrl} (PR #${prNumber})

## Instructions

1. Write the review-trigger comment to a temp file (avoids escaping issues):
   \`\`\`bash
   cat > ${tmpCommentFile} << 'SYMPHONY_EOF'
${codeReviewComment}
SYMPHONY_EOF
   \`\`\`

2. Capture the current review count before posting, so you can identify only new reviews later:
   \`\`\`bash
   BEFORE_COUNT=$(gh pr view ${prNumber} --json reviews --jq '.reviews | length')
   \`\`\`

3. Post the comment to trigger the board's configured AI reviewer:
   \`\`\`bash
   gh pr comment ${prNumber} --body-file ${tmpCommentFile}
   \`\`\`

4. Poll the PR reviews every 30 seconds, for up to 15 minutes, until the review bot responds.
   Only inspect reviews that were added after the trigger (index >= BEFORE_COUNT):
   \`\`\`bash
   gh pr view ${prNumber} --json reviews --jq ".reviews[$BEFORE_COUNT:] | map({login: .author.login, state: .state})"
   \`\`\`
   Repeat until you see a review with state APPROVED or CHANGES_REQUESTED, or 15 minutes elapse.

5. Based on the result:
   - If any new review shows CHANGES_REQUESTED → print \`ACTIONABLE:YES\`
   - If any new review shows APPROVED, or 15 minutes elapse with no new review → print \`ACTIONABLE:NO\`

Do not make code changes, commits, or any other actions beyond the above steps.

Print exactly one of these as your LAST line of output:
- \`ACTIONABLE:YES\` — the bot requested changes
- \`ACTIONABLE:NO\` — the bot approved or the wait timed out`;

  const child = child_process.spawn(
    'claude',
    ['--dangerously-skip-permissions', '--print', prompt],
    { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], detached: false }
  );
  let output = '';
  child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (output += d.toString()));

  child.on('exit', (code) => {
    if (code === 0) {
      const hasActionable = output.trim().endsWith('ACTIONABLE:YES');
      postComment(issue.id, hasActionable
        ? `[symphony] aiReviewComplete: changes requested — see PR comments at ${prUrl}`
        : `[symphony] aiReviewComplete: no changes needed — ${prUrl}`
      ).catch(() => {});
      if (hasActionable) moveToInProgress(board, issue.id, issue.identifier).catch(() => {});
    }
  });

  log(chalk.blue(`[${timestamp()}] 🔍 AI review started for ${issue.identifier} (PR #${prNumber})`));
}

// ── Worktree cleanup ──────────────────────────────────────────────────────────

async function cleanupDoneWorktrees(activeIdentifiers: Set<string>, board: BoardConfig): Promise<void> {
  for (const repo of board.repos) {
    const worktreesDir = repo.worktreesDir.replace(/^~/, process.env['HOME'] ?? '~');
    const repoPath = repo.path.replace(/^~/, process.env['HOME'] ?? '~');
    if (!fs.existsSync(worktreesDir)) continue;

    for (const entry of fs.readdirSync(worktreesDir)) {
      const match = entry.match(/^[a-z]+--(WOR-\d+)-/i) ?? entry.match(/^(?:feat|fix|chore|refactor)--(WOR-\d+)/i);
      if (!match) continue;
      const identifier = match[1].toUpperCase();
      if (activeIdentifiers.has(identifier) || runningAgents.has(identifier)) continue;

      const worktreePath = path.join(worktreesDir, entry);
      if (!fs.statSync(worktreePath).isDirectory()) continue;

      try {
        const result = child_process.spawnSync('git', ['status', '--porcelain'], { cwd: worktreePath, encoding: 'utf8' });
        const lines = (result.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
        const safeFiles = new Set(['.claude-session-id', 'node_modules']);
        const unexpected = lines.filter((l) => !safeFiles.has(l.replace(/^[? A-Z]+\s+/, '').trim()));
        if (unexpected.length > 0) continue;
      } catch { continue; }

      try {
        child_process.spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoPath, encoding: 'utf8' });
        child_process.spawnSync('git', ['worktree', 'prune'], { cwd: repoPath, encoding: 'utf8' });
        log(chalk.dim(`[${timestamp()}] 🗑 Cleaned up worktree for ${identifier}`));
      } catch { /* ignore */ }
    }
  }
}

async function cleanupOrphanedAgentsByPidFiles(): Promise<void> {
  const logsDir = path.join(SYMPHONY_ROOT, 'logs');
  if (!fs.existsSync(logsDir)) return;

  const files = fs.readdirSync(logsDir).filter((f) => f.startsWith('agent-pid-') && f.endsWith('.pid'));
  for (const file of files) {
    const match = file.match(/^agent-pid-([A-Z]+-\d+)\.pid$/i);
    if (!match) continue;
    const identifier = match[1].toUpperCase();
    const filePath = path.join(logsDir, file);
    let pid: number;
    try { pid = parseInt(fs.readFileSync(filePath, 'utf8').trim(), 10); } catch { fs.rmSync(filePath, { force: true }); continue; }
    if (isNaN(pid)) { fs.rmSync(filePath, { force: true }); continue; }
    if (!isPidAlive(pid)) { fs.rmSync(filePath, { force: true }); continue; }
    if (runningAgents.has(identifier)) continue;

    // Find which board this ticket belongs to
    const prefix = identifier.split('-')[0];
    const board = boards.find((b) => b.ticketPrefix === prefix);
    if (!board) continue;

    try {
      const stateId = await fetchTicketStateId(board, identifier);
      if (stateId === board.states.done) {
        log(chalk.dim(`[${timestamp()}] ⏹ Killing orphaned agent for ${identifier} (Done, PID ${pid})`));
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        fs.rmSync(filePath, { force: true });
      }
    } catch { /* ignore */ }
  }
}

// ── Main poll loop ────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  await cleanupOrphanedAgentsByPidFiles();

  const allEligible: { ticket: Issue; board: BoardConfig }[] = [];
  const allBlocked: { ticket: Issue; board: BoardConfig }[] = [];
  const allActiveIdentifiers = new Set<string>();

  for (const board of boards) {
    let todoTickets: Issue[], inProgressTickets: Issue[], humanReviewTickets: Issue[], mergingTickets: Issue[], reworkTickets: Issue[];
    try {
      [todoTickets, inProgressTickets, humanReviewTickets, mergingTickets, reworkTickets] = await Promise.all([
        fetchTicketsByState(board.teamId, board.states.todo),
        fetchTicketsByState(board.teamId, board.states.inProgress),
        fetchTicketsByState(board.teamId, board.states.humanReview),
        fetchTicketsByState(board.teamId, board.states.merging),
        fetchTicketsByState(board.teamId, board.states.rework),
      ]);
    } catch (err) {
      log(chalk.red(`[${timestamp()}] Linear API error (${board.name}): ${err}`));
      continue;
    }

    for (const t of [...todoTickets, ...inProgressTickets, ...humanReviewTickets, ...mergingTickets, ...reworkTickets]) {
      allActiveIdentifiers.add(t.identifier);
    }

    // Kill agents whose tickets moved out of active states
    const SETTLE_MS = 30_000;
    // Rework tickets are intentionally excluded: agents for tickets moved to Rework
    // should be stopped so resetReworkTicket() can run on the next poll cycle.
    const activeInBoard = new Set([...inProgressTickets.map((t) => t.identifier), ...mergingTickets.map((t) => t.identifier)]);
    for (const [identifier, agent] of runningAgents) {
      if (agent.boardName !== board.name) continue;
      if (Date.now() - agent.spawnedAt < SETTLE_MS) continue;
      if (!activeInBoard.has(identifier)) {
        log(chalk.dim(`[${timestamp()}] ⏹ ${identifier} no longer active — stopping agent`));
        agent.proc.kill('SIGTERM');
      }
    }

    // Human Review: AI review + approval detection
    for (const issue of humanReviewTickets.filter((t) => isEligible(t, board))) {
      try {
        const { alreadyHandled, aiReviewed, approved, prUrl } = await checkHumanReviewApproval(issue);
        if (!aiReviewed && prUrl) {
          await postComment(issue.id, `${AI_REVIEW_LOCK_PREFIX} ${prUrl}`);
          spawnAIReview(issue, board, prUrl);
        }
        if (alreadyHandled) continue;
        if (approved && prUrl) {
          await postComment(issue.id, `${APPROVAL_LOCK_PREFIX} notifying team…`);
          await moveToInReview(board, issue.id, issue.identifier);
          spawnNotifyReview(issue, board, prUrl).then(async (slackLink) => {
            if (slackLink) await postComment(issue.id, `${APPROVAL_LOCK_PREFIX} ${slackLink}`).catch(() => {});
          });
        }
      } catch (err) {
        log(chalk.red(`[symphony] Error checking ${issue.identifier}: ${err}`));
      }
    }

    // Merging
    for (const issue of mergingTickets.filter((t) => isEligible(t, board))) {
      if (runningAgents.has(issue.identifier)) continue;
      if (runningAgents.size >= MAX_CONCURRENT) break;
      log(chalk.magenta(`[${timestamp()}] ⬇ Merging:`) + ` ${chalk.bold(issue.identifier)} — ${issue.title}`);
      spawnAgent(issue, board, 'continue', true);
      await sleep(3000);
    }

    // Rework = reviewer requested a full reset.
    // Poller handles cleanup (close PR, delete workpad, remove worktree) then
    // moves ticket back to Todo. Next poll cycle picks it up as a fresh Todo.
    for (const issue of reworkTickets.filter((t) => isEligible(t, board))) {
      if (runningAgents.has(issue.identifier)) continue; // wait for running agent to exit first
      try {
        await resetReworkTicket(issue, board);
      } catch (err) {
        log(chalk.red(`[symphony] Error resetting rework ticket ${issue.identifier}: ${err}`));
      }
      await sleep(2000);
    }

    // Resume stale In Progress
    const stale = inProgressTickets.filter(
      (t) => isEligible(t, board) && !runningAgents.has(t.identifier) && (failureCounts.get(t.identifier) ?? 0) < MAX_RETRIES
    );
    for (const issue of stale) {
      if (runningAgents.size >= MAX_CONCURRENT) break;
      const prev = lastKnownState.get(issue.identifier);
      const fromReview = prev === 'Human Review' || prev === 'In Review' || prev === 'Rework';
      const mode: SpawnMode = fromReview ? 'feedback' : 'continue';
      log(chalk.yellow(`[${timestamp()}] ↺ Resuming ${fromReview ? '(feedback)' : '(continue)'}:`) + ` ${chalk.bold(issue.identifier)} — ${issue.title}`);
      spawnAgent(issue, board, mode);
      await sleep(3000);
    }

    // Classify todo tickets
    for (const t of todoTickets) {
      if (isEligible(t, board)) allEligible.push({ ticket: t, board });
      else allBlocked.push({ ticket: t, board });
    }
    for (const t of inProgressTickets.filter((t) => isEligible(t, board))) {
      allEligible.push({ ticket: t, board });
    }

    // Update last-known states
    for (const t of todoTickets) lastKnownState.set(t.identifier, 'Todo');
    for (const t of inProgressTickets) lastKnownState.set(t.identifier, 'In Progress');
    for (const t of humanReviewTickets) lastKnownState.set(t.identifier, 'Human Review');
    for (const t of mergingTickets) lastKnownState.set(t.identifier, 'Merging');
    for (const t of reworkTickets) lastKnownState.set(t.identifier, 'Rework');

    await cleanupDoneWorktrees(allActiveIdentifiers, board);
  }

  lastEligibleAll = allEligible;
  lastBlockedAll = allBlocked;
  renderDashboard();

  if (runningAgents.size >= MAX_CONCURRENT) return;

  // Spawn new agents for todo tickets
  for (const { ticket, board } of allEligible) {
    if (runningAgents.has(ticket.identifier)) continue;
    if (runningAgents.size >= MAX_CONCURRENT) break;
    log(`[${timestamp()}] Claiming ${chalk.bold(ticket.identifier)} [${ticket.project?.name ?? 'no project'}] — ${ticket.title}`);
    await moveToInProgress(board, ticket.id, ticket.identifier);
    spawnAgent(ticket, board, 'fresh');
    renderDashboard();
    await sleep(3000);
  }
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

process.on('SIGINT', async () => {
  isShuttingDown = true;
  const total = runningAgents.size;
  log('\n' + chalk.yellow(`[symphony] Shutting down — interrupting ${total} running agent(s)...`));

  if (REMOTE_CONTROL) {
    await Promise.all([...runningAgents.entries()].map(async ([identifier, agent]) => {
      const sessionFile = path.join(agent.worktreePath, '.claude-session-id');
      if (!fs.existsSync(sessionFile)) return;
      const sessionId = fs.readFileSync(sessionFile, 'utf8').trim();
      if (!sessionId) return;
      try {
        await new Promise<void>((resolve) => {
          const stop = child_process.spawn('claude', ['--dangerously-skip-permissions', '--resume', sessionId, '--print', 'STOP. The Symphony poller has shut down. Save your work to the workpad and exit immediately.'], { stdio: 'ignore' });
          stop.on('exit', () => resolve());
          setTimeout(() => { stop.kill(); resolve(); }, 10_000);
        });
      } catch { /* best-effort */ }
    }));
  }

  const pidKills: Promise<void>[] = [];
  for (const { proc } of runningAgents.values()) {
    proc.kill('SIGTERM');
    pidKills.push(new Promise<void>((resolve) => proc.on('exit', () => resolve())));
  }

  const logsDir = path.join(SYMPHONY_ROOT, 'logs');
  const trackedPids = new Set([...runningAgents.values()].map(({ proc }) => proc.pid).filter(Boolean));
  if (fs.existsSync(logsDir)) {
    for (const file of fs.readdirSync(logsDir)) {
      if (!file.startsWith('agent-pid-') || !file.endsWith('.pid')) continue;
      const filePath = path.join(logsDir, file);
      const pid = parseInt(fs.readFileSync(filePath, 'utf8').trim(), 10);
      if (!isNaN(pid) && !trackedPids.has(pid) && isPidAlive(pid)) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      fs.rmSync(filePath, { force: true });
    }
  }

  await Promise.all(pidKills);
  console.log(chalk.yellow('[symphony] Stopped.'));
  process.exit(0);
});

process.on('SIGTERM', async () => { process.emit('SIGINT'); });

// ── Banner ────────────────────────────────────────────────────────────────────

console.log(chalk.bold.blue('╔══════════════════════════════════════════╗'));
console.log(chalk.bold.blue('║') + chalk.bold.white('   Symphony Poller — claude-home           ') + chalk.bold.blue('║'));
console.log(chalk.bold.blue('╚══════════════════════════════════════════╝'));
for (const board of boards) {
  console.log(`  ${chalk.dim('Board:')}       ${board.name} (${board.ticketPrefix})`);
  console.log(`  ${chalk.dim('Projects:')}    ${board.projects.length} configured`);
}
console.log(`  ${chalk.dim('Assignee:')}    ${ASSIGNEE_ID || 'any'}`);
console.log(`  ${chalk.dim('Max agents:')}  ${MAX_CONCURRENT}`);
console.log(`  ${chalk.dim('Poll:')}        every ${POLL_INTERVAL_MS / 1000}s`);
if (DRY_RUN) console.log(chalk.yellow('  [DRY RUN MODE — no agents will be spawned]'));
console.log('');
console.log(
  chalk.dim(
    `  ${chalk.white('resume <id>')} to force-open a session  •  ${chalk.white('help')} for commands  •  Ctrl+C to stop`
  )
);
console.log('');

setupInteractiveCommands();

while (true) {
  // If a rate-limit pause is active, sleep in-place until the window expires
  if (rateLimitPausedUntil) {
    const pauseMs = rateLimitPausedUntil.getTime() - Date.now();
    if (pauseMs > 0) {
      log(chalk.yellow(`[${timestamp()}] ⏸ Rate-limited — sleeping ${Math.ceil(pauseMs / 60000)}min until ${rateLimitPausedUntil.toLocaleTimeString()}`));
      await sleep(pauseMs);
    }
    rateLimitPausedUntil = null;
    log(chalk.green(`[${timestamp()}] ▶ Rate-limit window expired — resuming`));

    // Resume each paused session with a continuation message
    const sessionsToResume = rateLimitPausedSessions.splice(0);
    for (const { ticket: pausedTicket, board: pausedBoard, sessionId, worktreePath } of sessionsToResume) {
      log(chalk.cyan(`[${timestamp()}] ↩ Resuming session:`) + ` ${chalk.bold(pausedTicket.identifier)} (session ${sessionId.slice(0, 8)}…)`);
      const logsDir = path.join(SYMPHONY_ROOT, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const logFile = path.join(logsDir, `symphony-${pausedTicket.identifier}.log`);
      const logFd = fs.openSync(logFile, 'a');
      const activePidFile = path.join(logsDir, `agent-pid-${pausedTicket.identifier}.pid`);

      const child = child_process.spawn(
        'claude',
        ['--dangerously-skip-permissions', '--resume', sessionId, '--print', 'rate limit 解除了，继续'],
        { cwd: worktreePath, stdio: ['ignore', logFd, logFd], detached: false }
      );

      if (child.pid !== undefined) fs.writeFileSync(activePidFile, String(child.pid));

      runningAgents.set(pausedTicket.identifier, {
        proc: child,
        project: pausedTicket.project?.name ?? '(no project)',
        issueId: pausedTicket.id,
        boardName: pausedBoard.name,
        ticket: pausedTicket,
        spawnedAt: Date.now(),
        spawnedForMerging: false,
        worktreePath,
        board: pausedBoard,
      });

      child.on('error', (err) => {
        fs.rmSync(activePidFile, { force: true });
        runningAgents.delete(pausedTicket.identifier);
        log(chalk.red(`[${timestamp()}] ✗ Resume spawn error: ${pausedTicket.identifier} — ${err.message}`));
        renderDashboard();
      });

      child.on('exit', (exitCode) => {
        fs.rmSync(activePidFile, { force: true });
        runningAgents.delete(pausedTicket.identifier);
        if (exitCode === 0) {
          log(chalk.green(`[${timestamp()}] ✓ Resumed agent done: ${chalk.bold(pausedTicket.identifier)}`));
          moveToHumanReview(pausedBoard, pausedTicket.id, pausedTicket.identifier).catch(() => {});
        } else {
          log(chalk.red(`[${timestamp()}] ✗ Resumed agent failed: ${chalk.bold(pausedTicket.identifier)} (exit ${exitCode})`));
        }
        renderDashboard();
      });

      await sleep(2000); // stagger spawns
    }
  }
  await poll();
  await sleep(POLL_INTERVAL_MS);
}
