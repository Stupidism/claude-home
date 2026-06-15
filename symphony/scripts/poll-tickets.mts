#!/usr/bin/env node --experimental-strip-types
/**
 * poll-tickets.mts — Poll all configured boards for eligible tickets and run Claude Code agents
 *
 * Supports Linear and Jira boards via per-board `ticketSystem` dispatch (see
 * scripts/ticket-systems/). The old name `poll-linear.mts` is kept as a thin
 * back-compat shim that just imports this file.
 *
 * Reads config from $SYMPHONY_ROOT/config/symphony.json and config/boards/*.json
 * Secrets from $SYMPHONY_ROOT/secrets.env (gitignored)
 *
 * Usage:
 *   node --experimental-strip-types $SYMPHONY_ROOT/scripts/poll-tickets.mts
 *   node --experimental-strip-types $SYMPHONY_ROOT/scripts/poll-tickets.mts --dry-run
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as child_process from 'node:child_process';
import * as readline from 'node:readline';
import chalk from 'chalk';
import Table from 'cli-table3';
import {
  buildDashboardHtml,
  readSessionId,
  type HtmlRow,
  type HtmlStatusKind,
} from './html-dashboard.mts';
import { linearAdapter } from './ticket-systems/linear.mts';
import { jiraAdapter } from './ticket-systems/jira.mts';
import { githubProjectsAdapter } from './ticket-systems/github-projects.mts';
import {
  snapshotPsByCommand,
  findOrphanPidsByWorktreePrefix,
  findNxDaemonPids,
  findDeadAgentIdentifiers,
} from './orphan-cleanup.mts';
import { codexCommentMatchesSha, type IssueComment } from './ai-review-comments.mts';
import type {
  BoardGithubProjectsConfig,
  BoardJiraConfig,
  BoardLinearConfig,
  Issue,
  StateKey,
  StateKeys,
  TicketSystemAdapter,
} from './ticket-systems/types.mts';
import {
  processTicket,
  APPROVAL_LOCK_PREFIX,
  FEEDBACK_REROUTE_LOCK_PREFIX,
  NEEDS_NOTIFY_LABEL,
  REVIEW_NOTIFIED_LABEL,
  MAX_RETRIES as STATE_MACHINE_MAX_RETRIES,
  type Deps as StateMachineDeps,
  type SpawnMode,
} from './state-machine.mts';
import { RATE_LIMIT_PATTERN, parseRateLimitResetTime } from './rate-limit.mts';

// ── Paths ─────────────────────────────────────────────────────────────────────

const SYMPHONY_ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG_DIR = path.join(SYMPHONY_ROOT, 'config');

const DRY_RUN = process.argv.includes('--dry-run');
const HTML_MODE = process.argv.includes('--html');
const HTML_DASHBOARD_FILE = path.join(os.tmpdir(), 'symphony-dashboard.html');

// ── Persistent log file (tee of stdout/stderr) ────────────────────────────────
//
// stdout/stderr are tee'd to logs/symphony-poller.log so trial diagnosis and
// post-mortems have a grep-able audit trail (UP-813). ANSI escapes are stripped
// before writing to the file; dashboard frames bypass the tee via the exported
// `rawStdoutWrite` to avoid filling the log with repaints.
const POLLER_LOG_FILE = path.join(SYMPHONY_ROOT, 'logs', 'symphony-poller.log');
const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const rawStdoutWrite = process.stdout.write.bind(process.stdout);
const rawStderrWrite = process.stderr.write.bind(process.stderr);
{
  // Best-effort tee: any failure here (read-only mount, permission drift, disk
  // full) must not stop the poller from booting. If setup fails or the stream
  // later emits an error, teeing is silently disabled and stdout/stderr keep
  // working as before.
  let logStream: fs.WriteStream | null = null;
  try {
    fs.mkdirSync(path.dirname(POLLER_LOG_FILE), { recursive: true });
    logStream = fs.createWriteStream(POLLER_LOG_FILE, { flags: 'a' });
    logStream.on('error', () => { logStream = null; });
  } catch (err) {
    rawStderrWrite(`[symphony] persistent log disabled: ${(err as Error).message}\n`);
  }

  if (logStream) {
    const teeWrite = (raw: typeof rawStdoutWrite): typeof rawStdoutWrite => {
      return function (chunk: unknown, ...rest: unknown[]): boolean {
        try {
          let text = '';
          if (typeof chunk === 'string') text = chunk;
          else if (chunk instanceof Uint8Array) text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8');
          const stripped = text.replace(ANSI_PATTERN, '');
          if (logStream && stripped.replace(/\s/g, '').length > 0) logStream.write(stripped);
        } catch {
          // never let logging break the poller
        }
        // @ts-expect-error — forwarding variadic Node stream args
        return raw(chunk, ...rest);
      } as typeof rawStdoutWrite;
    };
    process.stdout.write = teeWrite(rawStdoutWrite);
    process.stderr.write = teeWrite(rawStderrWrite);
    logStream.write(`\n[${new Date().toISOString()}] [symphony] poller starting (pid=${process.pid})\n`);
  }
}

// ── Config types ──────────────────────────────────────────────────────────────

/** Slack-system config block. Appears at any level (global, board, project, repo)
 *  and is deep-merged top-down by `resolveSlack`. */
interface SlackConfig {
  /** Channel for PR review notifications (id is the Slack channel id like "C09..."). */
  codeReviewChannel?: { name: string; id: string };
  /** Optional cross-post target (e.g. team-wide #e-code-review). */
  crossPost?: { name: string; id: string };
  /** Nickname → Slack user ID. Used by skills like notify-review to @-mention
   *  reviewers without searching Slack each time. */
  reviewers?: Record<string, string>;
}

/** GitHub-system config block. Appears at any level (global, board, project, repo)
 *  and is deep-merged top-down by `resolveGithub`. */
interface GithubConfig {
  /** Comment to post on a PR to trigger an external AI review bot.
   *  When set, the poller posts this instead of having Claude review the diff itself.
   *  An empty string at a lower level disables AI review for that level specifically.
   *  If absent across all levels, AI review is skipped. */
  codeReviewComment?: string;
}

interface RepoConfig {
  name: string;
  path: string;
  worktreesDir: string;
  defaultBranch: string;
  /** GitHub `owner/repo` slug used by `gh` commands and PR URL construction.
   *  Renamed from `github` to `githubRepo` in UP-761 so the per-repo `github`
   *  namespace (`github.codeReviewComment` etc.) doesn't collide with this. */
  githubRepo: string;
  isMono: boolean;
  /** Per-repo overrides — deep-merged on top of board.slack. */
  slack?: SlackConfig;
  /** Per-repo GitHub overrides — deep-merged on top of board.github. */
  github?: GithubConfig;
  /** Sentry project slug (lowercase) for tickets created by the Sentry-Linear /
   *  Sentry-Jira integrations. When unset, the repo name is used. */
  sentryProject?: string;
  setup: {
    symlinkNodeModules: boolean;
    installCommand: string;
    installCheck: string;
  };
}

interface ProjectConfig {
  name: string;
  primaryRepo: string;
  repos: Array<{ name: string; path: string }>;
  /** Per-project Linear overrides. `projectId` is the Linear project UUID and
   *  is what the poller matches `ticket.project.id` against on Linear boards. */
  linear?: { projectId?: string };
  /** Per-project Jira overrides. `projectLabel` is the Jira label (e.g.
   *  `project:symphony`) that routes a ticket to this Symphony project. */
  jira?: { projectLabel?: string };
  /** Per-project GitHub-Projects overrides. `projectLabel` is the issue label
   *  (e.g. `project:symphony`) that routes a ticket to this Symphony project. */
  githubProjects?: { projectLabel?: string };
  /** Per-project Slack overrides — deep-merged on top of board.slack. */
  slack?: SlackConfig;
  /** Per-project GitHub overrides — deep-merged on top of board.github. */
  github?: GithubConfig;
}

type TicketSystem = 'linear' | 'jira' | 'github-projects';

interface BoardConfig {
  /** Linear: team UUID. Jira: project key (e.g. "UP"). */
  teamId: string;
  name: string;
  ticketPrefix: string;
  /** "linear" (default) or "jira". Missing defaults to linear; typos are rejected. */
  ticketSystem?: TicketSystem;
  /** Per-board assignee override. Linear: user UUID. Jira: Jira accountId.
   *  When unset, boards fall back to the global `symphony.json` assigneeId — which
   *  only makes sense if every board shares the same backend. Mixed Linear+Jira
   *  configs must set this explicitly on at least the Jira board(s). */
  assigneeId?: string;
  /** Linear-system block (required on Linear boards). */
  linear?: BoardLinearConfig;
  /** Jira-system block (required on Jira boards). */
  jira?: BoardJiraConfig;
  /** GitHub-Projects block (required on github-projects boards). */
  githubProjects?: BoardGithubProjectsConfig;
  /** Board-level Slack overrides — deep-merged on top of global symphony.slack. */
  slack?: SlackConfig;
  /** Board-level GitHub overrides — deep-merged on top of global symphony.github. */
  github?: GithubConfig;
  defaultRepo: string;
  /** Agent runtime to use when a ticket has no `runtime:<name>` label.
   *  "claude" (default) spawns claude with the existing session/remote-control
   *  plumbing. "codex" spawns the codex CLI directly without pty/session files. */
  defaultRuntime?: AgentRuntime;
  repos: RepoConfig[];
  projects: ProjectConfig[];
}

type AgentRuntime = 'claude' | 'codex';

const RUNTIME_LABEL_PREFIX = 'runtime:';

/** Pick the runtime for a ticket. Resolution order, highest priority first:
 *    1. ticket label `runtime:<name>` (per-ticket override)
 *    2. board `defaultRuntime` (per-board override)
 *    3. global `symphony.json` `defaultRuntime` (per-machine default)
 *    4. built-in `"claude"`
 *  Unknown values throw — typos like `runtime:Codex` should not silently fall back. */
function runtimeFor(ticket: Issue, board: BoardConfig): AgentRuntime {
  const label = ticket.labels.find((l) => l.toLowerCase().startsWith(RUNTIME_LABEL_PREFIX));
  const raw = label
    ? label.slice(RUNTIME_LABEL_PREFIX.length).trim().toLowerCase()
    : (board.defaultRuntime ?? symphonyConfig.defaultRuntime ?? 'claude');
  if (raw !== 'claude' && raw !== 'codex') {
    throw new Error(`[config] Ticket ${ticket.identifier} has unknown runtime ${JSON.stringify(raw)}. Expected "claude" or "codex".`);
  }
  return raw;
}

/** Resolve the adapter for a board. Unknown values are rejected rather than
 *  silently falling back to Linear — catches `ticketSystem: "jirA"` typos. */
function ticketSystemFor(board: BoardConfig): TicketSystem {
  const system = board.ticketSystem ?? 'linear';
  if (system !== 'linear' && system !== 'jira' && system !== 'github-projects') {
    throw new Error(`[config] Board "${board.name}" has unknown ticketSystem: ${JSON.stringify(system)}. Expected "linear", "jira", or "github-projects".`);
  }
  return system;
}

function getAdapter(board: BoardConfig): TicketSystemAdapter {
  const system = ticketSystemFor(board);
  if (system === 'jira') return jiraAdapter;
  if (system === 'github-projects') return githubProjectsAdapter;
  return linearAdapter;
}

function assigneeIdFor(board: BoardConfig): string {
  return board.assigneeId ?? ASSIGNEE_ID;
}

interface SymphonyConfig {
  assigneeId: string;
  maxConcurrent: number;
  pollIntervalSeconds: number;
  remoteControl: boolean;
  /** Per-machine default runtime. Personal machines may set `"codex"` here so
   *  every board without an explicit override prefers codex; a board can still
   *  pin `"claude"` via its own `defaultRuntime`. */
  defaultRuntime?: AgentRuntime;
  preferences: {
    personalLanguage: string;
    workLanguage: string;
    neverUseLanguage: string;
  };
  /** Global Slack defaults — deep-merged into every board's `slack` block. */
  slack?: SlackConfig;
  /** Global GitHub defaults — deep-merged into every board's `github` block. */
  github?: GithubConfig;
}

