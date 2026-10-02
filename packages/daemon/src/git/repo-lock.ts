import fs from "node:fs";
import path from "node:path";
import { assertRepoNotQuarantined } from "./merge-quarantine.js";

// @decision e076d2a2 — every writer touching a canonical repo's index (a merge, or GitWriter's
// commit/checkout/createBranch, widened by e41dbb58) must hold this per-repo lock, or the
// squash+commit race it closes can land one op's staged content under another op's message.
const canonicalIndexLocks = new Map<string, Promise<unknown>>();

/**
 * Thrown by {@link withCanonicalIndexLock} when the canonical repo is found QUARANTINED at the moment the
 * lock is acquired. This is now the ONE place every canonical-index writer is refused —
 * `GitWriter.checkout`/`createBranch`/`commit`, `mergeBranch`, `createWorktree`'s fresh-cut path, and
 * `fastForwardCanonicalMain`'s ff-only — rather than each re-deriving its own copy of
 * {@link assertRepoNotQuarantined}. A caller that needs its own structured refusal shape (`GitWriteResult`,
 * a `{ok:false,...}` merge result, `FastForwardResult`) must catch this AROUND THE WHOLE
 * `withCanonicalIndexLock(...)` call, never nested inside the `fn` it passes in — this check runs BEFORE
 * `fn` is ever invoked, so a try/catch inside `fn` never sees it.
 *
 * @decision 24c0bdba (round 6, Code Review BLOCKER 1)
 */
export class RepoQuarantinedError extends Error {}

/**
 * Realpath the NEAREST EXISTING ancestor (inclusive) of `bp`, then reattach whatever trailing segments
 * don't exist yet — so the result is the SAME value `bp` would realpath to once it exists, independent of
 * whether `bp` ITSELF happens to exist at the moment this is called (an unmounted drive, a cloud-synced
 * folder not yet materialized: the ENCLOSING directory structure is typically still there even when the
 * leaf isn't). Falls back to `bp`'s own `path.resolve` only when NOTHING along the chain up to the
 * filesystem root resolves at all (a wholly disconnected drive/share) — a last-resort literal, not a
 * verified anchor.
 */
