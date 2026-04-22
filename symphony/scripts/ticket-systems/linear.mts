/**
 * Linear adapter — wraps Linear GraphQL into the TicketSystemAdapter shape.
 */

import type { BoardLike, Issue, StateKey, TicketSystemAdapter } from './types.mts';

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
    project { id name }`;

export const linearAdapter: TicketSystemAdapter = {
  async fetchTicketsByState(board, stateKey, assigneeId) {
    const stateId = board.states[stateKey];
    const filter: Record<string, unknown> = { state: { id: { eq: stateId } } };
    if (assigneeId) filter['assignee'] = { id: { eq: assigneeId } };

    const data = await linearQuery<{ team: { issues: { nodes: Issue[] } } }>(
      `query GetTickets($teamId: String!, $filter: IssueFilter) {
        team(id: $teamId) {
          issues(filter: $filter, orderBy: createdAt, first: 50) {
            nodes { ${ISSUE_FIELDS} }
          }
        }
      }`,
      { teamId: board.teamId, filter }
    );
    return data.team.issues.nodes;
  },

  async fetchTicketByIdentifier(_board, identifier) {
    const data = await linearQuery<{ issue: Issue | null }>(
      `query GetTicket($identifier: String!) {
        issue(id: $identifier) { ${ISSUE_FIELDS} }
      }`,
      { identifier }
    );
    return data.issue ?? null;
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
      { id: issueId, stateId: board.states[stateKey] }
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
};
