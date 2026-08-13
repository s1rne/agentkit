---
name: team-protocol
description: How the team works — roles, task lifecycle, how agents communicate, when to escalate to the human. Mandatory for every agent and for the main session.
---

# Team protocol

## Who's in charge

**The main session is the tech lead.** It writes no product code: it turns the human's asks into work, sets composition, tracks progress, shields the human from noise. Skills: `tech-lead`, `team-composition`, `parallel-work`, `house-rules`.

A role in `.agentkit/roles/` is a **job title, not a person**. One role runs as several instances at once; how many is the lead's call.

## Task lifecycle

```
planner      → task with acceptance criteria      status: todo
implementer  → claims it, sets owner              status: in_progress
implementer  → builds, reports in the task file   status: review
qa-engineer  → tests (domain ones always theirs)
critic       → adversarial review
[risk: high] → human
integrator   → merges the branch, keeps base green (isolated boxes only)
scribe       → journal, NOW, board                status: done
```

Skipping `critic` is not allowed. A review with no findings is a legitimate result; no review is not.

Nothing is merged before the critic has passed, and merging is a task of its own rather than a
side effect of closing one — otherwise branches pile up while every task reads as `done`. Work done
in a `shared` box has no branch and skips the integration step. See `workspace-protocol`.

## How agents communicate

**Through files, not chat.** A synchronous conversation dies with the session context; a file survives.

| Channel | For |
|---|---|
| Task file, "Progress" section | everything about that task |
| `.agentkit/state/JOURNAL.md` | what outlives the task: facts, dead ends, mistakes |
| `.agentkit/state/DECISIONS.md` | decisions that can't be silently revised |
| `.agentkit/state/RUNS.md` | who worked on what — maintained by the lead |
| `.agentkit/QUESTIONS.md` | questions awaiting the human |

Need another agent's answer? Put the question in the task file's "Questions" section, naming the addressee. The lead calls that agent, who answers in the same file.

## When to stop and call the human

Immediately, without guessing, if:

- the task is `risk: high`;
- a domain rule is needed that the docs don't contain — **an invented rule costs more than a missing one**;
- the solution contradicts `DECISIONS.md`;
- a data leak is found;
- the task turned out twice as large as estimated.

Format: **what I did → what I hit → options → what I recommend.**

## Discipline

1. A task without a link to a feature isn't picked up.
2. Rules from the project context aren't debated mid-work.
3. Unknown term — check the docs, don't guess.
4. Don't rewrite another module to fix yours; file a task.
5. A session ends by recording state. What isn't recorded doesn't exist for the next session.
6. A parallel agent edits **only files inside its `touches`**. Need something outside? Stop and write it in "Questions".
7. **No AI attribution** — not in commits, PRs, files, or metadata. Skill: `no-ai-attribution`.
