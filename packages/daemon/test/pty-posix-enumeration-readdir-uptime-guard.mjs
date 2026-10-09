// Card 21f6175c, follow-up to 2b7df434 (landed c9b5c501). That card bounded enumerateProcessesPosix's
// PER-PID /proc reads against a hung-read-pins-a-thread-per-enumeration hazard, but explicitly left its
// two NON-per-pid reads out of scope: readdir("/proc") (lists every pid) and readFile("/proc/uptime")
// (feeds only the best-effort creationTime field). Neither has a pid key, so the per-pid in-flight Map
// doesn't cover them — a hang in either still pins a fresh libuv thread on EVERY overlapping call.
//
// This file covers the two new process-wide SINGLETON guards (posixReaddirSlot/posixUptimeSlot via
// joinSingletonPosixRead), deliberately ASYMMETRIC in how they fail:
//   - readdir is STRUCTURAL (no list, nothing to enumerate): a still-outstanding read past this call's
//     own deadline REJECTS the whole call, tagged timedOut:true — routed through the EXISTING
//     enumerateWithRetry/withReapTimeout machinery every consumer already has, zero new consumer code. A
//     CONFIRMED rejection (not a timeout) still falls back to enumerateProcessesPosixViaPs, unchanged.
//   - uptime is COSMETIC (feeds only creationTime, already best-effort/nullable today): a still-
//     outstanding read degrades silently to creationTime:null for every row; the call still resolves.
//     Critically, the uptime read runs CONCURRENTLY with the per-pid loop (kicked off before readdir,
//     joined only after the per-pid loop finishes) — awaiting it SEQUENTIALLY before the per-pid loop
//     would burn the whole shared deadline on a hang, leaving every per-pid race ~0ms to work with and
//     turning this one best-effort field into a total-enumeration failure.
//
// Round 2 (re-CR 483b6e0f) added: (1) a platform-agnostic confirmed-rejection scenario — the OLD version
// asserted settled==="rejected" for a rejecting readdir, which only held because the dev host has no
// real `ps`; on ubuntu-latest the ps-fallback actually spawns and RESOLVES, so that assertion goes RED on
// Linux CI (the 4e762baf class the Windows gate can't see) — fixed by injecting `psFallback` through the
// deps seam, so no real `ps` is ever spawned on ANY platform; (2) the POSIX_LISTING_JOINED_STALE marker
// and checkRootSurvival's consumption of it — a call that JOINS an in-flight readdir gets a listing taken
// BEFORE its own entry, and an absent root in that listing is NOT proof the root is gone NOW (the
// fail-open direction a kill/recycle decision must never take); (3) an uptime-rejection scenario and an
// end-to-end reapProcessesRootedInWorktree scenario (folded into the readdir-permanent-hang scenario,
// since both poison the same singleton slot — see the ordering note below); (4) joinSingletonPosixRead
// now wraps startRead() so a synchronous throw maps to {outcome:"rejected"} instead of risking an
// unhandled rejection of the un-awaited uptime promise. See the decision record's "Round 2" section.
//
// ⚠️ SCENARIO ORDER IS LOAD-BEARING, unlike the pid-keyed card's test file. There, each scenario used a
// disjoint fake PID range, so a deliberately-permanently-hung pid in one scenario could never collide
// with another. These two guards have NO key at all — there is exactly one shared slot per resource for
// this whole process — so a scenario that makes readdir (or uptime) hang FOREVER poisons that slot for
// every scenario that runs AFTER it in this same file. The only safe order: every scenario that needs a
// WORKING round-trip for a resource must run BEFORE the scenario that permanently hangs that resource,
// and "permanently hangs readdir" must be the very last thing in the file to touch readdir at all (since
// readdir is also a prerequisite for every other scenario's own pid listing).
//
// No real filesystem/process access anywhere in this file: EVERY scenario injects `readBootTimeMs`
// explicitly (even where uptime is not the thing under test), and the one scenario that exercises a
// CONFIRMED readdir rejection also injects `psFallback` — so no real `ps` is ever spawned on any
// platform either. No real pid is ever passed to a real kill/reaper.

import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-posix-enum-readdir-uptime-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { enumerateProcessesPosix, checkRootSurvival, reapProcessesRootedInWorktree, POSIX_LISTING_JOINED_STALE } =
  await import("../dist/pty/host.js");

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

const fakePidRecord = (pidStr) => ({ exePath: `/fake/${pidStr}`, cwd: null, commandLine: `fake-cmd-${pidStr}`, creationTicks: 100 });

