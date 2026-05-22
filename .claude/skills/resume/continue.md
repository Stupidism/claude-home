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
  -d "{\"query\": \"{ issue(id: \\\"$TICKET_ID\\\") { comments { nodes { body createdAt user { name } } } } }\"}" \
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

## No actionable work

A ticket only counts as "no actionable work" once **all** of the following are true:

- No new developer instructions in ticket comments.
- No unresolved PR review comments or inline code comments (human or bot).
- CI is green.
- **The AI code review cycle has completed for the current PR head.** Check the GitHub commit status `symphony/ai-reviewed` on the current PR HEAD (`gh api repos/<owner>/<repo>/commits/<sha>/statuses --jq '.[] | select(.context=="symphony/ai-reviewed")'`). The poller sets it to `pending` when it fires the AI review trigger from `handleInProgress` and flips it to `success` once a review whose `commit_id` matches that SHA has landed (UP-806). If the status is missing or `pending`, the review is **not** complete — wait, do not declare done. If the AI review left actionable findings, address them first.

If — and only if — all of the above hold, do **not** silently exit. The poller will respawn you on every cycle if the ticket stays in `In Progress`, burning tokens for no progress.

Push the ticket back to `Human Review` by running `$SKILLS_ROOT/submit-for-review/SKILL.md`. The `handleHumanReview` PR-merged / approval fast-path (see `symphony/scripts/state-machine.mts`) will then finalize the ticket without further agent work.