/** Active state map for a board: the system block whose `states` field the
 *  poller compares ticket state IDs against. Throws if the board is missing
 *  the namespace its `ticketSystem` declares. */
function statesFor(board: BoardConfig): StateKeys {
  const system = ticketSystemFor(board);
  if (system === 'jira') {
    if (!board.jira) throw new Error(`[config] Jira board "${board.name}" is missing the "jira" config block`);
    return board.jira.states;
  }
  if (system === 'github-projects') {
    if (!board.githubProjects) throw new Error(`[config] github-projects board "${board.name}" is missing the "githubProjects" config block`);
    return board.githubProjects.states;
  }
  if (!board.linear) throw new Error(`[config] Linear board "${board.name}" is missing the "linear" config block`);
  return board.linear.states;
}

/** Identifier used to match a Linear ticket's project / Jira label against
 *  a Symphony project entry. Linear projects use UUIDs; Jira tickets use
 *  the `project:<slug>` label (resolved by the Jira adapter into `ticket.project.id`). */
function projectKeyFor(board: BoardConfig, project: ProjectConfig): string | undefined {
  const system = ticketSystemFor(board);
  if (system === 'jira') return project.jira?.projectLabel;
  if (system === 'github-projects') return project.githubProjects?.projectLabel;
  return project.linear?.projectId;
}

/** Deep-merge plain objects. Arrays and primitives are replaced wholesale by
 *  later sources; nested plain objects are merged key-by-key. Used by
 *  `resolveSlack` to compose global → board → project → repo overrides. */
function deepMerge<T extends Record<string, unknown>>(...sources: (Partial<T> | undefined)[]): T {
  const out: Record<string, unknown> = {};
  for (const src of sources) {
    if (!src) continue;
    for (const [key, value] of Object.entries(src)) {
      const prev = out[key];
      if (
        value && typeof value === 'object' && !Array.isArray(value) &&
        prev && typeof prev === 'object' && !Array.isArray(prev)
      ) {
        out[key] = deepMerge(prev as Record<string, unknown>, value as Record<string, unknown>);
      } else if (value !== undefined) {
        out[key] = value;
      }
    }
  }
  return out as T;
}

/** Resolve effective Slack config for a (board, project?, repo?) tuple by
 *  deep-merging global → board → project → repo overrides. */
function resolveSlack(
  symphony: SymphonyConfig,
  board: BoardConfig,
  project?: ProjectConfig,
  repo?: RepoConfig,
): SlackConfig {
  return deepMerge<SlackConfig>(symphony.slack, board.slack, project?.slack, repo?.slack);
}

/** Resolve effective GitHub config for a (board, project?, repo?) tuple by
 *  deep-merging global → board → project → repo overrides. */
function resolveGithub(
  symphony: SymphonyConfig,
  board: BoardConfig,
  project?: ProjectConfig,
  repo?: RepoConfig,
): GithubConfig {
  return deepMerge<GithubConfig>(symphony.github, board.github, project?.github, repo?.github);
}

/** Look up the Symphony project entry for a ticket. Used by call sites that
 *  need per-project overrides (e.g. `spawnAIReview` reading project-level
 *  `github.codeReviewComment`). Returns null when the ticket has no project
 *  or is not in the board's `projects[]`. */
function resolveProject(ticket: Issue, board: BoardConfig): ProjectConfig | null {
  if (!ticket.project) return null;
  const resolved = projectMap.get(ticket.project.id);
  return resolved && resolved.board === board ? resolved.project : null;
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

// ── Sync trusted folders ───────────────────────────────────────────────────────

/**
 * Sync all board repo worktreesDirs into Claude's localAgentModeTrustedFolders.
 * Claude Code shows a blocking trust dialog for new directories in interactive
 * (PTY/remote-control) mode. Pre-registering worktree parent dirs suppresses it.
 */
function syncTrustedFolders(boards: BoardConfig[]): void {
  const claudeConfigPath = path.join(
    process.env['HOME'] ?? '',
    'Library/Application Support/Claude/claude_desktop_config.json',
  );
  if (!fs.existsSync(claudeConfigPath)) return;

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8'));
  } catch {
    return;
  }

  const prefs = (config['preferences'] ?? {}) as Record<string, unknown>;
  const existing = new Set<string>((prefs['localAgentModeTrustedFolders'] as string[] | undefined) ?? []);
  const added: string[] = [];

  for (const board of boards) {
    for (const repo of board.repos) {
      const raw = (repo as unknown as { worktreesDir?: string }).worktreesDir;
      if (!raw) continue;
      const expanded = raw.replace(/^~/, process.env['HOME'] ?? '');
      if (!existing.has(expanded)) {
        existing.add(expanded);
        added.push(expanded);
      }
    }
  }

  if (added.length === 0) return;

  prefs['localAgentModeTrustedFolders'] = [...existing];
  config['preferences'] = prefs;
  fs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2));
  for (const p of added) log(chalk.dim(`[symphony] Trusted folder added: ${p}`));
}

// Per-board credentials are validated lazily below, once we know which
// ticketSystem values appear in the loaded board configs.

const symphonyJsonPath = path.join(CONFIG_DIR, 'symphony.json');
if (!fs.existsSync(symphonyJsonPath)) {
  console.error(chalk.red('ERROR: config/symphony.json not found.'));
  console.error(chalk.yellow('Run the following to initialize:'));
  console.error(chalk.cyan(`  cp ${SYMPHONY_ROOT}/config-example/symphony.json ${CONFIG_DIR}/symphony.json`));
  console.error(chalk.cyan(`  # Then edit ${CONFIG_DIR}/symphony.json and fill in your Linear assigneeId`));
  process.exit(1);
}
const symphonyConfig: SymphonyConfig = JSON.parse(fs.readFileSync(symphonyJsonPath, 'utf8'));

const boardsDir = path.join(CONFIG_DIR, 'boards');
const boardFiles = fs.existsSync(boardsDir)
  ? fs.readdirSync(boardsDir).filter((f) => f.endsWith('.json'))
  : [];
if (boardFiles.length === 0) {
  console.error(chalk.red('ERROR: No board configs found in config/boards/.'));
  console.error(chalk.yellow('Run the following to initialize:'));
  console.error(chalk.cyan(`  mkdir -p ${boardsDir}`));
  console.error(chalk.cyan(`  cp ${SYMPHONY_ROOT}/config-example/boards/wor.json ${boardsDir}/<your-board>.json`));
  console.error(chalk.cyan(`  # Then edit the file and fill in your teamId, state UUIDs, and repos`));
  process.exit(1);
}
const boards: BoardConfig[] = boardFiles.map((f) =>
  JSON.parse(fs.readFileSync(path.join(boardsDir, f), 'utf8'))
);

let lastDashboardLines = 0;
syncTrustedFolders(boards);

// Build lookup: project key (Linear projectId / Jira projectLabel) → { project, repo }
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
    const key = projectKeyFor(board, project);
    if (!key) {
      console.warn(chalk.yellow(`[config] Project "${project.name}" on board "${board.name}" is missing ${
        ticketSystemFor(board) === 'jira' ? 'jira.projectLabel'
          : ticketSystemFor(board) === 'github-projects' ? 'githubProjects.projectLabel'
          : 'linear.projectId'
      }`));
      continue;
    }
    projectMap.set(key, { project, primaryRepo, board });
  }
}

const MAX_CONCURRENT = symphonyConfig.maxConcurrent;
const POLL_INTERVAL_MS = symphonyConfig.pollIntervalSeconds * 1000;
const REMOTE_CONTROL = symphonyConfig.remoteControl;
const ASSIGNEE_ID = symphonyConfig.assigneeId;

if (ASSIGNEE_ID === 'YOUR_LINEAR_USER_UUID') {
  console.error(chalk.red('\n[symphony] ✗ assigneeId 未配置'));
  console.error(chalk.yellow('  symphony.json 里的 assigneeId 还是占位符，需要填入你的 Linear 用户 UUID。'));
  console.error(chalk.cyan('\n  修复方法：'));
  console.error(chalk.cyan(`  1. 编辑 ${path.join(CONFIG_DIR, 'symphony.json')}`));
  console.error(chalk.cyan('  2. 将 assigneeId 替换为你的 Linear 用户 UUID'));
  console.error(chalk.cyan('  3. 如不知道 UUID，可在 Linear → Settings → Account 查看，'));
  console.error(chalk.cyan('     或运行：'));
  console.error(chalk.white(`     curl -s -X POST https://api.linear.app/graphql \\`));
  console.error(chalk.white(`       -H "Authorization: $LINEAR_API_KEY" \\`));
  console.error(chalk.white(`       -H "Content-Type: application/json" \\`));
  console.error(chalk.white(`       -d '{"query":"{ viewer { id name } }"}'\n`));
  process.exit(1);
}

// Per-backend credential checks — only enforce what the configured boards actually need.
const hasLinearBoard = boards.some((b) => ticketSystemFor(b) === 'linear');
const hasJiraBoard = boards.some((b) => ticketSystemFor(b) === 'jira');
const hasGithubProjectsBoard = boards.some((b) => ticketSystemFor(b) === 'github-projects');

if (hasLinearBoard && !process.env['LINEAR_API_KEY']) {
  console.error(chalk.red('ERROR: LINEAR_API_KEY not set in $SYMPHONY_ROOT/secrets.env (required by a Linear board)'));
  process.exit(1);
}
if (hasJiraBoard) {
  const missing = ['JIRA_EMAIL', 'JIRA_API_TOKEN'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(chalk.red(`ERROR: ${missing.join(', ')} not set in $SYMPHONY_ROOT/secrets.env (required by a Jira board)`));
    console.error(chalk.yellow('  Create a Jira API token at https://id.atlassian.com/manage-profile/security/api-tokens'));
    process.exit(1);
  }
  for (const b of boards.filter((b) => ticketSystemFor(b) === 'jira')) {
    if (!b.jira?.baseUrl) {
      console.error(chalk.red(`ERROR: Jira board "${b.name}" is missing "jira.baseUrl" (e.g. "https://your-org.atlassian.net")`));
      process.exit(1);
    }
  }
}
if (hasGithubProjectsBoard) {
  if (!process.env['GITHUB_TOKEN']) {
    console.error(chalk.red('ERROR: GITHUB_TOKEN not set in $SYMPHONY_ROOT/secrets.env (required by a github-projects board)'));
    console.error(chalk.yellow('  Create a fine-grained PAT with Issues:write + Projects:write + Metadata:read'));
    process.exit(1);
  }
  for (const b of boards.filter((b) => ticketSystemFor(b) === 'github-projects')) {
    const gp = b.githubProjects;
    if (!gp) {
      console.error(chalk.red(`ERROR: github-projects board "${b.name}" is missing the "githubProjects" config block`));
      process.exit(1);
    }
    const missing = [
      ['owner', gp.owner],
      ['projectNumber', gp.projectNumber],
      ['repo', gp.repo],
      ['states', gp.states],
    ].filter(([, v]) => v === undefined || v === null || v === '').map(([k]) => `githubProjects.${k}`);
    if (missing.length) {
      console.error(chalk.red(`ERROR: github-projects board "${b.name}" is missing ${missing.join(', ')}`));
      process.exit(1);
    }
    if (!gp.repo.includes('/')) {
      console.error(chalk.red(`ERROR: github-projects board "${b.name}" has invalid "githubProjects.repo" — expected "owner/name", got ${JSON.stringify(gp.repo)}`));
      process.exit(1);
    }
  }
}

// ── Ticket-system dispatch ────────────────────────────────────────────────────

async function fetchTicketsByState(board: BoardConfig, stateKey: StateKey): Promise<Issue[]> {
  return getAdapter(board).fetchTicketsByState(board, stateKey, assigneeIdFor(board));
}

async function fetchTicketStateId(board: BoardConfig, identifier: string): Promise<string | null> {
  return getAdapter(board).fetchTicketStateId(board, identifier);
}

