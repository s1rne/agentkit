---
name: workspace-protocol
description: How a workspace (box) is chosen, created, used and closed — the four modes, who gets which, the box-belongs-to-the-task rule, subteam inheritance, and the merge order.
---

# Boxes: where a task actually runs

A **box** is the workspace of a task: the directory an agent reads and writes in, plus the branch it commits to, if any.

Boxes live **outside the repository**: `~/.agentkit/boxes/<repo>/<task-id>`. A workspace kept inside the repo gets committed, indexed and linted by the very run it was supposed to be isolated from.

## Four modes

| Mode | When | Who |
|---|---|---|
| `readonly` | the product tree will not be written to | `critic`, `security-auditor`, `architect`, `domain-analyst`, `planner` — they read code and write only under `.agentkit/`: tasks, ADRs, memory |
| `shared` | exactly one writer on this repo right now | the default. Cheapest: the repo itself, no branch, no copy |
| `worktree` | two or more concurrent writers, or `risk: high`, or a migration or mass rewrite | own git worktree on branch `ak/<task-id>` |
| `sandbox` | the operation is destructive, or isolation is needed and there is no git | a copy of the working tree; nothing lands without a human |

Tie-breaks, in order: the role doesn't touch the product tree → `readonly`. Anything in the `worktree` row → `worktree`, and with no git that becomes `sandbox`. Otherwise `shared`.

**Without git, a single writer still works in `shared`** — a copy for every ordinary task would make the tool unusable — but the run says so plainly, because there is no undo. The fix is `git init`, not a bigger warning.

`shared` is not a way to run two writers cheaply. Two writers means `worktree`, even when their `touches` don't overlap — see `parallel-work`.

## The box belongs to the task, not to the agent

One task, one box, whoever is working in it. Consequences:

- `qa-engineer` and `critic` inspect the **same** box the implementer used, not a fresh checkout. Reviewing a different tree than the one that was built is a review of nothing.
- A subteam **inherits its parent task's box**. It does not create one.
- A subteam that genuinely needs its own workspace is not a subteam — the parent creates a **subtask**, and the subtask gets a box of its own.
- **Nesting depth is capped at 2.** Beyond that nobody can say which tree a change is in, and the lead loses the ability to answer "where does this code live right now".

## Merge order

`implementation` → `qa-engineer` → `critic` → `integration` → `done`.

**Merging is a separate task, never a side effect of `done`.** Nothing is merged before the critic has passed. The merge is done by `integrator`, which is also the only role permitted to resolve a conflict between two agents' work. `risk: high` merges go to the human.

## The report

Every agent that worked in a box states, in the report section required by `handoff-protocol`:

- **mode** — `readonly` / `shared` / `worktree` / `sandbox`;
- **branch** — `ak/<task-id>`, or "none" for `shared` and `readonly`;
- **uncommitted** — whether anything is left uncommitted in the box, and what. "Nothing" is an answer; silence is not.

A box with uncommitted changes is never closed, garbage-collected or reused. Unreported leftovers are how work disappears.

## Closing a box

1. Checks green in the box itself.
2. Everything committed, or explicitly listed as left behind and why.
3. `critic` passed → the integration task merges `ak/<task-id>` into the base branch.
4. The branch is deleted only after it is fully merged. A branch with unmerged commits stays, and so does its box.
5. Merged and empty → the box is garbage-collected; see `resource-limits`.

## No git in the project

Degrade, don't improvise:

- tasks that need isolation run in `sandbox` mode, on a copy of the working tree;
- **only one writer at a time** — without branches there is nothing to merge conflicting work into;
- integration becomes a reviewed patch a **human** applies to the real tree;
- the lead states this in the run report, because the whole team is now serialized and the plan must reflect it.

Setting up version control is a task for the human, not something an agent does on the side.
