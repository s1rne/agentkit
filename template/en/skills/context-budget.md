---
name: context-budget
description: Context as a measurable budget — how it is measured, the rotation threshold, the report-not-transcript contract, one task per context, and why stability beats brevity in always-loaded files.
---

# Context budget

Context is a **measurable resource**, not a feeling. It is spent whether or not anyone is watching, and the failure mode is silent: an agent doesn't announce that it has started forgetting, it just gets worse.

## How it is measured

An agent's context size is `input + cache_read + cache_creation` of its **last request**. Output tokens are not context; cache reads are — cached material still occupies the window.

Measure it, don't estimate it from message count. A single file read can outweigh an hour of conversation.

## Five rules

**1. The lead never reads an implementer's transcript — only its report.**

The whole point of a subagent is that its exploration burns *its* window, not the lead's. A lead that reads transcripts has merely paid twice for the same tokens and now has less room to coordinate. The contract is `handoff-protocol`: what was built, what wasn't, what's next. Not enough detail in the report? The fix is a better report, never a transcript.

**2. One task must fit in one fresh context.**

The cutting criterion for `planner`: a task that cannot be finished in a fresh context — read what it needs, do the work, write the report — is too big and gets split. This is the same boundary as the six-hour rule in `task-protocol`, measured differently.

A task that forces a rotation mid-flight was mis-cut. Record it as such; the next task like it gets split instead.

**3. State is written to files the moment it is learned.**

Not at session end. A fact learned at 70% of the window and written at 95% is a fact that may never be written at all — the session can end at any point, and everything not in a file dies with it. Formats and destinations: `memory-protocol`.

**4. The lead rotates at ~60% of the window.**

Rotation is `wrap` → `boot`: write state, end the session, restore from files. **At 60%, not at the point where answers get worse** — by then the session is already producing the reasoning you'll have to redo, and it no longer has the room to write a good handoff.

Rotating early costs one wrap. Rotating late costs the session's undocumented knowledge.

**5. Stability beats brevity in always-loaded files.**

Project context, role definitions and always-on skills are prompt-cached. **Churn invalidates the cache, and every later run in that window pays the full uncached price.**

Consequences:

- Don't reword an always-loaded file cosmetically. A better sentence is not worth the fleet-wide re-charge.
- Batch edits to these files: one edit before a wave, not five during it.
- Keep volatile material — `NOW.md`, `RUNS.md`, the board — **out** of the always-loaded set. Load it on demand.
- A slightly longer file that never changes is cheaper than a shorter one edited daily.

## Where the budget actually goes

| Spender | Fix |
|---|---|
| Whole files read for one function | search, then read the range |
| Command output pasted in full | filter at the source |
| Re-reading what's already in the window | it hasn't fallen out; check before re-reading |
| A subagent's exploration in the lead's window | rule 1 |
| Restating the plan every turn | it's in the task file |

## Signs the budget is blown

The agent asks something it was told twenty minutes ago. The lead can no longer say who is running what. Reports arrive shorter as the session goes on — the window is being conserved by dropping exactly the part that was supposed to survive. A session ends with nothing written to files.
