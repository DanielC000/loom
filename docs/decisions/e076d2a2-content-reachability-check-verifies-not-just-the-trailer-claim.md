# e076d2a2 — Verify a squash-trailer's CLAIM against the tree's actual content, not just its presence

## Narrative

`branchContentLandedInCommit` is a content-reachability check (board card `e076d2a2`, item 2): does `sha`'s tree ACTUALLY contain `branch`'s own changes, not merely carry its trailer text? Under the squash+commit race the per-repo mutex closes, a commit can bear one branch's `Loom-Worker-Branch` trailer while its content belongs to a DIFFERENT branch entirely (reproduced against real git — see `test/merge-content-reachability.mjs`) — a `--grep` trailer match alone is a CLAIM, not proof. This verifies the claim: diff the branch's OWN changed files (relative to its merge-base with `sha`) between `sha`'s tree and the branch tip's tree — zero difference over EXACTLY that path set proves `sha` carries the branch's content verbatim.

FAILS CLOSED, deliberately the OPPOSITE default from `findLandedSquashCommit`'s own fail-safe: any git ERROR, or the two trees genuinely differing on the branch's own paths, returns `false` — NOT VERIFIED — so the caller falls through to attempting a real merge instead of trusting an unproven "landed" claim. A false `false` just costs a redundant (safe, idempotent) merge attempt; a false `true` is the exact silent-data-loss bug this card exists to close, so ambiguity must never resolve to `true`.

OUTPUT-based, NOT exit-code based (mirrors `mergeBranch`'s own `staged`/`conflicted` checks — see `isBranchMerged`'s doc): simple-git's `raw()` does NOT reliably reject on a command whose nonzero exit is a normal BOOLEAN signal rather than a real failure (`--is-ancestor`, `diff --quiet`) — a first version of this check used `git diff --quiet`'s exit code and silently always resolved `true`, the exact false-positive this function exists to prevent. `git diff --name-only` has no such ambiguity: any output at all means a real difference.

## Do not

- Do not trust a `--grep` trailer match alone as proof of landed content — under the squash+commit race a commit can carry one branch's trailer while its content belongs to a different branch entirely.
- Do not use an exit-code-based git check (`--is-ancestor`, `diff --quiet`) for this verification — simple-git's `raw()` doesn't reliably reject on a boolean-signal nonzero exit, and a first version using `git diff --quiet`'s exit code silently always resolved `true`.
- Do not resolve any ambiguity (git error, or a genuine content difference) to `true` — a false `false` only costs a redundant, safe, idempotent merge attempt; a false `true` is the silent-data-loss bug this function exists to close.

## Consequences

A commit whose trailer claims it carries a branch's content, but whose tree actually doesn't (the squash+commit race), is no longer trusted blindly — it falls through to a real (safe, idempotent) merge attempt instead of being treated as already-landed.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `branchContentLandedInCommit`'s own doc comment (~line 2141), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