function findExistingAncestorRealpath(bp: string): string {
  const resolvedInput = path.resolve(bp);
  const tail: string[] = [];
  let probe = resolvedInput;
  for (;;) {
    try {
      const realAncestor = fs.realpathSync.native(probe);
      return tail.length > 0 ? path.join(realAncestor, ...tail) : realAncestor;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return resolvedInput; // walked to the fs root; nothing resolves at all
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Resolve the git TOPLEVEL for `bp` — walk UP from the nearest existing ancestor's realpath (see
 * {@link findExistingAncestorRealpath}) looking for the nearest ancestor (inclusive) that contains a
 * `.git` entry, a directory for an ordinary repo or a FILE for a linked worktree/submodule (its mere
 * presence marks the enclosing directory as a git root; what the pointer inside it says doesn't matter
 * here — see {@link canonicalRepoLockKey}'s own doc for why).
 *
 * Returns the existence-independent realpath, UNCHANGED, when no `.git` is found anywhere up to the
 * filesystem root — `bp` isn't inside a git repo at all (a vault-only project's bound path, a not-yet-
 * `git init`'d directory, a test fixture) — the same case {@link canonicalRepoLockKey} already fell back
 * to before this existed.
 *
 * @decision 7673d096 — SYNCHRONOUS, no subprocess: never thread GIT_DIR/GIT_CEILING_DIRECTORIES/
 * safe.directory through here, and never add a cache without re-reading the record first.
 *
 * Full record: docs/decisions/7673d096-sync-toplevel-walk-for-the-canonical-lock-key.md
 */
export function resolveGitToplevelSync(bp: string): string {
  const real = findExistingAncestorRealpath(bp);
  let dir = real;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir; // a directory (ordinary repo) or a FILE (worktree/submodule pointer)
    const parent = path.dirname(dir);
    if (parent === dir) return real; // reached the filesystem root — not inside any repo; fall back to the input
    dir = parent;
  }
}

/**
 * True iff `bp` ITSELF currently resolves via realpath — used ONLY to gate a boot-time quarantine-latch
 * MIGRATION decision (merge-quarantine.ts): never trust a freshly-computed key enough to migrate/destroy a
 * durable latch when the registered path itself can't currently be verified (an unmounted drive, a
 * not-yet-synced cloud folder) — even though {@link resolveGitToplevelSync} may still compute a STABLE key
 * for it via the nearest-existing-ancestor walk above.
 *
 * @decision 7673d096 — never swap this for an ancestor-existence check — the reviewed bug is specifically
 * about `bp` itself being momentarily absent while an ancestor (and `C:\`/`/` itself) still resolves, which
 * would make an ancestor-existence check pass in virtually every real case and protect nothing.
 */
export function isRepoPathCurrentlyResolvable(bp: string): boolean {
  try { fs.realpathSync.native(bp); return true; } catch { return false; }
}

/** Canonicalize a repo path for lock-keying — two spellings of the same physical directory, OR two
 *  different paths inside the SAME physical repo (e.g. a project bound to a subdirectory with no `.git`
 *  of its own), must map to the SAME key. See {@link resolveGitToplevelSync} for the toplevel walk this
 *  delegates to and the full rationale. */
export function canonicalRepoLockKey(repoPath: string): string {
  const toplevel = resolveGitToplevelSync(repoPath);
  return process.platform === "win32" ? toplevel.toLowerCase() : toplevel;
}

/**
 * Serialize `fn` against every other in-flight caller for the SAME canonical repo path — FIFO via promise
 * chaining. `prior.then(fn, fn)` runs `fn` once `prior` SETTLES regardless of whether it resolved or
 * rejected, so one caller's failure never poisons or skips the next caller's turn; the chained promise
 * (its outcome ignored via `.catch`) is what the NEXT caller awaits, so callers queue strictly in arrival
 * order.
 *
 * @decision 44c28799 — no timeout HERE, deliberately: every wrapped caller bounds its OWN git calls, so
 * a wedged holder fails only its own op, never the whole queue.
 *
 * **⚠️ NOT RE-ENTRANT.** A holder that itself (directly or transitively) calls back into
 * `withCanonicalIndexLock` for the SAME canonical repo path deadlocks permanently — and because callers
 * queue via promise chaining, that hang wedges every LATER caller for that repo too, not just the
 * re-entrant one.
 *
 * @decision e41dbb58 — verified nothing reachable from inside a held lock imports or constructs a
 * `GitWriter` (the one change that would reintroduce the deadlock above); `test/merge-writer-index-lock.mjs`
 * guards it statically.
 *
 * QUARANTINE CHECK, run once `prior` SETTLES (i.e. AFTER this caller has actually acquired the lock), never
 * before enqueueing: a repo can be quarantined by an unrelated op while this caller sat queued behind
 * `prior`, and checking only at enqueue time would miss that. Throws {@link RepoQuarantinedError} rather
 * than returning a sentinel — `T` is caller-defined, so there is no one refusal shape this generic helper
 * could return on every caller's behalf.
 */
export async function withCanonicalIndexLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = canonicalRepoLockKey(repoPath);
  const prior = canonicalIndexLocks.get(key) ?? Promise.resolve();
  const guarded = (): Promise<T> => {
    const q = assertRepoNotQuarantined(repoPath);
    if (!q.ok) return Promise.reject(new RepoQuarantinedError(q.reason));
    return fn();
  };
  const run = prior.then(guarded, guarded);
  canonicalIndexLocks.set(key, run.catch(() => { /* only used to sequence the NEXT caller; outcome irrelevant here */ }));
  return run;
}
