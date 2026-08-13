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

## Running agents

Agents run **only through the vendors' subscription CLIs** — `claude` and `cursor-agent`. Never through a metered API key: that path is billed separately and per token. The orchestrator strips `ANTHROPIC_API_KEY`, `CURSOR_API_KEY` and friends from every child process, and `doctor` fails if one is set in your shell. Two accounts of the same vendor are separated by `CLAUDE_CONFIG_DIR` / `CURSOR_CONFIG_DIR`, not by keys.

A role asks for a **capability**, not a provider — `code`, `bulk`, `images`, `big-context`, `plan-mode`, `worktree`, `parallel`. The router picks among providers that are actually logged in.

```bash
agentkit providers      # who is available and what each adds
agentkit run T-0042 --role backend-dev --writers 2
agentkit context        # how full this session is · how many agents the machine allows
agentkit usage          # tokens spent in the rolling window
agentkit box list       # open boxes, branches, uncommitted work
```

**Everything works on Claude Code alone.** Cursor only adds capability. A capability nobody has blocks *one task* — recorded with the exact command that would fix it — and never stops the wave.

## Running the whole queue

```bash
agentkit wave                 # takes ready tasks and carries each one end to end
agentkit wave --conc 2 --max 8
```

Per task: implementer → critic → for `risk: high` a second, differently-tasked reviewer (`security-auditor`) → merge → the project's own checks on the base branch. A merge that turns the base branch red is reverted immediately, because one bad merge is cheaper to unpick than ten.

It stops for a human only where a machine honestly cannot decide: a conflict of intent in code (not history, not a lockfile — those it resolves), a review that has not converged in three passes, a base branch that fails its own checks. Everything else is the runner's job, not yours.

What it verifies after each merge is yours to set, in `.agentkit/providers.json`:

```json
"wave": { "verify": ["pnpm -s typecheck", "pnpm -s lint", "pnpm -s test"], "outputBudget": 4000000 }
```

## Seeing what the team is doing

```bash
agentkit team            # one screen: who is running, on what, at what cost
agentkit team --watch    # the same, refreshing every 3 seconds
agentkit team T-0019     # one agent in detail: elapsed, memory, tokens, last verdict
```

It reads only what is already on disk — the active-run registry, finished run records, task frontmatter — so polling it is free and starts nothing.

## Adopting a project that already has agents

`init` writes the kit's templates over `.claude/`. A project that already built its own team — its own roles, in its own language, with its own domain rules — would lose them. `adopt` goes the other way:

```bash
npx @s1rne/agentkit adopt --lang ru
```

It backs up `.claude/` untouched, makes the existing agents, skills, commands and memory the **source** in `.agentkit/`, adds only what the project did not already have, and regenerates `.claude/` from that. Existing definitions come through byte for byte.

## Two accounts of the same vendor

Two subscriptions are two logins, never two API keys. Adding one:

```bash
agentkit account add cursor work
# prints the exact login command for that account, then:
agentkit account list
```

What separates the logins differs by vendor, and it was measured rather than assumed:

| Vendor | Separated by | Evidence |
|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` | an empty config dir reports `loggedIn: false` |
| Cursor | `HOME` | an empty `CURSOR_CONFIG_DIR` still reports the **same** user — the token lives in the system keychain, which is found through `HOME` |

`account add` sets up whichever one actually works. **Check it took effect with `account list`: two rows showing the same address mean the isolation did not happen**, and the kit marks them as one login rather than pretending it has two.

Work goes to whichever login has spent the least in the current subscription window — not round-robin, because one task can cost ten times another. A run that comes back rate-limited or unauthenticated puts that login to rest for the window and retries once on another; never in a loop.

## Where agents work

Every task gets a **box**, chosen by the lead and written into the task file:

| Mode | When |
|---|---|
| `readonly` | reviewing roles — no write tools at all |
| `shared` | exactly one writer, ordinary task: no branch, no merge |
| `worktree` | two or more concurrent writers, `risk: high`, or a migration — own branch `ak/<task>` |
| `sandbox` | not a git repository, or a destructive operation |

Two concurrent writers in one directory collide over the git index, the build output and the test run — not just over file lines. That is why the threshold is "two writers", not "overlapping files".

Boxes live outside the repo at `~/.agentkit/boxes/<repo>/<task>`. The box belongs to the **task**, not the agent: a subteam inherits its parent's box, and nesting is capped at depth 2. Merging is a separate task owned by `integrator`, never a side effect of `done`, and never before the critic has passed.

## Staying off your machine's back

The fleet must not make the computer unusable. Before every spawn there is an admission check — RAM headroom, disk headroom, load per core, concurrency cap — and a refusal comes back with an actionable reason instead of a silent queue. During a run a watchdog samples the process tree and kills anything past its RSS ceiling or wall clock.

Defaults reserve 6 GB of RAM and 20 GB of disk for you, cap concurrency at performance-cores-minus-two (8 at most), assume 1.2 GB per agent — a figure taken from a real run that peaked at 1.4 GB, not from an idle process, and give each agent 3 GB RSS and 20 minutes. All of it is in `.agentkit/providers.json`.

## Context as a budget

Long sessions degrade. The kit treats that as a measurable quantity, not a feeling: a session's context size is `input + cache_read + cache_creation` of its last request, and `agentkit context` prints it.

- The lead never reads an implementer's transcript — only its report. The transcript goes to `.agentkit/state/runs/`.
- One task must fit in one fresh context. If it does not, it is cut wrong.
- State is written the moment it is learned, not at session end.
- The lead rotates the session at ~60% of the window, by wrap → boot, rather than waiting to degrade.
- Stability beats brevity: churn in always-loaded files invalidates the prompt cache and every later run pays full price.

The kit itself costs about **2 000 tokens** at session start; the remaining ~15 000 load only on demand.

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

- Verified Cursor stream parsing (its schema is currently handled defensively — nobody has logged in yet to confirm it).
- Generate `TEAM.md` from `config.json` instead of maintaining it by hand.
- More languages: the content is fully parameterised, a language is a directory under `template/`.
- Validate the core on a real project and remove whatever turns out to be ceremony.

## Status

`0.7.0` — early. The structure is complete and tested, but the core has not yet been proven by shipping a real product with it. Expect the protocols to shrink once they meet actual work.

## License

MIT
