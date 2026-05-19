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
import type { Issue, StateKey, StateKeys } from './ticket-systems/types.mts';

// ── Public types ──────────────────────────────────────────────────────────────

export type SpawnMode = 'fresh' | 'continue' | 'feedback';

/** Any object that quacks like a BoardConfig. Kept structural so tests can pass stubs.
 *  `states` is unused inside the state machine itself — tests stub it for ticket
 *  construction — so it stays optional to fit the post-UP-761 namespaced
 *  BoardConfig (where state IDs live under `linear.states` / `jira.states`). */
export interface BoardRef {
  name: string;
  ticketPrefix: string;
  states?: StateKeys;
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
  moveToMerging(board: Board, issueId: string, identifier: string): Promise<void>;
  moveToTodo(board: Board, issueId: string, identifier: string): Promise<void>;
  moveToDone(board: Board, issueId: string, identifier: string): Promise<void>;

  // Agent lifecycle
  spawnAgent(ticket: Issue, board: Board, mode: SpawnMode, forMerging?: boolean): void;
  resetReworkTicket(ticket: Issue, board: Board): Promise<void>;
  removeWorktree(ticket: Issue, board: Board): void;
  /**
   * One-shot cleanup for a ticket the human moved to a terminal cancelled
   * state: close any open PR for the synthesized branch, remove the worktree,
   * and leave a single audit comment. Fires exactly once per cancelled-edge
   * transition — the dispatcher uses the `prevState` argument to suppress
   * re-firing on every subsequent poll cycle (UP-775).
   */
  cleanupCancelledTicket(ticket: Issue, board: Board): Promise<void>;

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
    /**
     * Timestamp parsed from the most recent `[symphony] feedbackReroute:` lock
     * comment (the `at=<ISO>` suffix). Null when no reroute has happened yet,
     * which means "the next PR review is the first the agent will see". Used
     * by handleHumanReview to decide whether to re-hand fresh feedback back to
     * the agent.
     */
    lastFeedbackRerouteAt: Date | null;
  }>;
  postComment(board: Board, issueId: string, body: string): Promise<void>;
  spawnAIReview(ticket: Issue, board: Board, prUrl: string): void;
  /**
   * Return true if the PR has any review (state != APPROVED) or substantive
   * top-level comment newer than `since`. When `since` is null, returns true
   * if ANY such feedback exists at all. Used by handleHumanReview to decide
   * whether to auto-reroute the ticket back to In Progress for pr-feedback-sweep.
   */
  hasNewPRReviewSince(prUrl: string, since: Date | null): Promise<boolean>;
  spawnNotifyReview(ticket: Issue, board: Board, prUrl: string): Promise<string | null>;
  /** Add a label to the ticket. Used by humanReview to record that the
   *  team-notify side-effect has already fired (so it won't fire again on the
   *  next poll cycle). */
  addLabel(board: Board, issueId: string, label: string): Promise<void>;

  // Capacity / running-agent introspection
  isAgentRunning(identifier: string): boolean;
  agentSlotsAvailable(): number;
  failureCountFor(identifier: string): number;
  /**
   * If another running agent (i.e. for a different ticket identifier) already
   * occupies the worktree this ticket would spawn into, return the conflicting
   * identifier. Otherwise return null. Used to prevent two agents from
   * trampling each other on a shared worktree (parent ticket + Phase-N rebase
   * sub-ticket is the canonical case).
   */
  worktreeOccupiedBy(ticket: Issue, board: Board): string | null;

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
  | { kind: 'humanReviewFeedbackReroute' }
  | { kind: 'humanReviewNotifyTeam' }
  | { kind: 'humanReviewApproved' }
  | { kind: 'resetRework' }
  | { kind: 'cancelledCleanup' };

export const MAX_RETRIES = 3;
export const AI_REVIEW_LOCK_PREFIX = '[symphony] aiReviewRequested:';
export const APPROVAL_LOCK_PREFIX = '[symphony] developerApproved:';
/** Stamped on the ticket workpad each time the poller hands AI/human PR feedback
 *  back to the agent. Body format: `${PREFIX} <prUrl> at=<ISO>` — the timestamp
 *  is the cut-off used on the next cycle to decide whether new PR reviews have
 *  arrived since the last reroute (enables multi-round feedback handling). */
