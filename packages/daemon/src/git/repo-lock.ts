import fs from "node:fs";
import path from "node:path";

// ── Canonical-repo INDEX mutex (board card e076d2a2 — CRITICAL silent data loss; widened by e41dbb58) ──
//
// A canonical repo's git index is a process-wide, un-namespaced shared resource. `mergeBranchLocked`
// (git/worktrees.ts) stages + commits directly against it during its residue-clear→squash→conflict-check→
// commit sequence; `GitWriter.commit`/`checkout`/`createBranch` (git/writer.ts) stage/switch against the SAME index via
// the human-only REST git surface and the LOOM_DEV-gated Platform Lead tools. Two concurrent writers
// against that one index — whether two merges, or a merge racing an unrelated `GitWriter.commit` — can
// interleave: one op's own `git commit`/`--squash` can fail (e.g. the OTHER op's write moving HEAD or
// touching `index.lock` first) while the other op's now-staged-but-uncommitted diff is still sitting in
// the index; neither op's own residue-clear sees this (it only resets on an AFFIRMATIVE `ls-files
// --unmerged`/`MERGE_HEAD` signal, which a normal concurrent `--squash` or a plain `commit` never sets),
// so a writer can blindly commit the OTHER op's staged content under its OWN subject/trailer — reproduced
// against real, unmodified git (see test/merge-repo-mutex.mjs for the merge-vs-merge case and
// test/merge-writer-index-lock.mjs for the merge-vs-GitWriter case): a commit bearing one op's own
// subject/message but containing (also, or only) another op's diff, no artificial delays needed.
//
// This mutex makes any wrapped op's own index-touching sequence atomic PER REPO, closing that race at the
// source — for merges (the whole residue-clear→squash→conflict-check→commit sequence) and, since e41dbb58,
// for `GitWriter.commit`/`checkout`/`createBranch` too. The invariant is attached to the INDEX (the resource), not to any
// one caller — a caller that forgets to acquire it is the bug, which is exactly why `GitWriter` now goes
// through the SAME shared lock instead of each writer re-deriving its own discipline.
//
// In-process, keyed by the repo's CANONICALIZED path — mirrors `projects/repos.ts`'s own aliasing guard:
// two spellings of the same physical directory (different casing/separators, or a registry entry vs.
// `repoPath` itself) must serialize together, not slip past each other. Cross-repo calls are NEVER
// blocked — the index is per-repo, so unrelated repos merging/committing concurrently is safe and
// untouched by this lock. No eviction needed: entries are bounded by the number of distinct repos a
// daemon touches (small, unlike a branch-keyed cache), never by task/branch/commit volume, so leaving
// settled entries in the map is not a leak.
const canonicalIndexLocks = new Map<string, Promise<unknown>>();

/** Canonicalize a repo path for lock-keying — two spellings of the same physical directory must map to
 *  the SAME key. Best-effort: a repo that doesn't exist yet on disk (a test/edge case) falls back to a
 *  resolved (not necessarily real) path rather than throwing. */
export function canonicalRepoLockKey(repoPath: string): string {
  let real: string;
  try {
    real = fs.realpathSync.native(repoPath);
  } catch {
    real = path.resolve(repoPath); // repo may not exist yet on disk in a test/edge case — best effort
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/**
 * Serialize `fn` against every other in-flight caller for the SAME canonical repo path — FIFO via promise
 * chaining. `prior.then(fn, fn)` runs `fn` once `prior` SETTLES regardless of whether it resolved or
 * rejected, so one caller's failure never poisons or skips the next caller's turn; the chained promise
 * (its outcome ignored via `.catch`) is what the NEXT caller awaits, so callers queue strictly in arrival
 * order.
 *
 * **No timeout HERE, deliberately** (board card 44c28799). Every caller wrapped in this lock is required
 * to bound its OWN git calls (`mergeBranchLocked` via `boundedMergeGit` + `withTimeout`; `GitWriter` via
 * its own `withTimeout` + block-timeout `simpleGit` client) — so `fn` is GUARANTEED to settle within a
 * bounded time on its own, and a wedged holder fails its own op instead of the whole queue. A SEPARATE
 * timeout at THIS level was considered and rejected: racing `fn()`'s completion here would let the NEXT
 * queued caller start (`prior` resolving) while the ABANDONED `fn()` call may still be actually running
 * against the shared canonical index in the background — reintroducing the exact concurrent-index race
 * this mutex exists to close. Bounding the work itself closes the hang without that risk; bounding the
 * WAIT for it here would reopen it.
 *
 * **⚠️ NOT RE-ENTRANT.** A holder that itself (directly or transitively) calls back into
 * `withCanonicalIndexLock` for the SAME canonical repo path deadlocks permanently — and because callers
 * queue via promise chaining, that hang wedges every LATER caller for that repo too, not just the
 * re-entrant one. **Verified (card e41dbb58):** no function reachable from inside a held lock —
 * `mergeBranchLocked` and everything it calls (`findLandedSquashCommit`, `changedPathSetDigest`,
 * `boundedMergeGit`, all in `git/worktrees.ts`) — imports or constructs a `GitWriter`; `git/writer.ts`'s
 * `commit()`/`checkout()`/`createBranch()` are the only OTHER acquirers of this lock, and none are reachable from inside
 * a merge. `test/merge-writer-index-lock.mjs` asserts `git/worktrees.ts` never imports `GitWriter` as a
 * static regression guard — a future change that routes a merge-path call through `GitWriter` (the one
 * change that WOULD reintroduce this deadlock) fails that test instead of silently wedging the daemon.
 */
export async function withCanonicalIndexLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = canonicalRepoLockKey(repoPath);
  const prior = canonicalIndexLocks.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  canonicalIndexLocks.set(key, run.catch(() => { /* only used to sequence the NEXT caller; outcome irrelevant here */ }));
  return run;
}
