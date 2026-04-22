/**
 * Jira adapter — Jira REST v2 (plain-text description/comments; v3 returns ADF JSON).
 *
 * Board config for Jira boards:
 *   "ticketSystem": "jira",
 *   "teamId": "UP",                // Jira project key
 *   "jiraBaseUrl": "https://workstreamhq.atlassian.net",
 *   "states":      { todo: "To Do", inProgress: "In Progress", done: "Done", ... },
 *   "transitions": { todo: "11",    inProgress: "21",           done: "31",   ... }
 *
 * Secrets (read from the process environment):
 *   JIRA_EMAIL      — Atlassian account email
 *   JIRA_API_TOKEN  — https://id.atlassian.com/manage-profile/security/api-tokens
 */

import type { BoardLike, Issue, StateKey, TicketSystemAdapter } from './types.mts';

interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description: string | null;
    status: { id: string; name: string };
    assignee: { accountId: string; displayName: string } | null;
    project: { id: string; key: string; name: string };
  };
}

function authHeader(): string {
  const email = process.env['JIRA_EMAIL'] ?? '';
  const token = process.env['JIRA_API_TOKEN'] ?? '';
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function jiraRequest(board: BoardLike, pathAndQuery: string, init?: RequestInit): Promise<Response> {
  const base = (board.jiraBaseUrl ?? '').replace(/\/$/, '');
  if (!base) throw new Error(`[jira] Board "${board.name}" is missing jiraBaseUrl`);
  const res = await fetch(`${base}${pathAndQuery}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[jira] ${init?.method ?? 'GET'} ${pathAndQuery} → ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  return res;
}

function toIssue(board: BoardLike, raw: JiraIssue): Issue {
  const base = (board.jiraBaseUrl ?? '').replace(/\/$/, '');
  return {
    id: raw.id,
    identifier: raw.key,
    title: raw.fields.summary,
    description: raw.fields.description ?? null,
    url: `${base}/browse/${raw.key}`,
    project: raw.fields.project
      ? { id: raw.fields.project.id, name: raw.fields.project.name }
      : null,
    // `id` is the status *name*, not Jira's numeric status ID — Jira boards
    // configure Symphony states by name (see board.states), so the poller
    // compares against names when checking transitions.
    state: { id: raw.fields.status.name, name: raw.fields.status.name },
    assignee: raw.fields.assignee
      ? { id: raw.fields.assignee.accountId, name: raw.fields.assignee.displayName }
      : null,
  };
}

function escapeJql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export const jiraAdapter: TicketSystemAdapter = {
  async fetchTicketsByState(board, stateKey: StateKey, assigneeId) {
    const statusName = board.states[stateKey];
    const clauses = [
      `project = "${escapeJql(board.teamId)}"`,
      `status = "${escapeJql(statusName)}"`,
    ];
    if (assigneeId) clauses.push(`assignee = "${escapeJql(assigneeId)}"`);
    const jql = clauses.join(' AND ') + ' ORDER BY created ASC';

    // Use the "enhanced" search/jql endpoint — /rest/api/2/search is being
    // removed from Jira Cloud. The new endpoint uses nextPageToken for paging;
    // 50 per Symphony state is plenty, so we only ever fetch the first page.
    const body = JSON.stringify({
      jql,
      fields: ['summary', 'description', 'status', 'assignee', 'project'],
      maxResults: 50,
    });
    const res = await jiraRequest(board, '/rest/api/2/search/jql', { method: 'POST', body });
    const data = (await res.json()) as { issues: JiraIssue[] };
    return data.issues.map((i) => toIssue(board, i));
  },

  async fetchTicketByIdentifier(board, identifier) {
    try {
      const res = await jiraRequest(
        board,
        `/rest/api/2/issue/${encodeURIComponent(identifier)}?fields=summary,description,status,assignee,project`
      );
      const raw = (await res.json()) as JiraIssue;
      return toIssue(board, raw);
    } catch (err) {
      if (String(err).includes('404')) return null;
      throw err;
    }
  },

  async fetchTicketStateId(board, identifier) {
    try {
      const res = await jiraRequest(
        board,
        `/rest/api/2/issue/${encodeURIComponent(identifier)}?fields=status`
      );
      const raw = (await res.json()) as { fields: { status: { name: string } } };
      // Return the status name so it compares equal to board.states.*.
      return raw.fields?.status?.name ?? null;
    } catch (err) {
      if (String(err).includes('404')) return null;
      throw err;
    }
  },

  async moveToState(board, issueId, stateKey) {
    const transitionId = board.transitions?.[stateKey];
    if (!transitionId) {
      throw new Error(`[jira] Board "${board.name}" is missing transitions.${stateKey}`);
    }
    await jiraRequest(board, `/rest/api/2/issue/${encodeURIComponent(issueId)}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
  },

  async postComment(board, issueId, body) {
    await jiraRequest(board, `/rest/api/2/issue/${encodeURIComponent(issueId)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  },

  async listComments(board, issueId) {
    const res = await jiraRequest(
      board,
      `/rest/api/2/issue/${encodeURIComponent(issueId)}/comment?maxResults=100`
    );
    const data = (await res.json()) as { comments: { id: string; body: string }[] };
    return data.comments.map((c) => ({ id: c.id, body: c.body ?? '' }));
  },

  async deleteComment(board, issueId, commentId) {
    await jiraRequest(
      board,
      `/rest/api/2/issue/${encodeURIComponent(issueId)}/comment/${encodeURIComponent(commentId)}`,
      { method: 'DELETE' }
    );
  },
};
