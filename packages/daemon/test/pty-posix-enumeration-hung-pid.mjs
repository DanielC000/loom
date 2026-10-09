// Card 2b7df434. Round 1 (f12af7c3) tracked an in-flight per-pid `/proc` read in a Set and SKIPPED any
// later call that found a pid already marked — correct for a GENUINELY hung read, but `Promise.all`
// marks every pid "in flight" the instant two enumerations merely OVERLAP in time, which is routine on a
// healthy host (checkRootSurvival runs up to ROOT_REAP_ENUMERATION_CONCURRENCY-wide; reap/attribution
// aren't semaphored at all). Measured regression (CR bdd12be5): 200 healthy pids at 20ms each, a
// concurrent checkRootSurvival came back enumerationFailed, a concurrent reap killed 0 of 200.
//
// Round 2 replaced the Set with a dedup Map<pidStr, Promise<record>>: a later caller for a pid already
// being read JOINS that shared read (never starts a second one) — a healthy read resolves for every
// joiner with REAL data; only a read still pending past this caller's own bound yields `readUnverified`.
//
// Round 3 (re-CR d25075d5): round 2 bounded each pid by a FRACTION (0.5×) of timeoutMs, computed fresh
// per pid — since every pid in one `Promise.all` starts at roughly the same instant, that fraction acted
// as the WHOLE call's effective deadline, ~4× tighter than this call's own budget under contention. Now
// every pid races the REMAINING time to ONE shared `deadline` (this call's entry time + its own
// `timeoutMs`), computed once. See docs/decisions/2b7df434-posix-enumeration-hung-pid-tracking.md.
//
// No real filesystem or process access anywhere in this file — every scenario drives
// `enumerateProcessesPosix`'s own `PosixEnumerationDeps` seam (or the three consumers' own `enumerate`
// param) with fully-injected fakes, so this is OS-independent by construction. Every potentially-hanging
// call is wrapped in `raceTest` (a TEST-LEVEL bounded race, independent of the production join bound) so
// a real regression prints a named FAIL instead of the whole file hanging or exiting with an opaque code.
//
// Pid ranges are disjoint per scenario (92xx/93xx/94xx/95xx/...) because the dedup map is a module-level
// singleton that persists for this whole process, and scenario B deliberately leaves its hung pid's real
// read permanently pending for the rest of the run.

import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-posix-enum-hung-pid-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { enumerateProcessesPosix, checkRootSurvival, reapProcessesRootedInWorktree, attributeProcessesToWorktree } =
  await import("../dist/pty/host.js");

/** TEST-LEVEL bounded race (never the production join bound): if a regression reintroduces an unbounded
 *  hang anywhere in this file, this reports a named FAIL instead of the process hanging or exiting with
 *  an opaque code. Returns `undefined` (and logs the FAIL) on timeout — callers must guard for that. */
