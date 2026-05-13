/**
 * state-machine.mts — Symphony ticket-lifecycle state machine.
 *
 * The poller observes Linear/Jira every cycle and discovers each ticket's
 * current state. This module is the single place that decides what side
 * effect to run for that state (claim, spawn, finalize, reset, …).
 *
 * Two halves:
 *
 *   1. `ticketMachine` — an XState v5 statechart that documents the lifecycle
 *      declaratively. The poller does NOT execute this machine; the actor
 *      lives in Linear/Jira, not in process memory. We keep the chart for:
 *        - visualization in stately.ai (paste output of visualize-state-machine.mts)
 *        - a single typed source of truth for state/event names
 *        - exhaustiveness checks at the type level
 *
 *   2. `processTicket` — the imperative dispatcher the poller actually calls
 *      once per ticket per cycle. It looks at the observed state, consults
 *      `Deps` (injected I/O — moveToX / spawnAgent / etc.), and fires the
 *      appropriate side effect. All branching that used to live inline in
 *      poll-tickets.mts `poll()` now lives here so the poller's `poll()`
 *      is reduced to "fetch → dispatch → render".
 *
 * Why not run XState as the actual runtime? The source of truth for state
 * is the ticket system (Linear or Jira); two clients edit it concurrently
 * (this poller plus human reviewers), so the local FSM would constantly be
 * fighting Linear. Observed-state dispatch is simpler and correct.
 */

import { setup } from 'xstate';
import type { Issue, StateKey } from './ticket-systems/types.mts';

// ── Public types ──────────────────────────────────────────────────────────────

export type SpawnMode = 'fresh' | 'continue' | 'feedback';

/** Any object that quacks like a BoardConfig. Kept structural so tests can pass stubs. */
export interface BoardRef {
  name: string;
  ticketPrefix: string;
  states: Record<StateKey, string>;
}

/**
 * Side-effect callbacks the poller injects. Each one is wrapped in a thin
 * layer that handles its own logging — `processTicket` never logs directly,
 * so tests can assert exactly which deps fired.
 */
export interface Deps<Board extends BoardRef = BoardRef> {
  // State transitions
  moveToInProgress(board: Board, issueId: string, identifier: string): Promise<void>;
  moveToHumanReview(board: Board, issueId: string, identifier: string): Promise<void>;
  moveToInReview(board: Board, issueId: string, identifier: string): Promise<void>;
  moveToTodo(board: Board, issueId: string, identifier: string): Promise<void>;
  moveToDone(board: Board, issueId: string, identifier: string): Promise<void>;

  // Agent lifecycle
  spawnAgent(ticket: Issue, board: Board, mode: SpawnMode, forMerging?: boolean): void;
  resetReworkTicket(ticket: Issue, board: Board): Promise<void>;
  removeWorktree(ticket: Issue, board: Board): void;

  // GitHub / review checks
  areAllPRsMerged(ticket: Issue, board: Board): boolean;
  /**
   * Resolve a specific PR URL and return whether GitHub reports it MERGED.
   * Used as a fallback when the ticket references a pre-existing PR whose
   * head branch does not match the synthesized branch name (e.g. an agent
   * recognized the issue was already fixed by an unrelated PR).
   */
  isPRUrlMerged(prUrl: string): boolean;
  checkHumanReviewApproval(ticket: Issue, board: Board): Promise<{
    alreadyHandled: boolean;
    aiReviewed: boolean;
    approved: boolean;
    /** First PR URL found in any comment — used for AI review + notify flows. */
    prUrl: string | null;
    /**
     * PR URL extracted only from Symphony-authored lock comments
     * (`[symphony] aiReviewRequested:` / `[symphony] developerApproved:`).
     * Trusted reference for finalize-as-merged decisions so an unrelated PR
     * URL pasted in human discussion can't trigger a premature Done move.
     */
    lockedPrUrl: string | null;
  }>;
  postComment(board: Board, issueId: string, body: string): Promise<void>;
  spawnAIReview(ticket: Issue, board: Board, prUrl: string): void;
  spawnNotifyReview(ticket: Issue, board: Board, prUrl: string): Promise<string | null>;

