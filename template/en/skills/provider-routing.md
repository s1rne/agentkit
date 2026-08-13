---
name: provider-routing
description: How a task reaches a provider — the capability vocabulary, the subscription-only rule, account isolation, and what happens when a capability is missing or auth goes stale mid-run.
---

# Routing work to providers

## A role asks for a capability, not a provider

A role never names `claude` or `cursor-agent`. It declares what the work needs; the router picks among the providers that are **actually logged in right now**.

| Capability | Means |
|---|---|
| `code` | edit files in a repository and run its toolchain |
| `bulk` | many cheap, near-identical passes — renames, sweeps, mechanical fixes |
| `images` | read screenshots, mockups, diagrams |
| `big-context` | a large amount of material must be held in one context |
| `plan-mode` | produce a plan without touching the working tree |
| `worktree` | run in an isolated checkout on its own branch |
| `parallel` | several instances of this role at once |

Naming a provider instead of a capability makes the task unrunnable the moment that provider isn't logged in on this machine.

## Subscription CLIs only

Permitted providers: **`claude`** (Claude Code) and **`cursor-agent`**. Both authenticate through their own subscription login.

**Never a metered HTTP API. Never an API key.** Metered usage is billed separately and expensively: a fleet that quietly falls back to an API key turns a flat subscription into a per-token bill nobody approved, and the bill arrives after the work.

Therefore:

- API-key and endpoint-override variables are **stripped** from the environment handed to a child agent — removed, not blanked, so the CLI falls back to its stored login;
- a provider whose auth resolves to a metered state is **never selected**, even when it is the only one that has the capability. The task blocks instead;
- if such a variable is set in the human's own shell, the lead reports it in one line. It is not silently worked around.

## Account isolation

Separate accounts are separated by **config directory**, never by key: `CLAUDE_CONFIG_DIR` for Claude Code, `CURSOR_CONFIG_DIR` for cursor-agent. One directory per account, stable across runs so the login survives.

## Claude Code alone is enough

The whole system runs on `claude` and nothing else. Other providers **add** capability — they are never a prerequisite. Any rule that would make a second provider mandatory is a bug in the rule.

## A missing capability blocks one task, not the wave

When no logged-in provider offers a required capability:

1. **That one task** goes `blocked`, with the missing capability named.
2. The **exact command that would fix it** is recorded in the task and reported to the human in one line — for example `cursor-agent login`.
3. **Everything else keeps running.** A wave is never held up by one unavailable capability.
4. No substitution behind the human's back: a `bulk` task is not quietly downgraded onto a provider that will take ten times longer, unless the lead says so and records it.

## Auth goes stale mid-run

Discovering at runtime that a session expired is normal; looping on it is not.

- **Re-route once** to another provider that is ready and has the capability.
- **Record the fact** — which provider went stale, which one took over, in the task file and in `RUNS.md`.
- **Never a second re-route** for the same task in the same run, and never a retry loop against the same provider. No ready provider left → the task blocks with the login command, and the wave continues.
- Partial work already done in the box stays in the box and is reported per `workspace-protocol`. It is not thrown away because the provider changed.

## What the lead reports

One line per missing capability, with the fixing command. Not the routing decisions themselves — those live in `RUNS.md`.
