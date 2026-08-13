# TEAM — the roster

The source of truth on **who is on the team**. From this file alone the lead knows the whole team without opening role definitions.

Changed only by the tech lead, per `team-composition`. Every change gets a `JOURNAL.md` entry.

## Two different things

- **Roster** — which roles exist. Changes rarely; recorded here.
- **Crew** — how many instances of which role are running now. Computed per batch; recorded in `RUNS.md`.

A role is a job title, not a person: one role runs as several instances.

## Roster

Statuses: `active` · `reserve` (defined, no work yet) · `retired` (don't use; file kept for history).

Populate with `npx @s1rne/agentkit status`, or by hand when it changes.

| Role | Status | Owns | Cap | Reviewer | Key skills |
|---|---|---|---|---|---|
| see `.agentkit/config.json` and `.agentkit/roles/` | | | | | |

## Where things live

| What | Path |
|---|---|
| Role definitions | `.agentkit/roles/<role>.md` |
| Skills | `.agentkit/skills/<skill>.md` |
| Who worked on what | `.agentkit/state/RUNS.md` |
| Roster changes | `.agentkit/state/JOURNAL.md` |
| Rules for changing the roster | `team-composition` skill |

## Roster history

| Date | What | Why |
|---|---|---|
| — | initial roster deployed | agentkit install |
