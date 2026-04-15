---
name: resume
description: Two resume prompt templates used by run-ticket.sh — "continue" for poller restarts, "feedback" for tickets returned from review.
---

# Resume Skill

Provides two lightweight prompt templates, both injected by `run-ticket.sh` via `envsubst`:

| File          | When                                          | What it does                                                                                                            |
| ------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `continue.md` | Poller restarted, same session resumed        | Verifies working directory, sweeps ticket comments for new instructions, then continues                                 |
| `feedback.md` | Ticket returned from Human Review / In Review | Checks Linear comments, GitHub PR comments (filtered: skip Vercel/SonarCloud bots), all inline code comments, CI status |

The poller (`poll-linear.mts`) tracks each ticket's last-known state. When a ticket transitions from a review state back to In Progress, it passes `--feedback` to `run-ticket.sh`. Otherwise it omits the flag (continue mode).
