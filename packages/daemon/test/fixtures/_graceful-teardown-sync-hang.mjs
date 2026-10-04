// Card 347b3584 fixture: arms the REAL armHardShutdownWatchdog, then blocks the MAIN thread genuinely
// synchronously (Atomics.wait with no timeout — zero event-loop activity, exactly the shape a stalled
// console/pipe write or a hung sync subprocess call takes). Never calls disarm. Used by
// test/graceful-teardown-hard-exit-backstop.mjs to prove the watchdog force-exits the whole process
// within its configured window, preserving the requested exit code, even though nothing on the main
// thread ever runs again. argv[2]=hardExitMs, argv[3]=intendedExitCode.
//
// @decision 347b3584 — round 3: this fixture's watchdog WILL fire (by design) and write the real record
// file, which resolves from LOOM_HOME — call requireHermeticEnv() before arming, so a bare `node
// <this file>.mjs` run with no LOOM_HOME set refuses instead of writing into the real ~/.loom.
import { requireHermeticEnv } from "../_guard.mjs";
import { armHardShutdownWatchdog } from "../../dist/graceful-teardown.js";

requireHermeticEnv();

const hardExitMs = Number(process.argv[2]);
const intendedExitCode = Number(process.argv[3]);

console.log(`[fixture] pid=${process.pid} arming watchdog hardExitMs=${hardExitMs} intendedExitCode=${intendedExitCode}`);
const watchdog = armHardShutdownWatchdog({ hardExitMs, intendedExitCode, label: "test-sync-hang" });
watchdog.step("about-to-hang");

// Genuinely, synchronously block the main thread forever — no timeout, no timers, no I/O after this.
const sab = new SharedArrayBuffer(4);
Atomics.wait(new Int32Array(sab), 0, 0);
console.log("[fixture] UNREACHABLE — the watchdog failed to terminate this process");
