---
description: Cold start — rebuild project context from zero and report where we are
---

Rebuild context via `.agentkit/state/BOOT.md`. Run it fully, step by step.

Separately check `.agentkit/HOUSE-RULES.md`: does the system match the human's rules? If not, bring it into line per the `house-rules` skill and say what you changed.

Then report briefly:

1. **Where we are** — phase, what's done.
2. **In flight** — `in_progress` tasks, owner, how long they've been open.
3. **Blocked** — what, and on whom.
4. **New from the human** — entries in `INBOX.md`, answers in `QUESTIONS.md`.
5. **What I propose next** — one concrete step, not a menu.

Don't start work until the human replies.