async function fetchTicketByIdentifier(board: BoardConfig, identifier: string): Promise<Issue | null> {
  return getAdapter(board).fetchTicketByIdentifier(board, identifier);
}

// ── Resolve ticket → repo ─────────────────────────────────────────────────────

/**
 * Parse the Sentry project slug out of a ticket description.
 *
 * The Sentry-Linear and Sentry-Jira integrations both embed a line like:
 *   ** Sentry Issue: [WORKSTREAM-HR-18B](https://...sentry.io/...)
 * where `WORKSTREAM-HR` is the (uppercased) Sentry project slug and `18B` is
 * the per-issue short ID. Returns the lowercase slug, or null when the ticket
 * doesn't look like a Sentry-sourced one.
 */
function parseSentryProjectSlug(description: string | null): string | null {
  if (!description) return null;
  const m = description.match(/Sentry Issue:[\s\[*]*([A-Z][A-Z0-9-]*-[A-Z0-9]+)/);
  if (!m) return null;
  const parts = m[1]!.split('-');
  if (parts.length < 2) return null;
  parts.pop(); // drop the short ID
  return parts.join('-').toLowerCase();
}

function resolveSentryRepo(ticket: Issue, board: BoardConfig): RepoConfig | null {
  const slug = parseSentryProjectSlug(ticket.description);
  if (!slug) return null;
  return board.repos.find((r) => (r.sentryProject ?? r.name).toLowerCase() === slug) ?? null;
}

/**
 * Cache the repo a ticket's branch was found to live in, so the GitHub probe in
 * `resolveRepoByPR` runs at most once per ticket per poller process. Keyed by
 * board + project + ticket identifier (see `resolvedRepoCacheKey`) so a ticket
 * that gets re-labelled into a different project mid-process is not served a
 * stale repo. Only positive probe hits are cached — the primaryRepo fallback
 * (no PR found anywhere) is never cached, so a branch pushed on a later cycle is
 * still detected (UP-824).
 */
const resolvedRepoCache = new Map<string, RepoConfig>();

function resolvedRepoCacheKey(board: BoardConfig, ticket: Issue): string {
  return `${board.name}:${ticket.project?.id ?? '(no-project)'}:${ticket.identifier}`;
}

/**
 * Probe which repo in a multi-repo project actually owns the ticket's branch.
 *
 * A project label (e.g. `project:hiring`) can span several repos and the branch
 * may land in any of them, not necessarily `project.primaryRepo`. We ask GitHub
 * which candidate repo has an open OR merged PR for `feat/<TICKET_ID>-*`, using
 * `gh pr list --state all` rather than probing `git ls-remote`: the remote
 * branch is deleted on merge, but the PR record survives. This is the same
 * signal `areAllPRsMerged()` relies on, so the two stay consistent — which is
 * the bug UP-824 fixes (resolveRepo returning primaryRepo while the merged PR
 * lived elsewhere left tickets stuck in Merging forever).
 *
 * A CLOSED-but-unmerged PR does NOT count as ownership: a stale closed PR left
 * by a rework/reset in an earlier candidate repo must not shadow the real
 * open/merged PR in a later one (that would reproduce the same deadlock). We
 * therefore fetch `state` and accept only OPEN / MERGED — exactly the states
 * `areAllPRsMerged()` keys off.
 *
 * Returns the owning repo, or null when no candidate claims the branch (e.g. a
 * fresh ticket whose branch hasn't been pushed yet).
 */
function resolveRepoByPR(
  ticket: Issue,
  project: ProjectConfig,
  repoMap: Map<string, RepoConfig>,
): RepoConfig | null {
  const branch = branchForIssue(ticket);
  for (const entry of project.repos) {
    const repo = repoMap.get(entry.name);
    if (!repo) continue;
    const result = child_process.spawnSync(
      'gh',
      ['pr', 'list', '--repo', repo.githubRepo, '--head', branch, '--state', 'all', '--json', 'state', '--limit', '20'],
      { encoding: 'utf8', timeout: 15_000, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } },
    );
    if (result.status !== 0) continue;
    try {
      const prs = JSON.parse(result.stdout) as Array<{ state: string }>;
      if (prs.some((pr) => pr.state === 'OPEN' || pr.state === 'MERGED')) return repo;
    } catch { /* malformed gh output — treat as no PR */ }
  }
  return null;
}

function resolveRepo(ticket: Issue, board: BoardConfig): RepoConfig {
  const repoMap = new Map<string, RepoConfig>(board.repos.map((r) => [r.name, r]));
  const sentryRepo = resolveSentryRepo(ticket, board);
  if (sentryRepo) return sentryRepo;
  if (ticket.project) {
    const resolved = projectMap.get(ticket.project.id);
    if (resolved) {
      const cacheKey = resolvedRepoCacheKey(board, ticket);
      const cached = resolvedRepoCache.get(cacheKey);
      if (cached) return cached;
      // Multi-repo project: the branch may live in a non-primary repo, so probe
      // GitHub for the repo that actually owns the PR before falling back.
      if (resolved.project.repos.length > 1) {
        const owner = resolveRepoByPR(ticket, resolved.project, repoMap);
        if (owner) {
          resolvedRepoCache.set(cacheKey, owner);
          return owner;
        }
      }
      return resolved.primaryRepo;
    }
  }
  return repoMap.get(board.defaultRepo) ?? board.repos[0];
}

function resolveProjectPath(ticket: Issue, board: BoardConfig): string {
  const sentryRepo = resolveSentryRepo(ticket, board);
  if (sentryRepo) {
    // When the ticket also belongs to a project that itemizes per-repo paths,
    // prefer that path (e.g. monorepo sub-app paths). Otherwise fall back to
    // the repo root.
    if (ticket.project) {
      const resolved = projectMap.get(ticket.project.id);
      const repoEntry = resolved?.project.repos.find((r) => r.name === sentryRepo.name);
      if (repoEntry?.path) {
        return repoEntry.path.replace(/^~/, process.env['HOME'] ?? '~');
      }
    }
    return '';
  }
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
  // OR if it has no project, OR if the board doesn't itemize projects
  // (Jira boards usually don't — they fall back to defaultRepo).
  if (!ticket.project) return true;
  if (!board.projects?.length) return true;
  return board.projects.some((p) => projectKeyFor(board, p) === ticket.project!.id);
}

// ── State transitions ─────────────────────────────────────────────────────────

async function moveToState(board: BoardConfig, issueId: string, identifier: string, stateKey: StateKey, label: string, color: (s: string) => string): Promise<void> {
  await getAdapter(board).moveToState(board, issueId, stateKey);
  log(color(`[symphony] ${identifier} → ${label}`));
}

const moveToInProgress = (b: BoardConfig, id: string, ident: string) =>
  moveToState(b, id, ident, 'inProgress', 'In Progress', chalk.cyan);
const moveToHumanReview = (b: BoardConfig, id: string, ident: string) =>
  moveToState(b, id, ident, 'humanReview', 'Human Review', chalk.magenta);
const moveToDone = (b: BoardConfig, id: string, ident: string) =>
  moveToState(b, id, ident, 'done', 'Done ✓', chalk.green);
const moveToMerging = (b: BoardConfig, id: string, ident: string) =>
  moveToState(b, id, ident, 'merging', 'Merging', chalk.blue);
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
  const worktreePath = path.join(worktreesDir, branchToFolder(branch));

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

  // 2. Delete stale lock comments + workpad (best-effort)
  try {
    const adapter = getAdapter(board);
    const comments = await adapter.listComments(board, issue.id);
    const staleComments = comments.filter((c) =>
      c.body.includes('## Claude Workpad') ||
      c.body.startsWith('[symphony] aiReviewRequested:') ||
      c.body.startsWith('[symphony] developerApproved:') ||
      c.body.startsWith('[symphony] feedbackReroute:')
    );
    await Promise.all(staleComments.map((c) => adapter.deleteComment(board, issue.id, c.id)));
    if (staleComments.length) {
      log(chalk.dim(`[symphony] Deleted ${staleComments.length} stale comment(s) for ${identifier}`));
    }
  } catch { /* best-effort */ }

  // 3. Clear notify labels so the next Human Review cycle can re-notify (best-effort).
  //    Without this, a ticket sent through Rework would carry `review-notified`
  //    forward — and the next Human Review pass would see both labels present
  //    and skip notify forever.
  try {
    const adapter = getAdapter(board);
    if (adapter.hasLabel(issue, REVIEW_NOTIFIED_LABEL)) {
      await adapter.removeLabel(board, issue.id, REVIEW_NOTIFIED_LABEL);
    }
    if (adapter.hasLabel(issue, NEEDS_NOTIFY_LABEL)) {
      await adapter.removeLabel(board, issue.id, NEEDS_NOTIFY_LABEL);
    }
  } catch { /* best-effort */ }

  // 4. Remove local worktree (best-effort)
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

  // 5. Move ticket back to Todo — next poll cycle picks it up fresh
  await moveToTodo(board, issue.id, identifier);
}

/**
 * Derive the branch name for a ticket using the same slug logic as spawnAgent.
 */
function branchForIssue(issue: Issue): string {
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/-$/, '');
  return `feat/${issue.identifier}-${slug}`;
}

/**
 * Map a branch name to its worktree folder name.
 *
 * Must stay in lockstep with `run-ticket.sh`, which uses `tr '/' '--'` — and
 * because `tr` maps source set to destination set character-by-character, the
 * trailing `-` in the destination is dropped and `/` is replaced by a single
 * `-`. Diverging here would make the poller look up `.claude-session-id` and
 * worktrees at paths that do not exist on disk.
 */
function branchToFolder(branch: string): string {
  return branch.replace(/\//g, '-');
}

/**
 * Resolve the absolute worktree path a spawn for `issue` would use. Single
 * source of truth so the spawn path and the worktree-busy guard agree.
 */
function computeWorktreePath(issue: Issue, board: BoardConfig): { branch: string; worktreePath: string } {
  const repo = resolveRepo(issue, board);
  const worktreesDir = repo.worktreesDir.replace(/^~/, process.env['HOME'] ?? '~');
  const branch = branchForIssue(issue);
  return { branch, worktreePath: path.join(worktreesDir, branchToFolder(branch)) };
}

/**
 * Return the identifier of a different ticket whose agent currently runs on
 * the worktree `issue` would spawn into, or null if the worktree is free.
 */
function worktreeOccupiedBy(issue: Issue, board: BoardConfig): string | null {
  const { worktreePath } = computeWorktreePath(issue, board);
  for (const [otherId, other] of runningAgents) {
    if (otherId === issue.identifier) continue;
    if (other.worktreePath === worktreePath) return otherId;
  }
  return null;
}

/**
 * Check whether all PRs for a ticket's branch have been merged on GitHub
 * (i.e. at least one merged PR exists and no open PRs remain).
 * Returns true only when it is safe to finalize: merged exists AND no open PR.
 */
function areAllPRsMerged(issue: Issue, board: BoardConfig): boolean {
  const repo = resolveRepo(issue, board);
  const repoPath = repo.path.replace(/^~/, process.env['HOME'] ?? '~');
  const branch = branchForIssue(issue);
  const ghOpts = { encoding: 'utf8' as const, cwd: repoPath };
  // If an open PR still exists, the ticket is not ready to finalize
  const openResult = child_process.spawnSync(
    'gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--limit', '1'], ghOpts
  );
  try { if (openResult.status === 0 && (JSON.parse(openResult.stdout) as unknown[]).length > 0) return false; } catch { /* ignore */ }
  // Check for at least one merged PR
  const mergedResult = child_process.spawnSync(
    'gh', ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number', '--limit', '1'], ghOpts
  );
  if (mergedResult.status !== 0) return false;
  try { return (JSON.parse(mergedResult.stdout) as unknown[]).length > 0; } catch { return false; }
}

/**
 * Resolve an explicit PR URL and report whether GitHub considers it MERGED.
 * Used by the Human Review fast-path as a fallback when the ticket records a
 * pre-existing PR (different branch) in the workpad.
 */
