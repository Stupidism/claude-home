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
  // `cancelled` is optional on a board — when absent (e.g. test config-example
  // boards), we still want to construct a ticket stub for dispatch-logic tests.
  // The dispatcher never reads `state.id`, so a synthetic placeholder is fine.
  const stateId = board.states?.[stateKey] ?? `synthetic-${stateKey}`;
  return {
    id: `uuid-${prefix}-${n}`,
    identifier: `${prefix}-${n}`,
    title: `Stub ticket ${prefix}-${n}`,
    description: null,
    url: `https://example.test/${prefix}-${n}`,
    project: null,
    state: { id: stateId, name: stateKey },
    assignee: null,
    labels: [],
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
    moveToMerging: recordAsync('moveToMerging', undefined),
    moveToTodo: recordAsync('moveToTodo', undefined),
    moveToDone: recordAsync('moveToDone', undefined),
    spawnAgent: record('spawnAgent'),
    resetReworkTicket: recordAsync('resetReworkTicket', undefined),
    removeWorktree: record('removeWorktree'),
    cleanupCancelledTicket: recordAsync('cleanupCancelledTicket', undefined),
    areAllPRsMerged: () => false,
    isPRUrlMerged: () => false,
    checkHumanReviewApproval: async () => ({ alreadyHandled: false, approved: false, prUrl: null, lockedPrUrl: null, lastFeedbackRerouteAt: null }),
    postComment: recordAsync('postComment', undefined),
    spawnAIReview: ((ticket: Issue, board: BoardRef, prUrl: string) => {
      calls.push({ fn: 'spawnAIReview', args: [ticket, board, prUrl] });
      return true;
    }) as Deps<BoardRef>['spawnAIReview'],
    isAiReviewEnabled: () => true,
    getOpenPRUrl: async () => null,
    getPRHeadSha: async () => null,
    getAiReviewStatus: async () => null,
    postAiReviewStatus: recordAsync('postAiReviewStatus', undefined),
    hasReviewForSha: async () => false,
    hasNewPRReviewSince: async () => false,
    spawnNotifyReview: (async () => null) as Deps<BoardRef>['spawnNotifyReview'],
    addLabel: recordAsync('addLabel', undefined),
    isAgentRunning: () => false,
    agentSlotsAvailable: () => 5,
    failureCountFor: () => 0,
    resetFailureCount: record('resetFailureCount'),
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
    const { deps } = makeDeps();
    const effect = await processTicket('inProgress', ticket, board, deps, 'humanReview');
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

  // UP-781: a ticket that exhausted MAX_RETRIES on a previous round must get a
  // fresh budget when a human bounces it back through review → In Progress.
  // The dispatcher fires `resetFailureCount` on the review→inProgress edge so
  // the retry guard no longer trips.
  test(`[${board.name}] inProgress with prevState='rework' resets failureCount → spawnAgent fires even past MAX_RETRIES`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 130, 'inProgress', board);
    let count = 99;
    const { deps, calls } = makeDeps({
      failureCountFor: () => count,
      resetFailureCount: (_id: string) => { count = 0; },
    });
    const effect = await processTicket('inProgress', ticket, board, deps, 'rework');
    assert.deepEqual(effect, { kind: 'resumeAgent', mode: 'feedback' });
    assert.ok(fnNames(calls).includes('spawnAgent'), 'spawnAgent must be invoked despite prior failures');
    assert.equal(count, 0, 'failureCount must be reset to 0');
  });

  test(`[${board.name}] inProgress with prevState='humanReview' also resets failureCount`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 131, 'inProgress', board);
    let count = 99;
    const { deps, calls } = makeDeps({
      failureCountFor: () => count,
      resetFailureCount: (_id: string) => { count = 0; },
    });
    const effect = await processTicket('inProgress', ticket, board, deps, 'humanReview');
    assert.deepEqual(effect, { kind: 'resumeAgent', mode: 'feedback' });
    assert.ok(fnNames(calls).includes('spawnAgent'));
    assert.equal(count, 0);
  });

  test(`[${board.name}] inProgress with prevState='todo' does NOT reset (first-entry edge)`, async () => {
    // The reset is gated on the review-return edge: a ticket entering
    // In Progress for the first time (todo→inProgress) must keep its counter.
    const ticket = stubTicket(board.ticketPrefix, 132, 'inProgress', board);
    let count = 99;
    const { deps } = makeDeps({
      failureCountFor: () => count,
      resetFailureCount: (_id: string) => { count = 0; },
    });
    const effect = await processTicket('inProgress', ticket, board, deps, 'todo');
    assert.deepEqual(effect, { kind: 'noop', reason: 'max retries exhausted' });
    assert.equal(count, 99, 'counter untouched on non-review edge');
  });

  test(`[${board.name}] inProgress with prevState='inProgress' does NOT reset (re-observation)`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 133, 'inProgress', board);
    let count = 99;
    const { deps } = makeDeps({
      failureCountFor: () => count,
      resetFailureCount: (_id: string) => { count = 0; },
    });
    const effect = await processTicket('inProgress', ticket, board, deps, 'inProgress');
    assert.deepEqual(effect, { kind: 'noop', reason: 'max retries exhausted' });
    assert.equal(count, 99);
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
        approved: false,
        prUrl: 'https://github.com/x/y/pull/999',
        lockedPrUrl: 'https://github.com/x/y/pull/999',
        lastFeedbackRerouteAt: null,
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
        approved: false,
        prUrl: 'https://github.com/x/y/pull/777',
        lockedPrUrl: null,
        lastFeedbackRerouteAt: null,
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

  test(`[${board.name}] humanReview with approval → posts lock + moves directly to Merging`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 107, 'humanReview', board);
    const { deps, calls } = makeDeps({
      checkHumanReviewApproval: async () => ({
        alreadyHandled: false,
        approved: true,
        prUrl: 'https://github.com/x/y/pull/1',
        lockedPrUrl: 'https://github.com/x/y/pull/1',
        lastFeedbackRerouteAt: null,
      }),
    });
    const effect = await processTicket('humanReview', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'humanReviewApproved' });
    // postComment (approval lock) + moveToMerging, in that order (UP-782: no In Review hop)
    assert.deepEqual(fnNames(calls).slice(0, 2), ['postComment', 'moveToMerging']);
  });

  test(`[${board.name}] humanReview with no notify-review label → no notify, no addLabel`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 130, 'humanReview', board);
    const spawnCalls: string[] = [];
    const { deps, calls } = makeDeps({
      checkHumanReviewApproval: async () => ({
        alreadyHandled: true, // skip AI-review path so we isolate notify gating
        approved: false,
        prUrl: 'https://github.com/x/y/pull/3',
        lockedPrUrl: 'https://github.com/x/y/pull/3',
        lastFeedbackRerouteAt: null,
      }),
      spawnNotifyReview: async (_t, _b, url) => { spawnCalls.push(url); return null; },
    });
    const effect = await processTicket('humanReview', ticket, board, deps);
    assert.equal(effect.kind, 'noop');
    assert.deepEqual(spawnCalls, [], 'notify must not fire without the needs-notify label');
    assert.ok(!fnNames(calls).includes('addLabel'));
  });

  test(`[${board.name}] humanReview with symphony:needs-notify-review and no review-notified → fires notify + stamps label`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 131, 'humanReview', board);
    ticket.labels = ['symphony:needs-notify-review'];
    const spawnCalls: string[] = [];
    const { deps, calls } = makeDeps({
      checkHumanReviewApproval: async () => ({
        alreadyHandled: true,
        approved: false,
        prUrl: 'https://github.com/x/y/pull/4',
        lockedPrUrl: 'https://github.com/x/y/pull/4',
        lastFeedbackRerouteAt: null,
      }),
      spawnNotifyReview: async (_t, _b, url) => { spawnCalls.push(url); return 'https://slack/x'; },
    });
    const effect = await processTicket('humanReview', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'humanReviewNotifyTeam' });
    assert.deepEqual(spawnCalls, ['https://github.com/x/y/pull/4']);
    const addLabelCall = calls.find((c) => c.fn === 'addLabel');
    assert.ok(addLabelCall, 'addLabel must be called');
    assert.equal((addLabelCall!.args as unknown[])[2], 'symphony:review-notified');
  });

  test(`[${board.name}] humanReview with both notify labels → does NOT re-fire notify`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 132, 'humanReview', board);
    ticket.labels = ['symphony:needs-notify-review', 'symphony:review-notified'];
    const spawnCalls: string[] = [];
    const { deps, calls } = makeDeps({
      checkHumanReviewApproval: async () => ({
        alreadyHandled: true,
        approved: false,
        prUrl: 'https://github.com/x/y/pull/5',
        lockedPrUrl: 'https://github.com/x/y/pull/5',
        lastFeedbackRerouteAt: null,
      }),
      spawnNotifyReview: async (_t, _b, url) => { spawnCalls.push(url); return 'https://slack/x'; },
    });
    const effect = await processTicket('humanReview', ticket, board, deps);
    assert.equal(effect.kind, 'noop');
    assert.deepEqual(spawnCalls, []);
    assert.ok(!fnNames(calls).includes('addLabel'));
  });

  // UP-806: AI review now fires inside In Progress, not Human Review. The
  // handleHumanReview branch that posted `[symphony] aiReviewRequested:` and
  // spawned the AI reviewer has been removed.
  test(`[${board.name}] humanReview no longer spawns AI review (UP-806 — moved to In Progress)`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 108, 'humanReview', board);
    const { deps, calls } = makeDeps({
      checkHumanReviewApproval: async () => ({
        alreadyHandled: false,
        approved: false,
        prUrl: 'https://github.com/x/y/pull/2',
        lockedPrUrl: null,
        lastFeedbackRerouteAt: null,
      }),
    });
    const effect = await processTicket('humanReview', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'humanReviewWaitForApproval' });
    assert.ok(!fnNames(calls).includes('spawnAIReview'), 'handleHumanReview must not spawn AI review');
    assert.ok(!fnNames(calls).some((n) => n === 'postComment'), 'handleHumanReview must not post the request-lock comment');
  });

  test(`[${board.name}] inProgress with PR + no AI-review status → writes pending FIRST, then spawns AI review`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 208, 'inProgress', board);
    const order: string[] = [];
    const { deps } = makeDeps({
      // Suppress the agent-spawn side of handleInProgress so we isolate the
      // AI-review orchestration.
      isAgentRunning: () => true,
      getOpenPRUrl: async () => 'https://github.com/x/y/pull/208',
      getPRHeadSha: async () => 'sha208',
      getAiReviewStatus: async () => null,
      postAiReviewStatus: async (_url, _sha, state) => { order.push(`postAiReviewStatus:${state}`); },
      spawnAIReview: () => { order.push('spawnAIReview'); return true; },
    });
    await processTicket('inProgress', ticket, board, deps);
    // Order matters (Codex P1 on PR #68): pending must be written before the
    // trigger fires so a failed status write doesn't produce duplicate
    // review requests on every cycle.
    assert.deepEqual(order, ['postAiReviewStatus:pending', 'spawnAIReview']);
  });

  test(`[${board.name}] inProgress with PR + no status + AI review disabled → no pending write, no spawn`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 215, 'inProgress', board);
    const order: string[] = [];
    const { deps } = makeDeps({
      isAgentRunning: () => true,
      getOpenPRUrl: async () => 'https://github.com/x/y/pull/215',
      getPRHeadSha: async () => 'sha215',
      getAiReviewStatus: async () => null,
      isAiReviewEnabled: () => false,
      postAiReviewStatus: async (_url, _sha, state) => { order.push(`postAiReviewStatus:${state}`); },
      spawnAIReview: () => { order.push('spawnAIReview'); return true; },
    });
    await processTicket('inProgress', ticket, board, deps);
    // When AI review is disabled, the orchestration must NOT write `pending`
    // — otherwise the status stays pending forever (no review will arrive)
    // and the In Progress → Human Review gate never passes (Codex P1).
    assert.deepEqual(order, []);
  });

  test(`[${board.name}] inProgress with PR + getAiReviewStatus returns 'unknown' → skip cycle (no write, no spawn)`, async () => {
    // UP-830 regression guard: a transient gh API failure must NOT fall
    // through to the first-time branch. Otherwise every network blip re-posts
    // `pending` and re-spawns the AI review trigger, causing duplicate Codex
    // review comments on the same unchanged commit.
    const ticket = stubTicket(board.ticketPrefix, 217, 'inProgress', board);
    const order: string[] = [];
    const { deps } = makeDeps({
      isAgentRunning: () => true,
      getOpenPRUrl: async () => 'https://github.com/x/y/pull/217',
      getPRHeadSha: async () => 'sha217',
      getAiReviewStatus: async () => 'unknown',
      postAiReviewStatus: async (_url, _sha, state) => { order.push(`postAiReviewStatus:${state}`); },
      spawnAIReview: () => { order.push('spawnAIReview'); return true; },
    });
    await processTicket('inProgress', ticket, board, deps);
    assert.deepEqual(order, []);
  });

  test(`[${board.name}] inProgress with PR + failed pending write → no spawn (avoids duplicate triggers)`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 216, 'inProgress', board);
    const order: string[] = [];
    const { deps } = makeDeps({
      isAgentRunning: () => true,
      getOpenPRUrl: async () => 'https://github.com/x/y/pull/216',
      getPRHeadSha: async () => 'sha216',
      getAiReviewStatus: async () => null,
      postAiReviewStatus: async () => { order.push('postAiReviewStatus:throw'); throw new Error('403'); },
      spawnAIReview: () => { order.push('spawnAIReview'); return true; },
    });
    await processTicket('inProgress', ticket, board, deps);
    // pending write failed → trigger MUST NOT fire (Codex P1 on PR #68).
    // Next cycle will retry from scratch (status still absent).
    assert.deepEqual(order, ['postAiReviewStatus:throw']);
  });

  test(`[${board.name}] inProgress with PR + pending status + review for current HEAD → flips to success`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 209, 'inProgress', board);
    const postStatusArgs: Array<[string, string, string, string]> = [];
    const { deps, calls } = makeDeps({
      isAgentRunning: () => true,
      getOpenPRUrl: async () => 'https://github.com/x/y/pull/209',
      getPRHeadSha: async () => 'sha209',
      getAiReviewStatus: async () => 'pending',
      hasReviewForSha: async () => true,
      postAiReviewStatus: async (...args) => {
        postStatusArgs.push(args as [string, string, string, string]);
      },
    });
    await processTicket('inProgress', ticket, board, deps);
    assert.deepEqual(postStatusArgs, [['https://github.com/x/y/pull/209', 'sha209', 'success', 'AI reviewer responded']]);
    assert.ok(!fnNames(calls).includes('spawnAIReview'), 'must not re-spawn AI review when status already pending');
  });

  test(`[${board.name}] inProgress with PR + pending status + no review yet → no-op on the status flip`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 210, 'inProgress', board);
    const postStatusArgs: unknown[][] = [];
    const { deps, calls } = makeDeps({
      isAgentRunning: () => true,
      getOpenPRUrl: async () => 'https://github.com/x/y/pull/210',
      getPRHeadSha: async () => 'sha210',
      getAiReviewStatus: async () => 'pending',
      hasReviewForSha: async () => false,
      postAiReviewStatus: async (...args) => { postStatusArgs.push(args); },
    });
    await processTicket('inProgress', ticket, board, deps);
    assert.deepEqual(postStatusArgs, [], 'must not flip status without a matching review');
    assert.ok(!fnNames(calls).includes('spawnAIReview'));
  });

  test(`[${board.name}] inProgress with PR + success status → no AI-review side-effect`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 211, 'inProgress', board);
    const postStatusArgs: unknown[][] = [];
    const { deps, calls } = makeDeps({
      isAgentRunning: () => true,
      getOpenPRUrl: async () => 'https://github.com/x/y/pull/211',
      getPRHeadSha: async () => 'sha211',
      getAiReviewStatus: async () => 'success',
      postAiReviewStatus: async (...args) => { postStatusArgs.push(args); },
    });
    await processTicket('inProgress', ticket, board, deps);
    assert.deepEqual(postStatusArgs, []);
    assert.ok(!fnNames(calls).includes('spawnAIReview'));
  });

  test(`[${board.name}] inProgress with no PR → AI orchestration is a no-op`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 212, 'inProgress', board);
    const postStatusArgs: unknown[][] = [];
    const { deps, calls } = makeDeps({
      isAgentRunning: () => true,
      getOpenPRUrl: async () => null,
      postAiReviewStatus: async (...args) => { postStatusArgs.push(args); },
    });
    await processTicket('inProgress', ticket, board, deps);
    assert.deepEqual(postStatusArgs, []);
    assert.ok(!fnNames(calls).includes('spawnAIReview'));
  });

  test(`[${board.name}] humanReview after AI fired with no new PR review yet → waits (no reroute)`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 140, 'humanReview', board);
    const { deps, calls } = makeDeps({
      checkHumanReviewApproval: async () => ({
        alreadyHandled: false,
        approved: false,
        prUrl: 'https://github.com/x/y/pull/140',
        lockedPrUrl: 'https://github.com/x/y/pull/140',
        lastFeedbackRerouteAt: null,
      }),
      hasNewPRReviewSince: async () => false,
    });
    const effect = await processTicket('humanReview', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'humanReviewWaitForApproval' });
    assert.ok(!fnNames(calls).includes('moveToInProgress'), 'must not reroute without fresh PR feedback');
  });

  test(`[${board.name}] humanReview with fresh PR review → posts reroute lock + moves to In Progress`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 141, 'humanReview', board);
    const { deps, calls } = makeDeps({
      checkHumanReviewApproval: async () => ({
        alreadyHandled: false,
        approved: false,
        prUrl: 'https://github.com/x/y/pull/141',
        lockedPrUrl: 'https://github.com/x/y/pull/141',
        lastFeedbackRerouteAt: null,
      }),
      hasNewPRReviewSince: async () => true,
    });
    const effect = await processTicket('humanReview', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'humanReviewFeedbackReroute' });
    assert.deepEqual(fnNames(calls), ['postComment', 'moveToInProgress']);
    const postCommentCall = calls.find((c) => c.fn === 'postComment');
    const body = (postCommentCall?.args as unknown[])[2] as string;
    assert.match(body, /^\[symphony\] feedbackReroute: https:\/\/github\.com\/x\/y\/pull\/141 at=\d{4}-\d{2}-\d{2}T/);
  });

  test(`[${board.name}] humanReview reroute is gated by approval → approved short-circuits to Merging`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 142, 'humanReview', board);
    let rerouteCheck = 0;
    const { deps, calls } = makeDeps({
      checkHumanReviewApproval: async () => ({
        alreadyHandled: false,
        approved: true,
        prUrl: 'https://github.com/x/y/pull/142',
        lockedPrUrl: 'https://github.com/x/y/pull/142',
        lastFeedbackRerouteAt: null,
      }),
      hasNewPRReviewSince: async () => { rerouteCheck++; return true; },
    });
    const effect = await processTicket('humanReview', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'humanReviewApproved' });
    assert.equal(rerouteCheck, 0, 'reroute branch must short-circuit on approved without invoking gh');
    // postComment (approval lock) + moveToMerging — same as the existing approval test.
    assert.deepEqual(fnNames(calls).slice(0, 2), ['postComment', 'moveToMerging']);
    assert.ok(!fnNames(calls).includes('moveToInProgress'), 'approval must short-circuit reroute');
  });

  test(`[${board.name}] humanReview after prior reroute → only re-reroutes when PR review is newer than lock`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 143, 'humanReview', board);
    const lastReroute = new Date('2026-05-19T07:00:00Z');
    const receivedSince: Array<Date | null> = [];
    const { deps } = makeDeps({
      checkHumanReviewApproval: async () => ({
        alreadyHandled: false,
        approved: false,
        prUrl: 'https://github.com/x/y/pull/143',
        lockedPrUrl: 'https://github.com/x/y/pull/143',
        lastFeedbackRerouteAt: lastReroute,
      }),
      hasNewPRReviewSince: async (_url, since) => { receivedSince.push(since); return false; },
    });
    const effect = await processTicket('humanReview', ticket, board, deps);
    assert.deepEqual(effect, { kind: 'humanReviewWaitForApproval' });
    assert.equal(receivedSince.length, 1);
    assert.equal(receivedSince[0]?.toISOString(), lastReroute.toISOString(),
      'cut-off must be the most recent reroute timestamp');
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

  test(`[${board.name}] rework with no running agent (edge) → resetReworkTicket fires`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 111, 'rework', board);
    const { deps, calls } = makeDeps();
    const effect = await processTicket('rework', ticket, board, deps, 'humanReview');
    assert.deepEqual(effect, { kind: 'resetRework' });
    assert.deepEqual(fnNames(calls), ['resetReworkTicket']);
  });

  test(`[${board.name}] rework when prevState is already rework → no-op (edge guard, UP-775)`, async () => {
    // The bug this guards: a Rework ticket whose reset failed (or whose human
    // is mid-conversation in the workpad) would have re-fired resetReworkTicket
    // every poll cycle under the old level-triggered dispatcher.
    const ticket = stubTicket(board.ticketPrefix, 119, 'rework', board);
    const { deps, calls } = makeDeps();
    const effect = await processTicket('rework', ticket, board, deps, 'rework');
    assert.equal(effect.kind, 'noop');
    if (effect.kind === 'noop') assert.match(effect.reason, /already reset/);
    assert.deepEqual(calls, []);
  });

  test(`[${board.name}] rework with running agent → wait`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 112, 'rework', board);
    const { deps, calls } = makeDeps({ isAgentRunning: () => true });
    const effect = await processTicket('rework', ticket, board, deps, 'inProgress');
    assert.deepEqual(effect, { kind: 'noop', reason: 'agent still running' });
    assert.deepEqual(calls, []);
  });

  test(`[${board.name}] cancelled on the prev→cancelled edge → fires cleanupCancelledTicket once`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 130, 'cancelled', board);
    const { deps, calls } = makeDeps();
    const effect = await processTicket('cancelled', ticket, board, deps, 'inProgress');
    assert.deepEqual(effect, { kind: 'cancelledCleanup' });
    assert.deepEqual(fnNames(calls), ['cleanupCancelledTicket']);
  });

  test(`[${board.name}] cancelled when prevState is already cancelled → no-op (UP-775 bug fix)`, async () => {
    // The exact level-trigger bug flagged by Codex on PR #45: without an edge
    // guard, every poll cycle would re-fire cleanup on every historical
    // cancelled ticket — hammering `gh pr list` and the ticket comment API.
    const ticket = stubTicket(board.ticketPrefix, 131, 'cancelled', board);
    const { deps, calls } = makeDeps();
    for (let i = 0; i < 5; i++) {
      const effect = await processTicket('cancelled', ticket, board, deps, 'cancelled');
      assert.equal(effect.kind, 'noop');
    }
    assert.deepEqual(calls, [], 'cleanupCancelledTicket must not fire on re-observation');
  });

  test(`[${board.name}] cancelled on cold start (prevState null) → still fires cleanup once`, async () => {
    // Cold start (poller restart, no persisted state) must still treat the
    // first observation as an edge, otherwise tickets cancelled while the
    // poller was offline never get cleaned up.
    const ticket = stubTicket(board.ticketPrefix, 132, 'cancelled', board);
    const { deps, calls } = makeDeps();
    const effect = await processTicket('cancelled', ticket, board, deps, null);
    assert.deepEqual(effect, { kind: 'cancelledCleanup' });
    assert.deepEqual(fnNames(calls), ['cleanupCancelledTicket']);
  });

  test(`[${board.name}] cancelled with a running agent → wait for agent to exit before cleaning up`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 133, 'cancelled', board);
    const { deps, calls } = makeDeps({ isAgentRunning: () => true });
    const effect = await processTicket('cancelled', ticket, board, deps, 'inProgress');
    assert.deepEqual(effect, { kind: 'noop', reason: 'agent still running' });
    assert.deepEqual(calls, [], 'cleanup deferred until the agent exits');
  });

  test(`[${board.name}] cancelled deferred-then-resolved still fires on the next cycle (Codex P1 on PR #49)`, async () => {
    // Reproduces the regression flagged on the UP-775 PR: if the poller had
    // persisted `cancelled` as the lastKnownState on the deferred cycle, the
    // next cycle's edge guard would see `prevState === 'cancelled'` and skip
    // cleanup forever. The poller MUST NOT advance prevState on a deferred
    // edge — this test asserts the state-machine half of that contract:
    // given the unchanged prevState, the next dispatch must fire.
    const ticket = stubTicket(board.ticketPrefix, 134, 'cancelled', board);
    // Cycle N — agent still running, dispatcher defers.
    let agentRunning = true;
    const { deps, calls } = makeDeps({ isAgentRunning: () => agentRunning });
    const deferred = await processTicket('cancelled', ticket, board, deps, 'inProgress');
    assert.deepEqual(deferred, { kind: 'noop', reason: 'agent still running' });
    assert.deepEqual(calls, [], 'no cleanup on the deferred cycle');
    // Cycle N+1 — agent exited; poller correctly kept prevState === 'inProgress'.
    agentRunning = false;
    const fired = await processTicket('cancelled', ticket, board, deps, 'inProgress');
    assert.deepEqual(fired, { kind: 'cancelledCleanup' });
    assert.deepEqual(fnNames(calls), ['cleanupCancelledTicket']);
  });

  test(`[${board.name}] rework deferred-then-resolved still fires on the next cycle (Codex P1 on PR #49)`, async () => {
    const ticket = stubTicket(board.ticketPrefix, 135, 'rework', board);
    let agentRunning = true;
    const { deps, calls } = makeDeps({ isAgentRunning: () => agentRunning });
    const deferred = await processTicket('rework', ticket, board, deps, 'inProgress');
    assert.deepEqual(deferred, { kind: 'noop', reason: 'agent still running' });
    assert.deepEqual(calls, []);
    agentRunning = false;
    const fired = await processTicket('rework', ticket, board, deps, 'inProgress');
    assert.deepEqual(fired, { kind: 'resetRework' });
    assert.deepEqual(fnNames(calls), ['resetReworkTicket']);
  });

  test(`[${board.name}] backlog / done → no-op`, async () => {
    const states: StateKey[] = ['backlog', 'done'];
    for (const s of states) {
      const ticket = stubTicket(board.ticketPrefix, 113, s, board);
      const { deps, calls } = makeDeps();
      const effect = await processTicket(s, ticket, board, deps, null);
      assert.equal(effect.kind, 'noop');
      assert.deepEqual(calls, []);
    }
  });

  test(`[${board.name}] full lifecycle walkthrough: todo → … → done`, async () => {
    const id = `${board.ticketPrefix}-999`;
    let lastSeen: StateKey | null = null;
    const calls: Effect[] = [];

    // 1. todo → claim
    {
      const ticket = stubTicket(board.ticketPrefix, 999, 'todo', board);
      const { deps } = makeDeps();
      calls.push(await processTicket('todo', ticket, board, deps, lastSeen));
      lastSeen = 'todo';
    }
    // 2. inProgress (stale, after claim) — agent done event fires moveToHumanReview
    //    externally; we just observe the transition by polling humanReview next.
    lastSeen = 'inProgress';
    // 3. humanReview with approval
    {
      const ticket = stubTicket(board.ticketPrefix, 999, 'humanReview', board);
      const { deps } = makeDeps({
        checkHumanReviewApproval: async () => ({
          alreadyHandled: false,
          approved: true,
          prUrl: 'https://github.com/x/y/pull/999',
          lockedPrUrl: 'https://github.com/x/y/pull/999',
          lastFeedbackRerouteAt: null,
        }),
      });
      calls.push(await processTicket('humanReview', ticket, board, deps, lastSeen));
      lastSeen = 'humanReview';
    }
    // 4. merging — spawn agent (UP-782: approval skips inReview, goes straight here)
    {
      const ticket = stubTicket(board.ticketPrefix, 999, 'merging', board);
      const { deps } = makeDeps();
      calls.push(await processTicket('merging', ticket, board, deps, lastSeen));
      lastSeen = 'merging';
    }
    // 5. merging — PR now merged, finalize
    {
      const ticket = stubTicket(board.ticketPrefix, 999, 'merging', board);
      const { deps } = makeDeps({ areAllPRsMerged: () => true });
      calls.push(await processTicket('merging', ticket, board, deps, lastSeen));
      lastSeen = 'done';
    }

    const kinds = calls.map((e) => e.kind);
    assert.deepEqual(kinds, [
      'claim',
      'humanReviewApproved',
      'spawnMergingAgent',
      'finalizeMerged',
    ]);
    // Reference id in assertion message so the linter doesn't trip on unused var
    assert.ok(id.startsWith(board.ticketPrefix), 'identifier prefix matches board');
  });
}

// ── XState chart sanity ───────────────────────────────────────────────────────

test('ticketMachine has all 8 Symphony states (UP-782 removed inReview; UP-775 added cancelled)', () => {
  const stateIds = Object.keys(ticketMachine.config.states ?? {});
  assert.deepEqual(stateIds.sort(), [
    'backlog', 'cancelled', 'done', 'humanReview', 'inProgress', 'merging', 'rework', 'todo',
  ]);
});

test('ticketMachine done is a final state', () => {
  const done = ticketMachine.config.states?.done as { type?: string } | undefined;
  assert.equal(done?.type, 'final');
});

test('ticketMachine cancelled is a final state', () => {
  const cancelled = ticketMachine.config.states?.cancelled as { type?: string } | undefined;
  assert.equal(cancelled?.type, 'final');
});
