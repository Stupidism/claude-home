/**
 * Ticket-system adapter types.
 *
 * Symphony was originally Linear-only. The adapter layer lets the poller work
 * against any ticket backend (Linear today, Jira as of WOR-138) by dispatching
 * through a small, stable interface.
 */

export interface Issue {
  /** Internal/stable ID. Linear: issue UUID. Jira: numeric id as string. */
  id: string;
  /** Human-facing key. Linear: "WOR-138". Jira: "UP-314". */
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  project: { id: string; name: string } | null;
  state: { id: string; name: string };
  assignee: { id: string; name: string } | null;
}

export interface StateKeys {
  backlog: string;
  todo: string;
  inProgress: string;
  humanReview: string;
  inReview: string;
  rework: string;
  merging: string;
  done: string;
}

export type StateKey = keyof StateKeys;

export interface BoardLike {
  name: string;
  ticketPrefix: string;
  /** Missing is allowed; the poller defaults to "linear" via `ticketSystemFor`. */
  ticketSystem?: 'linear' | 'jira';
  teamId: string;
  states: StateKeys;
  /** Jira-only. Transition IDs keyed by the same Symphony state keys. */
  transitions?: Partial<Record<StateKey, string>>;
  /** Jira-only. e.g. "https://workstreamhq.atlassian.net". */
  jiraBaseUrl?: string;
}

export interface TicketSystemAdapter {
  /** Fetch every ticket on the board currently in the given state. */
  fetchTicketsByState(board: BoardLike, stateKey: StateKey, assigneeId: string): Promise<Issue[]>;
  /** Fetch a single ticket by identifier (e.g. "WOR-138"). */
  fetchTicketByIdentifier(board: BoardLike, identifier: string): Promise<Issue | null>;
  /** Return just the state ID for a ticket — cheaper than a full fetch. */
  fetchTicketStateId(board: BoardLike, identifier: string): Promise<string | null>;
  /** Move a ticket to a Symphony state. */
  moveToState(board: BoardLike, issueId: string, stateKey: StateKey): Promise<void>;
  /** Post a plain-text / Markdown comment on a ticket. */
  postComment(board: BoardLike, issueId: string, body: string): Promise<void>;
  /** List all comments on a ticket. */
  listComments(board: BoardLike, issueId: string): Promise<{ id: string; body: string }[]>;
  /** Delete a comment. Jira needs both the issue and the comment; Linear ignores issueId. */
  deleteComment(board: BoardLike, issueId: string, commentId: string): Promise<void>;
}
