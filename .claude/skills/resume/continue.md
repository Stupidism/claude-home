# Continue — $TICKET_ID

Poller restarted. You are resuming the exact same session — all prior context is intact.

Before continuing, verify your working directory is valid:

```bash
pwd && git status --short | head -5
```

If the directory does not exist or is not a git repo, `cd` to `$WORKTREE_PATH` or `$REPO_ROOT` first.

## Check ticket comments

Sweep for any new instructions or notes left on the ticket since the session started. Route by `$TICKET_SYSTEM` and prefer the matching MCP tools — see `$SKILLS_ROOT/ticket/SKILL.md` for the dispatcher contract.

### Linear (`$TICKET_SYSTEM=linear`)

Preferred: `mcp__linear-server__list_comments` with `issueId: $TICKET_ID`.

Curl fallback:

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ issue(id: \"$TICKET_ID\") { comments { nodes { body createdAt user { name } } } } }'"'"' \
  | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); d.data.issue.comments.nodes.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,5).reverse().forEach(c=>console.log(c.createdAt, c.user?.name??'unknown', c.body))"
```

### Jira (`$TICKET_SYSTEM=jira`)

Preferred: `mcp__mcp-atlassian__jira_get_issue` with `issue_key: $TICKET_ID` — comments come back inline. (If only the `mcp__claude_ai_Atlassian__*` connector is present, use `getJiraIssue`.)

Curl fallback — see `$SKILLS_ROOT/jira/SKILL.md` for the auth header and base URL setup, then:

```bash
curl -s -H "Authorization: $JIRA_AUTH" -H "Accept: application/json" \
  "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID/comment?maxResults=20&orderBy=-created" \
  | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); (d.comments||[]).slice(-5).forEach(c=>console.log(c.created, c.author?.displayName??'unknown', JSON.stringify(c.body).slice(0,500)))"
```

If there are new comments with instructions (ignore `[symphony]` bot workpad comments):

- Address each instruction before continuing
- Update the workpad with what was found and resolved

**Then continue where you left off.**