function isPRUrlMerged(prUrl: string): boolean {
  const result = child_process.spawnSync(
    'gh', ['pr', 'view', prUrl, '--json', 'state', '-q', '.state'],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    }
  );
  if (result.error || result.status !== 0) return false;
  return result.stdout.trim() === 'MERGED';
}

/**
 * One-shot cleanup for a ticket the human moved to a terminal cancelled state.
 *
 * Closes any open PR for the synthesized branch, removes the worktree, and
 * posts a single audit comment. The dispatcher (state-machine.mts) guards
 * this so it fires only on the prev→cancelled edge — UP-775. Every operation
 * is best-effort: a partial failure logs and moves on rather than throwing,
 * because the alternative is the same one-shot retrying every poll cycle.
 */
async function cleanupCancelledTicket(issue: Issue, board: BoardConfig): Promise<void> {
  const branch = branchForIssue(issue);
  const repo = resolveRepo(issue, board);
  try {
    child_process.spawnSync(
      'gh',
      ['pr', 'close', branch, '--repo', repo.githubRepo, '--delete-branch'],
      { encoding: 'utf8', timeout: 15_000 },
    );
  } catch (err) {
    log(chalk.yellow(`[symphony] gh pr close failed for ${issue.identifier}: ${err}`));
  }
  removeWorktree(issue, board);
  try {
    await postComment(board, issue.id, '[symphony] cancelled — closed any open PR and removed the worktree.');
  } catch (err) {
    log(chalk.yellow(`[symphony] cancelled audit comment failed for ${issue.identifier}: ${err}`));
  }
}

/**
 * Remove the local worktree for a ticket (best-effort).
 */
function removeWorktree(issue: Issue, board: BoardConfig): void {
  const repo = resolveRepo(issue, board);
  const repoPath = repo.path.replace(/^~/, process.env['HOME'] ?? '~');
  const worktreesDir = repo.worktreesDir.replace(/^~/, process.env['HOME'] ?? '~');
  const folder = branchToFolder(branchForIssue(issue));
  const worktreePath = path.join(worktreesDir, folder);
  if (!fs.existsSync(worktreePath)) return;
  const r = child_process.spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { encoding: 'utf8', cwd: repoPath });
  if (r.status === 0) {
    child_process.spawnSync('git', ['worktree', 'prune'], { encoding: 'utf8', cwd: repoPath });
    log(chalk.dim(`[symphony] Removed worktree for ${issue.identifier}`));
  } else {
    log(chalk.yellow(`[symphony] Failed to remove worktree for ${issue.identifier}: ${r.stderr?.trim()}`));
  }
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
  logOffset: number;
  /** Set when a user invoked `kill`/`restart`; the exit handler must skip
   *  retries, rate-limit checks, and the auto Human Review transition. */
  userKilled?: boolean;
}

const runningAgents = new Map<string, AgentEntry>();
let isShuttingDown = false;
type DashboardState = 'todo' | 'blocked' | 'inProgress' | 'humanReview' | 'merging' | 'rework';
interface DashboardRow { ticket: Issue; board: BoardConfig; state: DashboardState }
let lastSnapshot: DashboardRow[] = [];

const STATE_ORDER: DashboardState[] = ['merging', 'inProgress', 'humanReview', 'rework', 'todo', 'blocked'];

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function renderStatus(row: DashboardRow): string {
  const agent = runningAgents.get(row.ticket.identifier);
  if (agent) {
    const dur = formatDuration(Date.now() - agent.spawnedAt);
    const label = agent.spawnedForMerging ? 'Merging' : 'Running';
    const color = agent.spawnedForMerging ? chalk.magenta : chalk.cyan;
    return `${color(label)} ${chalk.dim(dur)}`;
  }
  switch (row.state) {
    case 'merging': return chalk.magenta('Merging');
    case 'inProgress': return chalk.cyan('In Progress');
    case 'humanReview': return chalk.magenta('Human Review');
    case 'rework': return chalk.red('Rework');
    case 'todo': return chalk.yellow('Todo');
    case 'blocked': return chalk.dim('Blocked');
  }
}

function buildDashboard(updatedAt: string): string {
  const seen = new Set<string>();
  const rows: DashboardRow[] = [];
  for (const r of lastSnapshot) {
    if (seen.has(r.ticket.identifier)) continue;
    seen.add(r.ticket.identifier);
    rows.push(r);
  }
  for (const [id, agent] of runningAgents) {
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ ticket: agent.ticket, board: agent.board, state: agent.spawnedForMerging ? 'merging' : 'inProgress' });
  }

  rows.sort((a, b) => {
    const ra = runningAgents.has(a.ticket.identifier) ? 0 : 1;
    const rb = runningAgents.has(b.ticket.identifier) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    const sa = STATE_ORDER.indexOf(a.state);
    const sb = STATE_ORDER.indexOf(b.state);
    if (sa !== sb) return sa - sb;
    return a.ticket.identifier.localeCompare(b.ticket.identifier);
  });

  const table = new Table({
    head: [
      chalk.bold.white('Ticket'),
      chalk.bold.white('Status'),
      chalk.bold.white('Project'),
      chalk.bold.white('Repo'),
      chalk.bold.white('Summary'),
    ],
    colWidths: [10, 18, 22, 18, 50],
    style: { head: [], border: ['gray'] },
    wordWrap: true,
  });

  for (const row of rows) {
    const repo = resolveRepo(row.ticket, row.board);
    table.push([
      chalk.bold(row.ticket.identifier),
      renderStatus(row),
      row.ticket.project?.name ?? chalk.dim('—'),
      repo?.name ?? chalk.dim('—'),
      row.ticket.title,
    ]);
  }

  if (!rows.length) table.push([chalk.dim('(none)'), chalk.dim('—'), chalk.dim('—'), chalk.dim('—'), chalk.dim('—')]);

  let out = table.toString();
  out += `\n  ${chalk.dim(`Updated ${updatedAt}  •  agents ${runningAgents.size}/${MAX_CONCURRENT}  •  boards: ${boards.map((b) => b.ticketPrefix).join(', ')}  •  next poll in ${POLL_INTERVAL_MS / 1000}s`)}`;
  out += `\n  ${chalk.dim(`Type ${chalk.white('resume <id>')} / ${chalk.white('kill <id>')} / ${chalk.white('restart <id>')}  •  ${chalk.white('help')} for commands`)}`;
  return out;
}

function renderDashboard(): void {
  const ts = new Date().toTimeString().slice(0, 8);
  const dashboard = buildDashboard(ts);
  const lines = dashboard.split('\n');
  if (lastDashboardLines > 0) rawStdoutWrite(`\x1b[${lastDashboardLines}A\x1b[0J`);
  rawStdoutWrite(dashboard + '\n');
  lastDashboardLines = lines.length;
  if (HTML_MODE) writeHtmlDashboard(ts);
}

/**
 * Build the HTML row list from the same in-memory state buildDashboard uses,
 * then render the document to HTML_DASHBOARD_FILE. Best-effort: write errors
 * are logged but never crash the poller.
 */
/**
 * Open the rendered dashboard in the user's default browser on startup so
 * `--html` is one-shot — no need to copy/paste the path.
 */
function openHtmlDashboard(): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  try {
    child_process.spawn(cmd, [HTML_DASHBOARD_FILE], { stdio: 'ignore', detached: true }).unref();
  } catch (err) {
    log(chalk.yellow(`[symphony] Failed to open HTML dashboard: ${(err as Error).message}`));
  }
}

function writeHtmlDashboard(updatedAt: string): void {
  const seen = new Set<string>();
  const rawRows: DashboardRow[] = [];
  for (const r of lastSnapshot) {
    if (seen.has(r.ticket.identifier)) continue;
    seen.add(r.ticket.identifier);
    rawRows.push(r);
  }
  for (const [id, agent] of runningAgents) {
    if (seen.has(id)) continue;
    seen.add(id);
    rawRows.push({ ticket: agent.ticket, board: agent.board, state: agent.spawnedForMerging ? 'merging' : 'inProgress' });
  }

  const htmlRows: HtmlRow[] = rawRows.map((row) => {
    const agent = runningAgents.get(row.ticket.identifier);
    // `.claude-session-id` only maps to a claude.ai/agents/<id> URL when the
    // agent was spawned with `--remote-control`. Without it the file still
    // exists (run-ticket.sh always writes one) but the session was never
    // registered, so the link would 404. Suppress the column in that case.
    const sessionId = agent && REMOTE_CONTROL ? readSessionId(agent.worktreePath) : null;
    const repo = resolveRepo(row.ticket, row.board);
    const repoUrl = repo?.githubRepo ? `https://github.com/${repo.githubRepo}` : null;
    let statusKind: HtmlStatusKind;
    let statusLabel: string;
    let runtimeLabel: string | null = null;
    let spawnedAtMs: number | null = null;
    if (agent) {
      statusKind = agent.spawnedForMerging ? 'merging' : 'running';
      statusLabel = agent.spawnedForMerging ? 'Merging' : 'Running';
      runtimeLabel = formatDuration(Date.now() - agent.spawnedAt);
      spawnedAtMs = agent.spawnedAt;
    } else {
      statusKind = row.state;
      statusLabel = ({
        merging: 'Merging',
        inProgress: 'In Progress',
        humanReview: 'Human Review',
        rework: 'Rework',
        todo: 'Todo',
        blocked: 'Blocked',
      } as const)[row.state];
    }
    return {
      identifier: row.ticket.identifier,
      ticketUrl: row.ticket.url,
      statusLabel,
      statusKind,
      project: row.ticket.project?.name ?? '—',
      projectUrl: row.ticket.project?.url ?? null,
      repo: repo?.name ?? '—',
      repoUrl,
      summary: row.ticket.title,
      sessionId,
      spawnedAtMs,
      runtimeLabel,
    };
  });

  const html = buildDashboardHtml({
    rows: htmlRows,
    updatedAt,
    runningAgents: runningAgents.size,
    maxConcurrent: MAX_CONCURRENT,
    boards: boards.map((b) => b.ticketPrefix),
    pollIntervalSeconds: Math.round(POLL_INTERVAL_MS / 1000),
  });

  try {
    fs.writeFileSync(HTML_DASHBOARD_FILE, html);
  } catch (err) {
    console.error(chalk.yellow(`[symphony] Failed to write HTML dashboard: ${(err as Error).message}`));
  }
}

