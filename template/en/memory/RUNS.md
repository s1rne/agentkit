# RUNS — agent launch log

Who, when, on what, and how it ended. Maintained by the tech lead: an entry opens **before** launch and closes **after**.

Why: the only way to answer "what is actually going on" and "why is this task on its third attempt" without access to agent internals. The human reads this to gauge load without wading through every report.

Newest entries **on top**. `mode` is `single` or `parallel N/M`. `outcome` is `done` / `partial` / `blocked` / `returned` / `cancelled`.

Failures are recorded exactly like successes. One `returned` entry with a reason is worth more than three `done`.

| Date | Agent | Task | Mode | Outcome |
|---|---|---|---|---|
| — | — | — | — | — |
