# 62c4953a — detect a stale canonical `.git/index.lock` and refuse loudly; do not auto-remove

A 0-byte `.git/index.lock` was found in the canonical Loom repo, created at 07:53:44Z and never removed.
No git process was running when it was found (~4h20m later). Every landing in that window would have
failed. The next `worker_merge_confirm` was refused with a generic, buried message — "git merge --squash
failed (reset --hard (rawError cleanup) failed — canonical repo may have residue: fatal: Unable to create
'.git/index.lock': File exists" — with nothing having signalled the lock in the ~4h20m before that. A
human removed it by hand after confirming it was empty, stale, and no git process was alive.

Candidate culprits for how the lock was left behind: a canonical-repo git call during worktree add/prune/
remove, or a `killableCanonicalRaw`/`spawnCanonicalGitTree` call (`git/bounded.ts`) that was killed on
timeout or process-group-kill without git cleaning up its own lock first.

## Owner ruling

NO auto-removal of a detected `.git/index.lock` in this card. Two things instead:

1. **Detection and a loud refusal.** Before a canonical-index writer (the solo squash in
   `mergeBranchLocked`, the batch fast-forward in `fastForwardCanonicalMain`, or any other
   `withCanonicalIndexLock` caller) touches the canonical index, check for `.git/index.lock`. If present,
   refuse up front with a reason naming the path, size, and mtime age, and a best-effort liveness signal —
   never a generic squash-failure message. Tell the operator to remove the lock by hand once they've
   confirmed no git process is running. Surface the same fact to the confirming manager through the
   normal rejection path.
2. **Diagnosability.** Start/end logging (args summary, duration, exit or kill/timeout) on
   `canonicalGit`/`spawnCanonicalGitTree` (`git/bounded.ts`) for any call that was killed or timed out —
   covering both the win-job-launcher path and the taskkill fallback — so the next time a lock is left
   behind, the log names the culprit. A killed call that was an index-writing subcommand also logs a WARN
   that `index.lock` may have been left behind.

## Why detection lives in `withCanonicalIndexLock`, not duplicated per call site

`withCanonicalIndexLock` (`git/repo-lock.ts`) is already the TRUE convergence point for every canonical
writer — the solo squash path (`mergeBranch`/`mergeBranchLocked`, `git/worktrees.ts`), the batch fast-
forward (`fastForwardCanonicalMain`, `git/batch-merge.ts`), `GitWriter`'s checkout/commit/createBranch
(card `e41dbb58`), `createWorktree`'s fresh-cut path, and `vault/versioner.ts`'s `commitVault` all acquire
it before touching the canonical index — the same reason the quarantine check (`assertRepoNotQuarantined`)
already lives here rather than being re-derived at each call site. A lock check added per-file would drift
from this one the moment either file's own entry sequence changes.

## Scope (round 2 — Code Review `6ed0d5da`, B3)

The check is NOT unconditional at the chokepoint — round 1 shipped it that way and the Code Review found
it would have blocked `createWorktree` (worker/review spawns) against a held lock, including the owner's
own interactive `git commit` with its editor open, even though `worktree prune`/`branch --list`/`worktree
add` all work fine with one present (verified against real git 2.47). OWNER RULING: the check applies ONLY
to paths that actually write the canonical index. Implemented as `withCanonicalIndexLock`'s own opt-in
third param, `{checkIndexLock: true}` — default OFF, so an un-migrated caller is unaffected.

Every `withCanonicalIndexLock` caller, and its status:

| Caller | File | `checkIndexLock` | Why |
| --- | --- | --- | --- |
| `mergeBranch`/`mergeBranchLocked` (the squash) | `git/worktrees.ts` | **true** | writes the canonical index |
| `confirmWorkerMerge`'s preflight (staged/dirty/untracked overlap probes) | `sessions/service.ts` | **true** | runs INSIDE the same canonical-index acquisition the squash itself re-acquires one call later (B1 below) |
| `fastForwardCanonicalMain` (the batch ff-only) | `git/batch-merge.ts` | **true** | writes the canonical index |
| `GitWriter.checkout` | `git/writer.ts` | **true** | writes the canonical index |
| `GitWriter.createBranch` | `git/writer.ts` | **true** | writes the canonical index (`checkout -b`) |
| `GitWriter.commit` | `git/writer.ts` | **true** | writes the canonical index (`add -A` + `commit`) |
| `commitVault` (vault auto-commit), merge-eligible branch only | `vault/versioner.ts` | **true** | this IS the same canonical index a real merge/GitWriter write would hit (that is the entire reason this lock is taken at all — see this file's own `a09b81a0` doc); translated into the SAME graceful `{committed:false}` backoff a quarantine refusal already gets here, never a throw — an auto-commit tick already treats any failure as "retry next tick" |
| `createWorktree`'s fresh-cut path | `git/worktrees.ts` | **false (deliberate)** | `worktree prune`/`branch --list`/`worktree add` all work fine with a lock present; must never block a worker/review spawn |

## Why no auto-removal

Auto-removing a lock this check finds is a DIFFERENT, riskier decision than `resetOrSkip`'s own narrow
removal (`removeLeakedCanonicalIndexLockIfSafe`, `git/worktrees.ts`): that one only ever fires after THIS
process's own `killableCanonicalRaw` call was positively `treeDeathConfirmed` — it knows, with real
confidence, that the lock it is about to remove was almost certainly its own child's. A lock discovered
HERE, at lock-acquisition time, carries no such provenance — it could be a different daemon, an IDE, or an
owner's own interactive shell. Removing it on a guess risks corrupting a genuinely in-progress git
operation. The owner's ruling is to surface this to a human instead.

## Do not

- Do not add auto-removal of a lock this check discovers — that is a different, already-rejected design
  (see "Why no auto-removal" above). `resetOrSkip`'s own confirmed-kill removal
  (`removeLeakedCanonicalIndexLockIfSafe`) is unrelated and untouched by this card.
- Do not duplicate this check per call site (`git/worktrees.ts`, `git/batch-merge.ts`) — route every
  canonical-index writer through `withCanonicalIndexLock`'s own check (`checkCanonicalIndexLockNotPresent`,
  `git/repo-lock.ts`), the same convergence point the quarantine check already uses.
- Do not use the witnessed liveness check (stat → brief wait → re-stat) to DECIDE anything — it exists
  only to inform the refusal message with a best-effort signal; it is deliberately far shorter than
  `removeLeakedCanonicalIndexLockIfSafe`'s own 1.5s persistence-check delay, since a wrong guess here costs
  nothing beyond an imprecise message, never a wrongly-removed lock.
- Do not enumerate or kill host processes (by image name, PID sweep, or otherwise) to answer "is a git
  process live" — the liveness signal is derived entirely from the lock file's own mtime/size stability
  across a short wait, never from process enumeration.
- Do not treat `{ ok: true }` from `checkCanonicalIndexLockNotPresent` as proof no lock exists — it is also
  returned when the git dirs can't be resolved at all (this check cannot manufacture a refusal it can't
  support) and when the lock disappeared during the witnessed wait (nothing left to refuse by the time the
  real call would run).

