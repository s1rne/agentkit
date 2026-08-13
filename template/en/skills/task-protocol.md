---
name: task-protocol
description: How to create, claim, run and close tasks — frontmatter format, statuses, task file sections, decomposition rules, good vs bad acceptance criteria.
---

# Working with tasks

Three levels: epic `E-xx` → feature `F-xxx` → task `T-xxxx`. All as files in git: a board in someone else's SaaS doesn't survive context loss and isn't reachable by an agent.

## Task file

```markdown
---
id: T-0042
title: Short name
feature: F-003
epic: E-01
status: todo          # todo | blocked | in_progress | review | done
owner: backend-dev
reviewer: critic
estimate: 4h
blocked_by: null
touches: [path/one, path/two]
risk: high            # high — a human must review
---

## Why
Which pain it closes. Link to the requirement source.

## Acceptance criteria
- [ ] A verifiable statement, not a wish

## How to verify
Command or steps.

## Progress
Implementer's log.

## Questions
@role: … — for other agents and the human

## Report
Per the `handoff-protocol` skill.
```

## Rules

1. **The owner changes status**, except `critic`, who may send it back from `review`.
2. **`in_progress` over a day means abandoned.** Back to `todo`, reason in the journal.
3. **The implementer never edits the criteria.** If they turned out wrong, ask `planner` — don't reshape them around what got built.
4. **A task over 6 hours gets split.** Discover it mid-flight? Stop.
5. **`done` only after `definition-of-done`.**
6. **A task without a feature link isn't picked up** — it signals the wrong work.

## Criteria: bad and good

| Bad | Good |
|---|---|
| The UI is convenient | The action completes in ≤5 steps with no scrolling |
| Works offline | With the network off the operation saves locally and syncs on reconnect; a retry creates no duplicate |
| Fast | p95 < 1s at 200 concurrent users |
| Calculates correctly | Output matches the customer's 12 reference examples |
