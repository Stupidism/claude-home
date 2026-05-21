# Feedback Resume — $TICKET_ID

This ticket was moved back from Human Review / In Review to In Progress. There is new feedback to address.

## 1. Check ticket comments

Route by `$TICKET_SYSTEM`. Prefer the matching MCP tools when available — fall back to curl only when they're absent (see `$SKILLS_ROOT/ticket/SKILL.md` for the full dispatcher contract).

### Linear (`$TICKET_SYSTEM=linear`)

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ issue(id: \"$TICKET_ID\") { comments { nodes { body createdAt user { name } } } } }"}' \
  | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); d.data.issue.comments.nodes.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,5).reverse().forEach(c=>console.log(c.createdAt, c.user?.name??'unknown', c.body))"
```

### Jira (`$TICKET_SYSTEM=jira`)

Preferred: `mcp__mcp-atlassian__jira_get_issue` with `issue_key: $TICKET_ID` — the comments come back inline. (If only the `mcp__claude_ai_Atlassian__*` connector is present, use `getJiraIssue` with `issueIdOrKey: $TICKET_ID` instead.)

Curl fallback:

```bash
: "${JIRA_EMAIL:?JIRA_EMAIL not set}"
: "${JIRA_API_TOKEN:?JIRA_API_TOKEN not set}"

BOARD_FILE="$SYMPHONY_ROOT/config/boards/$(echo "$TICKET_ID" | cut -d- -f1 | tr A-Z a-z).json"
if [ ! -f "$BOARD_FILE" ]; then
  echo "Board config not found: $BOARD_FILE" >&2
  exit 1
fi

JIRA_BASE_URL=$(jq -r '.jira.baseUrl' "$BOARD_FILE")
if [ -z "$JIRA_BASE_URL" ] || [ "$JIRA_BASE_URL" = "null" ]; then
  echo "Missing .jira.baseUrl in $BOARD_FILE" >&2
  exit 1
fi

# tr -d '\n' guards against GNU `base64`'s default 76-column line wrap.
JIRA_AUTH="Basic $(printf '%s:%s' "$JIRA_EMAIL" "$JIRA_API_TOKEN" | base64 | tr -d '\n')"

curl -s -H "Authorization: $JIRA_AUTH" -H "Accept: application/json" \
  "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID/comment?maxResults=20&orderBy=-created" \
  | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); (d.comments||[]).slice(-5).forEach(c=>console.log(c.created, c.author?.displayName??'unknown', JSON.stringify(c.body).slice(0,500)))"
```

Jira comment bodies come back as ADF JSON — print the raw JSON and grep for the text you care about, or pull `body.content[*].content[*].text`.


## 2. Check GitHub PR comments

```bash
PR_NUMBER=$(gh pr list --head "$BRANCH" --json number --jq '.[0].number')
if [ -n "$PR_NUMBER" ]; then
  echo "=== PR #$PR_NUMBER ==="

  # Top-level review comments (skip bots: vercel, sonarcloud, etc.)
  gh api repos/$GITHUB_REPO/issues/"$PR_NUMBER"/comments \
    --jq '.[] | select(.user.login != "vercel[bot]" and .user.login != "sonarcloud[bot]" and .user.login != "github-actions[bot]") | "\(.user.login) (\(.created_at)): \(.body)"'

  # ALL inline code comments (these are always relevant)
  gh api repos/$GITHUB_REPO/pulls/"$PR_NUMBER"/comments \
    --jq '.[] | "\(.path):\(.line // .original_line) — \(.user.login): \(.body)"'

  # Unresolved review threads
  OWNER="${GITHUB_REPO%%/*}" REPO_NAME="${GITHUB_REPO##*/}"
  gh api graphql -f query='{ repository(owner:"'"$OWNER"'",name:"'"$REPO_NAME"'") { pullRequest(number:'"$PR_NUMBER"') { reviewThreads(first:100) { nodes { isResolved comments(first:3) { nodes { body path line author { login } } } } } } } }' \
    --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | .comments.nodes[] | "\(.path):\(.line) — \(.author.login): \(.body)"'

  # CI status
  gh pr checks "$PR_NUMBER"
fi
```

## 3. Act

First, decide whether there is any actionable feedback at all:

- New ticket comments from the developer (ignore `[symphony]` bot comments)
- Unresolved PR review comments or inline code comments
- Failing CI checks

### 3a. Actionable feedback exists

- Address every instruction in ticket comments (from the developer, not from `[symphony]` bot comments)
- Address every unresolved PR comment and inline code comment
- Fix every failing CI check
- Do not re-implement work that is already done — only fix what is asked for

After addressing all feedback, re-validate (read `$SKILLS_ROOT/validate/SKILL.md`) and submit for review (read `$SKILLS_ROOT/submit-for-review/SKILL.md`).

### 3b. No actionable feedback (PR already merged / nothing left to address)

This happens when the ticket was bounced back to `In Progress` but the underlying work is already done — typically because the user merged the PR directly on GitHub, or all review threads were resolved in an earlier cycle.

Before declaring "no actionable feedback", verify **all** of the following:

- No new developer instructions in ticket comments.
- No unresolved PR review comments or inline code comments (human or bot).
- CI is green.
- **The AI code review cycle has completed for the current PR head.** Look on the ticket for a `[symphony] aiReviewRequested: <prUrl>` lock comment and on the PR for the corresponding AI reviewer response (e.g. Codex's "Didn't find any major issues" / CodeRabbit's review summary). If the lock comment is missing, or the AI reviewer has not yet posted back, the review is not complete — wait, do not skip to 3b. If the AI review left findings, treat them as actionable feedback and handle them in 3a first.

If — and only if — all of the above hold, do **not** silently exit. The poller will keep respawning a fresh agent on every cycle.

Push the ticket back to `Human Review` by running `$SKILLS_ROOT/submit-for-review/SKILL.md`. The `handleHumanReview` PR-merged / approval fast-path in `symphony/scripts/state-machine.mts` will then finalize the ticket automatically.
