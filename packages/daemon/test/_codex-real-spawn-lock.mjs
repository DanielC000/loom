// Cross-process mutual exclusion for the two real-codex-spawn test files (card 14e6cf5f).
//
// WHY THIS EXISTS: `codex-mcp-reachability-real-spawn.mjs` and `codex-stateful-runtime-real-spawn.mjs`
// each drive a REAL, model-backed `codex` CLI process against the ONE real, shared `~/.codex` home
// (codex-doctrine.ts's own header: "every concurrent Codex worker on a host shares ONE real
// `~/.codex/config.toml` + `sessions/` tree" — never a per-test CODEX_HOME override, auth breaks under
// one). `scripts/test-daemon.mjs` schedules test FILES as independent OS processes in a concurrent pool
// (default 3 lanes) — neither of these two files is in that script's own `ISOLATED_REAL_SPAWN_BASENAMES`
// sequential-isolation set, so they can be scheduled to run their real codex spawns AT THE SAME TIME.
//
// MEASURED (card 14e6cf5f diagnosis): running the two concurrently reproduces an intermittent full-boot
// stall in codex-mcp-reachability-real-spawn.mjs — all four of its checks fail together, its own real
// codex process never reaches even the first-use trust dialog within its 25s window, and (in both
// captured specimens) config.toml is reported UNCHANGED — i.e. this is NOT the config.toml write-race
// the merge gate's own retry warning speculated about (op `1e2275f6`); it is real host/subprocess
// contention between two concurrently-booting real `codex` processes delaying one of them past its own
// fixed completion deadline. Reproduced at ~2/36 concurrent trials (pool>=2); 0/5 sequential (pool=1)
// trials failed, and a bare dual-codex-spawn control (no Loom Db/gateway in the picture) never failed in
// 5/5 trials either — the trigger needs the FULL concurrent scheduling shape, not just "two codex
// processes exist". Not further isolated beyond that; see the card for the full trial log.
//
// FIX SHAPE: serialize just these two files' own real-codex lifecycles via a simple, file-based
// exclusive lock — NOT by flipping `scripts/test-daemon.mjs`'s `ISOLATED_REAL_SPAWN_PHASE_ENABLED` (an
// explicit, owner/lead-approved, opt-in, default-OFF cost tradeoff for a DIFFERENT, larger set of files —
// see that constant's own doc for the +24-30% per-gate cost this would otherwise silently impose on
// every merge, daemon-global, for files that were never measured against that tradeoff). This lock costs
// nothing to any other test file and touches no daemon-global scheduling knob.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerForCleanup, unregister } from "./_tmp-fixture.mjs";

const LOCK_PATH = path.join(os.tmpdir(), "loom-codex-real-spawn.lock");
// Far longer than either file's own worst-case runtime (~30s observed even under contention) — a lock
// older than this is treated as abandoned (a prior holder crashed before its own `exit` backstop ran,
// e.g. SIGKILL — the same non-coverage `_tmp-fixture.mjs`'s own header already discloses) rather than
// blocking forever.
const STALE_MS = 5 * 60_000;
const POLL_MS = 250;
const WAIT_TIMEOUT_MS = 90_000;

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
      const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
      if (age > STALE_MS) {
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
