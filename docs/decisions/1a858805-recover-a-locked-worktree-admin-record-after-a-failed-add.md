# 1a858805 — Best-effort recovery of a locked `.git/worktrees/` admin record left by a killed `worktree add`

## Narrative

Card `1a858805`: a killed `worktree add` (via `withTimeoutKillingChild`, card `8e75ee20`) can leave `.git/worktrees/<name>/locked` (content `initializing`) behind — git's own in-progress marker, normally cleared on success, now orphaned because the child died mid-checkout. `git worktree prune` SKIPS locked records BY DESIGN (so a concurrent prune can't delete an in-progress add) — the leading prune in `createWorktree` can never clear it (git refuses: "cannot remove a locked working tree, lock reason: initializing"). Neither could `removeWorktree()` at the time this was written; card `adf03de8` (after this one) has since upgraded it to the same `-f -f` override this catch uses, so `removeWorktree()` now also clears an intact locked record on its own.

`git worktree remove -f -f` is git's own documented override for exactly this lock reason — the error text names it verbatim. Recovery runs best-effort, via the SAME lock-scoped `boundedLockedRaw` the surrounding prune/branch-list/add calls use (still inside `withCanonicalIndexLock`'s callback, so it doesn't reopen the race the lock exists to close). It is BOUNDED, not absolute: `worktreePath` is confirmed non-existent by the `fs.existsSync(worktreePath)` reuse-return check OUTSIDE this lock before control ever reaches it — so in practice this only ever targets a fresh directory Loom itself is trying to create, never an existing worktree a human deliberately locked. That check and the `add` are not atomic with each other (a narrow TOCTOU window), but accepted because `worktreePath` is deterministic PER TASK (`taskKey(taskId)`) and this daemon never runs two live spawns for the same task concurrently (`Db.liveSessionIdForTask`, checked before any worktree/pty side effect, plus a proven-atomic in-memory mutex `inFlightSpawnTaskIds` closing that check's own TOCTOU gap) — making the realistic exposure nil, not because the window itself is closed.

Two failure shapes reach the recovery catch, both handled the same best-effort way: the add failed WITHOUT ever creating `worktreePath` (e.g. "already used by worktree at <other path>") — the remove is then a harmless no-op against a path that was never registered, and must never be able to touch whatever OTHER path such an error names; or the add left a genuine locked ghost — the remove clears it.

## Do not

- Do not let a cleanup failure here mask or replace the real `add` error — swallow the cleanup failure and rethrow the ORIGINAL `add` error unchanged.
- Do not run the `remove -f -f` recovery outside the same `withCanonicalIndexLock` callback the surrounding prune/branch-list/add calls use — doing so would reopen the race the lock exists to close.
- Do not assume this recovery is safe against an arbitrary path — it relies on `worktreePath` being deterministic per task and on no concurrent live spawn for the same task; see the fdfe8a56 record for when this recovery is deliberately skipped instead.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, inside `createWorktree`'s `worktree add` catch block (~lines 1102-1139), as of commit `f8d18a2cbc315a3020b962ac7e85cf2194ca09ba`. Relocated by card `5b001dde`; wrapped source lines joined into flowing paragraphs, `//` comment markers stripped, no wording changed. Continues in the `fdfe8a56` record (same catch block, the PATH-1/PATH-2 skip decision).
