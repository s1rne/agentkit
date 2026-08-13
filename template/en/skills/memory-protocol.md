---
name: memory-protocol
description: How to keep project memory so a zero-context session can continue — what to put in NOW, JOURNAL, DECISIONS, what to leave out, how to check the writing is good enough.
---

# Project memory

Session context is always lost. Only what's written to files survives.

## Four files

| File | Answers | How often |
|---|---|---|
| `NOW.md` | where we are | every session |
| `JOURNAL.md` | what happened and what we learned | every session, newest on top |
| `DECISIONS.md` | what was decided and why | when deciding |
| `TEAM.md` | who's on the team | when the roster changes |

## NOW.md — the one that must always be accurate

Phase, what's done, what's in flight, what's blocked and on whom, the next milestone. If it drifts from reality, every other mechanism is useless.

## JOURNAL.md — append-only, newest on top

```
## YYYY-MM-DD · who · what

**Done:** …
**Learned:** facts about the domain, the customer, the technology
**Got wrong:** if anything
**Next:** …
```

**Never rewrite past entries.** The journal exists precisely so a future session sees what was already tried and why it was dropped.

### Always record

- **Domain facts.** Worth more than code: code gets rewritten, facts don't.
- **Dead ends.** "Tried X, failed because Y" saves the next session days.
- **Mistakes and their causes.** Not for self-flagellation — to avoid repeats.
- Answers received to open questions.

### Never record

A retelling of the diff. The journal is not a git log. Write what the code cannot tell you.

## DECISIONS.md

A short register: decision, rationale or ADR link, date. A separate block lists open questions and who owes the answer.

**A decision here is not revisited mid-work.** A new disqualifying fact goes to the human together with the fact.

## Quality check

One criterion: **could a zero-context session continue after reading only `BOOT.md` and what it points to?**

If not, write more. An entry nobody rereads is useless; an entry that fell short costs a day of work.
