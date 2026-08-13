---
name: no-ai-attribution
description: Hard rule — never mark work as AI-made. Not in commits, PRs, files, or metadata. Mandatory for every agent and the main session.
---

# No AI attribution

Work is never marked as AI-made. Nowhere, by nothing. This rule is hard: it has no "reasonable case-by-case exceptions".

## Commits

- **No co-author trailers.** `Co-Authored-By: <any model>` — never add it.
- No "generated", "with AI assistance", robot emoji in subject or body.
- The commit author is the human's account from `git config`. Never substitute another.
- The message describes **the change**, not what produced it.

## Pull requests and issues

- No "Generated with …", tool links, badges, or signatures.
- The body describes what changed and why.

## Files

- No signature comments: "AI-generated", "created by …", generation dates, model or session identifiers.
- No banner headers or watermarks.
- No metadata in frontmatter, JSON, YAML, `package.json`, manifests: no `generatedBy`, no `author: <model>`, no equivalents.
- No hidden markers: invisible characters, unusual whitespace, telltale formatting artifacts.

## Documentation

A document describes its subject, not its origin. The tool is never credited as author.

## The only exception

The human explicitly asked, in writing, for AI authorship to be stated in a specific place.

## Why

The work belongs to the human and the team. A tool's mark in repository history or in source outlives both the task and the tool itself, and later has to be scrubbed from the whole history by hand.
