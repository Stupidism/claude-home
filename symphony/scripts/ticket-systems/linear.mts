/**
 * Linear adapter — wraps Linear GraphQL into the TicketSystemAdapter shape.
 */

import type { BoardLike, BoardLinearConfig, Issue, StateKey, TicketSystemAdapter } from './types.mts';

function linearOf(board: BoardLike): BoardLinearConfig {
  if (!board.linear) throw new Error(`[linear] Board "${board.name}" is missing the "linear" config block`);
  return board.linear;
}

async function linearQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const apiKey = process.env['LINEAR_API_KEY'] ?? '';
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join(', '));
  return json.data;
}

const ISSUE_FIELDS = `id identifier title description url
    state { id name }
    assignee { id name }
    project { id name url }
    labels { nodes { name } }`;

type RawLinearIssue = Omit<Issue, 'labels'> & { labels?: { nodes: Array<{ name: string }> } };

function toIssue(raw: RawLinearIssue): Issue {
  const { labels, ...rest } = raw;
  return { ...rest, labels: labels?.nodes.map((n) => n.name) ?? [] };
}

export const linearAdapter: TicketSystemAdapter = {
  async fetchTicketsByState(board, stateKey, assigneeId) {
    const stateId = linearOf(board).states[stateKey];
    // Boards may legitimately omit optional states (e.g. `cancelled`).
    if (!stateId) return [];
    const filter: Record<string, unknown> = { state: { id: { eq: stateId } } };
    if (assigneeId) filter['assignee'] = { id: { eq: assigneeId } };

    const data = await linearQuery<{ team: { issues: { nodes: RawLinearIssue[] } } }>(
      `query GetTickets($teamId: String!, $filter: IssueFilter) {
        team(id: $teamId) {
          issues(filter: $filter, orderBy: createdAt, first: 50) {
            nodes { ${ISSUE_FIELDS} }
          }
        }
      }`,
      { teamId: board.teamId, filter }
    );
    return data.team.issues.nodes.map(toIssue);
  },

  async fetchTicketByIdentifier(_board, identifier) {
    const data = await linearQuery<{ issue: RawLinearIssue | null }>(
      `query GetTicket($identifier: String!) {
        issue(id: $identifier) { ${ISSUE_FIELDS} }
      }`,
      { identifier }
    );
    return data.issue ? toIssue(data.issue) : null;
  },

  async fetchTicketStateId(_board, identifier) {
    const data = await linearQuery<{ issue: { state: { id: string } } | null }>(
      `query GetTicketState($identifier: String!) {
        issue(id: $identifier) { state { id } }
      }`,
      { identifier }
    );
    return data.issue?.state?.id ?? null;
  },

  async moveToState(board, issueId, stateKey: StateKey) {
    await linearQuery(
      `mutation UpdateState($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: issueId, stateId: linearOf(board).states[stateKey] }
    );
  },

  async postComment(_board, issueId, body) {
    await linearQuery(
      `mutation PostComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }`,
      { issueId, body }
    );
  },

  async listComments(_board, issueId) {
    const data = await linearQuery<{ issue: { comments: { nodes: { id: string; body: string }[] } } }>(
      `query GetComments($id: String!) { issue(id: $id) { comments { nodes { id body } } } }`,
      { id: issueId }
    );
    return data.issue.comments.nodes;
  },

  async deleteComment(_board, _issueId, commentId) {
    await linearQuery(
      `mutation DeleteComment($id: String!) { commentDelete(id: $id) { success } }`,
      { id: commentId }
    );
  },

  async addLabel(board, issueId, label) {
    const labelId = await ensureLabelId(board, label);
    await linearQuery(
      `mutation AddLabel($id: String!, $labelId: String!) {
        issueAddLabel(id: $id, labelId: $labelId) { success }
      }`,
      { id: issueId, labelId }
    );
  },

  async removeLabel(board, issueId, label) {
    const labelId = await findLabelId(board, label);
    if (!labelId) return;
    await linearQuery(
      `mutation RemoveLabel($id: String!, $labelId: String!) {
        issueRemoveLabel(id: $id, labelId: $labelId) { success }
      }`,
      { id: issueId, labelId }
    );
  },

  hasLabel(issue, label) {
    return issue.labels.includes(label);
  },
};

async function findLabelId(board: BoardLike, name: string): Promise<string | null> {
  const data = await linearQuery<{ team: { labels: { nodes: { id: string }[] } } | null }>(
    `query FindLabel($teamId: String!, $name: String!) {
      team(id: $teamId) {
        labels(filter: { name: { eq: $name } }, first: 1) { nodes { id } }
      }
    }`,
    { teamId: board.teamId, name }
  );
  return data.team?.labels.nodes[0]?.id ?? null;
}

async function ensureLabelId(board: BoardLike, name: string): Promise<string> {
  const existing = await findLabelId(board, name);
  if (existing) return existing;
  const created = await linearQuery<{ issueLabelCreate: { issueLabel: { id: string } } }>(
    `mutation CreateLabel($input: IssueLabelCreateInput!) {
      issueLabelCreate(input: $input) { issueLabel { id } }
    }`,
    { input: { teamId: board.teamId, name } }
  );
  return created.issueLabelCreate.issueLabel.id;
}
