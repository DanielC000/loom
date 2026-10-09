// Card 49186d90, follow-up to 21f6175c/2b7df434. Those cards bound a pending readdir("/proc")/
// /proc/uptime read against pinning a fresh libuv thread per enumeration, but a pending read is NEVER
// evicted by design — a later call simply JOINS it. The only trace of a genuinely STUCK read used to be
// a per-call "possibly hung" log line at whichever consumer happened to be looking. This card adds a
// loud, ONCE-PER-EPISODE console.error once enough consecutive joins have timed out against the SAME
// pending read — see docs/decisions/49186d90-posix-singleton-stuck-read-signal.md for the full writeup,
// including why this is a daemon LOG LINE ONLY, never a durable event.
//
// ⚠️ SCENARIO ORDER IS LOAD-BEARING, same reason as pty-posix-enumeration-readdir-uptime-guard.mjs: these
// are process-wide SINGLETON slots with no key, so a scenario that permanently hangs a resource poisons
// it for every later scenario in this file. Order: both "below threshold, then resolves" negative
// controls first (A: readdir, B: uptime), then the two PERMANENT-hang scenarios last, uptime (C) before
// readdir (D) — readdir is also a prerequisite for scenario C's own healthy pid listing.
//
// Scenarios C and D drive the REAL reapProcessesRootedInWorktree -> enumerateWithRetry ->
// enumerateProcessesPosix path (fake kill, injected PosixEnumerationDeps — never the bare
// ProcessEnumerator seam) specifically to MEASURE, not infer, how many joins ONE consumer call
// contributes to each resource's counter: enumerateWithRetry retries ONLY a timedOut:true rejection, and
// only readdir's timeout branch throws one (uptime's degrades silently and the call resolves normally),
// so a stuck readdir gets ~2 joins per consumer call (crossing the threshold within the 2nd call) while a
// stuck uptime gets exactly 1 (needing a full 3rd separate call).
//
// No real filesystem/process access anywhere in this file, no real ps, no real kill — every scenario
// injects its own PosixEnumerationDeps and a fake `kill`.

import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-posix-enum-stuck-signal-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { enumerateProcessesPosix, reapProcessesRootedInWorktree, POSIX_SINGLETON_STUCK_SIGNAL_THRESHOLD } =
  await import("../dist/pty/host.js");

check("sanity: the exported threshold is a small positive integer", Number.isInteger(POSIX_SINGLETON_STUCK_SIGNAL_THRESHOLD) && POSIX_SINGLETON_STUCK_SIGNAL_THRESHOLD > 0 && POSIX_SINGLETON_STUCK_SIGNAL_THRESHOLD <= 5);

/** TEST-LEVEL bounded race (never the production guard's own bound): captures BOTH resolution and
 *  rejection without throwing, so a single call site can assert on either outcome. If the real promise
 *  hangs past the test's own `ms`, this logs a named FAIL and returns `null` instead of hanging the file
 *  or exiting with an opaque code. */
