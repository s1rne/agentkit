# Changelog

Dates are release dates. Earlier work is in the commit history.

## 0.9.0 — 2026-08-20

The release that makes a normal task finish, lets a reviewer run what it judges,
and opens the kit to a caller that is not a terminal.

### Fixed

- **A normal task could never reach `done`.** One writer on an ordinary task gets
  the shared box and no branch, and the wave then demanded that branch be merged.
  Every such task parked in `review`, and since a dependency counts as closed only
  when merged, nothing behind it ever became ready — the queue reported itself
  empty. Work with no branch is now committed where it was done and counts as
  merged. A sandbox still refuses: its work is outside version control.
- **`blocked_by: null` was read as a dependency on a task called "null".** The
  task protocol shipped with the kit tells the planner to write exactly that for
  a task that depends on nothing, so one such field stopped a whole order.
- **The critic could not run the code it was reviewing.** A reading role got plan
  mode, which forbids running as well as writing, so a mandatory test run came
  back as "could not check" and cost another implementer pass. Writing is
  withheld by the list of forbidden tools; the mode no longer has to carry both
  meanings.
- **A subscription reached with `CLAUDE_CODE_OAUTH_TOKEN` was called metered** and
  never selected — which left a container, where a browser login is impossible,
  unable to run an agent at all.
- **In a container the fleet was planned against the host.** A 4 GB container on a
  64 GB machine worked out room for eight agents; the OOM killer then removed
  them one at a time, which looked like runs failing at random.
- **A failed check after an in-place commit was reverted as if it were a merge.**

### Added

- `verify`, a permission between read and edit: run yes, write no. Which roles
  get it is decided by the role file, the same authority that decides who may
  write.
- An event stream from the wave — `refresh`, `impl`, `critic`, `audit`, `merge`,
  `verify` × `started`, `finished`, `verdict`, `deferred`, `conflict`,
  `reverted` — written as JSONL under `.agentkit/state/runs/`, and available to
  a caller through `onEvent` on `carry()`.
- A declared library surface: `@s1rne/agentkit` plus `/orchestrator`, `/wave`,
  `/accounts`, `/providers`, `/boxes`, `/resources`, `/team`, `/usage`.
- `--json` on `status`, `providers`, `team`, `box`, `context` and `usage`.
- Memory and CPU limits read from cgroup v2 and v1, with the reserve for a
  human's editor dropped where the memory is not shared with a human.

### Changed

- `capacity()` reports `dedicated` and counts only the cores the process will
  actually be given.
- Accounts that resolve to one token in the environment are reported as one
  login, the way two accounts sharing an address already were.