function log(msg: string): void {
  if (lastDashboardLines > 0) {
    rawStdoutWrite(`\x1b[${lastDashboardLines}A\x1b[0J`);
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
 * Force-open a claude session for any ticket by identifier, regardless of
 * current ticket-system state. Session-only: this never mutates the ticket
 * — the state-machine handles transitions while the agent runs.
 *   - Already running → no-op (logged)
 *   - Human Review / Rework → spawns in feedback mode
 *   - Any other state → spawns in continue mode
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

  // Resume is a pure claude-session operation: never mutate ticket state here.
  // The state-machine handles transitions when the agent runs.

  // Use feedback mode when coming from a review state so the agent reads all comments.
  // 'In Review' is included as a rollout fallback — UP-782 removes the state from the
  // workflow, but legacy tickets parked in it must still resume in feedback mode.
  const fromReview = stateName === 'Human Review' || stateName === 'In Review' || stateName === 'Rework';
  const mode: SpawnMode = fromReview ? 'feedback' : 'continue';

  spawnAgent(ticket, board, mode);
}

/**
 * Stop a running agent without changing the ticket state.
 * SIGTERM → 500ms grace → SIGKILL, signalled to the whole process group so
 * claude / MCP servers / nested shells die with the bash wrapper rather than
 * being orphaned. Cleans up the agent-pid file and the runningAgents entry.
 * Awaits child `exit` so callers (e.g. restart, or handleMerging freeing a
 * concurrency slot) can safely respawn afterwards without the old tree still
 * holding the worktree.
 */
async function killAgent(identifier: string): Promise<void> {
  const upper = identifier.toUpperCase();
  const agent = runningAgents.get(upper);
  if (!agent) {
    log(chalk.yellow(`[${timestamp()}] ⏭ No running agent for ${upper}`));
    return;
  }

  agent.userKilled = true;
  const proc = agent.proc;
  const pid = proc.pid;
  log(chalk.yellow(`[${timestamp()}] ✋ Killing agent ${chalk.bold(upper)}${pid ? ` (PID ${pid})` : ''}`));

  const exited = new Promise<void>((resolve) => {
    if (proc.exitCode != null || proc.signalCode != null) { resolve(); return; }
    proc.once('exit', () => resolve());
  });

  // run-ticket.sh re-execs through setsid, so proc.pid is the PGID leader;
  // signalling the negative PID reaps the whole tree instead of just the bash
  // wrapper. Killing only the wrapper would let the slot free up (below) while
  // claude/codex descendants are still alive — and the same poll cycle's Todo
  // pass could then spawn new work alongside the orphaned tree (UP-825 P2).
  try {
    if (pid !== undefined) process.kill(-pid, 'SIGTERM');
    else proc.kill('SIGTERM');
  } catch { try { proc.kill('SIGTERM'); } catch { /* already dead */ } }

  const killTimer = setTimeout(() => {
    if (proc.exitCode == null && proc.signalCode == null) {
      log(chalk.red(`[${timestamp()}] ✗ Agent ${upper} didn't exit on SIGTERM — sending SIGKILL`));
      try {
        if (pid !== undefined) process.kill(-pid, 'SIGKILL');
        else proc.kill('SIGKILL');
      } catch { try { proc.kill('SIGKILL'); } catch { /* already dead */ } }
    }
  }, 500);

  await exited;
  clearTimeout(killTimer);

  // child.on('exit') in spawnAgent already deletes runningAgents and removes
  // the pid file, but tolerate stragglers in case this is called against an
  // entry whose listeners didn't fire (e.g. restored from disk in the future).
  runningAgents.delete(upper);
  const pidFile = path.join(SYMPHONY_ROOT, 'logs', `agent-pid-${upper}.pid`);
  fs.rmSync(pidFile, { force: true });
  log(chalk.green(`[${timestamp()}] ✓ Agent ${upper} stopped`));
}

/**
 * Kill the running agent (if any) and immediately spawn a fresh session for
 * the same ticket. Does not change ticket state.
 */
async function restartAgent(identifier: string): Promise<void> {
  const upper = identifier.toUpperCase();
  if (runningAgents.has(upper)) {
    await killAgent(upper);
  }
  await forceResumeTicket(upper);
}

/**
 * Set up a readline-based interactive command handler on stdin.
 * Only active when stdin is a TTY (not piped/redirected).
 *
 * Commands:
 *   resume <id>   — force-open a session (e.g. resume WOR-53)
 *   r <id>        — shorthand for resume
 *   kill <id>     — stop a running agent (alias: k)
 *   restart <id>  — kill + resume (alias: rs)
 *   <id>          — bare ticket ID (e.g. WOR-53)
 *   help / h / ?  — show available commands
 *
 * stdin EIO/EAGAIN errors (e.g. child processes spawned with `stdio: 'inherit'`
 * briefly stealing the TTY) are swallowed so the poller stays alive. The
 * readline interface is rebuilt after a fatal stream error so subsequent
 * input keeps working.
 */
let interactiveCommandsActive = false;
let activeReadline: readline.Interface | null = null;
let activeStdinErrorHandler: ((err: NodeJS.ErrnoException) => void) | null = null;

function teardownInteractiveCommands(): void {
  if (activeStdinErrorHandler) {
    try { process.stdin.removeListener('error', activeStdinErrorHandler); } catch { /* ignore */ }
    activeStdinErrorHandler = null;
  }
  if (activeReadline) {
    try { activeReadline.removeAllListeners(); activeReadline.close(); } catch { /* ignore */ }
    activeReadline = null;
  }
  interactiveCommandsActive = false;
}

async function handleInteractiveLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  const resumeMatch =
    trimmed.match(/^(?:resume|r)\s+([A-Za-z]+-\d+)$/i) ??
    trimmed.match(/^([A-Za-z]+-\d+)$/);

  if (resumeMatch) {
    await forceResumeTicket(resumeMatch[1]);
    renderDashboard();
    return;
  }

  const killMatch = trimmed.match(/^(?:kill|k)\s+([A-Za-z]+-\d+)$/i);
  if (killMatch) {
    await killAgent(killMatch[1]);
    renderDashboard();
    return;
  }

  const restartMatch = trimmed.match(/^(?:restart|rs)\s+([A-Za-z]+-\d+)$/i);
  if (restartMatch) {
    await restartAgent(restartMatch[1]);
    renderDashboard();
    return;
  }

  if (trimmed === 'help' || trimmed === 'h' || trimmed === '?') {
    log(chalk.bold.white('Interactive commands:'));
    log(`  ${chalk.cyan('resume <id>')}   Force-open a session  (e.g. ${chalk.cyan('resume WOR-53')})`);
    log(`  ${chalk.cyan('r <id>')}        Shorthand for resume`);
    log(`  ${chalk.cyan('kill <id>')}     Stop a running agent  (alias: ${chalk.cyan('k <id>')})`);
    log(`  ${chalk.cyan('restart <id>')}  Stop and resume an agent  (alias: ${chalk.cyan('rs <id>')})`);
    log(`  ${chalk.cyan('<id>')}          Bare ticket ID  (e.g. ${chalk.cyan('WOR-53')})`);
    log(`  ${chalk.cyan('Ctrl+C')}        Shut down poller`);
    renderDashboard();
    return;
  }

  log(chalk.dim(`[symphony] Unknown command: "${trimmed}" — type "help" for commands`));
  renderDashboard();
}

function setupInteractiveCommands(): void {
  if (!process.stdin.isTTY) return;
  if (interactiveCommandsActive) return;
  interactiveCommandsActive = true;

  // Swallow transient stdin errors (EIO when a child with stdio: 'inherit'
  // grabs the TTY, EAGAIN under load). Without this, the default 'error'
  // listener on process.stdin/readline rethrows and kills the poller.
  const onStdinError = (err: NodeJS.ErrnoException) => {
    const code = err.code ?? '';
    if (code === 'EIO' || code === 'EAGAIN') {
      log(chalk.dim(`[symphony] stdin transient error ${code} — interactive commands rebuilding`));
      // Tear down the current interface (close listeners, drop the error
      // handler) before rebuilding, otherwise repeated EIO blips accumulate
      // readline Interfaces and double-fire every typed command.
      teardownInteractiveCommands();
      setTimeout(() => setupInteractiveCommands(), 50);
      return;
    }
    log(chalk.dim(`[symphony] stdin error: ${err.message}`));
  };
  activeStdinErrorHandler = onStdinError;
  process.stdin.on('error', onStdinError);

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false, // don't echo or add readline's own prompt
  });
  activeReadline = rl;

  rl.on('error', (err: NodeJS.ErrnoException) => {
    const code = err.code ?? '';
    if (code !== 'EIO' && code !== 'EAGAIN') {
      log(chalk.dim(`[symphony] readline error: ${err.message}`));
    }
    // Stdin's own 'error' handler will trigger the rebuild.
  });

  rl.on('line', (line: string) => {
    handleInteractiveLine(line).catch((err) => {
      log(chalk.red(`[symphony] Command failed: ${(err as Error).message}`));
    });
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
    // Match both the new entry point and the `poll-linear.mts` back-compat shim.
    // Anchor on `node` as the executable so a spawned child whose argv merely
    // mentions the script path (e.g. run-ticket.sh forwarding a ticket body
    // that quotes the filename) does not false-positive.
    const out = execSync('pgrep -f "^[^ ]*node .*symphony/scripts/poll-(tickets|linear)\\.mts"', { encoding: 'utf8' }).trim();
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

const MAX_RETRIES = STATE_MACHINE_MAX_RETRIES;
const failureCounts = new Map<string, number>();
/**
 * Last observed Symphony `StateKey` per ticket identifier. Used by the state
 * machine for edge-triggered dispatch (UP-775) — handlers whose effect is a
 * one-shot action on entering a state (cancelled cleanup, rework reset) read
 * this to know whether they're firing on the prev→state transition or just
 * re-observing the same state.
 *
 * The Map is the read path; we mirror it to {@link LAST_OBSERVED_FILE} on disk
 * so a poller restart doesn't lose the edge information and re-fire all
 * one-shot handlers for every ticket parked in a terminal state.
 */
const lastKnownState = new Map<string, StateKey>();
const LAST_OBSERVED_FILE = path.join(SYMPHONY_ROOT, 'state', 'last-observed.json');
const VALID_STATE_KEYS: ReadonlySet<StateKey> = new Set([
  'backlog', 'todo', 'inProgress', 'humanReview', 'rework', 'merging', 'done', 'cancelled',
]);

function loadLastObservedState(): void {
  if (!fs.existsSync(LAST_OBSERVED_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(LAST_OBSERVED_FILE, 'utf8')) as Record<string, string>;
    for (const [id, state] of Object.entries(raw)) {
      if (VALID_STATE_KEYS.has(state as StateKey)) {
        lastKnownState.set(id, state as StateKey);
      }
    }
  } catch (err) {
    // A corrupt file just means the next cycle treats every ticket as a
    // cold-start edge — annoying but not fatal. Log and move on.
    console.warn(chalk.yellow(`[symphony] Failed to load ${LAST_OBSERVED_FILE}: ${err}`));
  }
}

function saveLastObservedState(): void {
  try {
    fs.mkdirSync(path.dirname(LAST_OBSERVED_FILE), { recursive: true });
    const obj: Record<string, StateKey> = {};
    for (const [id, s] of lastKnownState) obj[id] = s;
    fs.writeFileSync(LAST_OBSERVED_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.warn(chalk.yellow(`[symphony] Failed to persist ${LAST_OBSERVED_FILE}: ${err}`));
  }
}
// Set when a rate-limit is detected; the main loop sleeps until this time.
let rateLimitPausedUntil: Date | null = null;

interface PausedSession {
  ticket: Issue;
  board: BoardConfig;
  sessionId: string;
  worktreePath: string;
}
let rateLimitPausedSessions: PausedSession[] = [];

// ── Agent runner ──────────────────────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

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

  const { branch, worktreePath } = computeWorktreePath(ticket, board);

  // Defense-in-depth: even if state-machine guards are bypassed (custom
  // dispatch, future code paths), refuse a spawn that would collide with
  // an existing agent's worktree. Prevents the WOR-153 retry storm where
  // a parent ticket in Merging spawns concurrently with a Phase-N sub-ticket
  // mid-rebase on the same worktree.
  for (const [otherId, other] of runningAgents) {
    if (otherId === ticket.identifier) continue;
    if (other.worktreePath === worktreePath) {
      log(chalk.yellow(`[${timestamp()}] ⏭ Worktree busy`) + ` ${chalk.bold(ticket.identifier)} — held by ${otherId} (${worktreePath}) — skipping`);
      return;
    }
  }

  const logFile = path.join(logsDir, `symphony-${ticket.identifier}.log`);
  let spawnLogOffset = 0;
  try { spawnLogOffset = fs.statSync(logFile).size; } catch { /* first run, file missing */ }
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
    GITHUB_REPO: repo.githubRepo,
    IS_MONO: String(repo.isMono ?? false),
    PROJECT_PATH: projectPath,
    // Setup config
    SETUP_SYMLINK_NODE_MODULES: String(repo.setup?.symlinkNodeModules ?? false),
    SETUP_INSTALL_COMMAND: repo.setup?.installCommand ?? '',
    SETUP_INSTALL_CHECK: repo.setup?.installCheck ?? '',
    // Board state IDs
    STATE_BACKLOG: statesFor(board).backlog,
    STATE_TODO: statesFor(board).todo,
    STATE_IN_PROGRESS: statesFor(board).inProgress,
    STATE_HUMAN_REVIEW: statesFor(board).humanReview,
    STATE_REWORK: statesFor(board).rework,
    STATE_MERGING: statesFor(board).merging,
    STATE_DONE: statesFor(board).done,
    // Ticket system
    TICKET_SYSTEM: ticketSystemFor(board),
    // Symphony root
    SYMPHONY_ROOT,
    // Language preferences
    PERSONAL_PREFERRED_LANGUAGE: symphonyConfig.preferences.personalLanguage,
    WORK_PREFERRED_LANGUAGE: symphonyConfig.preferences.workLanguage,
    NEVER_USE_LANGUAGE: symphonyConfig.preferences.neverUseLanguage,
    // Remote control
    REMOTE_CONTROL: String(REMOTE_CONTROL),
    // Agent runtime — `claude` (default) or `codex`. See runtimeFor().
    AGENT_RUNTIME: runtimeFor(ticket, board),
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
    logOffset: spawnLogOffset,
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

    if (agent?.userKilled) {
      // User-invoked kill/restart — strictly session-only, never touch ticket
      // state or retry counters. The exit handler's success branch otherwise
      // races into moveToHumanReview because a SIGTERM exit has signal !=null.
      log(chalk.yellow(`[${timestamp()}] ✋ Agent killed by user:`) + ` ${chalk.bold(ticket.identifier)}`);
      renderDashboard();
      return;
    }

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
        // Only scan bytes written during THIS run to avoid matching a banner
        // left by a prior run-ticket.sh invocation in the append-only log.
        const offset = Math.min(agent?.logOffset ?? 0, stat.size);
        const runBytes = stat.size - offset;
        const readSize = Math.min(65536, runBytes);
        if (readSize > 0) {
          const buf = Buffer.alloc(readSize);
          fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
          logTail = buf.toString();
          hitRateLimit = RATE_LIMIT_PATTERN.test(logTail);
        }
        fs.closeSync(fd);
      } catch { /* unreadable */ }

      if (hitRateLimit) {
        const resetDate = parseRateLimitResetTime(logTail);
        const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
        const pauseMs = resetDate ? resetDate.getTime() - Date.now() : null;
        const suspicious = pauseMs !== null && pauseMs > SIX_HOURS_MS;

        if (!resetDate) {
          // Banner matched but the reset time was unparseable. A single
          // malformed log line must never bring down the whole poller
          // (UP-831): mark this agent failed and keep polling other tickets.
          const failures = (failureCounts.get(ticket.identifier) ?? 0) + 1;
          failureCounts.set(ticket.identifier, failures);
          log(chalk.yellow(`[${timestamp()}] ⚠ Rate limit banner matched but reset time unparseable for ${chalk.bold(ticket.identifier)} — treating as a normal failure, continuing to poll`));
          log(chalk.red(`[${timestamp()}] ✗ Agent failed:`) + ` ${chalk.bold(ticket.identifier)} (exit ${code ?? signal}, attempt ${failures}/${MAX_RETRIES})`);
        } else if (suspicious) {
          // Likely a weekly-limit banner or stale parse; don't blind-pause for hours.
          log(chalk.yellow(`[${timestamp()}] ⚠ Suspicious reset time (>6h, parsed ${resetDate.toLocaleTimeString()}) — ignoring banner for ${chalk.bold(ticket.identifier)}`));
          const failures = (failureCounts.get(ticket.identifier) ?? 0) + 1;
          failureCounts.set(ticket.identifier, failures);
          log(chalk.red(`[${timestamp()}] ✗ Agent failed:`) + ` ${chalk.bold(ticket.identifier)} (exit ${code ?? signal}, attempt ${failures}/${MAX_RETRIES})`);
        } else {
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

          log(chalk.yellow(`[${timestamp()}] ⏸ Rate limit hit: ${chalk.bold(ticket.identifier)} — pausing until ${resetDate.toLocaleTimeString()} (~${Math.ceil(pauseMs! / 60000)}min, incl. +5min buffer)`));
          rateLimitPausedUntil = resetDate;
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
        // Respect terminal/explicit states the agent set during the session.
        // Without this guard, an agent that finalized to Done (e.g. "already
        // fixed by an unrelated merged PR") gets dragged back to Human Review
        // the instant it exits.
        const guardedAgent = agent;
        (async () => {
          const ownedStates = statesFor(guardedAgent.board);
          const owned = new Set([ownedStates.todo, ownedStates.inProgress]);
          let stateId: string | null;
          try {
            stateId = await fetchTicketStateId(guardedAgent.board, ticket.identifier);
          } catch (err) {
            // Treat resolver failures as "don't know" — skip the force-move
            // rather than defaulting to Human Review, which would re-introduce
            // the original bug on transient adapter/API errors.
            log(chalk.yellow(`[symphony] ${ticket.identifier} state resolve failed (${err}) — skipping auto Human Review move`));
            return;
          }
          if (!stateId || !owned.has(stateId)) {
            log(chalk.dim(`[symphony] ${ticket.identifier} not in an agent-owned state — skipping auto Human Review move`));
            return;
          }
          moveToHumanReview(guardedAgent.board, guardedAgent.issueId, ticket.identifier).catch(() => {});
        })();
      }
    }
    renderDashboard();
  });
}

