// Shared test-only helper: pre-stamp the ONE-TIME Setup Assistant first-run marker (app_meta key
// `setup.firstRunLaunched`) directly in a scratch LOOM_HOME's db file, BEFORE any real daemon subprocess
// is spawned against it. Belt-and-suspenders alongside LOOM_SUPPRESS_FIRST_RUN_LAUNCH=1 in the child
// env: either one alone stops `maybeAutoLaunchSetup` (packages/daemon/src/setup/first-run.ts) from ever
// calling `sessions.startSetup()` (a REAL node-pty-spawned `claude`) on boot — doing BOTH means a future
// change to either mechanism alone can't silently reopen the real-spawn risk. Mirrors
// packages/web/e2e/fixtures/prestamp.mjs's same intent, inline (so the caller can close the handle
// before spawning a subprocess against the SAME db file, rather than relying on a short-lived separate
// process to exit).
import path from "node:path";

/**
 * @param {string} loomHome a scratch LOOM_HOME whose db file does not need to exist yet (sqlite creates
 *   it on open) — this is cheap and safe to call unconditionally before a real daemon ever boots there.
 */
export async function prestampFirstRunMarker(loomHome) {
  const { Db } = await import("../dist/db.js");
  const { SETUP_FIRST_RUN_KEY } = await import("../dist/setup/first-run.js");
  const db = new Db(path.join(loomHome, "loom.db"));
  try {
    db.setMeta(SETUP_FIRST_RUN_KEY, new Date().toISOString());
  } finally {
    db.close();
  }
}
