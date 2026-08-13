---
description: Show or change the team — roster and current crew
---

Per `tech-lead` and `team-composition`.

**No arguments** — report:
- roster from `.agentkit/state/TEAM.md`: active, reserve, retired;
- current crew from `RUNS.md`;
- **the computed crew** for the current `todo` pool: how many instances of which role, and why;
- bottlenecks: roles at their cap, tasks with no free critic.

**With arguments** ($ARGUMENTS) — change the roster.

When hiring:
1. Check the signal: the same work in 3+ tasks, unfit for existing roles. Not met — say so and propose an existing role.
2. Write `.agentkit/roles/<role>.md` following the existing pattern.
3. Add it to `TEAM.md`, update `.agentkit/config.json`.
4. Needs a new procedure — write a skill, don't bloat the role.
5. Entry in `JOURNAL.md`, then `npx @s1rne/agentkit sync`.
6. Report in one line: who was hired and why.