// ── 1: a REJECTING (not hanging) readdir still takes the pre-existing ps-fallback path — injected, so ────
// this holds on EVERY platform (no real `ps` spawn, never dependent on whether this host has one).
{
  let psFallbackCallCount = 0;
  const deps = {
    listProcPids: async () => { throw new Error("simulated readdir rejection"); },
    readBootTimeMs: async () => null,
    psFallback: async () => {
      psFallbackCallCount++;
      return [{ pid: 9999, exePath: "/fake/ps-fallback", cwd: null, commandLine: null, creationTime: null, creationTicks: null, ppid: null }];
    },
  };
  const result = await raceSettle(enumerateProcessesPosix(500, deps), "(1) rejecting (not hanging) readdir", 5000);
  check("(1) a rejecting (not hanging) readdir takes the ps-fallback path (injected, platform-agnostic)",
    result?.settled === "resolved" && psFallbackCallCount === 1 && result.value?.[0]?.pid === 9999);
}

// ── 2: NEGATIVE CONTROL — readdir eventually resolves; a later call reads fresh ──────────────────────────
{
  const pids = ["8301"];
  let readdirCallCount = 0;
  let resolveReaddir;
  let firstReaddirPromise;
  const deps = {
    listProcPids: () => {
      readdirCallCount++;
      if (readdirCallCount === 1) {
        firstReaddirPromise = new Promise((resolve) => { resolveReaddir = resolve; });
        return firstReaddirPromise;
      }
      return Promise.resolve(pids);
    },
    readBootTimeMs: async () => null,
    readPidRecord: async (pidStr) => fakePidRecord(pidStr),
  };

  const result1 = await raceSettle(enumerateProcessesPosix(100, deps), "(2) call 1 (readdir times out)", 2000);
  check("(2) call 1 rejects with timedOut:true", result1?.settled === "rejected" && result1.err?.timedOut === true);

  resolveReaddir(pids);
  await firstReaddirPromise; // deterministic: production's own .then(clear, clear) was registered first

  const result2 = await raceSettle(enumerateProcessesPosix(1000, deps), "(2) call 2 (after readdir settled)", 2000);
  const row2 = result2?.value?.find((p) => p.pid === 8301);
  check("(2) NEGATIVE CONTROL: call 2, issued after the abandoned readdir resolved, succeeds with real data",
    result2?.settled === "resolved" && row2 != null && row2.exePath === "/fake/8301");
  check("(2) NEGATIVE CONTROL: listProcPids invoked exactly TWICE total (abandoned read + call 2's fresh one)",
    readdirCallCount === 2);
}

// ── 3: the JOINED-listing marker — set on a joiner's result, ABSENT from the owner's own result ─────────
{
  const pids = ["8401"];
  let readdirCallCount = 0;
  let resolveReaddir;
  const deps = {
    listProcPids: () => {
      readdirCallCount++;
      if (readdirCallCount === 1) return new Promise((resolve) => { resolveReaddir = resolve; });
      return Promise.resolve(pids);
    },
    readBootTimeMs: async () => null,
    readPidRecord: async (pidStr) => fakePidRecord(pidStr),
  };

  // Fired in direct succession, no intervening await: JS runs each call's synchronous prefix (through
  // its own first await) before yielding, so the OWNER call's listProcPids() call — and the slot write —
  // happen before the JOINER call even checks the slot. Deterministic, not a race.
  const ownerCall = enumerateProcessesPosix(2000, deps);
  const joinerCall = enumerateProcessesPosix(2000, deps);
  resolveReaddir(pids); // let the shared read settle quickly, so both calls resolve rather than time out

  const [ownerResult, joinerResult] = await Promise.all([
    raceSettle(ownerCall, "(3) owner call", 3000),
    raceSettle(joinerCall, "(3) joiner call", 3000),
  ]);
  check("(3) the OWNER call's listing is NOT marked joined-stale",
    ownerResult?.settled === "resolved" && !ownerResult.value[POSIX_LISTING_JOINED_STALE]);
  check("(3) the JOINER call's listing IS marked joined-stale",
    joinerResult?.settled === "resolved" && joinerResult.value[POSIX_LISTING_JOINED_STALE] === true);
  check("(3) listProcPids was invoked exactly ONCE total, shared by both calls", readdirCallCount === 1);
}