export const FEEDBACK_REROUTE_LOCK_PREFIX = '[symphony] feedbackReroute:';
/** Developer-applied label that asks the poller to ping the team. */
export const NEEDS_NOTIFY_LABEL = 'symphony:needs-notify-review';
/** Poller-applied label that records the notify side-effect already fired. */
export const REVIEW_NOTIFIED_LABEL = 'symphony:review-notified';

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
  | { type: 'REVIEW_NOTIFY_TEAM' }          // humanReview → humanReview (label-gated team notify)
  | { type: 'REVIEW_APPROVED' }             // humanReview → merging (PR approved on GitHub)
  | { type: 'PR_MERGED_EARLY' }             // humanReview → done (reviewer merged directly)
  | { type: 'SPAWN_MERGING' }               // merging → merging (agent runs land skill)
  | { type: 'PR_MERGED' }                   // merging → done
  | { type: 'REWORK_REQUESTED' }            // any → rework (human moves the ticket)
  | { type: 'REWORK_RESET' }                // rework → todo (after cleanup)
  | { type: 'CANCEL' };                     // any → cancelled (human abandons the ticket)

export const ticketMachine = setup({
  types: {
    events: {} as TicketEvent,
  },
}).createMachine({
  id: 'symphony-ticket',
  initial: 'backlog',
  states: {
    backlog: {
      on: { CLAIM: 'todo', CANCEL: 'cancelled' },
    },
    todo: {
      on: {
        CLAIM: 'inProgress',
        REWORK_REQUESTED: 'rework',
        CANCEL: 'cancelled',
      },
    },
    inProgress: {
      on: {
        AGENT_DONE: 'humanReview',
        AGENT_FAILED: 'inProgress',
        AGENT_EXHAUSTED: 'backlog',
        RESUME: 'inProgress',
        REWORK_REQUESTED: 'rework',
        CANCEL: 'cancelled',
      },
    },
    humanReview: {
      on: {
        REVIEW_TRIGGER_AI: 'humanReview',
        REVIEW_NOTIFY_TEAM: 'humanReview',
        REVIEW_APPROVED: 'merging',
        PR_MERGED_EARLY: 'done',
        REWORK_REQUESTED: 'rework',
        CANCEL: 'cancelled',
      },
    },
    merging: {
      on: {
        SPAWN_MERGING: 'merging',
        PR_MERGED: 'done',
        REWORK_REQUESTED: 'rework',
        CANCEL: 'cancelled',
      },
    },
    rework: {
      on: {
        REWORK_RESET: 'todo',
        CANCEL: 'cancelled',
      },
    },
    done: {
      type: 'final',
    },
    cancelled: {
      type: 'final',
    },
  },
});

// ── Per-state dispatchers ─────────────────────────────────────────────────────

interface DispatchArgs<Board extends BoardRef> {
  ticket: Issue;
  board: Board;
  deps: Deps<Board>;
  /**
   * The Symphony `StateKey` the poller observed for this ticket on the
   * previous cycle, or `null` if the poller has no memory of it (cold start,
   * first time the identifier is seen, or persistence file missing).
   *
   * Used by handlers whose side effect is a one-shot action on entering a
   * state (cancelled cleanup, rework reset). Comparing `state` vs `prevState`
   * yields edge-triggered dispatch — the action fires only on the prev→state
   * transition, not on every poll cycle that re-observes the same state.
   * UP-775 introduced this primitive; before it, the dispatcher was purely
   * level-triggered which re-fired one-shot effects every cycle.
   */
  prevState: StateKey | null;
}

