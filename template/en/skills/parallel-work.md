---
name: parallel-work
description: How to safely run several agents at once — conditions, avoiding file conflicts, collecting results, settling disputes. For the tech lead.
---

# Parallel work

## When it's allowed

Only if **all** conditions hold:

1. **`touches` sets don't overlap.** The decisive one: two agents editing the same file will overwrite each other.
2. **No dependency on each other's results.**
3. **No shared migration.**
4. **No task is `risk: high`.**

Any condition failing means sequential.

## How many

Computed by the `team-composition` algorithm; per-role caps live in `TEAM.md`. The global cap is **5**: beyond that nothing speeds up, because results must be stitched by hand and the lead loses track. The machine imposes a second, independent cap — RAM, disk and load, printed by `agentkit context`. **The lower of the two always wins**; see `resource-limits`.

## How to launch

All parallel calls **in a single message**, otherwise they run sequentially.

Each agent receives: the path to its task file; its `touches` with an explicit ban on going outside; which skills to load; the requirement to hand off via `handoff-protocol`.

Boundary wording: "edit only files inside `touches`. Need something outside? Stop and write it in the Questions section — don't edit."

## Collecting results

1. Wait for all.
2. Merge reports: done, not done, found along the way.
3. Verify nobody went outside their boundaries.
4. Run `critic` on each task — also in parallel.
5. Merge findings.
6. Record in `RUNS.md`, call `scribe`.

## Settling disputes

Two agents proposed incompatible solutions — **don't pick one yourself**. Call `architect` and hand over both. An architecture dispute is settled by the architect, not by whoever finished first.

## When parallelism hurts

- Poorly specified tasks — parallelism multiplies the misunderstanding by the number of agents.
- Unclear domain — you get several different wrong readings instead of one.
- The project's first module — build the reference sequentially, then copy it in parallel.
