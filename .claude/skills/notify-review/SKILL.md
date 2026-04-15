---
name: notify-review
description: Use when the user says "notify team", "request review", "send PR to slack", or wants to post a review request to Slack after creating a PR.
---

# Notify Review

Send a PR review notification to the team's Slack channel.

## Prerequisite: Slack MCP

This skill requires the Slack MCP server to be connected. If Slack tools are not available (check for `mcp__plugin_slack_slack__slack_send_message`), tell the user:

"The Slack MCP is not connected. Please connect it and try again, or copy the message below and send it manually."

Then compose and display the message for the user to copy.

## Gathering Context

1. Read `$SKILLS_ROOT/prime-project/session-state.md` for:
   - **Ticket ID**
   - **Project name** — to load the project config

2. Read `$SKILLS_ROOT/prime-project/project-configs/{project-name}.json` for:
   - **slack.channelName** — the Slack channel to post in
   - **slack.messageTemplate** — the message template

3. Get the PR URL from `gh pr view --json url -q .url` or ask the user.

## Composing the Message

Use the `messageTemplate` from the project config. The template already contains the correct Slack subteam mention format (`<!subteam^ID>`), so use it as-is — do **not** replace it with plain text like `@groupname`.

**Template variables:**

- `{pr_url}` — The PR URL
- `{pr_description}` — A short description like "to add processing period support" or "to fix overtime calculation"
- `{pr_action}` — One of: `fixes`, `closes`, `implements` (ask user or infer from commit type)
- `{ticket_id}` — The ticket ID (e.g. `TEAM-1234`)

**Ask the user** to provide or confirm the `pr_description` and `pr_action`.

## Sending

1. **Show the composed message** to the user and ask for confirmation before sending
2. Use `slack.channelId` from the project config if available, otherwise search by `channelName` using `slack_search_channels`
3. Send via `slack_send_message` to the channel

## Cross-Posting

If the project config has `slack.crossPost`, **ask the user** if they also want to post to that channel (e.g. `#e-code-review`). If yes, send the same message to the cross-post channel using its `channelId`.

## Post-Send

- Confirm the message was sent (and cross-posted if applicable)
- **Clear session state** — reset `$SKILLS_ROOT/prime-project/session-state.md` to the empty template:

```markdown
# Session State

<!-- Auto-updated by skills. Do not edit manually. Do not commit. -->
```

- Tell the user: "Review notification sent. Session complete."