// ── 4: checkRootSurvival treats an ABSENT root in a joined-stale listing as an enumeration failure, ─────
// never a confident "gone" — the fail-open direction a kill/recycle decision must never take.
{
  const staleEmptyListing = [];
  staleEmptyListing[POSIX_LISTING_JOINED_STALE] = true;
  const result = await raceSettle(checkRootSurvival(9801, "fake-session-stale", 5000, async () => staleEmptyListing), "(4) checkRootSurvival (stale listing)", 2000);
  check("(4) checkRootSurvival reports enumerationFailed:true for an absent root in a STALE listing",
    result?.settled === "resolved" && result.value.enumerationFailed === true && result.value.foundAlive === false);

  // NEGATIVE CONTROL: the SAME absence in a FRESH (non-stale) listing keeps the pre-existing, unchanged
  // "confirmed gone" behavior — proving the new check is scoped to the stale flag alone.
  const freshEmptyListing = [];
  const result2 = await raceSettle(checkRootSurvival(9801, "fake-session-fresh", 5000, async () => freshEmptyListing), "(4) checkRootSurvival (fresh listing, negative control)", 2000);
  check("(4) NEGATIVE CONTROL: the SAME absence in a FRESH (non-stale) listing still reports confirmed gone",
    result2?.settled === "resolved" && result2.value.enumerationFailed === false && result2.value.foundAlive === false);
}

// ── 5: NEGATIVE CONTROL — uptime eventually resolves; a later call gets a real creationTime ──────────────
{
  const pids = ["8201"];
  let uptimeCallCount = 0;
  let resolveUptime;
  let firstUptimePromise;
  const deps = {
    listProcPids: async () => pids,
    readBootTimeMs: () => {
      uptimeCallCount++;
      if (uptimeCallCount === 1) {
        firstUptimePromise = new Promise((resolve) => { resolveUptime = resolve; });
        return firstUptimePromise;
      }
      return Promise.resolve(1_700_000_000_000);
    },
    readPidRecord: async (pidStr) => fakePidRecord(pidStr),
  };

  const result1 = await raceSettle(enumerateProcessesPosix(100, deps), "(5) call 1 (uptime times out)", 2000);
  const row1 = result1?.value?.find((p) => p.pid === 8201);
  check("(5) call 1 resolves with creationTime null (uptime unresolved) and the real exe path present",
    result1?.settled === "resolved" && row1 != null && row1.creationTime === null && row1.exePath === "/fake/8201");

  resolveUptime(1_700_000_000_000);
  await firstUptimePromise; // deterministic: production's own .then(clear, clear) was registered first

  const result2 = await raceSettle(enumerateProcessesPosix(1000, deps), "(5) call 2 (after uptime settled)", 2000);
  const row2 = result2?.value?.find((p) => p.pid === 8201);
  check("(5) NEGATIVE CONTROL: call 2, issued after the abandoned uptime read resolved, gets a real (non-null) creationTime",
    result2?.settled === "resolved" && row2 != null && row2.creationTime !== null);
  check("(5) NEGATIVE CONTROL: readBootTimeMs invoked exactly TWICE total (abandoned read + call 2's fresh one)",
    uptimeCallCount === 2);
}

// ── 6: a REJECTING (not hanging) uptime degrades to creationTime:null WITHOUT rejecting the enumeration ─
{
  const pids = ["8501"];
  const deps = {
    listProcPids: async () => pids,
    readBootTimeMs: async () => { throw new Error("simulated uptime rejection"); },
    readPidRecord: async (pidStr) => fakePidRecord(pidStr),
  };
  const result = await raceSettle(enumerateProcessesPosix(500, deps), "(6) rejecting (not hanging) uptime", 2000);
  const row = result?.value?.find((p) => p.pid === 8501);
  check("(6) the enumeration RESOLVES (never rejects) when uptime rejects", result?.settled === "resolved");
  check("(6) the row has creationTime null and real exePath/cwd/commandLine (readUnverified absent)",
    row != null && !row.readUnverified && row.exePath === "/fake/8501" && row.creationTime === null);
}

// ── 6b: nitpick (CR 483b6e0f) — a SYNCHRONOUS throw from startRead() (uptime here) must map to ──────────
// {outcome:"rejected"} rather than escape as an unhandled rejection of the un-awaited uptime promise.
{
  let unhandled = null;
  const onUnhandledRejection = (reason) => { unhandled = reason; };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const pids = ["8601"];
    const deps = {
      listProcPids: async () => pids,
      // NOT an async function — throws BEFORE returning any promise at all, unlike every other
      // "rejecting" scenario in this file (those are async functions, which never throw synchronously).
      readBootTimeMs: () => { throw new Error("simulated SYNCHRONOUS throw from readBootTimeMs"); },
      readPidRecord: async (pidStr) => fakePidRecord(pidStr),
    };
    const result = await raceSettle(enumerateProcessesPosix(500, deps), "(6b) synchronous uptime throw", 2000);
    const row = result?.value?.find((p) => p.pid === 8601);
    check("(6b) a synchronous throw from readBootTimeMs still degrades to creationTime:null (never crashes the enumeration)",
      result?.settled === "resolved" && row != null && row.creationTime === null && !row.readUnverified);
    // Wait exactly ONE event-loop turn (never a guessed duration): Node's own unhandledRejection
    // detection runs once the microtask queue has drained for the current turn; setImmediate schedules
    // the NEXT turn, both necessary and sufficient here, unlike a sleep(ms) guess at "long enough".
    await new Promise((resolve) => setImmediate(resolve));
    check("(6b) the synchronous throw never surfaces as an unhandled promise rejection", unhandled === null);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
}

