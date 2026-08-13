---
name: resource-limits
description: How the fleet stays a good citizen on the machine — the admission check before every spawn, per-agent memory and time ceilings, the watchdog, box garbage collection, and how a refusal is reported.
---

# Machine limits

**The human's machine must stay usable while the fleet runs.** Their editor, browser and build are the workload; the agents are guests. A plan that needs the whole machine is not a plan.

Limits are measured, not assumed. A reference machine: 14 cores, 36 GB RAM. An idle headless process sits at 210–400 MB, but a **real agent run peaked at 1.4–1.5 GB RSS** — the tree includes the tools it spawns. So a new agent is assumed to need **1.2 GB**, and the estimate came from a measurement, not from the idle figure.

## Admission check — before every spawn

Every one of these must pass. The first failure refuses the spawn and names itself.

| Check | Refuse when |
|---|---|
| Concurrency | running agents ≥ the computed cap |
| RAM | available minus the reserve (**6 GB**) won't cover one more agent at ~1.2 GB |
| Disk | free space below the reserve (**20 GB**) |
| Load | 1-minute load per core above **1.5** |

**Cap** = min(RAM headroom ÷ 1.2 GB, performance cores − 2, **8**). Efficiency cores run an agent, but slowly enough to skew the plan, so they don't count. Two performance cores stay with the human and the orchestrator. Eight is absolute: past it the provider, not the machine, is the bottleneck.

The lead's own planning ceiling from `parallel-work` is stricter and also applies. **The lower of the two always wins**, and neither is ever raised to fit an impatient plan.

## A refusal is an answer, not a queue

A refused spawn returns **a reason a human can act on** — which limit, what the current value is, what it needs to be — plus a sensible retry interval. What it never does is sit in a queue forever while the lead reports "in progress".

The lead's options are: run fewer agents, wait for the named resource, or tell the human what to close. Not: retry in a tight loop; not: raise the ceiling because the queue is long.

## Per-agent ceilings and the watchdog

Every agent runs under a watchdog that samples its **whole process tree** — an agent's children hold most of the memory.

- **RSS ceiling: 3000 MB** for the tree — twice the measured peak, so a normal run is never killed and a leak still is. Above it, the tree is killed.
- **Wall clock: 20 minutes.** Above it, the tree is killed.
- Kill order: children first, so a parent cannot respawn them on the way down. `SIGTERM`, then `SIGKILL` if it is still alive five seconds later.
- The watchdog never keeps the orchestrator alive by itself, and never becomes the reason a finished run hangs.

A killed agent's task goes back to `todo` **with the reason and the peak numbers recorded**. It never silently disappears, and it is not restarted unchanged: a task that hit the ceiling twice is too large and goes back to `planner` (see `task-protocol` — a task over six hours gets split).

## Boxes are garbage-collected

Each `worktree` or `sandbox` box is a full checkout. A few dozen of them fill a disk, and a full disk fails every agent at once, including the ones doing fine.

Collected: boxes whose task is `done` and whose branch is fully merged.
Never collected: a box with uncommitted changes, a box whose branch has unmerged commits, a box belonging to a running task. See `workspace-protocol`.

Disk below the reserve → collect first, then report what could not be collected and why. Deleting unmerged work to free space is never the answer.

## What the lead does with this

Capacity is an **input to crew size**, not something discovered after launching. Before a wave: compute the crew per `team-composition`, take the machine cap, run with the lower number. If the difference matters — five useful groups of tasks, room for three — say so in one line to the human along with what would raise it.

Never report a wave as running when part of it was refused admission. A refused spawn is a task that hasn't started.

## Signs the limits are being ignored

The machine is unusable while a wave runs. Agents are killed on the clock rather than finishing. The disk fills with boxes of tasks closed weeks ago. The lead reports a task as running when it was actually refused admission and nobody noticed.
