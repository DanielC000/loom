// Cross-process mutual exclusion for the real-codex-spawn test files (card 14e6cf5f; membership +
// sizing revised by card 3791b14e).
//
// WHY THIS EXISTS: every file in CODEX_REAL_SPAWN_BASENAMES below drives a REAL, model-backed `codex`
// CLI process against the ONE real, shared `~/.codex` home (codex-doctrine.ts's own header: "every
// concurrent Codex worker on a host shares ONE real `~/.codex/config.toml` + `sessions/` tree" — never
// a per-test CODEX_HOME override, auth breaks under one).
//
// MEASURED (card 14e6cf5f diagnosis, original 2-file shape): running two of these concurrently
// reproduces an intermittent full-boot stall — a real codex process never reaches even the first-use
// trust dialog within its own completion deadline. Reproduced at ~2/36 concurrent trials (pool>=2); 0/5
// sequential (pool=1) trials failed — the trigger needs the FULL concurrent scheduling shape, not just
// "two codex processes exist". See that card for the full trial log.
//
// CARD 3791b14e (2026-09-07): the family grew from 2 to 4 files without this lock's own wait budget
// being re-derived, and a gate op (`7d31427a`) surfaced the staleness — a waiter (`codex-mcp-reachability
// -real-spawn`) timed out at the then-current 90s budget while the actual holder needed longer than that
// to legitimately finish. FIX SHAPE CHANGED with that card: `scripts/test-daemon.mjs` now imports
// CODEX_REAL_SPAWN_BASENAMES below and schedules this WHOLE family sequentially (pool size 1),
// ALWAYS-ON and independent of that script's own `ISOLATED_REAL_SPAWN_PHASE_ENABLED` (a different,
// larger, owner-approved opt-in tradeoff for a different file set — this family is never gated by, and
// never reads, that flag). That scheduling change is what actually prevents concurrent contention now;
// THIS file's lock is a BACKSTOP against a scheduling-invariant violation (a bug in that scheduling, or
// this file run ad hoc outside test-daemon.mjs), not the primary means of exclusion — see WAIT_TIMEOUT_MS
// below for what that changes about how it's sized.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerForCleanup, unregister } from "./_tmp-fixture.mjs";

// SINGLE SOURCE OF TRUTH for family membership — `scripts/test-daemon.mjs` imports this array (not the
// reverse) so the scheduler's sequential-phase set and this lock's own contender count can never drift
// apart. Adding a 5th real-codex-spawn file means adding its basename HERE, once; the scheduler picks it
// up automatically, and (per WAIT_TIMEOUT_MS's own comment below) the wait budget does not need to
// change when this list grows, so there is no second number to keep in sync.
export const CODEX_REAL_SPAWN_BASENAMES = [
  "codex-doctrine-real-spawn",
  "codex-mcp-reachability-real-spawn",
  "codex-stateful-runtime-real-spawn",
  "codex-transcript-real-spawn",
];
export const CODEX_REAL_SPAWN_SET = new Set(CODEX_REAL_SPAWN_BASENAMES);

const LOCK_PATH = path.join(os.tmpdir(), "loom-codex-real-spawn.lock");
// Far longer than any file's own worst-case runtime is EVER expected to be, but no longer this lock's
// PRIMARY defense — see the file header. Only reached if `scripts/test-daemon.mjs`'s own sequential
// scheduling for CODEX_REAL_SPAWN_BASENAMES (N=4 today: codex-doctrine-real-spawn,
// codex-mcp-reachability-real-spawn, codex-stateful-runtime-real-spawn, codex-transcript-real-spawn) is
// itself violated (a scheduling bug, or one of these files run ad hoc outside that harness). Because
// scheduling — not this budget — is what prevents concurrent contention now, this number does NOT need
// to scale with N (it never has to cover N-1 *other* holders finishing first); it only needs to exceed
// ONE legitimate holder's worst real runtime. Sized from ACTUAL production gate-op `7d31427a`'s surviving
// log (~/.loom/gate-output/7d31427a-824f-495c-8606-c868ae77cfac.log, captured before card 3791b14e's own
// 20-minute prune window closed) under REAL 4-way contention — the exact condition this fix removes:
// codex-transcript-real-spawn 120.0s (killed at the OUTER per-file ceiling, still holding this lock —
// see PID-liveness reaping below for why that no longer costs a full STALE_MS wait), codex-doctrine-
// real-spawn 96.8s (PASS), codex-mcp-reachability-real-spawn 91.7s (FAIL, blocked on this very lock),
// codex-stateful-runtime-real-spawn 69.4s (PASS). 180s clears the highest of those with real margin while
// staying well below STALE_MS (5 min) — this is a genuine field measurement, not a guess; if a fresh
// contended-vs-sequential comparison after this fix lands shows a smaller number suffices, it can shrink,
// but there was never a passing run recorded above 120s to justify going lower than that on this data
// alone.
const STALE_MS = 5 * 60_000;
const POLL_MS = 250;
const WAIT_TIMEOUT_MS = 180_000;

