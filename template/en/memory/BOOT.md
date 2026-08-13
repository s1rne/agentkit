# BOOT — cold start

Procedure for a **zero-context** session. Top to bottom, skipping nothing.

## 1. What the project is

- `.agentkit/PROJECT.md` — what we build, for whom, constraints, glossary.
- Root context: `CLAUDE.md` or `AGENTS.md`.

## 2. Under which rules we work

- `.agentkit/HOUSE-RULES.md` — **the human's rules.** Verify the system matches them. If it doesn't, bring it into line per the `house-rules` skill.

## 3. Where we are

1. `.agentkit/state/NOW.md` — phase, what's in flight, what's blocked.
2. `.agentkit/state/JOURNAL.md` — **the last 20 entries**, not the whole file.
3. `.agentkit/state/DECISIONS.md` — decisions made; don't revisit.
4. `.agentkit/state/TEAM.md` — who's on the team, caps, reviewers.
5. `.agentkit/state/RUNS.md` — recent launches.

## 4. What to do

1. `.agentkit/INBOX.md` — new entries from the human, triage them.
2. `.agentkit/QUESTIONS.md` — any answers to pending questions.
3. `tasks/BOARD.md` — the board.

## 5. Work

Rules: `team-protocol`. The main session's role: `tech-lead`.

---

## After a cold start, never

- Revisit decisions in `DECISIONS.md`. A new disqualifying fact is a separate conversation with the human, not a silent swap.
- Start work without reading `NOW.md`. Half the post-context-loss mistakes are redoing what's already done or already cancelled.
- Invent the domain. Check `PROJECT.md`, the docs, then file a question in `QUESTIONS.md`.
- Ignore `HOUSE-RULES.md`.
