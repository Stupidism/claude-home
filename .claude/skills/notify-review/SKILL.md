---
name: notify-review
description: Use when the user says "notify team", "request review", "send PR to slack", or wants to post a review request to Slack after creating a PR.
---

# Notify Review

Send a PR review notification to the team's Slack channel.

## Prerequisite: Slack MCP

This skill requires the Slack MCP server to be connected. If Slack tools are not available (check for an `mcp__*slack*__slack_send_message` tool name), tell the user:

"The Slack MCP is not connected. Please connect it and try again, or copy the message below and send it manually."

Then compose and display the message for the user to copy.

## Gathering Context

1. Identify the **ticket ID** (e.g. `WOR-265`, `UP-761`) and **board key** (`WOR`, `UP`) from the branch name or the ticket the agent is currently working on.

2. Load the resolved Slack config (UP-761 schema). Resolution order — later overrides earlier:

    1. `~/symphony/config/symphony.json` → `.slack`
    2. `~/symphony/config/boards/<board>.json` → `.slack`
    3. The matching `projects[*].slack` block, if the ticket's project entry has one

   Read keys from the resolved object:

    - `codeReviewChannel.id` — Slack channel ID (e.g. `C09EYTC2GLP`) to post the message in
    - `codeReviewChannel.name` — channel name, used only for fallback search if `id` is empty
    - `crossPost` — optional `{ name, id }` for a cross-post target
    - `reviewers` — map of `nickname → Slack user ID` for `@`-mentioning coworkers

   If `codeReviewChannel.id` is empty and `name` is set, search by name with `slack_search_channels` and use the first match. If both are empty, stop and ask the user which channel to post in.

3. Get the PR URL from `gh pr view --json url -q .url` or ask the user.

## Composing the Message

Default template (use unless the user gives a different one):

```
<{pr_url}|PR #{pr_number}> {pr_action} {ticket_id} — {pr_description}. Ready for review.
```

**Template variables:**

- `{pr_url}` — The PR URL
- `{pr_number}` — Extracted from the PR URL
- `{pr_description}` — A short description like "add processing period support" or "fix overtime calculation"
- `{pr_action}` — One of: `fixes`, `closes`, `implements` (ask user or infer from commit type)
- `{ticket_id}` — The ticket ID (e.g. `WOR-265`, `UP-761`)

If the user names specific reviewers ("ping wenkang and smith"), look up each nickname in `slack.reviewers` and prepend their `<@USERID>` mentions. Names not in the map: warn and ask the user for the Slack user ID before sending.

**Ask the user** to confirm `pr_description` and `pr_action` before sending.

## Sending

1. **Show the composed message** to the user and ask for confirmation before sending.
2. Send via `slack_send_message` to `codeReviewChannel.id`.

## Cross-Posting

If the resolved config has `slack.crossPost.id`, **ask the user** whether to also post to that channel. If yes, send the same message there.

## Post-Send

Confirm the message was sent (and cross-posted if applicable). Tell the user: "Review notification sent."
