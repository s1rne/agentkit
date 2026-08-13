---
name: handoff-protocol
description: How an agent hands off work — the mandatory report format in the task file. What to write, what not to, what to pass to whoever comes next.
---

# Handing off

Work isn't done until the report in the task file is filled in.

```markdown
## Report

**Status:** done / partially done / blocked

**What was built**
- bullet points with file paths

**Acceptance criteria**
- [x] criterion — how it's evidenced
- [ ] criterion — why it isn't met

**How to verify**
The command or steps a reviewer can run themselves.

**What was NOT done, and why**
Honestly. Silence here costs more than any gap.

**Found along the way**
Defects outside this task. Don't fix them — file a task and link it.

**For whoever's next**
Non-obvious decisions, hooks left in place, things that look finished but aren't.

**For the journal**
One or two lines if you learned something that outlives the task. Empty is fine.
```

## Rules

1. **Never hand off red.** Types, lint, tests green — otherwise status is "partially done" naming what fails.
2. **Don't retell the diff.** The reviewer can read code. Write what code can't show: why this way, what you considered and rejected.
3. **Don't fix other people's things on the way.** File a task.
4. **Silence is the worst outcome.** A gap you flagged is normal work. A gap you hid is a production defect.
5. **Unsure about a domain rule? Say so**, even if the code is already written.