// ── Human Review helpers ──────────────────────────────────────────────────────

async function checkHumanReviewApproval(issue: Issue, board: BoardConfig) {
  const comments = await getAdapter(board).listComments(board, issue.id);
  const bodies = comments.map((c) => c.body);
  const alreadyHandled = bodies.some((b) => b.startsWith(APPROVAL_LOCK_PREFIX));
  const approvalPattern = /\b(lgtm|approved?|looks good( to me)?|ship it|✅)\b/i;
  const prPattern = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;
  const approved = bodies.some((b) => approvalPattern.test(b));
  const prUrl = bodies.map((b) => b.match(prPattern)?.[0]).find(Boolean) ?? null;
  // PR URL specifically from a Symphony-authored lock comment. Used as a
  // trusted reference for finalize-as-merged decisions so that an unrelated
  // PR URL pasted in human discussion can't trigger a premature Done move.
  // Includes both APPROVAL_LOCK_PREFIX and FEEDBACK_REROUTE_LOCK_PREFIX so
  // tickets that have been bounced back for feedback (but not yet approved)
  // still have a trusted PR URL for the merged-fallback path (Codex P2 on
  // PR #68 — removing the AI_REVIEW lock left lockedPrUrl null on most
  // pre-approval tickets).
  const lockedPrUrl = bodies
    .filter((b) => b.startsWith(APPROVAL_LOCK_PREFIX) || b.startsWith(FEEDBACK_REROUTE_LOCK_PREFIX))
    .map((b) => b.match(prPattern)?.[0])
    .find(Boolean) ?? null;
  // Most recent `[symphony] feedbackReroute: <prUrl> at=<ISO>` timestamp. Used
  // as the cut-off when deciding whether new PR feedback has arrived since the
  // last hand-off. Lock bodies missing/malformed `at=` are skipped — they
  // contribute nothing to the cut-off, so worst case is one extra reroute.
  const rerouteTimes = bodies
    .filter((b) => b.startsWith(FEEDBACK_REROUTE_LOCK_PREFIX))
    .map((b) => b.match(/\bat=(\S+)/)?.[1])
    .map((s) => (s ? new Date(s) : null))
    .filter((d): d is Date => d !== null && !Number.isNaN(d.getTime()))
    .map((d) => d.getTime());
  const lastFeedbackRerouteAt = rerouteTimes.length > 0
    ? new Date(Math.max(...rerouteTimes))
    : null;
  return { alreadyHandled, approved, prUrl, lockedPrUrl, lastFeedbackRerouteAt };
}

async function postComment(board: BoardConfig, issueId: string, body: string): Promise<void> {
  await getAdapter(board).postComment(board, issueId, body);
}

async function addLabel(board: BoardConfig, issueId: string, label: string): Promise<void> {
  await getAdapter(board).addLabel(board, issueId, label);
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

/**
 * Returns true iff the PR has a review newer than `since` whose state is not
 * APPROVED. Uses `gh pr view --json reviews`; failures degrade to `false` (we
 * never want to auto-reroute on a transient gh CLI hiccup). Top-level issue
 * comments are intentionally ignored — they're noisy (the AI-review trigger
 * itself, user replies, bot walkthroughs), while a PR review is a strong
 * signal that someone actually evaluated the diff.
 */
function hasNewPRReviewSince(prUrl: string, since: Date | null): Promise<boolean> {
  const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];
  const repoMatch = prUrl.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  if (!prNumber || !repoMatch) return Promise.resolve(false);
  const repo = repoMatch[1];
  const sinceMs = since?.getTime() ?? 0;

  return new Promise<boolean>((resolve) => {
    const child = child_process.spawn(
      'gh',
      ['pr', 'view', prNumber, '--repo', repo, '--json', 'reviews'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', () => resolve(false));
    child.on('exit', (code) => {
      if (code !== 0) return resolve(false);
      try {
        const data = JSON.parse(output) as {
          reviews: Array<{ state: string; submittedAt: string }>;
        };
        const hasNew = data.reviews.some(
          (r) => r.state !== 'APPROVED' && new Date(r.submittedAt).getTime() > sinceMs,
        );
        resolve(hasNew);
      } catch {
        resolve(false);
      }
    });
  });
}

function isAiReviewEnabled(issue: Issue, board: BoardConfig): boolean {
  const repoConfig = resolveRepo(issue, board);
  const projectConfig = resolveProject(issue, board) ?? undefined;
  return Boolean(resolveGithub(symphonyConfig, board, projectConfig, repoConfig).codeReviewComment);
}

function spawnAIReview(issue: Issue, board: BoardConfig, prUrl: string): boolean {
  const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];
  if (!prNumber) return false;
  const repoConfig = resolveRepo(issue, board);
  const projectConfig = resolveProject(issue, board) ?? undefined;
  // Resolved via global → board → project → repo deep-merge (UP-761). Repo-level
  // overrides win; an empty string at any level disables AI review.
  const codeReviewComment = resolveGithub(symphonyConfig, board, projectConfig, repoConfig).codeReviewComment;
  if (!codeReviewComment) return false; // no review configured for this repo/board — skip
  const repoPath = repoConfig.path.replace(/^~/, process.env['HOME'] ?? '~');

  // Fire-and-forget the trigger comment. The AI reviewer leaves its feedback
  // as a PR review; the next poll cycle detects it via hasReviewForSha and
  // flips the symphony/ai-reviewed commit status from pending to success.
  const child = child_process.spawn(
    'gh',
    ['pr', 'comment', prNumber, '--body', codeReviewComment],
    { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], detached: false }
  );
  child.on('exit', (code) => {
    if (code !== 0) {
      log(chalk.yellow(`[${timestamp()}] ⚠ AI review trigger failed for ${issue.identifier} (PR #${prNumber}, exit ${code})`));
    }
  });

  log(chalk.blue(`[${timestamp()}] 🔍 AI review triggered for ${issue.identifier} (PR #${prNumber})`));
  return true;
}

// ── AI review completion-marker helpers (UP-806) ──────────────────────────────
//
// The `symphony/ai-reviewed` commit status replaces the old
// `[symphony] aiReviewRequested:` ticket-comment marker. A commit status is
// per-SHA, so force-pushes naturally drop the marker without a separate clear
// step. `pending` means the poller has asked the AI reviewer to look at this
// SHA; `success` means a review whose `commit_id` matches that SHA has landed.

const AI_REVIEW_CONTEXT = 'symphony/ai-reviewed';

function parsePrRef(prUrl: string): { repo: string; prNumber: string } | null {
  const repoMatch = prUrl.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  const prMatch = prUrl.match(/\/pull\/(\d+)/);
  if (!repoMatch || !prMatch) return null;
  return { repo: repoMatch[1] as string, prNumber: prMatch[1] as string };
}

function getOpenPRUrl(issue: Issue, board: BoardConfig): Promise<string | null> {
  const repo = resolveRepo(issue, board);
  const repoPath = repo.path.replace(/^~/, process.env['HOME'] ?? '~');
  const branch = branchForIssue(issue);
  return new Promise<string | null>((resolve) => {
    const child = child_process.spawn(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--limit', '1'],
      { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      if (code !== 0) return resolve(null);
      try {
        const data = JSON.parse(output) as Array<{ url: string }>;
        resolve(data[0]?.url ?? null);
      } catch {
        resolve(null);
      }
    });
  });
}

