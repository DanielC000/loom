# 82b4d9ac — Log worktree provisioning as a matched START/OK/FAILED triple per phase

## Narrative

Card `82b4d9ac`: START/OK/FAILED are a matched triple per provisioning phase (install, build) — the fix for the old failure-only logging, which left duration and concurrency of provisioning structurally unobservable (no start timestamp, no success emission at all). This is `console.log`/`.error` only — NOT an `orchestration_event` row: `createWorktree`'s one call site (`sessions/service.ts`'s `spawnWorker`) runs BEFORE a worker session row exists, so there is no `manager_session_id`/`worker_session_id`/`task_id` yet to key such a row on, and inventing a parallel event shape just to carry a worktree path is exactly what the card's DoD says not to do.

`worktreePath` already encodes the project id as a path segment (`WORKTREES_DIR/<projectId>/<taskKey>`), so it alone makes a window attributable to a project without a separate field. Each line embeds explicit ISO wall-clock timestamps (not just a duration) so two provisioning windows can be read DIRECTLY off the log for overlap — no proxy, no inference from unrelated completion events. Purely diagnostic: `Date.now()`/`console.log` are cheap, synchronous, non-blocking calls already used throughout this file — this adds no I/O and changes no provisioning behavior/timeout/precedence.

## Do not

- Do not add an `orchestration_event` row for provisioning — no session row exists yet at this call site to key it on; a plain log line is the correct shape here.
- Do not log only on failure — a completed provisioning window must be distinguishable from one that never ran, which needs a START and an OK/FAILED, not FAILED alone.

## Consequences

Provisioning duration and cross-window overlap are now readable directly from the log (explicit ISO timestamps on every line), where before only a failure left any trace at all. No behavior, timeout, or precedence changed — purely additive logging.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `logProvisionStart`'s own doc comment (~line 641), as of commit `f8d18a2cbc315a3020b962ac7e85cf2194ca09ba`. Relocated by card `5b001dde`; wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
