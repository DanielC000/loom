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

## The per-repo index mutex (`git/repo-lock.ts`) — the same card's other half

A canonical repo's git index is a process-wide, un-namespaced shared resource. `mergeBranchLocked` (`git/worktrees.ts`) stages + commits directly against it during its residue-clear→squash→conflict-check→commit sequence; `GitWriter.commit`/`checkout`/`createBranch` (`git/writer.ts`) stage/switch against the SAME index via the human-only REST git surface and the LOOM_DEV-gated Platform Lead tools. Two concurrent writers against that one index — two merges, or a merge racing an unrelated `GitWriter.commit` — can interleave: one op's own `git commit`/`--squash` can fail (e.g. the OTHER op's write moving HEAD or touching `index.lock` first) while the other op's now-staged-but-uncommitted diff is still sitting in the index; neither op's own residue-clear sees this (it only resets on an AFFIRMATIVE `ls-files --unmerged`/`MERGE_HEAD` signal, which a normal concurrent `--squash` or a plain `commit` never sets), so a writer can blindly commit the OTHER op's staged content under its OWN subject/trailer — reproduced against real, unmodified git (`test/merge-repo-mutex.mjs` for merge-vs-merge, `test/merge-writer-index-lock.mjs` for merge-vs-`GitWriter`): a commit bearing one op's own subject but containing another op's diff, no artificial delays needed.

`withCanonicalIndexLock` makes any wrapped op's own index-touching sequence atomic PER REPO, closing that race at the source — for merges and, since `e41dbb58` (see that record), for `GitWriter` too, instead of each writer re-deriving its own locking discipline. The invariant is attached to the INDEX (the resource), not to any one caller — a caller that forgets to acquire it is the bug. It's keyed by the repo's CANONICALIZED path (mirrors `projects/repos.ts`'s own aliasing guard: two spellings of the same physical directory — different casing/separators, or a registry entry vs. `repoPath` itself — must serialize together). Cross-repo calls are never blocked — the index is per-repo. No eviction needed: entries are bounded by the number of distinct repos a daemon touches, never by task/branch/commit volume.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `branchContentLandedInCommit`'s own doc comment (~line 2141), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed. The per-repo index mutex section is from `git/repo-lock.ts`'s own file-header doc comment, as of this worktree's HEAD (card `4301fa9c`).
