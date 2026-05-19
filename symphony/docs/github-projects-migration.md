# Symphony Ticket System Migration — Linear → GitHub Projects

UP-795. Design proposal for adding a third Symphony ticket backend (GitHub
Projects v2) alongside the existing Linear and Jira adapters, and migrating
the `WOR` board off Linear before it hits the 250-issue Free-plan cap.

This doc is the AC3 deliverable. AC1 (adapter + board config + sub-skill
landed on `main`) and AC2 (one real ticket lands end-to-end through GitHub
Projects) are tracked as separate Backlog subtasks under UP-795.

## 1. Why move

| | Linear Free | Linear Standard | GitHub Projects (any plan) |
|---|---|---|---|
| Item cap | **250** | 5,000 | **50,000** (public preview, no plan gate) |
| Cost | $0 | per seat | $0 for private repos + Projects |
| Native coupling to PR / CI | indirect | indirect | tight — items are Issues |
| Sub-issues | yes | yes | yes (GA, 100 per parent, 8 deep) |
| Cycles / sprints | yes | yes | iteration field only, no burndown |
| Single-select "Status" field | yes | yes | yes (configurable per project) |

The cap is the forcing function — Symphony is approaching 250 on `WOR` and
Linear deletes nothing. GitHub Projects also unifies the ticket and PR
surface, which is where the actual work already happens.

50k applies to GitHub Projects as of 2025-02 (public preview, all plans). For
Symphony's volume (~hundreds/year), this is effectively unbounded.

## 2. What Symphony actually requires from a ticket system

Pulled from the existing `TicketSystemAdapter` interface
(`symphony/scripts/ticket-systems/types.mts`) and the poller. Any new backend
must cover:

1. **Issue model** — id, human key (e.g. `WOR-138`), title, description, url,
   state, assignee, labels.
2. **`project:<slug>` routing** — the poller reads a `project:*` label to
   pick the Symphony project entry for monorepo dispatch.
3. **State machine** — Backlog / Todo / In Progress / Human Review / Rework
   / Merging / Done (+ optional Cancelled).
4. **Filtered listing** — "all issues on board X in state Y assigned to Z"
   every 30s.
5. **Single-ticket fetch** — by human identifier.
6. **State transition** — by name (Symphony state → backend state).
7. **Comments** — list, create, delete (workpad CRUD). Note: Symphony's
   workpad uses *one persistent comment* per ticket, identified by leading
   `## Claude Workpad`.
8. **Labels** — add/remove/check. Used for `symphony:needs-notify-review`,
   `runtime:codex`, and the `project:*` routing labels.
9. **Sub-task creation** — `read-and-plan` splits large work into Backlog
   subtasks linked to the parent.

## 3. GitHub Projects mapping

### 3.1 Identity model

| Symphony concept | GitHub equivalent |
|---|---|
| Board | A single ProjectV2, scoped to a GitHub org or user |
| Ticket identifier (`WOR-138`) | Issue number with repo prefix — e.g. `Stupidism/claude-home#138`. Surface as `<repo>#<num>` everywhere. |
| Ticket id (UUID/numeric) | Issue node ID (`I_kw...`) |
| Issue title/description | GitHub Issue title / body |
| State (Backlog/Todo/…) | ProjectV2 single-select **Status** field |
| Assignee | GitHub Issue assignee (username) |
| Labels | GitHub Issue labels |
| Comments / workpad | GitHub Issue comments |
| Sub-task | GitHub native sub-issue (REST `sub_issues`) |
| Project membership | ProjectV2 item row (an Issue can sit on many projects) |

Symphony already encodes `<prefix>-<num>` (e.g. `WOR-138`). The closest
analog on GitHub is `<repo>#<num>`. We will keep Symphony's pattern by
adopting `<prefix>-<num>` as a *synthetic identifier* derived from a single
"home repo" per board — see § 3.6.

### 3.2 Status field

ProjectV2 exposes a configurable single-select field per project. The
Symphony state machine maps 1:1 to a custom **Status** field whose options
are: `Backlog`, `Todo`, `In Progress`, `Human Review`, `Rework`, `Merging`,
`Done` (and optionally `Cancelled`).