  // Capacity / running-agent introspection
  isAgentRunning(identifier: string): boolean;
  agentSlotsAvailable(): number;
  failureCountFor(identifier: string): number;
  lastKnownState(identifier: string): string | undefined;

  // Selection
  isEligible(ticket: Issue, board: Board): boolean;

  // Logging — single hook so tests don't need to silence chalk
  log(msg: string): void;
}

/** What `processTicket` did this cycle. Returned for tests + dashboards. */
export type Effect =
  | { kind: 'noop'; reason: string }
  | { kind: 'claim' }
  | { kind: 'resumeAgent'; mode: SpawnMode }
  | { kind: 'spawnMergingAgent' }
  | { kind: 'finalizeMerged' }
  | { kind: 'finalizeMergedDuringReview' }
  | { kind: 'humanReviewWaitForApproval' }
  | { kind: 'humanReviewTriggerAI' }
  | { kind: 'humanReviewApproved' }
  | { kind: 'resetRework' };

export const MAX_RETRIES = 3;
export const AI_REVIEW_LOCK_PREFIX = '[symphony] aiReviewRequested:';
export const APPROVAL_LOCK_PREFIX = '[symphony] developerApproved:';

// ── XState chart (declarative documentation + viz) ────────────────────────────

/**
 * The events below describe transitions a ticket can undergo. The poller
 * fires them implicitly by observing Linear; the chart is here so a human
 * can read the lifecycle in one place and so stately.ai can render it.
 */
export type TicketEvent =
  | { type: 'CLAIM' }                       // todo → inProgress
  | { type: 'AGENT_DONE' }                  // inProgress → humanReview
  | { type: 'AGENT_FAILED' }                // inProgress → inProgress (retry)
  | { type: 'AGENT_EXHAUSTED' }             // inProgress → backlog (give up after MAX_RETRIES)
  | { type: 'RESUME' }                      // inProgress → inProgress (stale resume)
  | { type: 'REVIEW_TRIGGER_AI' }           // humanReview → humanReview (post review comment)
  | { type: 'REVIEW_APPROVED' }             // humanReview → inReview
  | { type: 'PR_MERGED_EARLY' }             // humanReview → done (reviewer merged directly)
  | { type: 'READY_TO_MERGE' }              // inReview → merging (human moves the ticket)
  | { type: 'SPAWN_MERGING' }               // merging → merging (agent runs land skill)
  | { type: 'PR_MERGED' }                   // merging → done
  | { type: 'REWORK_REQUESTED' }            // any → rework (human moves the ticket)
  | { type: 'REWORK_RESET' };               // rework → todo (after cleanup)

export const ticketMachine = setup({
  types: {
    events: {} as TicketEvent,
  },
}).createMachine({
  id: 'symphony-ticket',
  initial: 'backlog',
  states: {
    backlog: {
      on: { CLAIM: 'todo' },
    },
    todo: {
      on: {
        CLAIM: 'inProgress',
        REWORK_REQUESTED: 'rework',
      },
    },
    inProgress: {
      on: {
        AGENT_DONE: 'humanReview',
        AGENT_FAILED: 'inProgress',
        AGENT_EXHAUSTED: 'backlog',
        RESUME: 'inProgress',
        REWORK_REQUESTED: 'rework',
      },
    },
    humanReview: {
      on: {
        REVIEW_TRIGGER_AI: 'humanReview',
        REVIEW_APPROVED: 'inReview',
        PR_MERGED_EARLY: 'done',
        REWORK_REQUESTED: 'rework',
      },
    },
    inReview: {
      on: {
        READY_TO_MERGE: 'merging',
        REWORK_REQUESTED: 'rework',
      },
    },
    merging: {
      on: {
        SPAWN_MERGING: 'merging',
        PR_MERGED: 'done',
        REWORK_REQUESTED: 'rework',
      },
    },
    rework: {
      on: {
        REWORK_RESET: 'todo',
      },
    },
    done: {
      type: 'final',
    },
  },
});

