// SHARED TEST HELPER (card 2365cc22) — wait for a REAL spawned daemon (dist/index.js) to become ready,
// confirming the HTTP response actually came from the daemon WE spawned — not a foreign process that
// won the ephemeral-port TOCTOU window between reserveLanePort()'s probe-and-release and our own
// child's real .listen() call (see test/_hermetic-port.mjs's own doc, and
// docs/decisions/fc53ea74-codex-lock-budget-scales-with-gate-cap.md). Replaces the duplicated
// hand-rolled `waitReady()` that used to live in each of mgmt-surface.mjs / platform-scope.mjs /
// profiles-rest.mjs / scheduler.mjs / board-consistency.mjs (and now skills-e2e.mjs), none of which
// verified responder identity or failed fast on the child's own early exit.
//
// IDENTITY PROOF, NO DAEMON SRC CHANGE: every real daemon mints a fresh, per-LOOM_HOME random secret
// (gateway/loopback-secret.ts) BEFORE app.listen() opens the port, written to
// <LOOM_HOME>/gateway-loopback.key. The gateway's existing loopback write-guard (decision 9ccedbee)
// 401s any non-GET /api/* write that doesn't present that EXACT secret as `Authorization: Bearer`. So:
// read OUR OWN secret file, then issue a safe, side-effect-free write — DELETE /api/schedules/<random
// uuid> (db.deleteSchedule() is a plain `DELETE FROM schedules WHERE id=?`, a no-op on a nonexistent
// id, no FK) — bearing that secret. 200 {ok:true} is proof-positive the responding process holds OUR
// secret, i.e. is genuinely the daemon we spawned on OUR LOOM_HOME; 401 means something else is
// listening (keep polling — e.g. a sibling test's daemon with a different LOOM_HOME/secret); a
// connection error means nothing is up yet (keep polling, same as the old plain-GET check).
//
// FAIL FAST ON EARLY EXIT: races the readiness poll against the spawned `child`'s own "exit"/"error"
// events, so a child that dies early (e.g. EADDRINUSE because the TOCTOU race above went the other
// way) rejects immediately with a clear message — including a bounded stderr tail, since callers pipe
// the child's stderr into a small buffer via `captureStderrTail` below instead of `stdio:"ignore"`
// (which hid exactly this kind of failure in every one of these files before card 2365cc22, not just
// profiles-rest.mjs as originally suspected).
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

const STDERR_TAIL_MAX = 4000; // bytes; bounded so a chatty/runaway child can never grow this unbounded

/**
 * Attach to `child.stderr` (expects `stdio` to pipe stderr, e.g. `["ignore", "ignore", "pipe"]`) and
 * keep only the LAST `STDERR_TAIL_MAX` chars — enough for a real diagnostic (EADDRINUSE, a boot
 * exception) without risk of unbounded memory growth. Returns a getter, not the buffer itself, so the
 * caller always reads the current tail rather than a snapshot taken at attach time.
 * @param {import("node:child_process").ChildProcess} child
 * @returns {() => string}
 */
export function captureStderrTail(child) {
  let tail = "";
  child.stderr?.on("data", (chunk) => {
    tail += chunk.toString("utf8");
    if (tail.length > STDERR_TAIL_MAX) tail = tail.slice(-STDERR_TAIL_MAX);
  });
  return () => tail;
}

/**
 * Wait for a real spawned daemon to be ready AND confirm the responding process is actually `child` —
 * never a foreign TOCTOU-winning listener. Rejects immediately (not after the full timeout) if `child`
 * exits or errors before the identity check ever succeeds.
 * @param {object} opts
 * @param {import("node:child_process").ChildProcess} opts.child - the spawned `dist/index.js` process.
 * @param {string} opts.base - e.g. `http://127.0.0.1:${PORT}`.
 * @param {string} opts.loomHome - the SAME LOOM_HOME passed to `child`'s env.
 * @param {() => string} [opts.getStderrTail] - from `captureStderrTail(child)`, folded into a fail-fast message.
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.label]
 * @returns {Promise<true>} resolves true once identity-confirmed-ready; rejects on early exit/error or timeout.
 */
export async function waitForOwnDaemon({ child, base, loomHome, getStderrTail, timeoutMs = 20000, label = "daemon ready" }) {
  const earlyExit = new Promise((_resolve, reject) => {
    child.once("exit", (code, signal) => {
      const tail = getStderrTail ? getStderrTail() : "";
      reject(new Error(
        `${label}: child process exited early (code=${code}, signal=${signal}) before becoming ready — ` +
        `likely EADDRINUSE or a boot crash.${tail ? ` stderr tail:\n${tail}` : " (no stderr captured)"}`,
      ));
    });
    child.once("error", (err) => {
      reject(new Error(`${label}: child process failed to spawn: ${err.message}`));
    });
  });
  const ready = waitUntil(async () => {
    let secret;
    try {
      secret = fs.readFileSync(path.join(loomHome, "gateway-loopback.key"), "utf8").trim();
    } catch {
      return false; // not written yet — the daemon hasn't reached that point in boot
    }
    if (!secret) return false;
    let r;
    try {
      r = await fetch(`${base}/api/schedules/${randomUUID()}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${secret}` },
      });
    } catch {
      return false; // nothing listening yet
    }
    if (r.status === 401) return false; // something IS listening, but it isn't us
    if (r.status !== 200) return false;
    const body = await r.json().catch(() => null);
    return body?.ok === true;
  }, { timeoutMs, intervalMs: 200, label });
  return Promise.race([ready, earlyExit]);
}