async function handleTodo<B extends BoardRef>({ ticket, board, deps }: DispatchArgs<B>): Promise<Effect> {
  if (!deps.isEligible(ticket, board)) return { kind: 'noop', reason: 'not eligible' };
  if (deps.isAgentRunning(ticket.identifier)) return { kind: 'noop', reason: 'agent already running' };
  const occupant = deps.worktreeOccupiedBy(ticket, board);
  if (occupant) return { kind: 'noop', reason: `worktree busy (held by ${occupant})` };
  if (deps.agentSlotsAvailable() <= 0) return { kind: 'noop', reason: 'no agent slots' };

  deps.log(`Claiming ${ticket.identifier} — ${ticket.title}`);
  await deps.moveToInProgress(board, ticket.id, ticket.identifier);
  deps.spawnAgent(ticket, board, 'fresh');
  return { kind: 'claim' };
}

async function handleInProgress<B extends BoardRef>({ ticket, board, deps, prevState }: DispatchArgs<B>): Promise<Effect> {
  if (!deps.isEligible(ticket, board)) return { kind: 'noop', reason: 'not eligible' };
  if (deps.isAgentRunning(ticket.identifier)) return { kind: 'noop', reason: 'agent already running' };
  if (deps.failureCountFor(ticket.identifier) >= MAX_RETRIES) {
    return { kind: 'noop', reason: 'max retries exhausted' };
  }
  const occupant = deps.worktreeOccupiedBy(ticket, board);
  if (occupant) return { kind: 'noop', reason: `worktree busy (held by ${occupant})` };
  if (deps.agentSlotsAvailable() <= 0) return { kind: 'noop', reason: 'no agent slots' };

  const fromReview = prevState === 'humanReview' || prevState === 'rework';
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
    lastFeedbackRerouteAt: Date | null;
  } = {
    alreadyHandled: false,
    aiReviewed: false,
    approved: false,
    prUrl: null,
    lockedPrUrl: null,
    lastFeedbackRerouteAt: null,
  };
  try {
    approvalInfo = await deps.checkHumanReviewApproval(ticket, board);
  } catch (err) {
    deps.log(`checkHumanReviewApproval failed for ${ticket.identifier}: ${err}`);
  }
  const { alreadyHandled, aiReviewed, approved, prUrl, lockedPrUrl, lastFeedbackRerouteAt } = approvalInfo;

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

  // Auto-reroute back to In Progress when a reviewer has actually left
  // feedback on the PR. Gated on `aiReviewed` (the trigger comment exists, so
  // the cycle that just spawned the AI reviewer doesn't immediately reroute
  // before any review has been posted) and on `hasNewPRReviewSince` reporting
  // a review newer than the last reroute lock (multi-round: every subsequent
  // human/AI review starts a fresh feedback pass). The next cycle's
  // handleInProgress will see prevState=humanReview and spawn the agent in
  // `feedback` mode → pr-feedback-sweep picks up the new findings.
  if (aiReviewed && !approved && !merged && prUrl) {
    let hasFeedback = false;
    try {
      hasFeedback = await deps.hasNewPRReviewSince(prUrl, lastFeedbackRerouteAt);
    } catch (err) {
      deps.log(`hasNewPRReviewSince failed for ${ticket.identifier}: ${err}`);
    }
    if (hasFeedback) {
      const stamp = new Date().toISOString();
      await deps.postComment(
        board,
        ticket.id,
        `${FEEDBACK_REROUTE_LOCK_PREFIX} ${prUrl} at=${stamp}`,
      );
      await deps.moveToInProgress(board, ticket.id, ticket.identifier);
      return { kind: 'humanReviewFeedbackReroute' };
    }
  }

  // Approval → move directly to Merging. In Review is gone (UP-782); the gate
  // from Human Review to Merging is still PR approval, just one hop shorter.
  // Gated by alreadyHandled (the APPROVAL_LOCK comment) so we don't re-fire if
  // a previous cycle already moved the ticket.
  if (!alreadyHandled && approved && prUrl) {
    await deps.postComment(board, ticket.id, `${APPROVAL_LOCK_PREFIX} approved → Merging`);
    await deps.moveToMerging(board, ticket.id, ticket.identifier);
    return { kind: 'humanReviewApproved' };
  }

  // Label-gated team notify, independent of approval state. The developer adds
  // NEEDS_NOTIFY_LABEL when they're done self-reviewing and want colleagues
  // pinged; the poller fires notify-review once and stamps REVIEW_NOTIFIED_LABEL
  // so it doesn't repeat. To re-notify, the developer removes
  // REVIEW_NOTIFIED_LABEL. The label pair is its own lock — independent of
  // APPROVAL_LOCK comments, since notify and approval are orthogonal flows.
  if (prUrl
    && ticket.labels.includes(NEEDS_NOTIFY_LABEL)
    && !ticket.labels.includes(REVIEW_NOTIFIED_LABEL)
  ) {
    // Stamp the label first so a slow/failing spawn can't cause a double-ping
    // on the next poll cycle. Manual removal is the documented re-notify path.
    await deps.addLabel(board, ticket.id, REVIEW_NOTIFIED_LABEL);
    void deps.spawnNotifyReview(ticket, board, prUrl);
    return { kind: 'humanReviewNotifyTeam' };
  }

  if (alreadyHandled) {
    return triggeredAI ? { kind: 'humanReviewTriggerAI' } : { kind: 'noop', reason: 'approval already handled' };
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
  const occupant = deps.worktreeOccupiedBy(ticket, board);
  if (occupant) return { kind: 'noop', reason: `worktree busy (held by ${occupant})` };
  if (deps.agentSlotsAvailable() <= 0) return { kind: 'noop', reason: 'no agent slots' };

  deps.log(`Merging: ${ticket.identifier} — ${ticket.title}`);
  deps.spawnAgent(ticket, board, 'continue', true);
  return { kind: 'spawnMergingAgent' };
}

