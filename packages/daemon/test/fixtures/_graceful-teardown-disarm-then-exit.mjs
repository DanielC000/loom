// Card 347b3584 round 3 nitpick 7 fixture: arms the REAL armHardShutdownWatchdog, calls disarm()
// EXPLICITLY, then exits normally — the shape a real teardown actually takes (arm -> do work -> disarm ->
// exit). Restores test (B)'s original intent, which had silently collapsed onto the SAME fixture/args as
// test (C) (_graceful-teardown-clean.mjs, which deliberately never disarms to prove .unref() alone is
// enough) — so (B) never actually exercised the disarm() path it claimed to. Used by
// test/graceful-teardown-hard-exit-backstop.mjs. argv[2]=hardExitMs.
//
// @decision 347b3584 — round 4 finding 1: exiting right after disarm() can't actually catch a BROKEN
// (no-op) disarm(), because the watchdog's Worker is `.unref()`'d regardless — a trivial process with
// nothing else to do exits naturally almost immediately either way, the exact same shape test (C) proves
// for the never-disarmed case. So this fixture now stays alive PAST hardExitMs on its own (a plain
// setTimeout, which DOES hold the event loop open, unlike the unref'd watchdog Worker) before exiting —
// a genuinely-disarmed watchdog never fires during that window; a no-op disarm() still has a LIVE watchdog
// armed, which fires at hardExitMs and kills the process (writing the record file) before this fixture's
// own timer ever gets to complete it cleanly.
//
// @decision 347b3584 — round 3: even on the disarmed path, a broken disarm()/unref() could in theory leave
// the watchdog live long enough to fire and write the real record file (resolved from LOOM_HOME) — call
// requireHermeticEnv() before arming regardless, so a bare `node <this file>.mjs` run with no LOOM_HOME
// set refuses instead of risking a write into the real ~/.loom.
import { requireHermeticEnv } from "../_guard.mjs";
import { armHardShutdownWatchdog } from "../../dist/graceful-teardown.js";

requireHermeticEnv();

const hardExitMs = Number(process.argv[2]);
console.log(`[fixture] pid=${process.pid} arming watchdog hardExitMs=${hardExitMs} — then disarming explicitly before exit`);
const watchdog = armHardShutdownWatchdog({ hardExitMs, intendedExitCode: 0, label: "test-disarm-then-exit" });
watchdog.step("doing-some-work");
watchdog.disarm();
console.log("[fixture] disarmed — now staying alive past hardExitMs to prove disarm() actually suppressed the watchdog (a broken no-op disarm() would instead get killed by the still-live watchdog before this timer fires)");
setTimeout(() => {
  console.log("[fixture] survived past hardExitMs, exiting normally");
  process.exit(0);
}, hardExitMs + 1000);