State transitions are done with `updateProjectV2ItemFieldValue`, passing the
single-select option ID. Option IDs are stable per project and are stored on
the board config (analogous to Jira's `transitions` map).

### 3.3 Filtered listing — the hot path

The poller fetches "items in state X assigned to user Y" every 30s per
board. ProjectV2 has no server-side filter on field values, so the adapter
must:

1. Page through `node($projectId) { ... on ProjectV2 { items(first: 100) { nodes { ... } pageInfo { endCursor hasNextPage } } } }`.
2. Filter client-side by Status option + assignee.

At Symphony scale this is fine (hundreds of items per project, one page in
practice). If it ever grows past a few thousand open items per board, we
can add a "Closed" archive project and only poll the active one.

GraphQL rate limits: 5,000 points/hour. Each item page (~100 items with
nested fields) costs roughly 1 point. Polling every 30s = 120/hr/board.
Well under budget.

### 3.4 Single ticket fetch by identifier

GitHub doesn't have "WOR-138" as a primary key. Two options:

- **(A) Lookup by `<repo>#<num>`** — given a board's home repo, parse the
  numeric suffix and call `repository(owner, name) { issue(number) }`. The
  project item is joined via `issue.projectItems(first: 10)`.
- **(B) Store the ProjectV2 item ID locally** — Symphony already has a
  `state/` dir; we could cache identifier → item id mappings.

Pick **A**. It is stateless and matches what the poller does today (call
out to the source of truth). The `<prefix>` portion of the synthetic id
maps to the home repo via board config.

### 3.5 Sub-issues

GitHub Issues now have **native sub-issues** (GA, 100/parent, 8 deep). The
REST API exposes `POST /repos/{owner}/{repo}/issues/{number}/sub_issues`
to attach an existing issue, and `GET .../sub_issues` to list. The GraphQL
schema also exposes `parent` and `subIssues` connections on `Issue`.

For Symphony's `read-and-plan` "create N Backlog subtasks linked to
parent" workflow this is a clean fit. New-ticket creation flow:

1. `createIssue` mutation — body, title, labels, assignees.
2. `addProjectV2ItemById` — attach to the project.
3. `updateProjectV2ItemFieldValue` — set Status = Backlog.
4. (Optional) REST `sub_issues` — link to parent.

### 3.6 Synthetic identifier (`<PREFIX>-<num>`)

To keep Symphony's identifier convention (`WOR-138`, `UP-795`) and avoid
churning every branch-naming and skill that parses these:

- Each GitHub-Projects board declares a **home repo** in its config.
- The board's `ticketPrefix` (e.g. `SY` for Symphony) is the synthetic
  prefix.
- The numeric portion is the *issue number in the home repo*. Issues sitting
  on the same Project but originating in other repos either get re-homed
  (transfer to the home repo, GitHub supports this and renumbers) or stay
  under their native `<repo>#<num>` and Symphony ignores them.

So `SY-42` = `<homeOwner>/<homeRepo>#42`, and the worktree branch becomes
`feat/SY-42--<slug>`.

This loses Linear's globally unique `TEAM-N` semantics across repos, but
keeps the rest of Symphony unchanged.

## 4. Adapter contract — what changes vs Linear/Jira

`TicketSystemAdapter` (in `types.mts`) stays. New `BoardGithubProjectsConfig`
shape:

```jsonc
{
  "ticketSystem": "github-projects",
  "ticketPrefix": "SY",
  "teamId": "<homeOwner>/<homeRepo>",       // home repo for synthetic ids
  "assigneeId": "<github-username>",         // GitHub login of the bot/user
  "githubProjects": {
    "projectId": "PVT_kw...",                // node id of the ProjectV2
    "statusFieldId": "PVTSSF_...",
    "statusOptions": {
      "backlog":      "<option-id>",
      "todo":         "<option-id>",
      "inProgress":   "<option-id>",
      "humanReview":  "<option-id>",
      "rework":       "<option-id>",
      "merging":      "<option-id>",
      "done":         "<option-id>",
      "cancelled":    "<option-id>"
    }
  }
}
```

The adapter uses the GitHub GraphQL API (`https://api.github.com/graphql`)
with a `GITHUB_TOKEN` PAT (already required by the poller for `gh pr`
operations — we can reuse it, scoped to `repo` + `project`).

### 4.1 Method-by-method

| Method | GraphQL/REST |
|---|---|
| `fetchTicketsByState` | `node($projectId).items(first:100, after:$cursor)` → filter by status option + assignee → map to `Issue` |
| `fetchTicketByIdentifier` | parse `<prefix>-<num>` → `repository.issue(number)` → join `projectItems` |
| `fetchTicketStateId` | same as above, return the status option name |
| `moveToState` | `updateProjectV2ItemFieldValue` with `singleSelectOptionId` |
| `postComment` | `addComment` mutation (or REST `POST /issues/{n}/comments`) |
| `listComments` | REST `GET /issues/{n}/comments` — paginates simpler than GraphQL here |
| `deleteComment` | REST `DELETE /issues/comments/{id}` |
| `addLabel` / `removeLabel` | REST `POST/DELETE /issues/{n}/labels` |
| `hasLabel` | pure — read `issue.labels` |

## 5. Workpad data location

**Decision: GitHub Issue comments**, identical to Linear/Jira.

Alternatives considered and rejected:

- **Issue body** — would conflict with the human-authored description. Body
  edits also clobber each other on concurrent updates.
- **Dedicated sub-issue** — too many click-throughs for the reviewer; sub-
  issue creation also costs an extra API call per workpad write.
- **Project field (text)** — ProjectV2 has a free-text field type, but it
  is invisible from the Issue page where the reviewer reads.

Comments win. The `## Claude Workpad` first-line marker plus the env stamp
fenced block already used in Linear/Jira ports verbatim. No template
changes required.

## 6. Migration plan for in-flight `WOR` tickets

Three policies, in order of effort:

1. **Drain + freeze** *(recommended)*. Stop adding new tickets to `WOR`.
   Let the existing Todo/In-Progress queue drain on Linear. Once Linear
   Free goes quiet, archive the team and switch all new work to the new
   GitHub Projects board. No data is moved; Linear stays read-only for
   historical reference.
2. **Re-create open tickets only**. Script that fetches every Linear ticket
   in `Backlog | Todo | In Progress | Human Review | Rework | Merging` and
   re-creates as a GitHub Issue + Project item. Mark the Linear original
   `Cancelled` and post a "moved to SY-N" comment. ~30 tickets at most,
   one-shot script.
3. **Full export**. Export all 250 with comments. High effort, low value —
   workpads of finished tickets are not load-bearing once the PR has
   landed.

Recommend (1) for the cutover, with (2) as a hand-rolled fallback if any
WOR ticket is stuck > 1 week. (3) is unnecessary.

## 7. Tradeoffs and unsupported capabilities

| Linear feature | GitHub Projects status | Workaround |
|---|---|---|
| Cycles / sprints | Iteration field exists; no burndown chart | Use iteration field for grouping; if velocity tracking is needed later, GitHub Insights chart or external tool |
| Sub-issue rollup view | Native sub-issues + parent issue view, but no "% complete" bar | Acceptable. Symphony doesn't read rollup. |
| Triage / inbox | None | Use a `triage` label + a board view filtered to it |
| Project milestones | GitHub has Milestones (per-repo, not per-project) | Use Project iterations instead — broader scope |
| Comment update API | Yes (REST `PATCH /issues/comments/{id}`) | Direct map |
| Markdown rendering | Full GFM | Slightly better than Jira ADF, parity with Linear |
| Globally unique `TEAM-N` ID | No | Synthetic `<prefix>-<num>` via home repo (§ 3.6) |
| Cross-team issue linking | Linear has dependencies; GitHub has "blocked by" via labels + linked issues | Use sub-issues + the new `tracks/tracked-by` linking |
| "Triage / no state" | Implicit (item with Status unset) | Treat unset Status as Backlog in the adapter |

## 8. Open questions

- **PAT scope** — `repo` is broad. Investigate fine-grained PATs with
  `Issues: write`, `Projects: write`, `Metadata: read` on the home repo
  and the project.
- **Webhooks vs polling** — Symphony polls today. GitHub supports
  `project_v2_item.edited` webhooks; could halve the apparent latency
  but adds infra. Out of scope for AC1/AC2.
- **Cleanup-tickets skill** — already grep-walks across repos with `gh pr
  list`. Will need to also call the new adapter; track in the dispatcher
  subtask.
- **Notify-review** — currently posts to Slack via Linear webhook. With
  GitHub Projects we'll need to keep the existing Slack path triggered by
  a `symphony:needs-notify-review` label, which the poller checks
  independently of the ticket system. Should work unchanged.

## 9. Implementation breakdown (subtasks)

Each is filed as a Backlog ticket under UP-795:

1. **Adapter implementation** — `scripts/ticket-systems/github-projects.mts`
   + `types.mts` extension + `poll-tickets.mts` routing. Includes config
   validation and clear error messages for missing IDs. (~400 lines, ~5
   files.)
2. **Sub-skill + dispatcher** —
   `~/.claude/skills/github-projects/SKILL.md` (mirror of jira/linear) +
   update `~/.claude/skills/ticket/SKILL.md` routing table + a new entry
   in `symphony/config/boards/` for the trial board.
3. **WOR drain + cutover** — disable new ticket creation on `WOR`; wire
   `new-ticket` skill to the new board; document the freeze in
   README. Optional helper script that lists open Linear tickets so the
   team can decide which (if any) to re-file as SY-* manually.
4. **End-to-end validation (AC2)** — file one real implementation ticket on
   the new board, run it through `read-and-plan → setup-worktree →
   create-pr → submit-for-review → land`. Document any gaps surfaced.
