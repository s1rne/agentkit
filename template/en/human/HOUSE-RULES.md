# House rules

> **Written by the human. Agents only read.**
> This is *how* to work on this project. Not *what* to build (that's tasks), but under which rules.
> The lead reads this at cold start and on every change, and **reshapes the team around it** — creating roles, amending protocols, recording constraints. Skill: `house-rules`.
> Write in plain words. Interpreting it is the lead's job.

## Tools

<!-- Example:
- Tasks live in Trello, board "Development". Task files stay the source of truth; Trello is a display surface for people.
- Releases are tracked in Jira, project ABC.
-->

## Process

<!-- Example:
- No deploys after 15:00 on Friday.
- Billing changes need two reviewers, one of them human.
- Load tests run before every release.
-->

## Boundaries

<!-- Example:
- Don't touch legacy/ — another team owns it.
- Only humans edit the DB schema; agents prepare the migration and stop.
- No new external SaaS without approval.
-->

## Team

<!-- Example:
- We need a dedicated technical writer — customer-facing docs are on us.
- Design is done by a human; agents don't touch it.
-->

## Communication

<!-- Example:
- End-of-day summary.
- Reports in English, code and commits in English.
- Don't report intermediate steps, only decision points and results.
-->

## Technology

<!-- Example:
- PostgreSQL only; don't propose alternatives.
- No new dependencies without an ADR.
-->

---

**How this works.** A rule here that the system ignores is a failure of the lead, not a detail.
A rule conflicting with a system rule — **the human wins**, but the lead names the consequence once.
A rule that is unsafe (e.g. "keep secrets in the repo") — the lead refuses and proposes a workable alternative.
