/**
 * GitHub-Projects adapter — ProjectV2 (GraphQL) for state + project membership,
 * REST `/repos/{owner}/{repo}/issues/...` for comments and labels.
 *
 * Board config for github-projects boards:
 *   "ticketSystem": "github-projects",
 *   "ticketPrefix": "SYM",                    // shown in Issue.identifier as "SYM-123"
 *   "teamId": "ignored",                       // unused — kept for BoardLike compat
 *   "githubProjects": {
 *     "owner":         "my-org",
 *     "projectNumber": 7,
 *     "repo":          "my-org/symphony-tickets",
 *     "statusField":   "Status",               // optional, defaults to "Status"
 *     "states": { todo: "Todo", inProgress: "In Progress", done: "Done", ... }
 *   }
 *
 * Secrets:
 *   GITHUB_TOKEN — fine-grained PAT scoped to the repo + project with
 *                  Issues:write, Projects:write, Metadata:read.
 *
 * `Issue.id` is a compound `<projectItemId>|<owner/repo>|<issueNumber>` because
 * state transitions need the ProjectV2 item id while comments and labels need
 * the issue number on the repo. Callers treat it as opaque; only this module
 * unpacks it. `Issue.identifier` follows the board's `ticketPrefix` (e.g.
 * `SYM-123`) so the poller's existing routing keeps working.
 */

import type {
  BoardGithubProjectsConfig,
  BoardLike,
  Issue,
  StateKey,
  TicketSystemAdapter,
} from './types.mts';

const PROJECT_LABEL_PREFIX = 'project:';
const DEFAULT_STATUS_FIELD = 'Status';
const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';
const REST_BASE = 'https://api.github.com';

function ghOf(board: BoardLike): BoardGithubProjectsConfig {
  if (!board.githubProjects) {
    throw new Error(`[github-projects] Board "${board.name}" is missing the "githubProjects" config block`);
  }
  return board.githubProjects;
}

function token(): string {
  const t = process.env['GITHUB_TOKEN'] ?? '';
  if (!t) throw new Error('[github-projects] GITHUB_TOKEN is not set');
  return t;
}

interface CompoundId {
  itemId: string;
  ownerRepo: string;
  issueNumber: number;
}

function packId(itemId: string, ownerRepo: string, issueNumber: number): string {
  return `${itemId}|${ownerRepo}|${issueNumber}`;
}

function unpackId(id: string): CompoundId {
  const parts = id.split('|');
  if (parts.length !== 3) {
    throw new Error(`[github-projects] Malformed issue id ${JSON.stringify(id)}: expected "<itemId>|<owner/repo>|<number>"`);
  }
  const [itemId, ownerRepo, num] = parts as [string, string, string];
  const issueNumber = Number(num);
  if (!Number.isFinite(issueNumber)) {
    throw new Error(`[github-projects] Issue id ${JSON.stringify(id)} has non-numeric issue number`);
  }
  return { itemId, ownerRepo, issueNumber };
}

function splitOwnerRepo(ownerRepo: string): { owner: string; repo: string } {
  const slash = ownerRepo.indexOf('/');
  if (slash === -1) {
    throw new Error(`[github-projects] Expected "owner/repo", got ${JSON.stringify(ownerRepo)}`);
  }
  return { owner: ownerRepo.slice(0, slash), repo: ownerRepo.slice(slash + 1) };
}

async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`[github-projects] GraphQL: ${json.errors.map((e) => e.message).join(', ')}`);
  }
  if (!json.data) {
    throw new Error(`[github-projects] GraphQL returned no data (HTTP ${res.status})`);
  }
  return json.data;
}

