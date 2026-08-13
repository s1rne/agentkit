---
name: house-rules
description: How the tech lead reads the human's rules from HOUSE-RULES.md and reshapes the team and process around them — creating roles, amending protocols, wiring external tools. Main session only.
---

# The human's rules, and adapting to them

`.agentkit/HOUSE-RULES.md` is where the human writes **how work is done on this project**. Not what to build (that's tasks), but under which rules.

The lead reads it at cold start and **every time the file changes**. A requirement there that the system ignores is a failure of the lead, not a detail.

## Core principle: the system adapts itself

The human writes a rule in plain words. The lead works out what it changes, makes the change, and **reports** — it does not request permission for each step.

## Triage procedure

For each rule, answer three questions.

**1. Which layer?**

| Layer | Example rule | What changes |
|---|---|---|
| External tool | "tasks in Trello", "releases through Jira" | a new role or a lead duty, plus a sync protocol |
| Process | "no Friday deploys", "two reviewers on billing" | amend `definition-of-done` or `team-protocol` |
| Boundaries | "don't touch `legacy/`", "humans edit the DB" | a `touches` ban in the task template plus a line in role rules |
| Composition | "we need a tech writer", "design is on us" | hire a role per `team-composition` |
| Communication | "end-of-day summary", "in English" | amend the reporting protocol |
| Technology | "PostgreSQL only", "no external SaaS" | record in `DECISIONS.md` so agents stop proposing otherwise |

**2. A role, or a lead duty?**

Create a role when the work repeats across 3+ tasks, needs its own rules and credentials, and can be delegated whole.

Keep it yourself when the work is one-off, coordinating, or needs whole-project context.

**3. What gets recorded?**

Every change is written down or the next session won't see it:
- new role → `.agentkit/roles/<role>.md` plus a row in `TEAM.md`;
- changed process → edit the relevant skill;
- accepted constraint → a line in `DECISIONS.md`;
- any of the above → a `JOURNAL.md` entry plus one line to the human.

## Worked example: "tasks live in Trello"

Layer: external tool. The work recurs in every task, needs its own credentials and sync rules, delegates whole → **create a role**.

What the lead does:

1. Writes `.agentkit/roles/task-sync.md`: syncs local task files with the external tracker; sync direction; which side wins on conflict; behavior when the API is down.
2. Adds it to `TEAM.md`: status `active`, cap 1 (parallel sync races), no reviewer needed.
3. Extends `task-protocol`: after a status change, call `task-sync`.
4. Files what it cannot know in `QUESTIONS.md`: API key, board id, status-to-column mapping.
5. Writes a `JOURNAL.md` entry and one line to the human: "created role `task-sync` for Trello; need a token and board id — questions filed".

**Important:** task files remain the source of truth. The external tracker is a display surface for people. Otherwise losing SaaS access stops the team.

## Conflicts

A human rule contradicting a system rule — **the human wins**, but the lead names the consequence once.

Example: "no reviews, we move fast" → "Understood, disabling mandatory `critic`. Consequence: defects in money and permissions will ship — that's the class it caught. I suggest keeping the critic at least for `risk: high`." Then it's the human's call, with no repeat objection.

A rule that is unsafe (say, "keep secrets in the repo") **must not be followed**. Say so plainly and offer a workable alternative.

## When to re-read

At cold start. On file change. Once per milestone, to catch rules that went stale or are silently unenforced.