// ── 7: /proc/uptime never settles — every row still gets real exe/cwd/cmdline, ONLY creationTime is ──────
// null (never readUnverified); reader invoked exactly once across 5 calls. Permanently poisons the
// uptime slot — nothing later in this file needs a working uptime read.
{
  const pids = ["8101", "8102"];
  let uptimeCallCount = 0;
  const deps = {
    listProcPids: async () => pids,
    readBootTimeMs: () => { uptimeCallCount++; return new Promise(() => {}); },
    // A REAL (if tiny) delay, not an instantly-resolving fake: a microtask-fast fake would win even a
    // ~1ms remaining race under the (now-fixed) sequential-order regression, masking it. This delay is
    // what makes the per-pid race's remaining budget load-bearing enough to discriminate the two orderings.
    readPidRecord: async (pidStr) => { await new Promise((resolve) => setTimeout(resolve, 15)); return fakePidRecord(pidStr); },
  };

  for (let i = 0; i < 5; i++) {
    const result = await raceSettle(enumerateProcessesPosix(100, deps), `(7.${i})`, 2000);
    const ok = result?.settled === "resolved" && pids.every((p) => {
      const row = result.value.find((r) => r.pid === Number(p));
      return row != null && !row.readUnverified && row.exePath === `/fake/${p}` && row.commandLine === `fake-cmd-${p}` && row.creationTime === null;
    });
    check(`(7.${i}) call ${i + 1} resolves with readUnverified ABSENT and real exePath/cwd/commandLine on every row — only creationTime is null`, ok);
  }
  check("(7) readBootTimeMs was invoked exactly ONCE total across 5 enumeration calls",
    uptimeCallCount === 1);
}

// ── 8: readdir("/proc") never settles — covers both the DIRECT enumerateProcessesPosix shape and the ────
// END-TO-END reapProcessesRootedInWorktree shape against the SAME hung read (folded together since both
// permanently poison the readdir slot — a second, separate permanent hang could never be isolated from
// this one). MUST be last — readdir is also every other scenario's own pid-listing prerequisite.
{
  let callCount = 0;
  const deps = {
    listProcPids: () => { callCount++; return new Promise(() => {}); },
    readBootTimeMs: async () => null,
  };

  for (let i = 0; i < 5; i++) {
    const result = await raceSettle(enumerateProcessesPosix(100, deps), `(8.${i})`, 2000);
    check(`(8.${i}) call ${i + 1} rejects with timedOut:true while readdir("/proc") is still hung`,
      result?.settled === "rejected" && result.err?.timedOut === true);
  }
  check("(8) listProcPids was invoked exactly ONCE total across 5 direct enumeration calls",
    callCount === 1);

  // End-to-end: the SAME still-hung readdir, driven through reapProcessesRootedInWorktree's own retry.
  const killCalls = [];
  const e2eResult = await raceSettle(reapProcessesRootedInWorktree("/fake/worktree", {
    enumerate: (timeoutMs) => enumerateProcessesPosix(timeoutMs, deps),
    kill: (pid) => { killCalls.push(pid); },
    timeoutMs: 100,
  }), "(8) end-to-end reapProcessesRootedInWorktree", 5000);
  check("(8) end-to-end: reapProcessesRootedInWorktree resolves with enumerationFailed:true (never throws past its own catch)",
    e2eResult?.settled === "resolved" && e2eResult.value.enumerationFailed === true);
  check("(8) end-to-end: nothing was killed", killCalls.length === 0 && (e2eResult?.value?.killedPids?.length ?? -1) === 0);
  check("(8) end-to-end: listProcPids is STILL invoked only ONCE total — enumerateWithRetry's own 2nd attempt JOINED the same hang rather than starting a new read",
    callCount === 1);
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
fs.rmSync(tmpHome, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
