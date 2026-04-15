---
name: pr-feedback-sweep
description: Gather all PR feedback (top-level comments, inline review comments, unresolved threads), address every actionable item, re-validate, and confirm CI is green. Run before every Human Review transition.
---

# PR Feedback Sweep

Run this before every transition to Human Review.

## Step 1 — Gather all feedback

Run **all three** commands — inline comments are where most actionable feedback lives:

```bash
PR_NUMBER=$(gh pr view --json number --jq '.number')

# 1. Top-level PR review comments
gh pr view "$PR_NUMBER" --comments

# 2. Inline code comments (file-specific feedback — CRITICAL, don't skip)
gh api repos/$GITHUB_REPO/pulls/"$PR_NUMBER"/comments \
  --jq '.[] | "\(.path):\(.line) — \(.body)"'

# 3. Unresolved review threads
OWNER="${GITHUB_REPO%%/*}" REPO_NAME="${GITHUB_REPO##*/}"
gh api graphql -f query='
{ repository(owner:"'"$OWNER"'",name:"'"$REPO_NAME"'") {
    pullRequest(number:'"$PR_NUMBER"') {
      reviewThreads(first:100) { nodes {
        isResolved
        comments(first:3) { nodes { body path line } }
      }}
    }
  }
}' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | .comments.nodes[0] | "\(.path):\(.line) — \(.body)"'
```

## Step 2 — Address every item

- Every actionable comment is **blocking** — address it or post explicit justified pushback
- Update the workpad checklist with each feedback item and its resolution

## Step 3 — Re-validate

If any code changed:

1. Re-run lint and tests: `nx affected --target=lint,test --base=origin/master`
2. Push changes
3. Confirm CI is green (read `$SKILLS_ROOT/validate/SKILL.md` Step 3)

## Step 4 — Confirm ready

Invoke `check-pr` skill (this is Check #2 of 3):

```
Use the Skill tool with skill="check-pr"
```

**Do not move to Human Review unless `check-pr` reports `ready: YES`.**
