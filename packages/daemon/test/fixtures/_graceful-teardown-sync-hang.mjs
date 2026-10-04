// Card 347b3584 fixture: arms the REAL armHardShutdownWatchdog, then blocks the MAIN thread genuinely
// synchronously (Atomics.wait with no timeout — zero event-loop activity, exactly the shape a stalled
// console/pipe write or a hung sync subprocess call takes). Never calls disarm. Used by
// test/graceful-teardown-hard-exit-backstop.mjs to prove the watchdog force-exits the whole process
// within its configured window, preserving the requested exit code, even though nothing on the main
// thread ever runs again. argv[2]=hardExitMs, argv[3]=intendedExitCode.
//
// argv[4] (optional, round 5 card 0dc09fab): a module path/URL to import armHardShutdownWatchdog from
// INSTEAD of the real dist/graceful-teardown.js — lets a caller test against a PATCHED COPY (e.g. a
// stand-in win32 PowerShell script) without mutating the shared installed dist file, which would
// otherwise race any OTHER concurrently-running process/test importing from it. Every existing caller
// omits this arg and gets byte-identical behavior.
//
// argv[5] (optional, round 6 card e34cb710): a signed ms offset applied to THIS FIXTURE'S OWN (main
// thread) `Date.now()` before arming — simulates a wall-clock jump landing on the PARENT side (the one
// that WRITES the deadline), as distinct from argv[4]'s worker-source patches, which simulate a jump on
// the worker's own READ side. Scoped to this one process's main thread only — a watchdog's worker thread
// has its own independent global `Date`, never affected by a parent-thread patch like this one. Every
// existing caller omits this arg and gets byte-identical behavior.
//
// @decision 347b3584 — round 3: this fixture's watchdog WILL fire (by design) and write the real record
// file, which resolves from LOOM_HOME — call requireHermeticEnv() before arming, so a bare `node
// <this file>.mjs` run with no LOOM_HOME set refuses instead of writing into the real ~/.loom.
import { requireHermeticEnv } from "../_guard.mjs";

requireHermeticEnv();

const hardExitMs = Number(process.argv[2]);
const intendedExitCode = Number(process.argv[3]);
const moduleOverride = process.argv[4];
const parentDateNowSkewMs = process.argv[5] !== undefined && process.argv[5] !== "" ? Number(process.argv[5]) : null;
const { armHardShutdownWatchdog } = await import(moduleOverride || "../../dist/graceful-teardown.js");

if (parentDateNowSkewMs !== null) {
  const realDateNow = Date.now.bind(Date);
  Date.now = function () { return realDateNow() + parentDateNowSkewMs; };
}

console.log(`[fixture] pid=${process.pid} arming watchdog hardExitMs=${hardExitMs} intendedExitCode=${intendedExitCode}`);
const watchdog = armHardShutdownWatchdog({ hardExitMs, intendedExitCode, label: "test-sync-hang" });
watchdog.step("about-to-hang");

// Genuinely, synchronously block the main thread forever — no timeout, no timers, no I/O after this.
const sab = new SharedArrayBuffer(4);
Atomics.wait(new Int32Array(sab), 0, 0);
console.log("[fixture] UNREACHABLE — the watchdog failed to terminate this process");
