/**
 * Ticket-system adapter types.
 *
 * Symphony was originally Linear-only. The adapter layer lets the poller work
 * against any ticket backend (Linear today, Jira as of WOR-138) by dispatching
 * through a small, stable interface.
 *
 * Board configs are grouped by external system (UP-761): Linear-specific
 * fields live under `linear`, Jira-specific fields under `jira`. Adapters
 * read only from their own namespace.
 */

export interface Issue {
  /** Internal/stable ID. Linear: issue UUID. Jira: numeric id as string. */
  id: string;
  /** Human-facing key. Linear: "WOR-138". Jira: "UP-314". */
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  project: { id: string; name: string; url: string | null } | null;
  state: { id: string; name: string };
  assignee: { id: string; name: string } | null;
  /** All labels attached to the ticket. Used by the poller for routing
   *  (e.g. `project:<slug>`, `runtime:codex`). May be empty. */
  labels: string[];
}

export interface StateKeys {
  backlog: string;
  todo: string;
  inProgress: string;
  humanReview: string;
  rework: string;
  merging: string;
  done: string;
  /** Terminal "cancelled / abandoned" state. Optional because not every board
   *  exposes one; absent boards simply never dispatch `cancelled`. */
  cancelled?: string;
}

export type StateKey = keyof StateKeys;

/** Linear-system config block on a board file. */
export interface BoardLinearConfig {
  /** Linear state UUIDs keyed by Symphony state. */
  states: StateKeys;
}

/** Jira-system config block on a board file. */
export interface BoardJiraConfig {
  /** e.g. "https://workstreamhq.atlassian.net". */
  baseUrl: string;
  /** Jira status *names* keyed by Symphony state. Jira boards compare against names. */
  states: StateKeys;
  /** Workflow transition IDs keyed by Symphony state. */
  transitions: Partial<Record<StateKey, string>>;
}

/** GitHub-Projects config block on a board file.
 *
 *  ProjectV2 holds Symphony state in a single-select field (default "Status").
 *  Each Symphony state maps to the *display name* of one option in that field
 *  (e.g. `todo: "Todo"`); the adapter compares against option names, the same
 *  way the Jira adapter compares against status names. */
export interface BoardGithubProjectsConfig {
  /** Owner login (user or org) that hosts the ProjectV2. */
  owner: string;
  /** Project number from the project URL (`/users/<owner>/projects/<n>`). */
  projectNumber: number;
  /** "owner/repo" of the repo whose Issues live in the project. Used for
   *  REST comment + label calls — ProjectV2 itself has no per-item comments. */
  repo: string;
  /** Single-select field name carrying the Symphony state. Defaults to "Status". */
  statusField?: string;
  /** ProjectV2 single-select option names keyed by Symphony state. */
  states: StateKeys;
}

export interface BoardLike {
  name: string;
  ticketPrefix: string;
  /** Missing is allowed; the poller defaults to "linear" via `ticketSystemFor`. */
  ticketSystem?: 'linear' | 'jira' | 'github-projects';
  /** Linear: team UUID. Jira: project key (e.g. "UP"). GitHub Projects: ignored
   *  (project number lives under `githubProjects` instead). */
  teamId: string;
  linear?: BoardLinearConfig;
  jira?: BoardJiraConfig;
  githubProjects?: BoardGithubProjectsConfig;
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
  /** Add a label to a ticket. Idempotent — backend will dedupe. */
  addLabel(board: BoardLike, issueId: string, label: string): Promise<void>;
  /** Remove a label from a ticket. No-op if the label isn't attached. */
  removeLabel(board: BoardLike, issueId: string, label: string): Promise<void>;
  /** Check whether an already-fetched Issue carries a label. Pure helper —
   *  reads `issue.labels` so callers don't have to spell the includes-check
   *  themselves. */
  hasLabel(issue: Issue, label: string): boolean;
}
