---
name: definition-of-done
description: Definition of done — the hard checklist without which a task doesn't reach done. Separate requirements for risk high.
---

# Definition of done

Every item at your level. Partial completion is `review`, never `done`.

## Any task

- [ ] Acceptance criteria met, or explicitly marked unmet with a reason
- [ ] Types, lint, tests green
- [ ] Tests written: CRUD and contracts by the author, **domain calculations by `qa-engineer`**
- [ ] `critic` returned `accept`
- [ ] Report filled in per `handoff-protocol`
- [ ] Docs updated if behavior changed
- [ ] Incidental findings filed as tasks, not "fixed while I was there"

## Server tasks

- [ ] Mutations are idempotent
- [ ] State change and event in one transaction
- [ ] Isolation test exists for the touched tables
- [ ] No database access bypassing the shared wrapper

## Client tasks

- [ ] Loading, empty and error states exist
- [ ] Text goes through localization keys
- [ ] Keyboard navigation and visible focus work
- [ ] Lists use cursor pagination

## `risk: high`

Money, access control, irreversible operations, migrations:

- [ ] **A human reviewed and signed off.** The critic's verdict does not substitute
- [ ] Domain tests written from the requirement, not the implementation
- [ ] `security-auditor` passed if permissions or personal data are involved
- [ ] The migration is reversible or ships with a reverse migration
- [ ] Verified at realistic data volume, not on three rows

## What "done" does not mean

Not "the code is written". Not "it works on my machine". Not "the tests went green after I adjusted them to the code".
