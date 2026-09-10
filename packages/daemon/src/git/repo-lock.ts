import fs from "node:fs";
import path from "node:path";

// @decision e076d2a2 — every writer touching a canonical repo's index (a merge, or GitWriter's
// commit/checkout/createBranch, widened by e41dbb58) must hold this per-repo lock, or the
// squash+commit race it closes can land one op's staged content under another op's message.
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
 */
export async function withCanonicalIndexLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = canonicalRepoLockKey(repoPath);
  const prior = canonicalIndexLocks.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  canonicalIndexLocks.set(key, run.catch(() => { /* only used to sequence the NEXT caller; outcome irrelevant here */ }));
  return run;
}
