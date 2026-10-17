# 83e0573a — an UNLOCKED remover's `prune` can delete the shared `.git/worktrees` container under a concurrent `createWorktree` add's own mkdir

## Narrative

Follow-up to `c684d00d` (phase diagnostics correcting an earlier misreading of a completed-then-threw
step as a hang). With that marker in place, a real occurrence (`dist-importer-check-glue.mjs` (14), under
host load) captured the actual `git worktree add` error for the first time: `fatal: could not create
directory of '.git/worktrees/15e9ae059cb6': No such file or directory` — FAST (328ms), confirmed NOT
disk-related (134GB free at the time).

### Mechanism

Installed git (2.47.0.windows.2) deletes the whole `$GIT_DIR/worktrees` admin dir once the entry it
removes/prunes is the LAST one — confirmed empirically. `createWorktree`'s fresh-cut path serializes
`prune → branch --list → add` under `withCanonicalIndexLock` (`2fcd5eae`) — but `removeWorktree` (every
teardown path's chokepoint) was deliberately UNLOCKED (`c6a6f405`), whose analysis covered a DIFFERENT
race (git's `locked`/`initializing` marker stopping a concurrent `prune` from touching an in-flight
`add`'s own half-created entry) — never a separate worktree's removal deleting the SHARED container
while a different, concurrent `add` is mid-`mkdir()`, which is the shape that fired. Concretely:
`confirmWorkerMergeTracked` fires `void this.kickDistImporterCheck(...)` UN-AWAITED, then
`await this.finalizeMerge(...)` → `removeWorktree` for the just-merged worker's worktree — both run
concurrently on the SAME repo.

### Deterministic repro

50 iterations: cut one worktree, concurrently remove it (mirroring `removeWorktree`'s sequence) while
adding a second on the SAME repo. 2/50 hit the byte-identical "could not create directory" text; 1/50 hit
`failed to read .git/worktrees/.../commondir`. 47/50 clean — real but narrow. The committed hermetic
test's own calibrated repro later also found "not a git repository" and an `index.lock`-shaped ENOENT.

### Audit (before implementing)

Every removal funnels through `removeWorktree`/`gcWorktreeDir` (`dea6728e`/`b6d41db1`): `finalizeMerge`
(confirmed racing (14)), the wedge-retry sweep, boot-reconcile Pass B, `merge_batch`'s direct call — none
locked. `withCanonicalIndexLock` is a pure FIFO promise chain, released the instant its callback settles;
every caller above reaches it only AFTER its own prior locked call already returned — never from inside
a still-open callback. `canonicalRepoLockKey` resolves to the filesystem TOPLEVEL (`7673d096`), so the
new lock keys identically to `createWorktree`'s. No caller holds the lock at call time — audited clean.

## Fix

**(a′), shipped.** `removeWorktree` takes `withCanonicalIndexLock` around ONLY `unlock`+`prune`, leaving
the fs removal (can wedge) OUTSIDE it. Both route through `killableCanonicalRaw` (same helper
`createWorktree`'s locked `prune` uses) — a hung call can't hold this lock indefinitely. Worst case ~60s
(15s × `killableCanonicalRaw`'s 2x kill-grace, both calls); realistically ~`prune`'s 30s alone, since
`unlock` is near-instant and only runs when `removed`. An unconfirmed-kill give-up is still swallowed —
bounds the WAIT, not the outcome. Best-effort semantics unchanged.

**(b), proposed then DROPPED by Code Review.** A round-1 draft retried `createWorktree`'s own add once on
the two named shapes, for a remover Loom doesn't lock. CR repro (git 2.47.0.windows.2): real git creates
the `-b` branch BEFORE making the admin dir, and does NOT delete it on a failed add — so on a fresh cut
(the production shape) the retry's own second attempt always died with `fatal: a branch named '<branch>'
already exists`, hiding the real error. Round-1's scenario (3) missed this — it threw a FAKE error before
any real git ran, never exercising the branch git's real first attempt creates. DROPPED, never shipped.
An external remover racing a spawn/batch worktree is an ACCEPTED, DOCUMENTED gap: it fails loudly (a real
git error) and a manager can retry — not worth a branch-aware re-check path.

**Quarantine.** On a quarantined repo, the fs removal still runs, but `unlock`+`prune` are SKIPPED
entirely: `withCanonicalIndexLock`'s entry check throws `RepoQuarantinedError` before the callback runs,
swallowed by the outer catch — same "fs removed, admin record stale" shape `createWorktree`'s reuse path
already tolerates.

## Do not

- Do not move the fs removal INSIDE the lock — see the `c6a6f405` Follow-up; reopens the worktree-GC P0
  (`bd9fc808`) / wedge-retry-sweep hazard.
- Do not re-add a `createWorktree`-side retry without re-deriving the branch-before-admin-dir order first.
- Do not re-derive the ~60s worst-case figure without re-checking `GIT_OP_TIMEOUT_MS`/`killableCanonicalRaw`'s multiplier.
- Do not treat the dropped (b) as an oversight — the external-remover gap is accepted and documented above.

## Source

`packages/daemon/src/git/worktrees.ts` (`createWorktree`'s add-failure catch, `removeWorktree`'s
unlock/prune block), `git/repo-lock.ts`, `git/bounded.ts` (`killableCanonicalRaw`). Hermetic test:
`packages/daemon/test/worktree-add-container-race.mjs`.