async function rest(pathAndQuery: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${REST_BASE}${pathAndQuery}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new Error(`[github-projects] ${init?.method ?? 'GET'} ${pathAndQuery} → ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  return res;
}

// ── Project schema lookup (cached per process) ────────────────────────────────

interface ProjectSchema {
  projectId: string;
  statusFieldId: string;
  /** Option name → option id, for the single-select status field. */
  optionIds: Map<string, string>;
}

const schemaCache = new Map<string, ProjectSchema>();
const ownerKindCache = new Map<string, 'user' | 'organization'>();

// `repositoryOwner` is the canonical "is this a User or Organization?" probe —
// it returns null cleanly when the login doesn't exist, with no GraphQL error,
// so we can pick the right root field for follow-up queries without provoking
// "Could not resolve to ..." errors from probing both sides.
async function resolveOwnerKind(owner: string): Promise<'user' | 'organization'> {
  const cached = ownerKindCache.get(owner);
  if (cached) return cached;
  const data = await graphql<{ repositoryOwner: { __typename: string } | null }>(
    `query OwnerKind($owner: String!) {
      repositoryOwner(login: $owner) { __typename }
    }`,
    { owner }
  );
  const tn = data.repositoryOwner?.__typename;
  if (tn !== 'User' && tn !== 'Organization') {
    throw new Error(`[github-projects] Owner "${owner}" is neither a User nor an Organization (got ${tn ?? 'null'})`);
  }
  const kind = tn === 'User' ? 'user' : 'organization';
  ownerKindCache.set(owner, kind);
  return kind;
}

async function getProjectSchema(board: BoardLike): Promise<ProjectSchema> {
  const cfg = ghOf(board);
  // Cache key must include the status-field name — two boards may target the
  // same project with different `statusField` configs and need different
  // field-ID/option-ID maps.
  const cacheKey = `${cfg.owner}#${cfg.projectNumber}#${cfg.statusField ?? DEFAULT_STATUS_FIELD}`;
  const cached = schemaCache.get(cacheKey);
  if (cached) return cached;

  const kind = await resolveOwnerKind(cfg.owner);
  const data = await graphql<Record<string, { projectV2: ProjectQueryNode | null } | null>>(
    `query ProjectSchema($owner: String!, $number: Int!) {
      ${kind}(login: $owner) {
        projectV2(number: $number) { ${PROJECT_QUERY_FIELDS} }
      }
    }`,
    { owner: cfg.owner, number: cfg.projectNumber }
  );
  const project = data[kind]?.projectV2;
  if (!project) {
    throw new Error(`[github-projects] Project #${cfg.projectNumber} not found under owner "${cfg.owner}"`);
  }

  const fieldName = cfg.statusField ?? DEFAULT_STATUS_FIELD;
  const field = project.fields.nodes.find((f) => f.name === fieldName);
  if (!field || !field.options) {
    throw new Error(`[github-projects] Project #${cfg.projectNumber} has no single-select field named "${fieldName}"`);
  }
  const optionIds = new Map(field.options.map((o) => [o.name, o.id]));
  const schema: ProjectSchema = { projectId: project.id, statusFieldId: field.id, optionIds };
  schemaCache.set(cacheKey, schema);
  return schema;
}

const PROJECT_QUERY_FIELDS = `
  id
  fields(first: 50) {
    nodes {
      ... on ProjectV2SingleSelectField {
        id
        name
        options { id name }
      }
    }
  }
`;

interface ProjectQueryNode {
  id: string;
  fields: { nodes: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }> };
}

// ── Item → Issue conversion ───────────────────────────────────────────────────

interface RawProjectItem {
  id: string;
  content: RawIssueContent | null;
  fieldValues: {
    nodes: Array<{
      name?: string;
      field?: { name?: string };
    }>;
  };
}

interface RawIssueContent {
  __typename?: string;
  id: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  repository: { nameWithOwner: string };
  assignees: { nodes: Array<{ login: string; databaseId: number | null }> };
  labels: { nodes: Array<{ name: string }> };
}

function statusOf(item: RawProjectItem, statusFieldName: string): string | null {
  const node = item.fieldValues.nodes.find((n) => n.field?.name === statusFieldName);
  return node?.name ?? null;
}

function resolveProject(labels: string[]): Issue['project'] {
  const match = labels.find((l) => l.startsWith(PROJECT_LABEL_PREFIX));
  if (!match) return null;
  return { id: match, name: match.slice(PROJECT_LABEL_PREFIX.length), url: null };
}

