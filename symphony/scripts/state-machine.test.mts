/**
 * state-machine.test.mts — verify processTicket() fires the right effects per
 * (state, condition) pair. Run with:
 *
 *   node --experimental-strip-types --test symphony/scripts/state-machine.test.mts
 *
 * Each registered board in $SYMPHONY_ROOT/config/boards/*.json gets its own
 * stub ticket and the test walks it through every state. This ensures new
 * boards added later cannot silently break the state machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  processTicket,
  ticketMachine,
  type BoardRef,
  type Deps,
  type Effect,
  type SpawnMode,
} from './state-machine.mts';
import type { Issue, StateKey } from './ticket-systems/types.mts';

// ── Helpers ───────────────────────────────────────────────────────────────────

const SYMPHONY_ROOT = path.resolve(import.meta.dirname, '..');

function loadBoards(): BoardRef[] {
  // Prefer real local config; fall back to config-example so tests run in any
  // clone (CI doesn't have private config/boards/*.json).
  for (const sub of ['config/boards', 'config-example/boards']) {
    const dir = path.join(SYMPHONY_ROOT, sub);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (files.length === 0) continue;
    return files.map((f) => {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      // Boards now group state IDs under `linear.states` / `jira.states` (UP-761).
      // Flatten the active system's states into the top-level `states` field
      // that BoardRef expects, so state-machine tests stay namespace-agnostic.
      const states = raw.ticketSystem === 'jira' ? raw.jira?.states : raw.linear?.states;
      return { ...raw, states } as BoardRef;
    });
  }
  return [];
}

function stubTicket(prefix: string, n: number, stateKey: StateKey, board: BoardRef): Issue {
  return {
    id: `uuid-${prefix}-${n}`,
    identifier: `${prefix}-${n}`,
    title: `Stub ticket ${prefix}-${n}`,
    description: null,
    url: `https://example.test/${prefix}-${n}`,
    project: null,
    state: { id: board.states[stateKey], name: stateKey },
    assignee: null,
  };
}

interface Call { fn: string; args: unknown[] }

function makeDeps(overrides: Partial<Deps<BoardRef>> = {}): { deps: Deps<BoardRef>; calls: Call[] } {
  const calls: Call[] = [];
  const record = <T extends unknown[]>(fn: string) => (...args: T) => {
    calls.push({ fn, args });
  };
  const recordAsync = <T extends unknown[], R>(fn: string, ret: R) => async (...args: T): Promise<R> => {
    calls.push({ fn, args });
    return ret;
  };

  const deps: Deps<BoardRef> = {
    moveToInProgress: recordAsync('moveToInProgress', undefined),
    moveToHumanReview: recordAsync('moveToHumanReview', undefined),
    moveToInReview: recordAsync('moveToInReview', undefined),
    moveToTodo: recordAsync('moveToTodo', undefined),
    moveToDone: recordAsync('moveToDone', undefined),
    spawnAgent: record('spawnAgent'),
    resetReworkTicket: recordAsync('resetReworkTicket', undefined),
    removeWorktree: record('removeWorktree'),
    areAllPRsMerged: () => false,
    isPRUrlMerged: () => false,
    checkHumanReviewApproval: async () => ({ alreadyHandled: false, aiReviewed: false, approved: false, prUrl: null, lockedPrUrl: null }),
    postComment: recordAsync('postComment', undefined),
    spawnAIReview: record('spawnAIReview'),
    spawnNotifyReview: async () => null,
    isAgentRunning: () => false,
    agentSlotsAvailable: () => 5,
    failureCountFor: () => 0,
    lastKnownState: () => undefined,
    worktreeOccupiedBy: () => null,
    isEligible: () => true,
    log: () => {},
    ...overrides,
  };
  return { deps, calls };
}

function fnNames(calls: Call[]): string[] {
  return calls.map((c) => c.fn);
}

// ── Per-board lifecycle walkthrough ───────────────────────────────────────────

const boards = loadBoards();
assert.ok(boards.length > 0, 'expected at least one board in config/boards/');

for (const board of boards) {
  test(`[${board.name}] todo → claim spawns fresh agent + moves to In Progress`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 100, 'todo', board);
    const { deps, calls } = makeDeps();
    const effect = await processTicket('todo', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'claim' });
    assert.deepEqual(fnNames(calls), ['moveToInProgress', 'spawnAgent']);
    const spawnArgs = calls[1].args as [Issue, BoardRef, SpawnMode];
    assert.equal(spawnArgs[2], 'fresh');
  });

  test(`[${board.name}] todo → no slots is a no-op`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 101, 'todo', board);
    const { deps, calls } = makeDeps({ agentSlotsAvailable: () => 0 });
    const effect = await processTicket('todo', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'noop', reason: 'no agent slots' });
    assert.deepEqual(calls, []);
  });

  test(`[${board.name}] inProgress (stale) → resumes with continue`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 102, 'inProgress', board);
    const { deps, calls } = makeDeps();
    const effect = await processTicket('inProgress', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'resumeAgent', mode: 'continue' });
    assert.deepEqual(fnNames(calls), ['spawnAgent']);
    const spawnArgs = calls[0].args as [Issue, BoardRef, SpawnMode];
    assert.equal(spawnArgs[2], 'continue');
  });

  test(`[${board.name}] inProgress after Human Review → resumes with feedback`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 103, 'inProgress', board);
    const { deps } = makeDeps({ lastKnownState: () => 'Human Review' });
    const effect = await processTicket('inProgress', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'resumeAgent', mode: 'feedback' });
  });

  test(`[${board.name}] inProgress with running agent → no-op`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 104, 'inProgress', board);
    const { deps, calls } = makeDeps({ isAgentRunning: () => true });
    const effect = await processTicket('inProgress', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'noop', reason: 'agent already running' });
    assert.deepEqual(calls, []);
  });

  test(`[${board.name}] todo when worktree is held by another agent → no-op (no claim, no spawn)`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 120, 'todo', board);
    const { deps, calls } = makeDeps({ worktreeOccupiedBy: () => `${board.ticketPrefix}-OTHER` });
    const effect = await processTicket('todo', ticket, board, deps);
    assert.equal(effect.kind, 'noop');
    if (effect.kind === 'noop') {
      assert.match(effect.reason, /worktree busy/);
      assert.match(effect.reason, new RegExp(`${board.ticketPrefix}-OTHER`));
    }
    assert.deepEqual(calls, []);
  });

  test(`[${board.name}] inProgress when worktree is held by another agent → no-op`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 121, 'inProgress', board);
    const { deps, calls } = makeDeps({ worktreeOccupiedBy: () => `${board.ticketPrefix}-OTHER` });
    const effect = await processTicket('inProgress', ticket, board, deps);
    assert.equal(effect.kind, 'noop');
    if (effect.kind === 'noop') assert.match(effect.reason, /worktree busy/);
    assert.deepEqual(calls, []);
  });

  test(`[${board.name}] merging when worktree is held by another agent → no-op (prevents retry-storm into a mid-rebase worktree)`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 122, 'merging', board);
    const { deps, calls } = makeDeps({ worktreeOccupiedBy: () => `${board.ticketPrefix}-OTHER` });
    const effect = await processTicket('merging', ticket, board, deps);
    assert.equal(effect.kind, 'noop');
    if (effect.kind === 'noop') assert.match(effect.reason, /worktree busy/);
    assert.deepEqual(calls, []);
  });

  test(`[${board.name}] merging into busy worktree even with no failure count + retries reverted → still no-op`, async () => {
    // Simulates the retry-storm scenario with MAX_RETRIES reverted: even if
    // failureCountFor returns 0 forever, the worktree-busy guard keeps the
    // spawn from firing while another agent (e.g. a Phase-N rebase sub-ticket)
    // still holds the worktree.
    const ticket = stubTicket(board.ticketPrefix, 123, 'merging', board);
    const { deps, calls } = makeDeps({
      failureCountFor: () => 0,
      worktreeOccupiedBy: () => `${board.ticketPrefix}-258`,
    });
    for (let i = 0; i < 10; i++) {
      const effect = await processTicket('merging', ticket, board, deps);
      assert.equal(effect.kind, 'noop');
    }
    assert.deepEqual(calls, [], 'no spawnAgent calls regardless of how many poll cycles fire');
  });

  test(`[${board.name}] inProgress past MAX_RETRIES → no-op`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 105, 'inProgress', board);
    const { deps, calls } = makeDeps({ failureCountFor: () => 99 });
    const effect = await processTicket('inProgress', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'noop', reason: 'max retries exhausted' });
    assert.deepEqual(calls, []);
  });

  test(`[${board.name}] humanReview when PR already merged → removes worktree + moves to Done`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 106, 'humanReview', board);
    const { deps, calls } = makeDeps({ areAllPRsMerged: () => true });
    const effect = await processTicket('humanReview', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'finalizeMergedDuringReview' });
    assert.deepEqual(fnNames(calls), ['removeWorktree', 'moveToDone']);
  });

  test(`[${board.name}] humanReview when Symphony-locked PR URL is merged on an unrelated branch → finalizes via isPRUrlMerged fallback`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 116, 'humanReview', board);
    const { deps, calls } = makeDeps({
      areAllPRsMerged: () => false,
      isPRUrlMerged: (url) => url === 'https://github.com/x/y/pull/999',
      checkHumanReviewApproval: async () => ({
        alreadyHandled: false,
        aiReviewed: true,
        approved: false,
        prUrl: 'https://github.com/x/y/pull/999',
        lockedPrUrl: 'https://github.com/x/y/pull/999',
      }),
    });
    const effect = await processTicket('humanReview', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'finalizeMergedDuringReview' });
    assert.deepEqual(fnNames(calls), ['removeWorktree', 'moveToDone']);
  });

  test(`[${board.name}] humanReview with untrusted PR URL (no Symphony lock) → does NOT finalize via fallback`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 117, 'humanReview', board);
    const isPRUrlMergedCalls: string[] = [];
    const { deps } = makeDeps({
      areAllPRsMerged: () => false,
      isPRUrlMerged: (url) => { isPRUrlMergedCalls.push(url); return true; },
      checkHumanReviewApproval: async () => ({
        alreadyHandled: false,
        aiReviewed: false,
        approved: false,
        prUrl: 'https://github.com/x/y/pull/777',
        lockedPrUrl: null,
      }),
    });
    const effect = await processTicket('humanReview', ticket, board, deps);
    assert.notDeepEqual(effect, { kind: 'finalizeMergedDuringReview' });
    assert.deepEqual(isPRUrlMergedCalls, [], 'isPRUrlMerged must not be called when lockedPrUrl is null');
  });

  test(`[${board.name}] humanReview fast-path finalizes even when comment fetch throws`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 118, 'humanReview', board);
    const { deps, calls } = makeDeps({
      areAllPRsMerged: () => true,
      checkHumanReviewApproval: async () => { throw new Error('comment API down'); },
    });
    const effect = await processTicket('humanReview', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'finalizeMergedDuringReview' });
    assert.deepEqual(fnNames(calls), ['removeWorktree', 'moveToDone']);
  });

  test(`[${board.name}] humanReview with approval → posts lock + moves to In Review`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 107, 'humanReview', board);
    const { deps, calls } = makeDeps({
      checkHumanReviewApproval: async () => ({
        alreadyHandled: false,
        aiReviewed: true,
        approved: true,
        prUrl: 'https://github.com/x/y/pull/1',
        lockedPrUrl: 'https://github.com/x/y/pull/1',
      }),
    });
    const effect = await processTicket('humanReview', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'humanReviewApproved' });
    // postComment (approval lock) + moveToInReview, in that order
    assert.deepEqual(fnNames(calls).slice(0, 2), ['postComment', 'moveToInReview']);
  });

  test(`[${board.name}] humanReview without AI review yet → posts AI-review lock + spawns review`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 108, 'humanReview', board);
    const { deps, calls } = makeDeps({
      checkHumanReviewApproval: async () => ({
        alreadyHandled: false,
        aiReviewed: false,
        approved: false,
        prUrl: 'https://github.com/x/y/pull/2',
        lockedPrUrl: null,
      }),
    });
    const effect = await processTicket('humanReview', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'humanReviewTriggerAI' });
    assert.deepEqual(fnNames(calls), ['postComment', 'spawnAIReview']);
  });

  test(`[${board.name}] merging with already-merged PR → finalize directly`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 109, 'merging', board);
    const { deps, calls } = makeDeps({ areAllPRsMerged: () => true });
    const effect = await processTicket('merging', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'finalizeMerged' });
    assert.deepEqual(fnNames(calls), ['removeWorktree', 'moveToDone']);
  });

  test(`[${board.name}] merging with open PR → spawns merging agent`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 110, 'merging', board);
    const { deps, calls } = makeDeps();
    const effect = await processTicket('merging', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'spawnMergingAgent' });
    assert.deepEqual(fnNames(calls), ['spawnAgent']);
    const spawnArgs = calls[0].args as [Issue, BoardRef, SpawnMode, boolean];
    assert.equal(spawnArgs[2], 'continue');
    assert.equal(spawnArgs[3], true);
  });

  test(`[${board.name}] merging past MAX_RETRIES → no-op`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 111, 'merging', board);
    const { deps, calls } = makeDeps({ failureCountFor: () => 99 });
    const effect = await processTicket('merging', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'noop', reason: 'max retries exhausted' });
    assert.deepEqual(calls, []);
  });

  test(`[${board.name}] rework with no running agent → resetReworkTicket`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 111, 'rework', board);
    const { deps, calls } = makeDeps();
    const effect = await processTicket('rework', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'resetRework' });
    assert.deepEqual(fnNames(calls), ['resetReworkTicket']);
  });

  test(`[${board.name}] rework with running agent → wait`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 112, 'rework', board);
    const { deps, calls } = makeDeps({ isAgentRunning: () => true });
    const effect = await processTicket('rework', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'noop', reason: 'agent still running' });
    assert.deepEqual(calls, []);
  });

  test(`[${board.name}] inReview / backlog / done → no-op`, async () => {
    const states: StateKey[] = ['inReview', 'backlog', 'done'];
    for (const s of states) {
      const ticket = stubTicket(board.ticketPrefix, 113, s, board);
      const { deps, calls } = makeDeps();
      const effect = await processTicket(s, ticket, board, deps);
      assert.equal(effect.kind, 'noop');
      assert.deepEqual(calls, []);
    }
  });

  test(`[${board.name}] full lifecycle walkthrough: todo → … → done`, async () => {
    const id = `${board.ticketPrefix}-999`;
    let lastSeen: string | undefined;
    const calls: Effect[] = [];

    const make = (overrides: Partial<Deps<BoardRef>>) => makeDeps({
      lastKnownState: () => lastSeen,
      ...overrides,
    });

    // 1. todo → claim
    {
      const ticket = stubTicket(board.ticketPrefix, 999, 'todo', board);
      const { deps } = make({});
      calls.push(await processTicket('todo', ticket, board, deps));
      lastSeen = 'Todo';
    }
    // 2. inProgress (stale, after claim) — agent done event fires moveToHumanReview
    //    externally; we just observe the transition by polling humanReview next.
    lastSeen = 'In Progress';
    // 3. humanReview with approval
    {
      const ticket = stubTicket(board.ticketPrefix, 999, 'humanReview', board);
      const { deps } = make({
        checkHumanReviewApproval: async () => ({
          alreadyHandled: false,
          aiReviewed: true,
          approved: true,
          prUrl: 'https://github.com/x/y/pull/999',
          lockedPrUrl: 'https://github.com/x/y/pull/999',
        }),
      });
      calls.push(await processTicket('humanReview', ticket, board, deps));
      lastSeen = 'Human Review';
    }
    // 4. inReview — waiting
    {
      const ticket = stubTicket(board.ticketPrefix, 999, 'inReview', board);
      const { deps } = make({});
      calls.push(await processTicket('inReview', ticket, board, deps));
      lastSeen = 'In Review';
    }
    // 5. merging — spawn agent
    {
      const ticket = stubTicket(board.ticketPrefix, 999, 'merging', board);
      const { deps } = make({});
      calls.push(await processTicket('merging', ticket, board, deps));
      lastSeen = 'Merging';
    }
    // 6. merging — PR now merged, finalize
    {
      const ticket = stubTicket(board.ticketPrefix, 999, 'merging', board);
      const { deps } = make({ areAllPRsMerged: () => true });
      calls.push(await processTicket('merging', ticket, board, deps));
      lastSeen = 'Done';
    }

    const kinds = calls.map((e) => e.kind);
    assert.deepEqual(kinds, [
      'claim',
      'humanReviewApproved',
      'noop',
      'spawnMergingAgent',
      'finalizeMerged',
    ]);
    // Reference id in assertion message so the linter doesn't trip on unused var
    assert.ok(id.startsWith(board.ticketPrefix), 'identifier prefix matches board');
  });
}

// ── XState chart sanity ───────────────────────────────────────────────────────

test('ticketMachine has all 8 Symphony states', () => {
  const stateIds = Object.keys(ticketMachine.config.states ?? {});
  assert.deepEqual(stateIds.sort(), [
    'backlog', 'done', 'humanReview', 'inProgress', 'inReview', 'merging', 'rework', 'todo',
  ]);
});

test('ticketMachine done is a final state', () => {
  const done = ticketMachine.config.states?.done as { type?: string } | undefined;
  assert.equal(done?.type, 'final');
});
