# UP-758 — Spike: Inline Codex review for Symphony

**Goal:** Replace the current `@codex review in short words` comment-trigger flow with an inline AI review loop that fits Symphony's state machine, scoped to the `claude-home` repo.

## 1. Current state

- `board.repos[].github.codeReviewComment = "@codex review in short words"` is posted by `create-pr` / `submit-for-review`.
- Codex replies asynchronously as a GitHub PR comment.
- Symphony does not consume Codex's response — the agent exits and a human reads the comment manually.

Pain points: review is fire-and-forget, no closed loop, no auto-rework when Codex finds an issue.

## 2. How other orchestration tools structure the review loop

| Tool / Pattern              | Topology                              | Trigger                              | Communication channel             | Resume model                                       |
| --------------------------- | ------------------------------------- | ------------------------------------ | --------------------------------- | -------------------------------------------------- |
| **Codex GitHub Action**     | Reviewer-in-CI                        | PR open / push (automatic, no `@`)   | Native GitHub PR review (approve / request-changes) | Per-(repo, PR, model, SHA) cache; resumes prior thread, reviews delta since last SHA |
| **LangGraph Generator-Critic** | Two nodes in a graph                | State edge                           | Shared state object               | Checkpointing per node; `interrupt()` for HITL     |
| **Reflexion**               | Single actor, self-critique loop      | After each draft                     | In-memory reflections             | Bounded retry count                                |
| **OpenHands delegation**    | Parent agent spawns sub-agent         | Tool call                            | Sub-conversation result           | Sub-agent inherits parent's workspace, returns one message |
| **Devin**                   | Single agent with internal review     | Implicit                             | Internal scratchpad               | Opaque                                             |

**Common threads:**

1. **Sequential, not parallel.** Coder and reviewer never write to the same workspace simultaneously. Even multi-agent frameworks serialize the handoff through shared state.
2. **Native review channel.** Tools that integrate with GitHub use the PR review system (approve / request-changes), not free-form comments — it carries semantic state.
3. **Delta-aware resume.** After feedback, the next pass reviews only what changed since the last reviewed SHA.

## 3. Recommendation for Symphony

### 3.1 State design — labels, not a new Jira state

**Do not add an `AI Review` Jira workflow state.** Reasons:

- Adding a Jira state requires editing the workflow on each board (`up.json`, `wor.json`) and the Jira admin UI — high friction for a personal tool.
- Symphony's existing model is "one agent active per ticket at a time, transitioning between states." The Jira state already encodes whose turn it is.
- Labels (`ai-review:in-progress`, `ai-review:request-changed`, `ai-review:approved`) are a lighter sub-state that fits inside `Human Review` without touching the workflow.

**Proposed lifecycle:**

```
In Progress (coding agent)
     │  agent finishes, PR open, validate clean
     ▼
Human Review + label ai-review:in-progress         ◄──── enters here
     │  poller polls PR review state from Codex
     ├──► review = approved      → label ai-review:approved.  Stay in Human Review for human signoff.
     └──► review = request-changes → label ai-review:request-changed
            │
            ▼
        Transition back to In Progress; resume coding agent with the "feedback" template
```

### 3.2 Interrupt vs parallel coding agent

**Neither — sequential by state.** The Symphony pattern already exits the coding agent when it transitions the ticket to `Human Review`. There is no live coding agent process to interrupt; the poller is the only thing running. So:

- No "interrupt the coder" problem.
- No "two agents write to the worktree at once" risk.
- Re-engagement is the existing `resume "feedback"` flow — no new code path.

This matches the LangGraph Generator-Critic and OpenHands delegation models: strictly sequential handoff through persistent state (Jira status + labels), not concurrent processes.

### 3.3 Drop the comment trigger

Enable **automatic review** in the Codex GitHub App settings for `Stupidism/claude-home`. Codex posts a PR review on every `pull_request` event without needing a comment.

Symphony then **only reads** the PR review state via `gh pr view --json reviews,reviewDecision` — no posting required. Remove the `codeReviewComment` field from `board.repos[].github` for claude-home.

### 3.4 Customizable reviewer array

Add a per-repo config:

```jsonc
// board.repos[].review
{
  "agents": ["codex"],          // names of reviewers we wait on
  "requireAll": true,           // approved label only after all agents approve
  "maxRework": 3                // safety cap; surface to human if exceeded
}
```

The poller maps each agent name to a function `(pr) => "approved" | "request-changes" | "pending"`. For `codex`, that function reads PR reviews authored by the Codex GitHub App user.

Defaults: `agents: ["codex"]`, `requireAll: true`, `maxRework: 3`.

### 3.5 Where the new logic lives

| Location                                                 | Change                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `symphony/scripts/poll-tickets.mts`                      | New phase: for tickets in `Human Review` with no `ai-review:*` label → fetch PR reviews → set label / dispatch  |
| `symphony/scripts/ticket-systems/jira.mts` (and linear)  | `addLabel(ticketId, label)` / `removeLabel` helpers                                                             |
| `symphony/config/boards/up.json`, `wor.json`             | Add `review` object to claude-home repo entry; drop `codeReviewComment`                                         |
| `~/.claude/skills/submit-for-review/SKILL.md`            | After transitioning to Human Review, add the `ai-review:in-progress` label                                      |
| `~/.claude/skills/resume/SKILL.md`                       | Existing "feedback" template already handles re-entry; document the codex-feedback case                         |
| `~/.claude/skills/rework/SKILL.md`                       | Add branch for `ai-review:request-changed` (incremental, not full rework)                                       |
| Codex GitHub App settings (out-of-repo)                  | Toggle **Automatic reviews** ON for `Stupidism/claude-home`                                                     |
| `AGENTS.md` at repo root                                 | Add `## Review guidelines` section to tune Codex's focus (P0/P1 only, ignore docs typos, etc.)                  |

## 4. Open questions for follow-up tickets

1. **What feedback gets passed to the resumed coder?** Likely: the full Codex review body, fetched via `gh api repos/:o/:r/pulls/:n/reviews` and inlined into the resume prompt.
2. **Stop condition.** AC mentions "stop it when …" — implies a timeout or max-rework cap. Recommend `maxRework: 3` + escalation comment on the ticket.
3. **Approval ≠ auto-merge.** Recommend keeping the `Merging` transition human-gated for now; revisit after the loop is proven.
4. **Multi-reviewer ordering.** If the array grows beyond `[codex]`, do we fan-out or fan-in sequentially? Defer until a second reviewer is actually wanted.

## 5. Mapping back to the AC

| AC item                                                           | Covered by                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------- |
| No comment trigger                                                | §3.3 — enable Codex automatic review, remove `codeReviewComment` |
| Keep using codex                                                  | §3.4 — `agents: ["codex"]` default                      |
| Labels `ai-review:in-progress` / `request-changed` / `approved`   | §3.1                                                    |
| Poll PR until `ai-review:approved`                                | §3.1 + §3.5 (poller phase)                              |
| Customizable preferred agent array                                | §3.4                                                    |
| Start review on transition to Human Review; stop when …           | §3.1 (start), §4 (stop = approved OR maxRework cap)     |

## 6. Out of scope for this spike

- Implementation. This document is the design only. Follow-up tickets will land:
  - **UP-???**: Poller changes + label plumbing + config schema.
  - **UP-???**: Toggle Codex automatic reviews; remove `codeReviewComment`; add `AGENTS.md` review guidelines.
  - **UP-???**: Update `submit-for-review`, `rework`, `resume` skills for the new sub-state.