function toIssue(board: BoardLike, item: RawProjectItem): Issue | null {
  const content = item.content;
  // Items without an Issue (drafts, PRs) aren't Symphony tickets.
  if (!content || (content.__typename && content.__typename !== 'Issue')) return null;
  const cfg = ghOf(board);
  const statusName = statusOf(item, cfg.statusField ?? DEFAULT_STATUS_FIELD);
  const labels = content.labels.nodes.map((l) => l.name);
  const assignee = content.assignees.nodes[0];
  return {
    id: packId(item.id, content.repository.nameWithOwner, content.number),
    identifier: `${board.ticketPrefix}-${content.number}`,
    title: content.title,
    description: content.body ?? null,
    url: content.url,
    project: resolveProject(labels),
    // Match what the poller compares against: states config holds option names,
    // so the "id" we expose is the option name (mirrors the Jira adapter).
    state: { id: statusName ?? '', name: statusName ?? '' },
    assignee: assignee ? { id: String(assignee.databaseId ?? assignee.login), name: assignee.login } : null,
    labels,
  };
}

const ITEM_FIELDS = `
  id
  content {
    __typename
    ... on Issue {
      id
      number
      title
      body
      url
      repository { nameWithOwner }
      assignees(first: 10) { nodes { login databaseId } }
      labels(first: 50) { nodes { name } }
    }
  }
  fieldValues(first: 20) {
    nodes {
      ... on ProjectV2ItemFieldSingleSelectValue {
        name
        field { ... on ProjectV2SingleSelectField { name } }
      }
    }
  }
`;

async function fetchAllItems(board: BoardLike): Promise<RawProjectItem[]> {
  const cfg = ghOf(board);
  const kind = await resolveOwnerKind(cfg.owner);
  const all: RawProjectItem[] = [];
  let cursor: string | null = null;
  // Cap pagination — Symphony states normally hold tens of items, not thousands.
  for (let page = 0; page < 10; page++) {
    const data: Record<string, { projectV2: { items: ItemsPage } | null } | null> = await graphql(
      `query ProjectItems($owner: String!, $number: Int!, $cursor: String) {
        ${kind}(login: $owner) {
          projectV2(number: $number) { items(first: 100, after: $cursor) { ${ITEMS_PAGE_FIELDS} } }
        }
      }`,
      { owner: cfg.owner, number: cfg.projectNumber, cursor }
    );
    const items = data[kind]?.projectV2?.items;
    if (!items) break;
    all.push(...items.nodes);
    if (!items.pageInfo.hasNextPage) break;
    cursor = items.pageInfo.endCursor;
  }
  return all;
}

