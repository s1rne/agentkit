## AI agent team

Deployed with agentkit. Process rules live in `.agentkit/skills/`, roles in `.agentkit/roles/`.

### Roles

{{ROLES_LIST}}

There are no subagents here: to work in a role, read `.agentkit/roles/<role>.md` and follow its rules. Tasks run sequentially.

### Human interface — read this first

- `.agentkit/PROJECT.md` — what the project is, for whom, glossary (written by the human)
- `.agentkit/HOUSE-RULES.md` — **how to work**: tools, process, boundaries. The system adapts itself to these rules
- `.agentkit/INBOX.md` — the human's free-form wishes
- `.agentkit/QUESTIONS.md` — the team's questions to the human and the answers

### Project memory

- `.agentkit/state/NOW.md` — where we are
- `.agentkit/state/JOURNAL.md` — timeline: done / learned / got wrong
- `.agentkit/state/DECISIONS.md` — decisions made, never revisited silently
- `.agentkit/state/TEAM.md` — the roster
- `tasks/BOARD.md` — task board

Cold start with zero context: `.agentkit/state/BOOT.md`.

### Where agents work, and on what

Every task gets a box — `readonly`, `shared`, `worktree` or `sandbox` — chosen by the lead and
recorded in the task file; see `.agentkit/skills/workspace-protocol.md`. Merging is a separate
task and never precedes the critic. Agents run only through subscription CLIs, never a metered
API key; a role asks for a capability, not a provider. Everything works on Claude Code alone.
See `provider-routing`, `resource-limits`, `context-budget`.

### Rules that are not up for discussion

A critic's review is mandatory before a task is closed. Tests for domain calculations are written by someone other than the code's author. A task with `risk: high` goes to the human. A session ends by writing state into `NOW.md` and `JOURNAL.md`. **Work is never marked as AI-made** — no commit co-authorship, no signatures in files, no metadata: see `.agentkit/skills/no-ai-attribution.md`.
