#!/usr/bin/env node
/**
 * List all open Linear WOR tickets (Backlog → Merging) for the UP-798 cutover.
 *
 * Symphony's default board has moved from WOR (Linear) to SY (GitHub Projects)
 * — see UP-795 §6 and UP-798. WOR is now read-only history, but tickets that
 * were in flight when the cutover happened still need manual triage: either
 * re-file as SY-N or finish on Linear.
 *
 * This script enumerates every WOR issue whose state matches one of the
 * "open" Symphony states (anything except `done` and `cancelled`) so a human
 * can walk down the list and decide ticket-by-ticket. No automated copy.
 *
 * Usage:
 *   node --experimental-strip-types symphony/scripts/list-open-wor-tickets.mts
 *   node --experimental-strip-types symphony/scripts/list-open-wor-tickets.mts --json
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface BoardConfig {
  teamId: string;
  ticketPrefix: string;
  linear?: { states: Record<string, string> };
}

interface LinearIssue {
  identifier: string;
  title: string;
  url: string;
  state: { id: string; name: string };
  assignee: { name: string } | null;
  updatedAt: string;
}

const OPEN_STATE_KEYS = ['backlog', 'todo', 'inProgress', 'humanReview', 'rework', 'merging'] as const;

function loadSecrets(): void {
  const path = join(homedir(), 'symphony', 'secrets.env');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function loadBoard(): BoardConfig {
  const path = join(homedir(), 'symphony', 'config', 'boards', 'wor.json');
  const board = JSON.parse(readFileSync(path, 'utf8')) as BoardConfig;
  if (!board.linear) throw new Error(`wor.json is missing the "linear" config block`);
  return board;
}

async function linearQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const apiKey = process.env['LINEAR_API_KEY'] ?? '';
  if (!apiKey) throw new Error('LINEAR_API_KEY is not set (expected in ~/symphony/secrets.env)');
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join(', '));
  return json.data;
}

async function fetchOpenIssues(board: BoardConfig): Promise<LinearIssue[]> {
  const stateIds = OPEN_STATE_KEYS
    .map((k) => board.linear!.states[k])
    .filter((id): id is string => Boolean(id));

  const all: LinearIssue[] = [];
  let after: string | null = null;

  while (true) {
    const data = await linearQuery<{
      team: {
        issues: {
          nodes: LinearIssue[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    }>(
      `query OpenWorIssues($teamId: String!, $stateIds: [ID!]!, $after: String) {
        team(id: $teamId) {
          issues(
            filter: { state: { id: { in: $stateIds } } }
            orderBy: updatedAt
            first: 250
            after: $after
          ) {
            nodes {
              identifier
              title
              url
              updatedAt
              state { id name }
              assignee { name }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { teamId: board.teamId, stateIds, after }
    );

    all.push(...data.team.issues.nodes);
    if (!data.team.issues.pageInfo.hasNextPage) break;
    const nextAfter = data.team.issues.pageInfo.endCursor;
    if (!nextAfter || nextAfter === after) {
      throw new Error('Linear pagination cursor stalled (hasNextPage=true but endCursor missing/unchanged)');
    }
    after = nextAfter;
  }

  return all;
}

function groupByState(issues: LinearIssue[]): Map<string, LinearIssue[]> {
  const grouped = new Map<string, LinearIssue[]>();
  for (const issue of issues) {
    const list = grouped.get(issue.state.name) ?? [];
    list.push(issue);
    grouped.set(issue.state.name, list);
  }
  return grouped;
}

function printTable(issues: LinearIssue[]): void {
  if (issues.length === 0) {
    console.log('No open WOR tickets — the cutover is complete.');
    return;
  }
  const grouped = groupByState(issues);
  const stateOrder = ['Backlog', 'Todo', 'In Progress', 'Human Review', 'Rework', 'Merging'];
  const ordered = [...grouped.keys()].sort(
    (a, b) => stateOrder.indexOf(a) - stateOrder.indexOf(b)
  );

  for (const stateName of ordered) {
    const bucket = grouped.get(stateName) ?? [];
    console.log(`\n## ${stateName} (${bucket.length})`);
    for (const issue of bucket) {
      const assignee = issue.assignee?.name ?? '—';
      console.log(`  ${issue.identifier.padEnd(8)} ${assignee.padEnd(16)} ${issue.title}`);
      console.log(`           ${issue.url}`);
    }
  }
  console.log(`\nTotal: ${issues.length} open WOR ticket(s).`);
}

async function main(): Promise<void> {
  loadSecrets();
  const board = loadBoard();
  const issues = await fetchOpenIssues(board);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(issues, null, 2));
    return;
  }
  printTable(issues);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