function getPRHeadSha(prUrl: string): Promise<string | null> {
  const ref = parsePrRef(prUrl);
  if (!ref) return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    const child = child_process.spawn(
      'gh',
      ['pr', 'view', ref.prNumber, '--repo', ref.repo, '--json', 'headRefOid', '-q', '.headRefOid'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      if (code !== 0) return resolve(null);
      const sha = output.trim();
      resolve(sha.length > 0 ? sha : null);
    });
  });
}

// UP-830: distinguish "gh API failed" from "status genuinely absent". Returning
// null on a transient gh failure made ensureAiReviewForCurrentHead treat every
// network blip as a first-time review and re-post a `pending` status + re-spawn
// the AI review trigger — causing duplicate Codex review comments on the same
// unchanged commit. Now: null ONLY means the gh call succeeded and no
// `symphony/ai-reviewed` context was found; 'unknown' means we couldn't tell
// (spawn error, non-zero exit, unparseable JSON, malformed PR URL) and the
// caller MUST skip the cycle rather than fall through to the first-time branch.
function getAiReviewStatus(prUrl: string, sha: string): Promise<'success' | 'pending' | 'error' | 'failure' | 'unknown' | null> {
  const ref = parsePrRef(prUrl);
  if (!ref) return Promise.resolve('unknown');
  return new Promise<'success' | 'pending' | 'error' | 'failure' | 'unknown' | null>((resolve) => {
    const child = child_process.spawn(
      'gh',
      ['api', `repos/${ref.repo}/commits/${sha}/statuses`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', () => resolve('unknown'));
    child.on('exit', (code) => {
      if (code !== 0) return resolve('unknown');
      try {
        const data = JSON.parse(output) as Array<{ context: string; state: string }>;
        // Statuses are returned newest-first; the first match is authoritative.
        const hit = data.find((s) => s.context === AI_REVIEW_CONTEXT);
        if (!hit) return resolve(null);
        if (hit.state === 'success' || hit.state === 'pending' || hit.state === 'error' || hit.state === 'failure') {
          return resolve(hit.state);
        }
        resolve(null);
      } catch {
        resolve('unknown');
      }
    });
  });
}

function postAiReviewStatus(prUrl: string, sha: string, state: 'pending' | 'success', description: string): Promise<void> {
  const ref = parsePrRef(prUrl);
  if (!ref) throw new Error(`postAiReviewStatus: cannot parse PR URL ${prUrl}`);
  return new Promise<void>((resolve, reject) => {
    const child = child_process.spawn(
      'gh',
      [
        'api', `repos/${ref.repo}/statuses/${sha}`,
        '--method', 'POST',
        '-f', `state=${state}`,
        '-f', `context=${AI_REVIEW_CONTEXT}`,
        '-f', `description=${description}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gh api statuses exited ${code}: ${stderr.trim()}`));
    });
  });
}

function hasReviewForSha(prUrl: string, sha: string): Promise<boolean> {
  const ref = parsePrRef(prUrl);
  if (!ref) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const child = child_process.spawn(
      'gh',
      ['pr', 'view', ref.prNumber, '--repo', ref.repo, '--json', 'reviews'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', () => resolve(hasCodexReviewCommentForSha(ref, sha)));
    child.on('exit', (code) => {
      if (code === 0) {
        try {
          const data = JSON.parse(output) as { reviews: Array<{ commit?: { oid?: string }; commitId?: string }> };
          if (data.reviews.some((r) => (r.commit?.oid ?? r.commitId) === sha)) return resolve(true);
        } catch {
          // fall through to the issue-comment scan below
        }
      }
      // UP-832: no formal PR review matched. `@codex review` sometimes posts
      // its verdict as an issue comment (/issues/N/comments) — invisible to
      // `gh pr view --json reviews` — so fall back to scanning issue comments
      // for Codex's `Reviewed commit: <sha>` marker.
      resolve(hasCodexReviewCommentForSha(ref, sha));
    });
  });
}

// UP-832: scan PR issue comments for an AI reviewer's `Reviewed commit: <sha>`
// marker matching the head SHA. `--paginate` alone emits each page as its own
// JSON array (`[..][..]`), which `JSON.parse` chokes on once a busy PR exceeds
// one page; `--slurp` wraps the pages into a single array-of-arrays we flatten.
function hasCodexReviewCommentForSha(ref: { repo: string; prNumber: string }, sha: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = child_process.spawn(
      'gh',
      ['api', '--paginate', '--slurp', `repos/${ref.repo}/issues/${ref.prNumber}/comments?per_page=100`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', () => resolve(false));
    child.on('exit', (code) => {
      if (code !== 0) return resolve(false);
      try {
        const pages = JSON.parse(output) as IssueComment[][];
        resolve(codexCommentMatchesSha(pages.flat(), sha));
      } catch {
        resolve(false);
      }
    });
  });
}

// ── Worktree cleanup ──────────────────────────────────────────────────────────

