// Card 347b3584 fixture (round 2 nitpick 4): arms the REAL armHardShutdownWatchdog with a generous
// hardExitMs and then returns WITHOUT ever calling disarm() — the honest test of `.unref()`. If `.unref()`
// genuinely stops the watchdog's Worker handle from counting toward the event loop, this process has
// nothing else keeping it alive and exits naturally (code 0, near-instantly) the moment this script
// finishes, long before hardExitMs could ever fire the force-kill path. If `.unref()` were broken, this
// process would instead sit alive until the worker's own Atomics.wait(hardExitMs) timeout elapses and
// force-kills it — observably slower, and via the kill path rather than a natural exit. Used by
// test/graceful-teardown-hard-exit-backstop.mjs. argv[2]=hardExitMs.
//
// @decision 347b3584 — round 3: if .unref() is ever broken, this fixture's watchdog WOULD fire and write
// the real record file (resolved from LOOM_HOME) — call requireHermeticEnv() before arming regardless, so
// a bare `node <this file>.mjs` run with no LOOM_HOME set refuses instead of risking a write into the
// real ~/.loom.
import { requireHermeticEnv } from "../_guard.mjs";
import { armHardShutdownWatchdog } from "../../dist/graceful-teardown.js";

requireHermeticEnv();

const hardExitMs = Number(process.argv[2]);
console.log(`[fixture] pid=${process.pid} arming watchdog hardExitMs=${hardExitMs} — never disarming (proving .unref() alone lets this exit naturally)`);
armHardShutdownWatchdog({ hardExitMs, intendedExitCode: 0, label: "test-unref-honest" });
console.log("[fixture] returning without calling disarm() — if .unref() works, the process exits now anyway");