// ── Per-state dispatchers ─────────────────────────────────────────────────────

interface DispatchArgs<Board extends BoardRef> {
  ticket: Issue;
  board: Board;
  deps: Deps<Board>;
}

async function handleTodo<B extends BoardRef>({ ticket, board, deps }: DispatchArgs<B>): Promise<Effect> {
  if (!deps.isEligible(ticket, board)) return { kind: 'noop', reason: 'not eligible' };
  if (deps.isAgentRunning(ticket.identifier)) return { kind: 'noop', reason: 'agent already running' };
  if (deps.agentSlotsAvailable() <= 0) return { kind: 'noop', reason: 'no agent slots' };

  deps.log(`Claiming ${ticket.identifier} — ${ticket.title}`);
  await deps.moveToInProgress(board, ticket.id, ticket.identifier);
  deps.spawnAgent(ticket, board, 'fresh');
  return { kind: 'claim' };
}

async function handleInProgress<B extends BoardRef>({ ticket, board, deps }: DispatchArgs<B>): Promise<Effect> {
  if (!deps.isEligible(ticket, board)) return { kind: 'noop', reason: 'not eligible' };
  if (deps.isAgentRunning(ticket.identifier)) return { kind: 'noop', reason: 'agent already running' };
  if (deps.failureCountFor(ticket.identifier) >= MAX_RETRIES) {
    return { kind: 'noop', reason: 'max retries exhausted' };
  }
  if (deps.agentSlotsAvailable() <= 0) return { kind: 'noop', reason: 'no agent slots' };

  const prev = deps.lastKnownState(ticket.identifier);
  const fromReview = prev === 'Human Review' || prev === 'In Review' || prev === 'Rework';
  const mode: SpawnMode = fromReview ? 'feedback' : 'continue';

  deps.log(`Resuming (${mode}) ${ticket.identifier} — ${ticket.title}`);
  deps.spawnAgent(ticket, board, mode);
  return { kind: 'resumeAgent', mode };
}

async function handleHumanReview<B extends BoardRef>({ ticket, board, deps }: DispatchArgs<B>): Promise<Effect> {
  if (!deps.isEligible(ticket, board)) return { kind: 'noop', reason: 'not eligible' };

  // Fast path: PR was merged directly on GitHub, skipping Merging.
  let merged = false;
  try { merged = deps.areAllPRsMerged(ticket, board); } catch { /* best-effort */ }

  // Comment-derived state is best-effort: if the comment API trips, fall back
  // to safe defaults rather than throwing past the fast-path finalize block.
  let approvalInfo: {
    alreadyHandled: boolean;
    aiReviewed: boolean;
    approved: boolean;
    prUrl: string | null;
    lockedPrUrl: string | null;
  } = { alreadyHandled: false, aiReviewed: false, approved: false, prUrl: null, lockedPrUrl: null };
  try {
    approvalInfo = await deps.checkHumanReviewApproval(ticket, board);
  } catch (err) {
    deps.log(`checkHumanReviewApproval failed for ${ticket.identifier}: ${err}`);
  }
  const { alreadyHandled, aiReviewed, approved, prUrl, lockedPrUrl } = approvalInfo;

  // Fallback: a Symphony-authored lock comment references a PR whose head
  // branch doesn't match the synthesized branch name (e.g. agent recognized
  // an already-merged fix on an unrelated branch). Only trust PR URLs the
  // poller itself recorded — never a URL pasted in human discussion.
  if (!merged && lockedPrUrl) {
    try { merged = deps.isPRUrlMerged(lockedPrUrl); } catch { /* best-effort */ }
  }

  if (merged) {
    deps.log(`PR merged in Human Review for ${ticket.identifier} — finalizing`);
    try {
      deps.removeWorktree(ticket, board);
      await deps.moveToDone(board, ticket.id, ticket.identifier);
    } catch (err) {
      deps.log(`Failed to finalize merged PR ${ticket.identifier}: ${err}`);
    }
    return { kind: 'finalizeMergedDuringReview' };
  }

  let triggeredAI = false;
  if (!aiReviewed && prUrl) {
    await deps.postComment(board, ticket.id, `${AI_REVIEW_LOCK_PREFIX} ${prUrl}`);
    deps.spawnAIReview(ticket, board, prUrl);
    triggeredAI = true;
  }

  if (alreadyHandled) {
    return triggeredAI ? { kind: 'humanReviewTriggerAI' } : { kind: 'noop', reason: 'approval already handled' };
  }

  if (approved && prUrl) {
    await deps.postComment(board, ticket.id, `${APPROVAL_LOCK_PREFIX} notifying team…`);
    await deps.moveToInReview(board, ticket.id, ticket.identifier);
    void deps.spawnNotifyReview(ticket, board, prUrl).then(async (slackLink) => {
      if (slackLink) {
        await deps.postComment(board, ticket.id, `${APPROVAL_LOCK_PREFIX} ${slackLink}`).catch(() => {});
      }
    });
    return { kind: 'humanReviewApproved' };
  }

  return triggeredAI ? { kind: 'humanReviewTriggerAI' } : { kind: 'humanReviewWaitForApproval' };
}

