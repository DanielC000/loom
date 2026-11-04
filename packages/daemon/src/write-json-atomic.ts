import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Card 4c2a0bfd — moved out of pty/claude-config.ts (a PURE move, no behaviour change): that file pulled
// git/worktrees.ts (and its own large dependency graph) into every importer, including skills/inject.ts's
// synchronous spawn hot path, for the sake of this one small, genuinely dependency-free helper. See
// docs/decisions/31f997e7-capability-bound-skill-delivery-is-hygiene-not-a-boundary.md's "CARD 4c2a0bfd"
// section. pty/claude-config.ts re-exports every name below so its own existing callers/tests are
// unaffected; it also still imports transientFsRetryLimit/isTransientFsError/sleepSync from here for its
// OWN trust-lock retry logic, which shares this same bounded-retry budget by design.

// Windows can transiently throw EPERM/EACCES/EBUSY (instead of succeeding, or EEXIST/ENOENT as
// POSIX would) when a create/rename/delete races another process's brief handle on the SAME path —
// an AV/indexer mid-scan, or (for pty/claude-config.ts's trust lock) a create landing just as another
// process's release-delete of that lockfile is completing. It clears in milliseconds, so both this
// module's own rename retry and that lock's acquire retry treat it as transient and retry it with this
// SAME bounded count + backoff, rather than inventing separate numbers that could drift apart.
const DEFAULT_TRANSIENT_FS_RETRY_LIMIT = 12; // worst case (1,2,4,8,16,32,50,50,…ms backoff) well under 1s
// Ceiling for an env override — pty/claude-config.ts's withTrustLock transient-retry branch loops WITHOUT
// re-checking its own acquire deadline, so an unbounded override would block the synchronous spawn
// thread far past that bound. 1000 × the ~50ms backoff ceiling is ~50s worst case — generous for even
// extreme contention, while still bounding a typo'd huge value.
const MAX_TRANSIENT_FS_RETRY_LIMIT = 1000;
// Under EXTREME concurrent Windows FS contention (heavy-stress repro: ~1 in ~64 attempts at 12
// concurrent writers), the fixed default budget above can genuinely exhaust and surface an EPERM that
// would have cleared given a bit more time. LOOM_TRANSIENT_FS_RETRY_LIMIT: read fresh on each call
// (never cached at module load) so a test can flip it per-run, an operator on a heavily-contended host
// can raise it without a code change, and — left unset — retry behavior is BYTE-IDENTICAL to the
// pre-override fixed constant. Floor BEFORE the positivity check (not after) — a fractional override
// like "0.5" is `> 0` but floors to 0, which would DISABLE retries entirely (writeJsonAtomic throws on
// the very first transient EPERM) instead of falling back to the default.
export function transientFsRetryLimit(): number {
  const n = Number(process.env.LOOM_TRANSIENT_FS_RETRY_LIMIT);
  const floored = Math.floor(n);
  if (!Number.isFinite(n) || floored < 1) return DEFAULT_TRANSIENT_FS_RETRY_LIMIT;
  return Math.min(floored, MAX_TRANSIENT_FS_RETRY_LIMIT);
}
// Exported so a caller outside this module (ensureTrustedResilient's host.ts call site) can classify an
// error the SAME way writeJsonAtomic/withTrustLock already do, instead of re-listing the three codes.
export const isTransientFsError = (code: string): boolean =>
  code === "EPERM" || code === "EACCES" || code === "EBUSY";

/** Synchronous sleep that parks the thread (no busy-spin) — this module, and pty/claude-config.ts's
 *  trust lock (which imports it back), both run on a synchronous spawn-hot-path contract. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** TEST SEAM: swap the fs.renameSync writeJsonAtomic's rename retry uses — fs's ESM namespace import
 *  is immutable and can't be monkeypatched directly. Lets a hermetic test fault-inject transient
 *  EPERM/EACCES/EBUSY on the rename deterministically. Defaults to the real fs.renameSync; production
 *  code never calls the setter. */
type RenameSyncFn = typeof fs.renameSync;
let renameSyncImpl: RenameSyncFn = fs.renameSync;
export function __setRenameSyncForTest(fn?: RenameSyncFn): void { renameSyncImpl = fn ?? fs.renameSync; }

/**
 * Atomically write `value` as pretty JSON to `filePath`: a uniquely-named temp file in the
 * same directory (so two concurrent writers can't collide on it) followed by a rename onto
 * the target. The rename is atomic on a single filesystem, so a crash mid-write can never
 * leave the real (possibly large, concurrently-read) config truncated/corrupt.
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.loom.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  // On Windows, rename onto an EXISTING target can transiently throw EPERM/EACCES/EBUSY when another
  // process holds a handle on it — exactly the lock-free fast-path readers of .claude.json during
  // concurrent spawns (ensureTrusted's fast-path readCfg runs OUTSIDE the trust lock by design), or an
  // AV/indexer mid-scan. POSIX rename(2) has no such issue. The handle is released in milliseconds, so
  // retry with a short bounded backoff; rethrow once it persists (a genuine permission error still
  // surfaces), cleaning up the temp file so a terminal failure leaves nothing behind.
  for (let attempt = 0; ; attempt++) {
    try { renameSyncImpl(tmp, filePath); return; }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (attempt >= transientFsRetryLimit() || !isTransientFsError(code)) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
        throw err;
      }
      sleepSync(Math.min(50, 2 ** attempt)); // 1,2,4,8,16,32,50,50,… ms — worst case well under 1s
    }
  }
}
