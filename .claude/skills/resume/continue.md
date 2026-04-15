# Continue — $TICKET_ID

Poller restarted. You are resuming the exact same session — all prior context is intact.

Before continuing, verify your working directory is valid:

```bash
pwd && git status --short | head -5
```

If the directory does not exist or is not a git repo, `cd` to `$WORKTREE_PATH` or `$REPO_ROOT` first.

## Check ticket comments

Sweep for any new instructions or notes left on the ticket since the session started:

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ issue(id: \"$TICKET_ID\") { comments { nodes { body createdAt user { name } } } } }"}' \
  | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); d.data.issue.comments.nodes.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,5).reverse().forEach(c=>console.log(c.createdAt, c.user?.name??'unknown', c.body))"
```

If there are new comments with instructions (ignore `[symphony]` bot workpad comments):

- Address each instruction before continuing
- Update the workpad with what was found and resolved

**Then continue where you left off.**
