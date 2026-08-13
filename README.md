# agentkit

[English](README.md) · [Русский](README.ru.md)

A team of AI agents, project memory and engineering process — deployed into any repository with one command.

```bash
npx @s1rne/agentkit init
```

Works with **Claude Code**, **Cursor**, and any tool that reads `AGENTS.md` (Codex and compatible).

Any package manager:

```bash
npx @s1rne/agentkit init          # npm
pnpm dlx @s1rne/agentkit init     # pnpm
yarn dlx @s1rne/agentkit init     # yarn
bunx @s1rne/agentkit init         # bun
```

Everything the kit installs — roles, protocols, prompts, memory templates — is **English by default**: fewer tokens per session and better model comprehension. Russian is one flag away:

```bash
npx @s1rne/agentkit init --lang ru
```

The language is stored in `config.json`; later commands pick it up without repeating the flag.

---

## Why

Three things break most often when building software with AI agents. This kit solves them structurally, not with advice.

**Context is lost.** A new session doesn't know what's done, what was abandoned, or why. → Memory lives in files, not in the session. A cold-start procedure brings the project back from zero.

**The agent grades its own homework.** It wrote the code and wrote the test — it verified its own understanding of the task, not the task. → Domain tests are written by a different role. Review is adversarial: the critic hunts for defects rather than approving.

**Nobody is in charge.** Agents write code, but no one decides who does what and in what order. → The main session acts as tech lead: it sizes the crew, tracks progress, and shields the human from noise.

---

## What gets installed

```
.agentkit/
  PROJECT.md          ← written by human: what the project is, for whom, glossary
  HOUSE-RULES.md      ← written by human: how to work on this project
  INBOX.md            ← written by human: free-form thoughts
  QUESTIONS.md        ← team asks, human answers
  roles/              13 roles
  skills/             11 protocols
  commands/           8 commands
  blocks/             text of the managed blocks written into CLAUDE.md / AGENTS.md
  state/              memory: BOOT · NOW · JOURNAL · DECISIONS · TEAM · RUNS
  config.json
tasks/                epics → features → tasks
docs/adr/             architecture decision records

.claude/ · .cursor/ · AGENTS.md   ← generated, no need to edit
```

---

## The human interface

Four files through which a human steers the team without reading its output.

**`PROJECT.md`** — what agents can't learn from the code: what the product is, who the user is, constraints, domain glossary.

**`HOUSE-RULES.md`** — the important one. Here the human writes, in plain words, *how* to work:

```markdown
## Tools
- Tasks live in Trello, board "Development".

## Boundaries
- Don't touch legacy/ — another team owns it.
- Only humans edit the DB schema.

## Communication
- Don't report intermediate steps, only decision points and results.
```

**The lead reconfigures the system to match these rules on its own.** Told "tasks in Trello", it classifies that as an external tool, creates a sync role, adds the call to the task protocol, asks for the missing credentials in `QUESTIONS.md`, and reports back in one line. It does not ask permission for each step.

When a human rule contradicts a system rule, **the human wins** — but the lead names the consequence once. When a rule is unsafe, it refuses and proposes a working alternative.

**`INBOX.md`** — free-form notes; the lead turns them into tasks.

**`QUESTIONS.md`** — the team asks, the human answers inline. The governing rule: *an invented domain rule costs more than a missing one* — if you don't know, ask and block the task.

---

## The team

| | |
|---|---|
| Planning | `planner` · `architect` · `domain-analyst` |
| Building | `backend-dev` · `frontend-dev` · `mobile-dev` · `data-engineer` · `reports-dev` · `integrations-dev` |
| Quality | `qa-engineer` · `critic` · `security-auditor` |
| Memory | `scribe` |

**A role is a job title, not a person.** One `backend-dev` can run as three instances across three tasks. How many is computed by the lead with an algorithm, not by feel: take the `todo` pool, pull out risky work and migrations, group by owner, split each role by non-overlapping `touches`, cap by the role's ceiling and by a global limit of 5.

The roster changes dynamically. There is exactly one criterion for hiring a new role: **the same specific work appears in 3+ tasks** and doesn't fit any existing role. Role definitions are never deleted — the status changes, the file stays.

---

## Task lifecycle

```
planner      → task with verifiable criteria         todo
implementer  → takes it, builds, submits a report    in_progress → review
qa-engineer  → tests (domain ones always by them)
critic       → adversarial review
[risk: high] → human
scribe       → journal, NOW, board                   done
```

Skipping the critic is not allowed. A review with no findings is a legitimate outcome; no review is not.

---

## Commands

| | |
|---|---|
| `/boot` | cold start: rebuild context from zero and report where we are |
| `/plan` | break work into features and tasks |
| `/task` | run a task through the full cycle |
| `/team` | launch several agents in parallel |
| `/roster` | team roster and computed crew size |
| `/review` | adversarial review |
| `/wrap` | record state for the next session |
| `/standup` | status summary, no changes |

---

## CLI

```bash
npx @s1rne/agentkit init --pack web-product --adapters claude-code,cursor --lang en
npx @s1rne/agentkit sync        # regenerate tool configs from .agentkit/
npx @s1rne/agentkit doctor      # check integrity
npx @s1rne/agentkit status      # roster and current state
npx @s1rne/agentkit role cap backend-dev 4
```

Packs: `base` (6 roles) · `web-product` (10) · `full` (13). Languages: `en` (default) · `ru`.

**Edit `.agentkit/`, not the generated `.claude/` and `.cursor/`** — `sync` overwrites those.

---

## Portability

| | Claude Code | Cursor | AGENTS.md |
|---|---|---|---|
| Memory, tasks, protocols | ✓ | ✓ | ✓ |
| Roles | subagents, isolated context | invocable templates | invocable templates |
| Parallel execution | ✓ | — | — |
| Slash commands | ✓ | partial | — |

Memory deliberately lives in `.agentkit/state/` rather than inside a tool's folder: moving from Claude Code to Cursor doesn't lose project history. For the same reason observability is a protocol (`RUNS.md`) rather than hooks — hooks don't port, files do.

---

## Principles

1. State lives in files, not in the session context.
2. Agents communicate through task files and the journal, not chat: asynchronous handoff survives a restart.
3. The critic is mandatory.
4. The author of the code does not write the tests for their own domain calculations.
5. An invented domain rule costs more than a missing one.
6. The main session is a lead, not an implementer.
7. A session ends by recording state. What isn't recorded doesn't exist for the next session.
8. Work is never marked as AI-made — not in commits, not in files, not in metadata.

---

## Roadmap

- Generate `TEAM.md` from `config.json` instead of maintaining it by hand.
- More languages: the content is fully parameterised, a language is a directory under `template/`.
- Validate the core on a real project and remove whatever turns out to be ceremony.

## Status

`0.2.0` — early. The structure is complete and tested, but the core has not yet been proven by shipping a real product with it. Expect the protocols to shrink once they meet actual work.

## License

MIT
