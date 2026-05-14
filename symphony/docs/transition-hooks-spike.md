# Spike: Transition / Hook Concept for Symphony (UP-772)

> Status: research note — no code changes. Recommendation at the end.

## 1. Problem

Symphony's runtime is a single polling loop (`symphony/scripts/poll-tickets.mts`):
every `pollIntervalSeconds` it fetches all eligible tickets per board, then
hands each one to `processTicket()` in `state-machine.mts` for an
observed-state dispatch. There is no inbound event ingress.

That works fine for steady-state cycles (claim Todo → spawn agent → finalize
Merging). It hurts for **complex multi-step tasks** where the agent itself
should react to a ticket-system event mid-run, e.g.:

- a reviewer flips the ticket to `Rework` and pastes inline feedback — the
  running agent only learns about it on the next poll, up to one full
  interval later;
- a Phase-N sub-ticket is created and should immediately be picked up by the
  same worktree the parent agent is sitting on;
- a Linear comment threads back to Symphony ("rerun tests", "merge now")
  and we want the agent to act without waiting for a poll tick.

The ticket asks: how do Hermes Agent and Superpowers solve this, and is
webhook-driven transition handling the right shape for Symphony?

## 2. How Hermes Agent does it

Two layered mechanisms — both confirmed from upstream docs.

### 2.1 Webhook subscriptions (external events → agent runs)

[Hermes webhook subscriptions docs][hermes-webhooks] expose a long-running
HTTP server inside the gateway. Each route in `config.yaml` declares:

```yaml
github-pr:
  events: ["pull_request"]
  secret: "github-webhook-secret"
  prompt: |
    Review this pull request:
    Repository: {repository.full_name}
    PR #{number}: {pull_request.title}
    URL: {pull_request.html_url}
  skills: ["github-code-review"]
  deliver: "github_comment"
  deliver_extra:
    repo: "{repository.full_name}"
    pr_number: "{number}"
```

Mechanics worth stealing:

- HMAC signature validation per-source (GitHub `X-Hub-Signature-256`, GitLab
  `X-Gitlab-Token`, generic `X-Webhook-Signature`).
- Dot-notation templating against the raw payload to synthesize the agent
  prompt (`{pull_request.title}` etc.). `{__raw__}` dumps the whole payload
  capped at 4 KB.
- Output routing: the agent's response goes back via `deliver:` to the
  source platform (GitHub comment, Slack message, …).

Hermes lists Jira as a supported source; the route shape is the same — only
the secret header and prompt template differ.

### 2.2 Event hooks (internal agent lifecycle → side effects)

[Hermes event hooks docs][hermes-hooks] are a complementary, in-process
mechanism: drop a `~/.hermes/hooks/<name>/HOOK.yaml` + `handler.py`:

```yaml
name: my-hook
description: Log all agent activity to a file
events:
  - agent:start
  - agent:end
  - agent:step
```

```python
async def handle(event_type: str, context: dict):
    ...
```

Lifecycle events: `gateway:startup`, `session:start`, `agent:start`,
`agent:step`, `agent:end`, `command:*`. Hooks are non-blocking — errors
swallowed and logged.

These are *not* status-transition hooks per se; they are observability /
reaction points around the agent's own runtime. The same pattern would map
cleanly onto Symphony's `state-machine.mts` dispatch effects (`claim`,
`resumeAgent`, `finalizeMerged`, …) if we ever want plug-in side effects
without editing the dispatcher.

## 3. How Superpowers does it

[obra/superpowers][superpowers] uses **Claude Code hooks** (the
`settings.json` `UserPromptSubmit` / `Stop` family), not ticket-system
webhooks. The hooks rewrite the prompt context to force-load skills the
model would otherwise forget. The relevant insight for us is the meta one:

> "Skills alone don't solve the whole problem — Claude often forgets to
> load them or users forget to invoke them. Hooks solve this by ensuring
> skills are properly triggered."

i.e. **hooks exist to make a per-state guarantee that some side effect
fires**, regardless of the model's drift. The Symphony parallel is
`processTicket`'s switch: every state ⇒ guaranteed dispatcher entry. We
already have this internally; what we don't have is a way for *external*
triggers (Jira/Linear transitions) to enter that dispatcher promptly.

Superpowers is therefore an interesting reference but **not a model for
ticket transition hooks** — it solves a different problem (skill recall
inside one Claude session).

## 4. Symphony today vs. the gap

| Concern                                              | Symphony today                | Gap                                                                                                |
| ---------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| Discover state changes                               | Poll every `pollIntervalSeconds` | Up to one interval of latency on every state flip                                                |
| Dispatch per state                                   | `state-machine.mts` switch    | Solid; nothing missing here                                                                        |
| Inject side effects without editing the dispatcher   | Edit `Deps` and re-deploy     | No plug-in surface like Hermes' hooks dir                                                          |
| React to ticket comments mid-run                     | Next poll cycle               | Agent doesn't know feedback exists until poller re-renders                                         |
| React to brand-new tickets                           | Next poll cycle               | Same                                                                                               |

