# Task system

Three levels, as in an engineering team. All files in git: a board in someone else's SaaS doesn't survive context loss and isn't reachable by an agent.

```
Epic (E-xx)        a major block, weeks-months       tasks/epics/
  └─ Feature (F-xxx)  shippable value, days           tasks/features/
       └─ Task (T-xxxx)  one agent's work, hours      tasks/tasks/
```

Closed tasks move to `tasks/done/`.

## Rules

1. **A task is only picked up with a link to a feature**, a feature to an epic. An orphan task means the wrong work is happening.
2. **Features have verifiable acceptance criteria.** "Convenient" is not a criterion.
3. **Status lives in frontmatter**; the board is generated from it. Never edit the board by hand.
4. **Done ≠ code written.** See `definition-of-done`.
5. **`in_progress` over a day means abandoned** — back to `todo`, reason in the journal.

## Statuses

`todo` · `blocked` (`blocked_by` says on what) · `in_progress` (`owner` says who) · `review` · `done`

Task file format: `task-protocol` skill.

## Numbering

Sequential, never reused. The next free id is in `BOARD.md`.
