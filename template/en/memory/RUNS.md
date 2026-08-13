# RUNS — agent launch log

Who, when, on what, in which box, and how it ended. Rows are appended automatically by
`agentkit run`; the lead adds the ones it ran by hand. The full transcript of a run stays
in `.agentkit/state/runs/<id>.jsonl` — this file is the index, not the record.

Why: the only way to answer "what is actually going on" and "why is this task on its third
attempt" without reading transcripts. The human reads this to gauge load.

Newest entries **on top**. `outcome` is `done` / `failed` / `killed` / `deferred` / `blocked` /
`refused`. Failures are recorded exactly like successes — one `blocked` row with a reason is
worth more than three `done`.

| Date | Role | Task | Provider · box | Outcome | Tokens |
|---|---|---|---|---|---|
| — | — | — | — | — | — |
