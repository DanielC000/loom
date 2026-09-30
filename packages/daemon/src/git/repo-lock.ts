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
