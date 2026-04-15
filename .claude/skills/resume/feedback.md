# Feedback Resume — $TICKET_ID

This ticket was moved back from Human Review / In Review to In Progress. There is new feedback to address.

## 1. Check ticket comments

If `$TICKET_SYSTEM` is `linear`:

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ issue(id: \"$TICKET_ID\") { comments { nodes { body createdAt user { name } } } } }"}' \
  | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); d.data.issue.comments.nodes.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,5).reverse().forEach(c=>console.log(c.createdAt, c.user?.name??'unknown', c.body))"
```


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

- Address every instruction in ticket comments (from the developer, not from `[symphony]` bot comments)
- Address every unresolved PR comment and inline code comment
- Fix every failing CI check
- Do not re-implement work that is already done — only fix what is asked for

After addressing all feedback, re-validate (read `$SKILLS_ROOT/validate/SKILL.md`) and submit for review (read `$SKILLS_ROOT/submit-for-review/SKILL.md`).
