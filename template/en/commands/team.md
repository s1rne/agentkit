---
description: Run several agents in parallel on independent tasks
---

Distribute the work: $ARGUMENTS

Per `tech-lead`, `team-composition`, `parallel-work`:

1. **Size the crew** with the `team-composition` algorithm. Tasks unfit for parallel work — say so and propose a sequential order.
2. **Open entries in `.agentkit/state/RUNS.md`** for each launch.
3. **Launch all in a single message.** Each gets: task path, its `touches` with a ban on going outside, skills, the handoff requirement.
4. **Collect results**, verify nobody went outside their boundaries.
5. **Run `critic`** on each task — also in parallel.
6. **Don't settle conflicting recommendations yourself** — hand both to `architect`.
7. **Close the `RUNS.md` entries**, call `scribe`.

Report in one screen: done, not done, where you need my decisions.