async function raceSettle(promise, label, ms = 3000) {
  let timer;
  try {
    const result = await Promise.race([
      promise.then((value) => ({ settled: "resolved", value }), (err) => ({ settled: "rejected", err })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ settled: "test-timeout" }), ms); }),
    ]);
    if (result.settled === "test-timeout") {
      check(`${label} — did not hang past this test's own ${ms}ms bound`, false);
      return null;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const fakePidRecord = (pidStr) => ({ exePath: `/fake/${pidStr}`, cwd: null, commandLine: `fake-cmd-${pidStr}`, creationTicks: 100 });

// Capture console.error without ever losing a real failure's own diagnostic text — restored in a
// `finally` at the very end of the file, mirroring the file-scoped try/finally other guard tests use for
// process.on("unhandledRejection") listeners.
const originalConsoleError = console.error;
const errorLog = [];
console.error = (...args) => { errorLog.push(args.map(String).join(" ")); };
const stuckSignalsFor = (resourceSubstr) => errorLog.filter((l) => l.includes("[pty-posix-stuck]") && l.includes(resourceSubstr));

try {
  // ── A: readdir("/proc") slow-then-settling, BELOW the stuck-signal threshold — no false positive ──────
  {
    let resolveReaddir;
    const pending = new Promise((resolve) => { resolveReaddir = resolve; });
    const deps = {
      listProcPids: () => pending,
      readBootTimeMs: async () => null,
      readPidRecord: async (pidStr) => fakePidRecord(pidStr),
    };
    // Two direct calls join the same still-pending read and each time out — 2 hits, still BELOW the
    // threshold (3) — the signal must not fire yet.
    const a1 = await raceSettle(enumerateProcessesPosix(50, deps), "(A.1) readdir below-threshold call 1", 2000);
    check("(A.1) call 1 rejects with timedOut:true", a1?.settled === "rejected" && a1.err?.timedOut === true);
    const a2 = await raceSettle(enumerateProcessesPosix(50, deps), "(A.2) readdir below-threshold call 2", 2000);
    check("(A.2) call 2 ALSO rejects with timedOut:true", a2?.settled === "rejected" && a2.err?.timedOut === true);
    check("(A) NEGATIVE CONTROL: 2 timed-out joins (below the threshold of 3) do NOT fire the stuck signal",
      stuckSignalsFor('readdir("/proc")').length === 0);

    resolveReaddir(["9101"]);
    await pending; // deterministic settle before the next call, same pattern the sibling guard file uses

    const a3 = await raceSettle(enumerateProcessesPosix(1000, deps), "(A.3) readdir after settle", 2000);
    const row = a3?.value?.find((p) => p.pid === 9101);
    check("(A.3) a later call, issued after the abandoned read resolved, reads fresh real data",
      a3?.settled === "resolved" && row != null && row.exePath === "/fake/9101");
    check("(A) readdir stuck signal still never fired (the episode settled before crossing the threshold)",
      stuckSignalsFor('readdir("/proc")').length === 0);
  }

  // ── B: /proc/uptime slow-then-settling, BELOW the stuck-signal threshold — no false positive ──────────
  {
    let resolveUptime;
    const pending = new Promise((resolve) => { resolveUptime = resolve; });
    const pids = ["9201"];
    const deps = {
      listProcPids: async () => pids,
      readBootTimeMs: () => pending,
      readPidRecord: async (pidStr) => fakePidRecord(pidStr),
    };
    const b1 = await raceSettle(enumerateProcessesPosix(50, deps), "(B.1) uptime below-threshold call 1", 2000);
    check("(B.1) call 1 resolves with creationTime null (uptime unresolved)",
      b1?.settled === "resolved" && b1.value.find((p) => p.pid === 9201)?.creationTime === null);
    const b2 = await raceSettle(enumerateProcessesPosix(50, deps), "(B.2) uptime below-threshold call 2", 2000);
    check("(B.2) call 2 ALSO resolves with creationTime null",
      b2?.settled === "resolved" && b2.value.find((p) => p.pid === 9201)?.creationTime === null);
    check("(B) NEGATIVE CONTROL: 2 timed-out joins (below the threshold of 3) do NOT fire the stuck signal",
      stuckSignalsFor("/proc/uptime read").length === 0);

    resolveUptime(1_700_000_000_000);
    await pending;

    const b3 = await raceSettle(enumerateProcessesPosix(1000, deps), "(B.3) uptime after settle", 2000);
    const row = b3?.value?.find((p) => p.pid === 9201);
    check("(B.3) a later call, issued after the abandoned uptime resolved, gets a real (non-null) creationTime",
      b3?.settled === "resolved" && row != null && row.creationTime !== null);
    check("(B) uptime stuck signal still never fired", stuckSignalsFor("/proc/uptime read").length === 0);
  }

  // ── C: /proc/uptime permanently hangs, driven through the REAL reapProcessesRootedInWorktree path ──────
  // (fake kill, injected deps). Readdir stays healthy throughout — a stuck uptime never makes
  // enumerateProcessesPosix throw, so enumerateWithRetry never retries it: exactly 1 join per consumer
  // call, needing a full 3rd SEPARATE call to cross the threshold.
  {
    const killCalls = [];
    const enumerate = (timeoutMs) => enumerateProcessesPosix(timeoutMs, {
      listProcPids: async () => [], // healthy, instant — never retried
      readBootTimeMs: () => new Promise(() => {}), // PERMANENT hang
    });
    const oneCall = (label) => raceSettle(reapProcessesRootedInWorktree("/fake/worktree-uptime-stuck", {
      enumerate, kill: (pid) => killCalls.push(pid), timeoutMs: 100,
    }), label, 5000);

    const c1 = await oneCall("(C.1) uptime-stuck call 1");
    check("(C.1) call 1 resolves normally (a stuck uptime is cosmetic, never enumerationFailed)",
      c1?.settled === "resolved" && c1.value.enumerationFailed !== true);
    await sleepMs(50); // let this call's single join fully settle before the checkpoint below
    check("(C) after 1 consumer call (1 join), the stuck signal has NOT fired",
      stuckSignalsFor("/proc/uptime read").length === 0);

    const c2 = await oneCall("(C.2) uptime-stuck call 2");
    check("(C.2) call 2 ALSO resolves normally", c2?.settled === "resolved" && c2.value.enumerationFailed !== true);
    await sleepMs(50);
    check("(C) after 2 consumer calls (2 joins, still below the threshold of 3), the stuck signal has NOT fired",
      stuckSignalsFor("/proc/uptime read").length === 0);

    await oneCall("(C.3) uptime-stuck call 3");
    await sleepMs(50);
    check("(C) MEASURED: the 3rd SEPARATE consumer call is what crosses the threshold for uptime (1 join/call, never retried)",
      stuckSignalsFor("/proc/uptime read").length === 1);

    await oneCall("(C.4) uptime-stuck call 4");
    await sleepMs(50);
    check("(C) ONCE-ONLY: a 4th call past the threshold does not fire a second signal",
      stuckSignalsFor("/proc/uptime read").length === 1);
    check("(C) nothing was ever killed (a cosmetic uptime failure never widens the kill set)", killCalls.length === 0);
  }

  // ── D: readdir("/proc") permanently hangs, driven through the REAL reapProcessesRootedInWorktree path ──
  // (fake kill, injected deps). MEASURES the in-call retry's own doubling effect: enumerateWithRetry
  // retries ONLY a timedOut:true rejection, and only readdir's timeout branch throws one — so ONE
  // consumer call contributes UP TO 2 joins (its own attempt + the in-call retry), crossing the threshold
  // within the 2nd call rather than needing a 3rd. MUST run LAST: readdir is scenario C's own pid-listing
  // prerequisite, and this permanently poisons the readdir slot for the rest of the file.
  {
    let readdirCallCount = 0;
    const killCalls = [];
    const enumerate = (timeoutMs) => enumerateProcessesPosix(timeoutMs, {
      listProcPids: () => { readdirCallCount++; return new Promise(() => {}); }, // PERMANENT hang
      readBootTimeMs: async () => null, // moot: the uptime slot is already permanently stuck from scenario C
    });
    const oneCall = (label) => raceSettle(reapProcessesRootedInWorktree("/fake/worktree-readdir-stuck", {
      enumerate, kill: (pid) => killCalls.push(pid), timeoutMs: 100,
    }), label, 5000);

    const d1 = await oneCall("(D.1) readdir-stuck call 1");
    check("(D.1) call 1 resolves with enumerationFailed:true (fail-closed, never throws past its own catch)",
      d1?.settled === "resolved" && d1.value.enumerationFailed === true);
    await sleepMs(150); // let call 1's own in-call retry (attempt + 500ms sleep + retry attempt) and the outer withReapTimeout race fully settle
    check("(D) after 1 consumer call (2 joins: its own attempt + the in-call retry), the stuck signal has NOT fired",
      stuckSignalsFor('readdir("/proc")').length === 0);
    check("(D) readdir's underlying read was STILL only started ONCE across call 1's own 2 attempts (dedup intact)",
      readdirCallCount === 1);

    await oneCall("(D.2) readdir-stuck call 2");
    await sleepMs(150);
    check("(D) MEASURED: the 2nd consumer call's FIRST attempt is the 3rd join that crosses the threshold for readdir",
      stuckSignalsFor('readdir("/proc")').length === 1);

    await oneCall("(D.3) readdir-stuck call 3");
    await sleepMs(150);
    check("(D) ONCE-ONLY: a 3rd call past the threshold does not fire a second signal",
      stuckSignalsFor('readdir("/proc")').length === 1);
    check("(D) nothing was ever killed", killCalls.length === 0);
  }
} finally {
  console.error = originalConsoleError;
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
fs.rmSync(tmpHome, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