Two distinct improvements are visible:

1. **External transition ingress** — a small webhook server that turns Jira
   / Linear webhook events into immediate `processTicket` invocations,
   short-circuiting the poll interval. The poller stays as the safety net
   (idempotent, source-of-truth reconciler).
2. **Plug-in dispatcher hooks** — a hooks directory pattern à la Hermes
   that lets us attach observers/mutators to `Effect`s without editing
   `state-machine.mts`. Lower priority.

## 5. Webhook ingress for Jira & Linear — feasibility

Both providers ship the right primitives:

- **Jira Cloud**: configurable webhooks per event (`jira:issue_updated` with
  `changelog.items[].field == "status"`). Signed via HMAC if behind
  Atlassian Connect, otherwise just URL-based (recommend HMAC at our edge).
- **Linear**: native webhooks for `Issue` create/update events, signed with
  a shared secret in `Linear-Signature` (HMAC-SHA256).

A Symphony adapter sketch:

```
poll-tickets.mts (existing loop, unchanged — safety net)
        ▲
        │ triggers immediate re-poll of one ticket
        │
webhook-ingress.mts  (NEW)
   ├── POST /jira    → verify HMAC → resolve ticket → enqueue processTicket
   └── POST /linear  → verify HMAC → resolve ticket → enqueue processTicket
```

Key design constraints we already know:

- The state machine docstring (`state-machine.mts:23-27`) explicitly notes
  the source of truth is the ticket system, and the local FSM is an
  *observer*. A webhook ingress fits that model — it just nudges the
  observer to look sooner. No state is duplicated.
- `processTicket()` is already idempotent per state, so a webhook-triggered
  dispatch and a poller-triggered dispatch for the same state collapse
  cleanly.
- Running-agent concurrency is already gated by `isAgentRunning` and
  `worktreeOccupiedBy` — a hot-fire webhook can't cause double-spawn.

Open questions worth raising before implementation:

- Inbound URL: localhost-only with an `ngrok`-style tunnel? Or terminate at
  a long-lived public endpoint (Vercel / Cloudflare Worker → tunnel back)?
  Affects how dev laptops behave when offline.
- Replay / dedup: Jira occasionally re-delivers webhooks; we'd want an
  `event_id` dedup window even though `processTicket` is idempotent, to
  avoid spamming spawn logs.
- Failure isolation: ingress must never block the poller event loop. Run
  it on the same Node process via a separate `http.createServer` is fine
  if handlers only enqueue and return 200 fast.

## 6. Recommendation

**Adopt option (1) — webhook transition ingress — as a small follow-up
ticket, not as part of this spike.** Concretely:

1. New module `symphony/scripts/webhook-ingress.mts` that listens on
   `127.0.0.1:<port>` (configurable), verifies HMAC, decodes a
   `{ticketIdentifier, newState}` tuple, and pushes the affected ticket
   into an in-memory `urgentQueue` that `poll()` drains at the top of its
   next loop iteration.
2. Reuse `processTicket()` as the single dispatch entry — no parallel code
   path. The poller remains the reconciler-of-record; the webhook is just a
   prompt-poll signal.
3. Defer option (2) — plug-in dispatcher hooks à la Hermes — until we have
   a concrete second use case beyond observability. Adding the surface
   speculatively violates the "no abstractions for single-use code" rule
   in `CLAUDE.md`.

**Why not run XState as the real FSM?** Already answered in
`state-machine.mts:23-27`: two concurrent editors (poller + reviewer) live
in Linear/Jira, so the ticket system is the only safe source of truth.
Webhook ingress preserves that invariant; an in-process FSM does not.

**Estimated scope of the follow-up ticket:** ~150 lines + tests, all
contained in `symphony/scripts/` — no new dependencies (Node's `http`
suffices), no migration risk.

## 7. References

- [Hermes Agent — Event Hooks][hermes-hooks]
- [Hermes Agent — Webhook Subscriptions][hermes-webhooks]
- [Hermes Agent — devops/webhook-subscriptions skill][hermes-skill]
- [obra/superpowers — GitHub][superpowers]
- [Jira webhook custom events][jira-webhooks]
- [Linear webhooks docs][linear-webhooks]

[hermes-hooks]: https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks
[hermes-webhooks]: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks
[hermes-skill]: https://github.com/NousResearch/hermes-agent/blob/main/skills/devops/webhook-subscriptions/SKILL.md
[superpowers]: https://github.com/obra/superpowers
[jira-webhooks]: https://confluence.atlassian.com/jirakb/how-to-use-a-webhook-with-a-custom-event-779160676.html
[linear-webhooks]: https://developers.linear.app/docs/graphql/webhooks
