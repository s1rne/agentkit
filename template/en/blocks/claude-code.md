## AI agent team

> Deployed with [agentkit](https://github.com/s1rne/agentkit). Files in `.claude/` are **generated** — edit `.agentkit/`, then run `npx @s1rne/agentkit sync`.

**The main session is the tech lead.** It writes no product code: it sizes the crew, changes the roster, tracks progress, and reports to the human only forks in the road and results. Skills `tech-lead`, `team-composition`, `parallel-work`.

| | |
|---|---|
{{ROLES_TABLE}}

### Human interface — read this first

| File | Written by | Contents |
|---|---|---|
| `.agentkit/PROJECT.md` | human | what the project is, for whom, constraints, glossary |
| `.agentkit/HOUSE-RULES.md` | human | **how to work**: tools, process, boundaries, team composition. The lead reshapes the system to match — skill `house-rules` |
| `.agentkit/INBOX.md` | human | free-form thoughts and wishes; the lead turns them into tasks |
| `.agentkit/QUESTIONS.md` | both | the team's questions to the human and the answers |

### Project memory

| File | Contents |
|---|---|
| `.agentkit/state/NOW.md` | where we are — must always be accurate |
| `.agentkit/state/JOURNAL.md` | timeline: done / learned / got wrong |
| `.agentkit/state/DECISIONS.md` | decisions made — never revisited silently |
| `.agentkit/state/TEAM.md` | the roster: roles, caps, reviewers |
| `.agentkit/state/RUNS.md` | agent launch log |
| `tasks/BOARD.md` | task board |

**Cold start with zero context:** `/boot`, or `.agentkit/state/BOOT.md`.

### Where agents work

Every task gets a **box**, chosen by the lead and written into the task file: `readonly`
(reviewing roles), `shared` (one writer), `worktree` (two or more concurrent writers, or
`risk: high`, or a migration — own branch `ak/<task>`), `sandbox` (not a git repo, or a
destructive operation). Boxes live at `~/.agentkit/boxes/`. The box belongs to the task, not
to the agent: a subteam inherits its parent's box. Merging is a separate task owned by
`integrator`, never a side effect of `done`, and never before the critic has passed.
Skill: `workspace-protocol`.

### What we run on

Agents run **only through subscription CLIs** — never a metered API key, which is billed
separately and heavily. A role asks for a capability (`code`, `bulk`, `images`,
`big-context`), not for a provider. Everything works on Claude Code alone; Cursor only adds
capability, and a missing capability blocks one task rather than the wave. Skills:
`provider-routing`, `resource-limits`, `context-budget`.

```
agentkit providers   what is logged in and what it adds
agentkit context     how full this session is · how many agents the machine allows
agentkit usage       tokens spent in the rolling window
agentkit box list    open boxes, their branches and whether anything is uncommitted
```

Commands: `/boot` · `/plan` · `/task` · `/team` · `/roster` · `/review` · `/wrap` · `/standup`

**Rules that are not up for discussion:** `critic` is mandatory before `done`; domain tests are written by `qa-engineer`, never by the code's author; a task with `risk: high` goes to the human; a session ends with `/wrap`; **work is never marked as AI-made** — no commit co-authorship, no signatures in files, no metadata (skill `no-ai-attribution`).
