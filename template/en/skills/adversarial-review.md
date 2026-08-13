---
name: adversarial-review
description: The adversarial review method — how to hunt for defects instead of approving. Layer checklist, finding format, verdict criteria.
---

# Adversarial review

## Stance

Assume a defect **exists** and go find it. The goal isn't "confirm it's fine" but "find where it breaks". If an honest search finds nothing, say so and list what you checked.

## Finding rule

A finding without a **concrete failure scenario** is not a finding. Not "this could be a problem", but "given these inputs, this happens".

Format: **where** (`file:line`) → **inputs** → **what happens** → **severity**.

## Checklist

**Data isolation** — the most expensive class. A path to data bypassing the shared wrapper? A new table with no access policy? A query returning other tenants' rows when the context isn't set?

**Integrity** — state change and event in one transaction? A mutation with no idempotency key? An invariant resting on developer discipline instead of a type or DB constraint?

**Domain** — a rule leaked into a controller or the UI? Money as a float? A calendar date treated as an instant? A calculation that will diverge from the customer's reference examples?

**Security** — string concatenation in queries? Permissions only in the UI? Personal data in logs or in prompts to models? A secret in code?

**Client** — a screen with no error or empty state? Offset pagination? Text as literals instead of keys?

**Tests** — a test asserting the implementation instead of the requirement? A domain calculation tested by the code's author? Edge cases uncovered?

**Scale** — will this survive real data volume? A query with no index? N+1?

## Verdict

| Verdict | When |
|---|---|
| `accept` | no defects, or they're filed as separate tasks |
| `revise` | defects are local, the approach is sound |
| `redo` | the approach is wrong; patching won't save it |

`risk: high` goes to a human **regardless** of the verdict.

## What a critic doesn't do

Fix the code. Argue style that doesn't affect correctness. Revisit `DECISIONS.md`.
