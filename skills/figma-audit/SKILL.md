---
name: figma-audit
description: Enumerate all Figma frames, screenshot each one, compare against existing code, detect scope mismatches, and produce a per-frame change checklist. Run when a ticket contains a Figma link, before writing any code.
---

# Figma Audit

## Step 1 — Enumerate all frames

Open the Figma link with the Figma MCP tool. List every frame / top-level node in the file or the linked section.

**Do not assume you have seen everything after looking at one or two frames — enumerate the full list first.**

## Step 2 — Screenshot every frame

For each frame in the list: take a screenshot with the Figma MCP tool. Do not skip frames. Do not sample.

## Step 3 — Compare each frame against existing code

For each frame:

1. Identify the corresponding component(s) in the codebase (use Grep/LSP, not manual file browsing).
2. Note every visual or behavioral difference between the design and the current implementation.
3. Record as a checklist item: `- [ ] Frame "<name>": <what needs to change>`.

If a frame has no corresponding code yet, record it as a new component to build.

## Step 4 — Scope mismatch check

Compare the full audit findings against the original ticket description and AC.

**If the design reveals work that is substantially larger or different from the ticket, stop immediately.**

"Substantially larger or different" means any of:

- One or more UI fields or components not mentioned anywhere in the ticket
- A new user flow or interaction not described in the AC
- More than ~30% more files to change than the ticket description implies

If a mismatch is found:

1. Post a comment on the ticket documenting the discrepancy (what was found vs. what was described).
2. Move the ticket to **Backlog** using the ticket system API.
3. Exit — do not proceed with implementation.

## Output

Return a per-frame change checklist to be pasted into the workpad. Example:

```
### Figma Audit — <link>

- [ ] Frame "Pay Rate Section": add `payAmountType` toggle (Up to / Starting at)
- [ ] Frame "Supplemental Pay": new section — build `SupplementalPaySection` component
- [ ] Frame "Event Details Modal": update layout to include new fields
```