async function raceTest(promise, label, ms = 3000) {
  const TIMED_OUT = Symbol("test-bound-timeout");
  let timer;
  try {
    const result = await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); }),
    ]);
    if (result === TIMED_OUT) {
      check(`${label} — did not hang past this test's own ${ms}ms bound`, false);
      return undefined;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** A controllable fake per-pid reader. `specs[pidStr]` of `{mode:"never"}` never settles;
 *  `{mode:"delay", ms}` resolves after `ms`; `{mode:"reject", message}` rejects once; omitted means
 *  "resolve immediately with fake data". Exposes `callCounts` (invocations per pid). */
function makeControllableReader(specs) {
  const callCounts = {};
  const reader = (pidStr) => {
    callCounts[pidStr] = (callCounts[pidStr] ?? 0) + 1;
    const spec = specs[pidStr];
    const fakeRecord = { exePath: `/fake/${pidStr}`, cwd: null, commandLine: `fake-cmd-${pidStr}`, creationTicks: null };
    if (!spec) return Promise.resolve(fakeRecord);
    if (spec.mode === "never") return new Promise(() => {}); // deliberately never settles
    if (spec.mode === "reject") return Promise.reject(new Error(spec.message ?? "simulated read failure"));
    return new Promise((resolve) => setTimeout(() => resolve(fakeRecord), spec.ms));
  };
  return { reader, callCounts };
}

// ── Scenario A: the CR's own regression case — two OVERLAPPING enumerations of N healthy pids BOTH ────
// get real rows for every pid, with each pid read exactly once (RED on f12af7c3: call 2 used to come
// back almost entirely readSkipped placeholders for pids that were never hung at all).
{
  const N = 20;
  const pids = Array.from({ length: N }, (_, i) => String(9200 + i));
  const specs = {};
  for (const p of pids) specs[p] = { mode: "delay", ms: 15 };
  const { reader, callCounts } = makeControllableReader(specs);
  const deps = { listProcPids: async () => pids, readBootTimeMs: async () => null, readPidRecord: reader };

  const call1 = enumerateProcessesPosix(1000, deps);
  const call2 = enumerateProcessesPosix(1000, deps); // fired immediately — overlaps call1's in-flight reads

  const [result1, result2] = await Promise.all([raceTest(call1, "(A) call 1", 3000), raceTest(call2, "(A) call 2", 3000)]);

  if (result1 && result2) {
    const allReal = (result) => pids.every((p) => {
      const row = result.find((r) => r.pid === Number(p));
      return row != null && !row.readUnverified && row.exePath === `/fake/${p}`;
    });
    check(`(A) overlapping call 1 gets REAL data for every one of ${N} healthy pids (not readUnverified)`, allReal(result1));
    check(`(A) overlapping call 2 ALSO gets REAL data for every one of ${N} healthy pids — this was the regression (0/200 before the fix)`, allReal(result2));
    check(`(A) every one of the ${N} healthy pids was read EXACTLY once total, shared by both overlapping calls`,
      pids.every((p) => callCounts[p] === 1));
  }
}

// ── Scenario B: a GENUINELY hung pid still yields readUnverified after this call's own join bound, with
// the reader invoked exactly once across 5 successive enumerations (round 1's bound this card exists to
// provide, preserved under the new dedup mechanism). Uses a short timeoutMs so every call — including
// the very first, which also races its own join bound rather than blocking forever — settles quickly.
{
  const pids = ["9301", "9302"]; // 9301 hangs forever; 9302 is healthy
  const { reader, callCounts } = makeControllableReader({ "9301": { mode: "never" } });
  const deps = { listProcPids: async () => pids, readBootTimeMs: async () => null, readPidRecord: reader };
  const SHORT_TIMEOUT_MS = 100; // join bound = 50ms

  for (let i = 0; i < 5; i++) {
    const result = await raceTest(enumerateProcessesPosix(SHORT_TIMEOUT_MS, deps), `(B.${i})`, 2000);
    if (!result) continue;
    const row9301 = result.find((p) => p.pid === 9301);
    const row9302 = result.find((p) => p.pid === 9302);
    check(`(B.${i}) the hung pid 9301 is reported readUnverified once this call's own join bound elapses`,
      row9301 != null && row9301.readUnverified === true);
    check(`(B.${i}) the healthy pid 9302 still gets real data in the same call`,
      row9302 != null && !row9302.readUnverified && row9302.exePath === "/fake/9302");
  }
  check("(B) pid 9301's reader was invoked exactly ONCE total across 5 enumeration calls — the bound this card exists to provide",
    callCounts["9301"] === 1);
  check("(B) pid 9302 (healthy) was read fresh on every single call (5 times — never deduped against a completed read)",
    callCounts["9302"] === 5);
}

// ── Scenario C: a single-pid version of (A), plus the retained NEGATIVE CONTROL — once the shared read
// has genuinely settled, a LATER call reads that pid fresh again rather than reusing stale data forever.
{
  const pids = ["9401"];
  const { reader, callCounts } = makeControllableReader({ "9401": { mode: "delay", ms: 40 } });
  const deps = { listProcPids: async () => pids, readBootTimeMs: async () => null, readPidRecord: reader };

  const call1 = enumerateProcessesPosix(1000, deps);
  const call2 = enumerateProcessesPosix(1000, deps); // fired immediately — overlaps call1's in-flight read
  const [result1, result2] = await Promise.all([raceTest(call1, "(C) call 1", 3000), raceTest(call2, "(C) call 2", 3000)]);

  if (result1 && result2) {
    const row1 = result1.find((p) => p.pid === 9401);
    const row2 = result2.find((p) => p.pid === 9401);
    check("(C) the call that started the read gets the REAL row", row1 != null && !row1.readUnverified && row1.exePath === "/fake/9401");
    check("(C) a CONCURRENT call during pid 9401's short healthy delay ALSO gets the REAL row (not readUnverified)",
      row2 != null && !row2.readUnverified && row2.exePath === "/fake/9401");
    check("(C) pid 9401's reader was invoked exactly ONCE total, shared by both overlapping calls", callCounts["9401"] === 1);
  }

  const resultAfter = await raceTest(enumerateProcessesPosix(1000, deps), "(C) call 3 (after settlement)", 3000);
  if (resultAfter) {
    const rowAfter = resultAfter.find((p) => p.pid === 9401);
    check("(C) NEGATIVE CONTROL: a call AFTER the original read settled reads pid 9401 fresh again (not a stale cache)",
      rowAfter != null && !rowAfter.readUnverified);
    check("(C) NEGATIVE CONTROL: pid 9401's reader was invoked a SECOND time by that later call", callCounts["9401"] === 2);
  }
}

// ── Scenario D: a REJECTED read must not poison a later, fresh attempt for the same pid ────────────────
{
  const pids = ["9501"];
  const { reader, callCounts } = makeControllableReader({ "9501": { mode: "reject", message: "simulated read failure (first attempt)" } });
  const deps = { listProcPids: async () => pids, readBootTimeMs: async () => null, readPidRecord: reader };

  const result1 = await raceTest(enumerateProcessesPosix(200, deps), "(D) call 1 (rejecting read)", 2000);
  if (result1) {
    const row1 = result1.find((p) => p.pid === 9501);
    check("(D) a rejected read degrades to readUnverified for the caller that hit it (never crashes, never 'gone')",
      row1 != null && row1.readUnverified === true);
  }

  // A later, non-overlapping call must NOT be poisoned by the earlier rejection.
  const { reader: reader2, callCounts: callCounts2 } = makeControllableReader({}); // this pid now resolves cleanly
  const deps2 = { listProcPids: async () => pids, readBootTimeMs: async () => null, readPidRecord: reader2 };
  const result2 = await raceTest(enumerateProcessesPosix(200, deps2), "(D) call 2 (after the rejection, fresh reader)", 2000);
  if (result2) {
    const row2 = result2.find((p) => p.pid === 9501);
    check("(D) a later call is NOT poisoned by the earlier rejection — it reads pid 9501 fresh and succeeds",
      row2 != null && !row2.readUnverified && row2.exePath === "/fake/9501");
  }
  check("(D) the rejecting reader was invoked exactly once (never silently retried internally, never stuck on the dead promise)",
    callCounts["9501"] === 1);
  check("(D) the fresh reader for the later call was invoked exactly once (a genuinely new read, not a reused rejection)",
    callCounts2["9501"] === 1);
}

// ── Scenario E: checkRootSurvival treats a readUnverified row for the QUERIED pid as an enumeration ────
// failure — never "gone", never a confirmed match (recycleWorker's safety gate depends on this).
{
  const result = await raceTest(checkRootSurvival(9602, "fake-session-e", 5000, async () => [
    { pid: 9602, exePath: null, cwd: null, commandLine: null, creationTime: null, creationTicks: null, ppid: null, readUnverified: true },
  ]), "(E) checkRootSurvival", 2000);
  if (result) {
    check("(E) checkRootSurvival reports enumerationFailed:true for a readUnverified row on the queried pid",
      result.enumerationFailed === true);
    check("(E) checkRootSurvival never reports foundAlive:true or identityConfirmed:true for it",
      result.foundAlive === false && result.identityConfirmed === false);
  }
}

// ── Scenario F: reapProcessesRootedInWorktree never kills a readUnverified row, and surfaces it ────────
{
  const killCalls = [];
  const result = await raceTest(reapProcessesRootedInWorktree("/fake/worktree", {
    enumerate: async () => [
      { pid: 9603, exePath: null, cwd: null, commandLine: null, creationTime: null, creationTicks: null, ppid: null, readUnverified: true },
    ],
    kill: (pid) => { killCalls.push(pid); },
  }), "(F) reapProcessesRootedInWorktree", 2000);
  if (result) {
    check("(F) reapProcessesRootedInWorktree never kills a readUnverified row", killCalls.length === 0 && result.killedPids.length === 0);
    check("(F) reapProcessesRootedInWorktree surfaces the skipped pid via skippedUnverifiedPids",
      Array.isArray(result.skippedUnverifiedPids) && result.skippedUnverifiedPids.includes(9603));
  }
}

// ── Scenario G: attributeProcessesToWorktree excludes a readUnverified row from matched, surfaces it ───
{
  const result = await raceTest(attributeProcessesToWorktree("/fake/worktree", {
    enumerate: async () => [
      { pid: 9604, exePath: null, cwd: null, commandLine: null, creationTime: null, creationTicks: null, ppid: null, readUnverified: true },
    ],
  }), "(G) attributeProcessesToWorktree", 2000);
  if (result) {
    check("(G) attributeProcessesToWorktree excludes a readUnverified row from matched", result.matched.length === 0);
    check("(G) attributeProcessesToWorktree still counts it in totalProcessesScanned", result.totalProcessesScanned === 1);
    check("(G) attributeProcessesToWorktree surfaces the skipped pid via skippedUnverifiedPids",
      Array.isArray(result.skippedUnverifiedPids) && result.skippedUnverifiedPids.includes(9604));
  }
}

// ── Scenario H: the LIFECYCLE after an unverified timeout — the abandoned shared read is NOT actually
// hung, just slower than call 1's own deadline; once it eventually resolves, the map entry clears, and a
// LATER call reads this pid genuinely fresh (never stuck joining a dead promise forever).
{
  const pids = ["9701"];
  const callCounts = { "9701": 0 };
  let resolveFirstRead;
  let firstReadPromise;
  const reader = (pidStr) => {
    callCounts[pidStr]++;
    if (callCounts[pidStr] === 1) {
      firstReadPromise = new Promise((resolve) => { resolveFirstRead = resolve; });
      return firstReadPromise;
    }
    return Promise.resolve({ exePath: `/fake/${pidStr}-fresh`, cwd: null, commandLine: null, creationTicks: null });
  };
  const deps = { listProcPids: async () => pids, readBootTimeMs: async () => null, readPidRecord: reader };

  // Call 1's deadline is short — the first read (above) won't resolve within it, so call 1 gives up and
  // reports readUnverified, while the real read keeps running (abandoned, not cancelled).
  const result1 = await raceTest(enumerateProcessesPosix(50, deps), "(H) call 1 (times out waiting)", 2000);
  if (result1) {
    const row1 = result1.find((p) => p.pid === 9701);
    check("(H) call 1 gets readUnverified once its own deadline elapses, while the real read is still pending",
      row1 != null && row1.readUnverified === true);
  }

  // Now let the ABANDONED shared read actually resolve — it was never hung, just too slow for call 1.
  resolveFirstRead({ exePath: "/fake/9701-abandoned", cwd: null, commandLine: null, creationTicks: null });
  // Deterministic sequencing (no guessed wait): the production code's own `.then(clear, clear)` was
  // registered on this exact promise BEFORE this test ever ran, so awaiting the SAME promise object here
  // is guaranteed to resume only AFTER that clear has already executed (same-promise `.then()` callbacks
  // run in registration order).
  await firstReadPromise;

  const result2 = await raceTest(enumerateProcessesPosix(1000, deps), "(H) call 2 (after the entry cleared)", 2000);
  if (result2) {
    const row2 = result2.find((p) => p.pid === 9701);
    check("(H) call 2, issued after the abandoned read resolved and the entry cleared, reads pid 9701 FRESH",
      row2 != null && !row2.readUnverified && row2.exePath === "/fake/9701-fresh");
  }
  check("(H) the reader was invoked exactly TWICE total: once for the abandoned-but-eventually-resolving read, once for call 2's genuinely fresh read",
    callCounts["9701"] === 2);
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
fs.rmSync(tmpHome, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