const ITEMS_PAGE_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes { ${ITEM_FIELDS} }
`;

interface ItemsPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: RawProjectItem[];
}

// ── Adapter implementation ────────────────────────────────────────────────────

export const githubProjectsAdapter: TicketSystemAdapter = {
  async fetchTicketsByState(board, stateKey, assigneeId) {
    const cfg = ghOf(board);
    const optionName = cfg.states[stateKey];
    // Boards may legitimately omit optional states (e.g. `cancelled`).
    if (!optionName) return [];
    const items = await fetchAllItems(board);
    const out: Issue[] = [];
    for (const item of items) {
      const issue = toIssue(board, item);
      if (!issue) continue;
      if (issue.state.name !== optionName) continue;
      // Only items whose backing Issue lives in the configured repo. ProjectV2
      // can hold issues from multiple repos; without this check a sibling repo
      // could surface tickets with identifiers that collide with our board's.
      if (item.content?.repository.nameWithOwner !== cfg.repo) continue;
      // Match the assignee filter against *all* GitHub assignees, not just
      // the first one. GitHub issues support multiple assignees, and we'd
      // silently skip a ticket where the configured user is not first.
      if (assigneeId) {
        const all = item.content?.assignees.nodes ?? [];
        const match = all.some((a) => String(a.databaseId ?? a.login) === assigneeId || a.login === assigneeId);
        if (!match) continue;
      }
      out.push(issue);
    }
    return out;
  },

  async fetchTicketByIdentifier(board, identifier) {
    const num = parseIdentifier(board, identifier);
    if (num === null) return null;
    const cfg = ghOf(board);
    const items = await fetchAllItems(board);
    for (const item of items) {
      if (!item.content) continue;
      if (item.content.number !== num) continue;
      // Scope to the configured repo — ProjectV2 may hold issues from multiple
      // repos and issue numbers are repo-local.
      if (item.content.repository.nameWithOwner !== cfg.repo) continue;
      return toIssue(board, item);
    }
    return null;
  },

  async fetchTicketStateId(board, identifier) {
    const issue = await this.fetchTicketByIdentifier(board, identifier);
    return issue?.state.id || null;
  },

  async moveToState(board, issueId, stateKey: StateKey) {
    const cfg = ghOf(board);
    const optionName = cfg.states[stateKey];
    if (!optionName) {
      throw new Error(`[github-projects] Board "${board.name}" is missing githubProjects.states.${stateKey}`);
    }
    const { itemId } = unpackId(issueId);
    const schema = await getProjectSchema(board);
    const optionId = schema.optionIds.get(optionName);
    if (!optionId) {
      throw new Error(`[github-projects] Status field has no option named ${JSON.stringify(optionName)}`);
    }
    await graphql(
      `mutation SetStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }) { projectV2Item { id } }
      }`,
      { projectId: schema.projectId, itemId, fieldId: schema.statusFieldId, optionId }
    );
  },

  async postComment(_board, issueId, body) {
    const { ownerRepo, issueNumber } = unpackId(issueId);
    const { owner, repo } = splitOwnerRepo(ownerRepo);
    const res = await rest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
      { method: 'POST', body: JSON.stringify({ body }) }
    );
    if (!res.ok) {
      throw new Error(`[github-projects] postComment failed: ${res.status} ${res.statusText}`);
    }
  },

  async listComments(_board, issueId) {
    const { ownerRepo, issueNumber } = unpackId(issueId);
    const { owner, repo } = splitOwnerRepo(ownerRepo);
    const res = await rest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=100`
    );
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{ id: number; body: string | null }>;
    return data.map((c) => ({ id: String(c.id), body: c.body ?? '' }));
  },

  async deleteComment(_board, issueId, commentId) {
    const { ownerRepo } = unpackId(issueId);
    const { owner, repo } = splitOwnerRepo(ownerRepo);
    await rest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${encodeURIComponent(commentId)}`,
      { method: 'DELETE' }
    );
  },

  async addLabel(_board, issueId, label) {
    const { ownerRepo, issueNumber } = unpackId(issueId);
    const { owner, repo } = splitOwnerRepo(ownerRepo);
    // Ensure the label exists on the repo — POST /issues/N/labels 422s otherwise.
    await ensureRepoLabel(owner, repo, label);
    await rest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels`,
      { method: 'POST', body: JSON.stringify({ labels: [label] }) }
    );
  },

  async removeLabel(_board, issueId, label) {
    const { ownerRepo, issueNumber } = unpackId(issueId);
    const { owner, repo } = splitOwnerRepo(ownerRepo);
    await rest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      { method: 'DELETE' }
    );
  },

  hasLabel(issue, label) {
    return issue.labels.includes(label);
  },
};

function parseIdentifier(board: BoardLike, identifier: string): number | null {
  const prefix = `${board.ticketPrefix}-`;
  if (!identifier.startsWith(prefix)) return null;
  const num = Number(identifier.slice(prefix.length));
  return Number.isFinite(num) ? num : null;
}

async function ensureRepoLabel(owner: string, repo: string, name: string): Promise<void> {
  const check = await rest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels/${encodeURIComponent(name)}`
  );
  if (check.ok) return;
  // 404 → create. Other errors already threw inside `rest`.
  await rest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}