async function handleRework<B extends BoardRef>({ ticket, board, deps, prevState }: DispatchArgs<B>): Promise<Effect> {
  if (!deps.isEligible(ticket, board)) return { kind: 'noop', reason: 'not eligible' };
  // Wait for a running agent to exit first; cleanup happens on the next poll cycle.
  if (deps.isAgentRunning(ticket.identifier)) return { kind: 'noop', reason: 'agent still running' };
  // Edge guard: only reset on the prev→rework transition. Without this, a
  // ticket that lingers in Rework because the reset itself failed (or because
  // the human is mid-conversation in the workpad) would have resetReworkTicket
  // re-fired every poll cycle, hammering git + the ticket API.
  if (prevState === 'rework') return { kind: 'noop', reason: 'rework already reset on this entry' };

  try {
    await deps.resetReworkTicket(ticket, board);
  } catch (err) {
    deps.log(`Error resetting rework ticket ${ticket.identifier}: ${err}`);
  }
  return { kind: 'resetRework' };
}

async function handleCancelled<B extends BoardRef>({ ticket, board, deps, prevState }: DispatchArgs<B>): Promise<Effect> {
  // Edge-triggered: cleanup runs exactly once, on the prev→cancelled transition.
  // On subsequent cycles the ticket is still "Cancelled" in the ticket system,
  // but we must not re-close the PR or re-post the audit comment.
  if (prevState === 'cancelled') return { kind: 'noop', reason: 'cancelled already cleaned up' };
  if (!deps.isEligible(ticket, board)) return { kind: 'noop', reason: 'not eligible' };
  if (deps.isAgentRunning(ticket.identifier)) return { kind: 'noop', reason: 'agent still running' };

  deps.log(`Cancelled — cleaning up ${ticket.identifier}`);
  try {
    await deps.cleanupCancelledTicket(ticket, board);
  } catch (err) {
    deps.log(`Error cleaning up cancelled ticket ${ticket.identifier}: ${err}`);
  }
  return { kind: 'cancelledCleanup' };
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
  prevState: StateKey | null = null,
): Promise<Effect> {
  const args = { ticket, board, deps, prevState };
  switch (state) {
    case 'todo':         return handleTodo(args);
    case 'inProgress':   return handleInProgress(args);
    case 'humanReview':  return handleHumanReview(args);
    case 'merging':      return handleMerging(args);
    case 'rework':       return handleRework(args);
    case 'cancelled':    return handleCancelled(args);
    case 'backlog':      return { kind: 'noop', reason: 'backlog — not actionable' };
    case 'done':         return { kind: 'noop', reason: 'done — terminal' };
  }
}
