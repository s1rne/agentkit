---
description: Take a task and run it through the full cycle to review
---

Take task $ARGUMENTS and run the `team-protocol` cycle.

1. Read the task file. Missing `feature` or criteria — stop, call `planner`.
2. Task is `blocked` — don't take it, report what blocks it.
3. Set `status: in_progress` and `owner`.
4. Call the agent named in `owner`. Pass: task file path, criteria, required skills, `touches` boundaries.
5. Domain tests needed — call `qa-engineer` separately. **Never** ask the code's author to write them.
6. Call `critic`. Verdict `revise`/`redo` — return to the author, repeat.
7. `risk: high` — stop and bring it to me for sign-off, regardless of the critic's verdict.
8. Check against `definition-of-done`.
9. Call `scribe` — journal, `NOW`, board.

Report only at decision points and on completion.