async function handleMerging<B extends BoardRef>({ ticket, board, deps }: DispatchArgs<B>): Promise<Effect> {
  if (!deps.isEligible(ticket, board)) return { kind: 'noop', reason: 'not eligible' };
  if (deps.isAgentRunning(ticket.identifier)) return { kind: 'noop', reason: 'agent already running' };

  try {
    if (deps.areAllPRsMerged(ticket, board)) {
      deps.log(`PR already merged for ${ticket.identifier} — finalizing`);
      deps.removeWorktree(ticket, board);
      await deps.moveToDone(board, ticket.id, ticket.identifier);
      return { kind: 'finalizeMerged' };
    }
  } catch { /* fall through */ }

  if (deps.failureCountFor(ticket.identifier) >= MAX_RETRIES) {
    return { kind: 'noop', reason: 'max retries exhausted' };
  }
  if (deps.agentSlotsAvailable() <= 0) return { kind: 'noop', reason: 'no agent slots' };

  deps.log(`Merging: ${ticket.identifier} — ${ticket.title}`);
  deps.spawnAgent(ticket, board, 'continue', true);
  return { kind: 'spawnMergingAgent' };
}

async function handleRework<B extends BoardRef>({ ticket, board, deps }: DispatchArgs<B>): Promise<Effect> {
  if (!deps.isEligible(ticket, board)) return { kind: 'noop', reason: 'not eligible' };
  // Wait for a running agent to exit first; cleanup happens on the next poll cycle.
  if (deps.isAgentRunning(ticket.identifier)) return { kind: 'noop', reason: 'agent still running' };

  try {
    await deps.resetReworkTicket(ticket, board);
  } catch (err) {
    deps.log(`Error resetting rework ticket ${ticket.identifier}: ${err}`);
  }
  return { kind: 'resetRework' };
}

// ── Public dispatcher ─────────────────────────────────────────────────────────

/**
 * Run one cycle of state-machine logic against a ticket the poller just
 * observed. `state` is the StateKey the poller fetched the ticket for —
 * we trust the caller rather than re-reading ticket.state to keep tests
 * trivial. Returns the effect that fired, for logging / assertions.
 */
export async function processTicket<B extends BoardRef>(
  state: StateKey,
  ticket: Issue,
  board: B,
  deps: Deps<B>,
): Promise<Effect> {
  switch (state) {
    case 'todo':         return handleTodo({ ticket, board, deps });
    case 'inProgress':   return handleInProgress({ ticket, board, deps });
    case 'humanReview':  return handleHumanReview({ ticket, board, deps });
    case 'merging':      return handleMerging({ ticket, board, deps });
    case 'rework':       return handleRework({ ticket, board, deps });
    case 'inReview':     return { kind: 'noop', reason: 'inReview — waiting for human to move to merging' };
    case 'backlog':      return { kind: 'noop', reason: 'backlog — not actionable' };
    case 'done':         return { kind: 'noop', reason: 'done — terminal' };
  }
}