// Card 3791b14e DoD-3: a holder killed via `scripts/test-daemon.mjs`'s own per-file timeout (`child.kill()`
// with no signal — Node reports it to the PARENT as "SIGTERM", but EMPIRICALLY CONFIRMED on this host
// (a throwaway spawn+kill+observe script, not this file's own test-shaped code) that the CHILD's own
// `process.on("SIGTERM")` handler and `_tmp-fixture.mjs`'s `beforeExit`/`exit` hooks never run — the
// child is torn down before any JS-level cleanup executes, same non-coverage that file's own header
// already discloses for SIGKILL/`taskkill /F`, just reached here by this repo's ordinary timeout-kill
// path too. So a killed holder's lock file survives it. Without this check, the NEXT waiter would have to
// sit out the full STALE_MS (5 min) even though the holder is provably gone the instant it dies.
// Returns true (dead — reapable now), false (confirmed alive), or null (can't tell — e.g. the lock file's
// `pid=` field isn't there yet because the writer is between its `openSync`/`writeSync` calls, or a
// permissions error on the liveness probe itself) so the caller can fall back to the age-only check
// rather than guessing either way.
function isRecordedHolderDead(lockContent) {
  const match = /pid=(\d+)/.exec(lockContent);
  if (!match) return null;
  try {
    process.kill(Number(match[1]), 0); // signal 0: existence probe only, sends nothing
    return false;
  } catch (err) {
    return err.code === "ESRCH" ? true : null; // ESRCH = definitively gone; anything else, don't guess
  }
}

function tryAcquireOnce() {
  try {
    // "wx": atomic create-exclusive — throws EEXIST if another process already holds it. This is the
    // actual mutual-exclusion primitive; everything else here is retry/staleness bookkeeping around it.
    const fd = fs.openSync(LOCK_PATH, "wx");
    fs.writeSync(fd, `pid=${process.pid} at=${new Date().toISOString()}`);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    try {
      // PID-liveness first (see isRecordedHolderDead's own doc) — a dead recorded holder is reapable
      // immediately regardless of age. STALE_MS (untouched) remains the fallback for the one case
      // liveness can't resolve: the recorded pid got reused by an unrelated process after the real
      // holder exited.
      const holderDead = isRecordedHolderDead(fs.readFileSync(LOCK_PATH, "utf8"));
      const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
      if (holderDead === true || age > STALE_MS) {
        fs.rmSync(LOCK_PATH, { force: true });
        return tryAcquireOnce();
      }
    } catch {
      // Lost the race to read/remove it (another process reaped or refreshed it first) — fall through to
      // the caller's own poll loop rather than treating this as a hard failure.
    }
    return false;
  }
}

/**
 * Acquire the shared real-codex-spawn lock, polling up to WAIT_TIMEOUT_MS. Registers the lock file for
 * this process's own guaranteed cleanup (`_tmp-fixture.mjs`'s `beforeExit`/`exit` hooks) so a crash
 * mid-run still releases it (SIGKILL excepted — disclosed, unmitigated non-coverage, same as every other
 * caller of that helper).
 * @returns {Promise<() => void>} a release function — call it exactly once when finished with codex.
 */
export async function acquireCodexRealSpawnLock() {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!tryAcquireOnce()) {
    if (Date.now() > deadline) {
      throw new Error(
        `could not acquire ${LOCK_PATH} within ${WAIT_TIMEOUT_MS}ms — held by a stuck/still-running sibling real-codex-spawn test file`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  registerForCleanup(LOCK_PATH);
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    try {
      fs.rmSync(LOCK_PATH, { force: true });
    } catch {
      return; // best-effort — leave it registered so the exit backstop still retries
    }
    if (!fs.existsSync(LOCK_PATH)) unregister(LOCK_PATH);
  };
}
