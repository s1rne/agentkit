---
name: team-composition
description: How the lead sizes the crew — how many instances of which role to launch for a given set of tasks — and how the roster changes: hiring, retiring, adjusting caps. Main session only.
---

# Crew size and roster

- **Crew** — how many instances of which role are running now. Computed per batch, recorded in `RUNS.md`.
- **Roster** — which roles exist at all. Changes rarely, recorded in `.agentkit/state/TEAM.md`.

Both are the lead's call, reported rather than negotiated.

## Part 1. Sizing the crew

Follow the steps; don't eyeball it.

**1. Take the pool.** Tasks that are `todo`, not `blocked`, with criteria filled in.

**2. Pull out the sequential ones.** These run alone: `risk: high`; any schema migration; the first task of a new module — build the reference implementation first, then copy it.

**3. Group the rest by `owner`.**

**4. Within each role, split into non-overlapping `touches` groups.** Two tasks sharing a file form one group.

**5. Instances of a role = number of groups**, capped by the role's ceiling from `TEAM.md`.

**6. Global cap is 5.** Above it, cut by feature priority.

**7. Check coverage.** Every launched task needs a free `critic` at the exit. Not enough — shrink the crew, never skip review.

### Example

Pool of 7. One `risk: high` and one migration are pulled out. Remaining: 3 `backend-dev` tasks (two share a module, one is elsewhere), 2 `reports-dev` tasks with no overlap.

Crew: **2 × `backend-dev`** + **2 × `reports-dev`** = 4. Then critics, then the sequential pair.

## Part 2. Changing the roster

### When to hire

Exactly **one** signal: the same specific work appears in **3+ tasks** and doesn't fit any existing role without distortion.

Not signals: the task is hard (that's decomposition); the task is unusual (the nearest role handles a one-off); the structure would look nicer (a roster isn't decoration — every role costs context and lead attention).

A second source of hiring is the human's rules in `HOUSE-RULES.md` — see the `house-rules` skill.

### How to hire

1. Write `.agentkit/roles/<role>.md` following the existing pattern: what it does, **what it doesn't**, hard rules, the common block.
2. Add a row to `TEAM.md`: status, ownership, cap, reviewer, skills.
3. Needs a new procedure? Write a skill; don't bloat the role definition.
4. Entry in `JOURNAL.md`.
5. Tell the human in one line. Don't ask permission.
6. Run `npx @s1rne/agentkit sync` if the project generates tool configs.

### When to retire

- A role unused for two milestones → `reserve`.
- A role consistently duplicating another → merge it, status `retired`.
- A role whose reports are incoherent → it's too broad; split it.

**Definitions are never deleted.** The status changes, the file stays: a deleted role gets reinvented six months later with the same mistakes.

### Caps

Raise when a role is consistently the bottleneck and its tasks genuinely don't share files. Lower when parallel instances start conflicting or their reports can't be reconciled.

**The cap for any role touching the database schema is always 1.** Two parallel migrations produce an ordering conflict.

## What the lead must know about every role

From `TEAM.md` alone, without opening definitions: what it does, how many instances are allowed, who reviews it, which skills to pass on launch. If that's not answerable, `TEAM.md` is incomplete.
