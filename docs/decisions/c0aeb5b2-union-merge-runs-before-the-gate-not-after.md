# c0aeb5b2 — Merge main's tip INTO the worktree BEFORE the gate, closing the untested-union hole

## Narrative

`mergeMainIntoWorktree` merges canonical main's CURRENT tip (`repoPath`'s HEAD) INTO the worker's worktree, IN the worktree — a REAL (non-squash) merge, run BEFORE the build/DoD gate and the squash-merge.

THE HOLE THIS CLOSES: the gate used to run against the worktree's PRE-merge state — the branch as it was cut, with no knowledge of anything that landed on main afterward — so it validated a union that was never actually tested. A branch cut before a main-side change that the branch's code now conflicts with (textually) or is incompatible with (semantically, e.g. main removed a symbol the branch now depends on) could sail through a green gate and land a broken union. Merging main's tip into the worktree FIRST means the gate (run by the caller immediately afterward, in the same worktree) sees the actual post-merge union, and a hard textual conflict is caught right here, fail-closed.

Deliberately a MERGE, not a rebase or squash: the resulting worktree tip has `mainSha` as a direct ancestor, so `merge-base(repoPath HEAD, branch)` — the base `mergeBranch`'s own `--squash` diffs against — becomes `mainSha` itself. The squash therefore still lands ONLY the branch's own net changes; main's content is common ancestor, not re-applied.

FAIL-CLOSED, mirroring `mergeBranch`'s own conflict handling: a real merge sets `MERGE_HEAD` (unlike `--squash`), so a conflict is cleaned up with `git merge --abort` (equivalent to `mergeBranch`'s `reset --hard HEAD`, but the more idiomatic call for a non-squash merge) — leaving the worktree exactly as it was before this call. Any other failure (unresolvable main tip, a merge command error with no conflict, a failed inspection of the merge state) also returns `ok:false` rather than assuming success — this function is itself a gate, not a best-effort probe like `detectStrandedWork`, so an inconclusive result must block, not wave through.

A worktree that already contains `mainSha` (the common case for a freshly-cut, not-yet-drifted branch) short-circuits to a no-op success (`merged:false`) without spawning a merge child at all.

`FALLBACK_GIT_IDENTITY` (`{name: "Loom", email: "loom@localhost"}`) is used ONLY when the host has no git identity configured at all — same rationale as `vault/versioner.ts`'s own fallback, duplicated rather than shared: each commit-creating path in this codebase decides its own identity policy (`git/writer.ts` commits with NO override; `versioner.ts` falls back for its unattended vault auto-committer). This merge ALSO runs unattended (the card `5150fdc2` stale-base auto-forward), so it needs the same fallback: a CI runner or a fresh end-user host may have no configured git identity, which would otherwise make `git merge --no-edit` (a real merge commit) fail on the commit step.

## Do not

- Do not run the gate against the worktree's pre-merge state — that validates a union that was never actually tested against main's current tip.
- Do not use a rebase or squash for this step — a real merge is what makes `mainSha` the merge-base the squash later diffs against, so main's content is never re-applied as the branch's own net change.
- Do not assume success on an inconclusive failure (unresolvable tip, a non-conflict merge error) — this function is itself a gate; it must block, not wave through.
- Do not share `FALLBACK_GIT_IDENTITY` with `vault/versioner.ts`'s own fallback constant — each commit-creating path deliberately decides its own identity policy.

## Consequences

A branch that conflicts textually or semantically with what landed on main after it was cut is caught right here, fail-closed, instead of sailing through a green gate that never actually tested the real union.

## Source

Inline comments in `packages/daemon/src/git/worktrees.ts`: `mergeMainIntoWorktree`'s own doc comment and `FALLBACK_GIT_IDENTITY`'s own doc comment, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.

## Reap runs before the union-merge too, not just before the gate

The pre-gate reap (card [[c21487e8-pre-gate-worktree-reap-prevents-a-spurious-eperm-on-the-gates-install-build-step|c21487e8]]) runs before BOTH steps below it, not just the gate: the union-merge itself WRITES tracked files in the worktree, so it is at least as lock-sensitive as the gate this reap was originally built for. An escaped watcher still holding a handle on a tracked file that main also touched would otherwise make the union-merge's own file-write fail with a spurious EPERM, misreported as `union_merge_failed` rather than the lock issue it actually is. Reaping first, before either step, clears that risk for both.

### Do not (this section)

- Do not assume the reap is only relevant to the gate — the union-merge's own file-writes are equally lock-sensitive, and skipping the reap before it would misreport a lock collision as `union_merge_failed`.

### Source (this section)

Inline comment in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMerge`'s pre-gate cleanup block (the "RUNS BEFORE THE UNION-MERGE TOO" paragraph), as of this tranche's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `//` comment markers stripped, no wording changed.