## Round 2 (Code Review `6ed0d5da`) — additional "Do not"s

- Do not let `CanonicalIndexLockPresentError` escape uncaught from ANY `{checkIndexLock: true}` call site
  — an uncaught throw classifies as `"unknown"` (NOT in `NEVER_CACHED_OUTCOMES`) and gets cached/replayed
  by the until-superseded verdict cache, silently blocking a re-confirm even after the lock is removed
  (B1: `confirmWorkerMerge`'s preflight, `sessions/service.ts`, caught only `RepoQuarantinedError` before
  this round). Every opted-in call site must catch it and return its own typed `indexLockPresent: true`
  shape.
- Do not add a NEW canonical-index-touching call site (a `withCanonicalIndexLock` caller, or any future
  one) without deciding its `checkIndexLock` value AND adding its row to the Scope table above — an
  undecided caller silently inherits the default (`false`, no check), which is wrong for one that actually
  writes the canonical index.
- Do not add `quarantined`/`indexLockPresent` handling to only ONE of the two `classifyOutcome` lambdas
  (the solo path's or the batch path's, `sessions/service.ts`) — they are separate functions over separate
  result types (B2: the batch lambda had NO arm for either, so both fell to `"rejected"`, which IS
  replayed from the until-superseded cache — the `quarantined` gap predates this card but is fixed here,
  same lines).
- Do not reuse `PURE_READ_SUBCOMMANDS` (the merge-driver-execution set) to decide whether a killed call
  gets the index-writing WARN in `logCanonicalGitAbnormalOutcome` (`git/bounded.ts`) — it answers a
  DIFFERENT question and wrongly treats `status` as safe, even though git opportunistically takes
  `.git/index.lock` for it (no `GIT_OPTIONAL_LOCKS=0` anywhere in this codebase). Use the dedicated
  `NEVER_INDEX_TOUCHING_SUBCOMMANDS` set instead (also excludes `diff`/`ls-files` for the same reason).
- Do not have `canonicalGit`'s own raw-wrapper catch (`git/bounded.ts`) claim a call "timed out" purely
  because elapsed time crossed the configured idle `block` bound — that path has no abort-kill machinery,
  so elapsed time alone cannot distinguish a real timeout from an ordinary slow failure of the same
  duration. Label it as the weaker, honest claim the signal actually supports ("slow failure (elapsed X ms
  >= idle bound Y ms)").