async function cleanupDoneWorktrees(activeIdentifiers: Set<string>, board: BoardConfig): Promise<void> {
  for (const repo of board.repos) {
    const worktreesDir = repo.worktreesDir.replace(/^~/, process.env['HOME'] ?? '~');
    const repoPath = repo.path.replace(/^~/, process.env['HOME'] ?? '~');
    if (!fs.existsSync(worktreesDir)) continue;

    for (const entry of fs.readdirSync(worktreesDir)) {
      const prefix = board.ticketPrefix;
      const prefixRe = new RegExp(`^[a-z]+--(${prefix}-\\d+)-`, 'i');
      const fallbackRe = new RegExp(`^(?:feat|fix|chore|refactor)--(${prefix}-\\d+)`, 'i');
      const match = entry.match(prefixRe) ?? entry.match(fallbackRe);
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

/**
 * Build the set of path prefixes that scope orphan reclamation: every
 * configured worktrees directory plus every repo root. Used to keep the scan
 * from reaping nx daemons / processes belonging to unrelated workspaces the
 * developer happens to have open on the same machine.
 */
function symphonyManagedPathPrefixes(): string[] {
  const home = process.env['HOME'] ?? '~';
  const out = new Set<string>();
  for (const board of boards) {
    for (const repo of board.repos) {
      out.add(repo.worktreesDir.replace(/^~/, home));
      out.add(repo.path.replace(/^~/, home));
    }
  }
  return [...out];
}

/**
 * Worktree subdirectories owned by agents this poller is currently managing.
 * Anything inside these paths is by definition live work — exclude it from
 * orphan scans so we never SIGTERM a child of a running agent (P1 review
 * finding on UP-789).
 */
function liveAgentWorktreePaths(): string[] {
  return [...runningAgents.values()].map((a) => a.worktreePath);
}

function killOrphanedNxDaemons(): void {
  // Shutdown caller: every agent is being torn down, so any nx daemon under
  // a Symphony-managed worktree / repo root is fair game. The prefix scope
  // is the only thing protecting other workspaces' daemons.
  const rows = snapshotPsByCommand();
  const pids = findNxDaemonPids(rows, symphonyManagedPathPrefixes());
  if (pids.length === 0) return;
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  log(chalk.dim(`[${timestamp()}] ⏹ Sent SIGTERM to ${pids.length} nx daemon process(es)`));
}

async function cleanupOrphanedAgentsByPidFiles(): Promise<void> {
  const logsDir = path.join(SYMPHONY_ROOT, 'logs');
  if (!fs.existsSync(logsDir)) return;

  // ── Pass 1: PID files left behind by previous pollers ─────────────────────
  //
  // Any pid-file PID still alive that we don't own is an orphan from a
  // previous poller (SIGKILL'd / OOM'd / crashed). Kill the whole process
  // group — bash from run-ticket.sh is a session leader (see setsid trampoline
  // in run-ticket.sh) so the negative-PID form reaches claude + descendants.
  // Done-state gating was removed: orphans in any ticket state are reclaimed
  // because their original poller no longer owns them and they accumulate
  // forever otherwise (UP-789).
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

    log(chalk.dim(`[${timestamp()}] ⏹ Killing orphan agent group for ${identifier} (PID ${pid})`));
    try { process.kill(-pid, 'SIGTERM'); } catch {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    fs.rmSync(filePath, { force: true });
  }

  // ── Pass 2: rogue claude / node / bash by worktree-path match ─────────────
  //
  // If a poller crashed before writing the pid file, the pid-file pass misses
  // those PIDs. Walk every process on the system and match against the
  // configured worktrees roots so
  // we catch leftover `claude`, `python3 pty-wrapper.py`, `bash run-ticket.sh`,
  // and nested tool subprocesses by their argv. Skip anything the live
  // runningAgents map already manages (its descendants share the same path).
  const rows = snapshotPsByCommand();
  const prefixes = boards
    .flatMap((b) => b.repos)
    .map((repo) => repo.worktreesDir.replace(/^~/, process.env['HOME'] ?? '~'))
    .filter((p, i, arr) => arr.indexOf(p) === i);
  const skip = new Set<number>([process.pid]);
  for (const { proc } of runningAgents.values()) {
    if (proc.pid !== undefined) skip.add(proc.pid);
  }
  // Exclude every PID whose argv references a currently-tracked agent's
  // worktree. The descendants of a live bash/python/claude tree share the
  // worktree path with their ancestor, so a plain PID skip-set would still
  // let Pass 2 reap them. Without this filter we'd kill the agent currently
  // running this very session on the first poll cycle.
  const liveTreePaths = liveAgentWorktreePaths();
  const isUnderLiveAgent = (cmd: string): boolean =>
    liveTreePaths.some((p) => cmd.includes(p));
  const orphans = findOrphanPidsByWorktreePrefix(rows, prefixes, skip)
    .filter(({ command }) => !isUnderLiveAgent(command));
  // Stable per-cycle log line: list how many orphans we found rather than one
  // line each, which would spam the dashboard on a cold start.
  if (orphans.length > 0) {
    log(chalk.dim(`[${timestamp()}] ⏹ Reaping ${orphans.length} orphan(s) under known worktrees`));
    for (const { pid } of orphans) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }

  // ── Pass 3: nx daemons — always detached, never share a PGID ──────────────
  //
  // Reuse the same ps snapshot. AC 2 requires explicit cleanup even when no
  // poller-tracked agent matched, because nx daemons survive long past the
  // node process that forked them. Scope to Symphony-managed paths so we
  // don't reap an unrelated workspace's daemon that the developer also runs.
  const nxPids = findNxDaemonPids(rows, symphonyManagedPathPrefixes());
  if (nxPids.length > 0) {
    log(chalk.dim(`[${timestamp()}] ⏹ Stopping ${nxPids.length} stale nx daemon(s)`));
    for (const pid of nxPids) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }
}

// ── Main poll loop ────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  // Reap phantom runningAgents entries whose child already died but whose
  // `exit` handler never fired (PTY-wrapper edge case after SIGKILL, UP-826).
  // Left in place, a dead entry counts against MAX_CONCURRENT forever (starving
  // Todo claims) and makes the active-state sweep below SIGTERM a dead PID every
  // cycle. Polls are seconds apart, so if `exit` had a chance to fire it already
  // did — a still-tracked entry whose PID is gone is genuinely a leak.
  //
  // This MUST run before cleanupOrphanedAgentsByPidFiles(): that sweep skips any
  // process whose argv references a still-tracked agent's worktree (so it won't
  // kill the live tree). A SIGKILL'd agent can leave Claude/Codex descendants
  // alive in its worktree; pruning the map entry first un-protects them, so the
  // sweep's worktree-match pass reaps those descendants in THIS poll — before
  // the freed slot lets another ticket spawn a second agent into the same
  // worktree.
  const deadIds = findDeadAgentIdentifiers(
    [...runningAgents].map(([identifier, agent]) => ({ identifier, pid: agent.proc.pid })),
    isPidAlive,
  );
  for (const identifier of deadIds) {
    runningAgents.delete(identifier);
    fs.rmSync(path.join(SYMPHONY_ROOT, 'logs', `agent-pid-${identifier}.pid`), { force: true });
    log(chalk.dim(`[${timestamp()}] 🧹 ${identifier} agent process gone — pruned phantom entry (UP-826)`));
  }

  await cleanupOrphanedAgentsByPidFiles();

  const allEligible: { ticket: Issue; board: BoardConfig }[] = [];
  const allBlocked: { ticket: Issue; board: BoardConfig }[] = [];
  const allSnapshot: DashboardRow[] = [];
  const allActiveIdentifiers = new Set<string>();

  for (const board of boards) {
    let todoTickets: Issue[], inProgressTickets: Issue[], humanReviewTickets: Issue[], mergingTickets: Issue[], reworkTickets: Issue[], cancelledTickets: Issue[];
    const boardStates = statesFor(board);
    try {
      [todoTickets, inProgressTickets, humanReviewTickets, mergingTickets, reworkTickets, cancelledTickets] = await Promise.all([
        fetchTicketsByState(board, 'todo'),
        fetchTicketsByState(board, 'inProgress'),
        fetchTicketsByState(board, 'humanReview'),
        fetchTicketsByState(board, 'merging'),
        fetchTicketsByState(board, 'rework'),
        // Boards without a `cancelled` state simply contribute an empty list —
        // the state machine then never dispatches `cancelled` for them.
        boardStates.cancelled ? fetchTicketsByState(board, 'cancelled') : Promise.resolve<Issue[]>([]),
      ]);
    } catch (err) {
      const msg = String(err);
      const system = ticketSystemFor(board);
      if (system === 'linear' && msg.includes('Argument Validation Error')) {
        log(chalk.red(`[${timestamp()}] Linear API 参数错误 (${board.name})`));
        log(chalk.yellow(`  可能原因：assigneeId 或 state ID 格式不合法。`));
        log(chalk.cyan(`  检查 ${path.join(CONFIG_DIR, 'symphony.json')} 里的 assigneeId 是否为有效 UUID。`));
      } else {
        const label = system === 'jira' ? 'Jira' : system === 'github-projects' ? 'GitHub Projects' : 'Linear';
        log(chalk.red(`[${timestamp()}] ${label} API error (${board.name}): ${err}`));
      }
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

    // All per-state ticket handling lives in state-machine.mts. We just build a
    // deps object that wraps the poller's I/O + introspection and let
    // processTicket() decide what side effect to run.
    const deps: StateMachineDeps<BoardConfig> = {
      moveToInProgress,
      moveToHumanReview,
      moveToMerging,
      moveToTodo,
      moveToDone,
      spawnAgent,
      killAgent,
      resetReworkTicket,
      removeWorktree,
      cleanupCancelledTicket,
      areAllPRsMerged,
      isPRUrlMerged,
      checkHumanReviewApproval,
      postComment,
      spawnAIReview,
      isAiReviewEnabled,
      getOpenPRUrl,
      getPRHeadSha,
      getAiReviewStatus,
      postAiReviewStatus,
      hasReviewForSha,
      hasNewPRReviewSince,
      spawnNotifyReview,
      addLabel,
      isAgentRunning: (id) => runningAgents.has(id),
      agentSlotsAvailable: () => Math.max(0, MAX_CONCURRENT - runningAgents.size),
      failureCountFor: (id) => failureCounts.get(id) ?? 0,
      resetFailureCount: (id) => { failureCounts.set(id, 0); },
      worktreeOccupiedBy,
      isEligible,
      log,
    };

    // Tickets whose entry-edge handler (rework / cancelled) ran but DEFERRED
    // because an agent was still running. We must NOT mark these as
    // `lastKnownState === 'rework' / 'cancelled'` below — if we did, the next
    // cycle's edge guard would see `prevState === current` and skip the
    // one-shot forever (Codex P1 on PR #49). Keeping the previous state lets
    // the next cycle re-detect the edge and fire the deferred cleanup.
    const deferredEdge = new Set<string>();

    const dispatch = async (state: StateKey, tickets: Issue[], throttleMs = 0): Promise<void> => {
      for (const issue of tickets) {
        let effect;
        try {
          effect = await processTicket(state, issue, board, deps, lastKnownState.get(issue.identifier) ?? null);
        } catch (err) {
          log(chalk.red(`[symphony] processTicket(${state}) error for ${issue.identifier}: ${err}`));
          continue;
        }
        if ((state === 'rework' || state === 'cancelled') && effect.kind === 'noop' && effect.reason === 'agent still running') {
          deferredEdge.add(issue.identifier);
        }
        // Stop the whole batch the moment slots run out — every subsequent
        // ticket in this state would just no-op for the same reason. Don't
        // sleep for no-ops either; throttling is only meaningful when we
        // actually spawned / reset / finalized work (mirrors the pre-refactor
        // `continue` / `break` semantics).
        if (effect.kind === 'noop') {
          if (effect.reason === 'no agent slots') break;
          continue;
        }
        if (throttleMs > 0) await sleep(throttleMs);
      }
    };

    // Order matters: Human Review and Merging finalize Done tickets which frees
    // up agent slots; Rework cleans up before classify-and-spawn for new Todos.
    await dispatch('humanReview', humanReviewTickets.filter((t) => isEligible(t, board)));
    await dispatch('merging', mergingTickets.filter((t) => isEligible(t, board)), 3000);
    await dispatch('rework', reworkTickets.filter((t) => isEligible(t, board)), 2000);
    await dispatch('inProgress', inProgressTickets.filter((t) => isEligible(t, board)), 3000);
    // Cancelled is dispatched last: its one-shot cleanup doesn't compete for
    // agent slots, and running it after In Progress means agents killed by the
    // "no longer active" sweep above have already exited by the time we try
    // to remove the worktree.
    await dispatch('cancelled', cancelledTickets.filter((t) => isEligible(t, board)));

    // Classify todo tickets
    for (const t of todoTickets) {
      if (isEligible(t, board)) allEligible.push({ ticket: t, board });
      else allBlocked.push({ ticket: t, board });
    }
    for (const t of inProgressTickets.filter((t) => isEligible(t, board))) {
      allEligible.push({ ticket: t, board });
    }

    // Snapshot every fetched ticket for the dashboard (ticket-centric view)
    for (const t of todoTickets) {
      allSnapshot.push({ ticket: t, board, state: isEligible(t, board) ? 'todo' : 'blocked' });
    }
    for (const t of inProgressTickets) allSnapshot.push({ ticket: t, board, state: 'inProgress' });
    for (const t of humanReviewTickets) allSnapshot.push({ ticket: t, board, state: 'humanReview' });
    for (const t of mergingTickets) allSnapshot.push({ ticket: t, board, state: 'merging' });
    for (const t of reworkTickets) allSnapshot.push({ ticket: t, board, state: 'rework' });

    // Update last-known states. These are written AFTER the dispatch above
    // ran, so handlers receive the *previous* cycle's state via `prevState`
    // and can detect the prev→state edge. Once we've finished dispatch, we
    // snapshot the current cycle for the next one.
    //
    // Rework / cancelled are entry-edge states: we MUST skip persisting them
    // for tickets whose one-shot got deferred (agent still running). Persisting
    // would set `prevState === current` on the next cycle and the edge guard
    // would skip cleanup forever — see `deferredEdge` above.
    for (const t of todoTickets) lastKnownState.set(t.identifier, 'todo');
    for (const t of inProgressTickets) lastKnownState.set(t.identifier, 'inProgress');
    for (const t of humanReviewTickets) lastKnownState.set(t.identifier, 'humanReview');
    for (const t of mergingTickets) lastKnownState.set(t.identifier, 'merging');
    for (const t of reworkTickets) {
      if (!deferredEdge.has(t.identifier)) lastKnownState.set(t.identifier, 'rework');
    }
    for (const t of cancelledTickets) {
      if (!deferredEdge.has(t.identifier)) lastKnownState.set(t.identifier, 'cancelled');
    }

    await cleanupDoneWorktrees(allActiveIdentifiers, board);
  }

  lastSnapshot = allSnapshot;
  renderDashboard();

  if (runningAgents.size >= MAX_CONCURRENT) return;

  // Spawn new agents for todo tickets — delegate per-ticket to processTicket('todo').
  // Done in a second pass after Human Review / Merging / etc. so freed slots are
  // visible. Tickets that came in via inProgress polling already had their own
  // handler run above; here we just want fresh Todos.
  for (const { ticket, board } of allEligible) {
    if (lastKnownState.get(ticket.identifier) !== 'todo') continue; // skip inProgress entries
    if (runningAgents.has(ticket.identifier)) continue;
    if (runningAgents.size >= MAX_CONCURRENT) break;
    // Validate runtime before claiming the ticket. If we waited until spawnAgent
    // throws, handleTodo would have already moved it to In Progress, leaving a
    // typo'd ticket stuck with no running agent.
    try {
      runtimeFor(ticket, board);
    } catch (err) {
      log(chalk.red(`[${timestamp()}] ✗ Skipping ${ticket.identifier}: ${err instanceof Error ? err.message : err}`));
      continue;
    }
    const deps: StateMachineDeps<BoardConfig> = {
      moveToInProgress, moveToHumanReview, moveToMerging, moveToTodo, moveToDone,
      spawnAgent, killAgent, resetReworkTicket, removeWorktree, cleanupCancelledTicket,
      areAllPRsMerged, isPRUrlMerged,
      checkHumanReviewApproval, postComment, spawnAIReview, isAiReviewEnabled,
      getOpenPRUrl, getPRHeadSha, getAiReviewStatus, postAiReviewStatus, hasReviewForSha,
      hasNewPRReviewSince, spawnNotifyReview, addLabel,
      isAgentRunning: (id) => runningAgents.has(id),
      agentSlotsAvailable: () => Math.max(0, MAX_CONCURRENT - runningAgents.size),
      failureCountFor: (id) => failureCounts.get(id) ?? 0,
      resetFailureCount: (id) => { failureCounts.set(id, 0); },
      worktreeOccupiedBy,
      isEligible, log,
    };
    // prevState is null here: this branch only runs for fresh Todo tickets in
    // the second pass, and Todo's handler doesn't consult prevState anyway.
    await processTicket('todo', ticket, board, deps, null);
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
    if (proc.pid === undefined) continue;
    // run-ticket.sh re-execs through setsid, so proc.pid is the PGID leader.
    // Signalling the negative PID hits every descendant — claude, MCP servers,
    // nested shells — instead of just the bash, which used to die fast and
    // leave its children for launchd to adopt.
    try { process.kill(-proc.pid, 'SIGTERM'); }
    catch { try { proc.kill('SIGTERM'); } catch { /* already gone */ } }
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
        try { process.kill(-pid, 'SIGTERM'); } catch {
          try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        }
      }
      fs.rmSync(filePath, { force: true });
    }
  }

  // Best-effort sweep of nx daemons spawned by any agent — they detach into
  // their own session, so the PGID kill above does not reach them.
  killOrphanedNxDaemons();

  // Wait up to 5s for children to exit cleanly, then escalate to SIGKILL on
  // the same PGIDs. 100ms (the previous value) was nowhere near enough for
  // claude to flush MCP state, leaving zombies on every SIGINT.
  await Promise.race([
    Promise.all(pidKills),
    sleep(5000),
  ]);
  for (const { proc } of runningAgents.values()) {
    if (proc.pid === undefined) continue;
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already gone */ }
  }

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
if (HTML_MODE) {
  console.log(`  ${chalk.dim('HTML out:')}    ${HTML_DASHBOARD_FILE}`);
  writeHtmlDashboard(new Date().toTimeString().slice(0, 8));
  openHtmlDashboard();
}
console.log('');
console.log(
  chalk.dim(
    `  ${chalk.white('resume <id>')} / ${chalk.white('kill <id>')} / ${chalk.white('restart <id>')}  •  ${chalk.white('help')} for commands  •  Ctrl+C to stop`
  )
);
console.log('');

setupInteractiveCommands();
loadLastObservedState();

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
      let resumeLogOffset = 0;
      try { resumeLogOffset = fs.statSync(logFile).size; } catch { /* file missing */ }
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
        logOffset: resumeLogOffset,
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
  saveLastObservedState();
  await sleep(POLL_INTERVAL_MS);
}
