// Card fc53ea74 Code Review follow-up — regression coverage for scripts/test-daemon.mjs's
// `sweepOrphanedDiskProbeFiles`: DISK_PROBE_FILE is pid-qualified (`.disk-probe-<pid>.bin`) so two
// concurrent test-daemon.mjs processes never corrupt each other's disk-I/O sample, but a process that
// never reaches its own cleanup (a hard kill) orphans its file forever without this sweep.
//
// Fully hermetic — no daemon, no claude; a synthetic gate-timing directory, no real process is killed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { sweepOrphanedDiskProbeFiles } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "scripts", "test-daemon.mjs")).href
);

// A pid astronomically unlikely to exist on any real host — `process.kill(pid, 0)` on this must throw
// ESRCH. Verified via a positive control below rather than assumed.
const DEAD_PID = 999_999;
check(
  "sanity: the chosen DEAD_PID is actually NOT alive on this host (positive control on the probe itself)",
  (() => { try { process.kill(DEAD_PID, 0); return false; } catch (err) { return err?.code === "ESRCH"; } })(),
);

function makeFixtureHome() {
  const home = mkdtempManaged("loom-disk-probe-sweep-");
  fs.mkdirSync(path.join(home, "gate-timing"), { recursive: true });
  return home;
}

// --- a dead-pid file IS removed ---
{
  const home = makeFixtureHome();
  const deadFile = path.join(home, "gate-timing", `.disk-probe-${DEAD_PID}.bin`);
  fs.writeFileSync(deadFile, "stale");
  sweepOrphanedDiskProbeFiles(home);
  check("a .disk-probe-<dead-pid>.bin file IS removed", !fs.existsSync(deadFile));
}

// --- a live-pid file (this process's own pid, standing in for "some other still-running sibling") is
// NEVER removed --- the liveness check, not identity, is what protects it; a REAL other process's pid
// would be just as protected.
{
  const home = makeFixtureHome();
  const liveFile = path.join(home, "gate-timing", `.disk-probe-${process.pid}.bin`);
  fs.writeFileSync(liveFile, "live");
  sweepOrphanedDiskProbeFiles(home);
  check("a .disk-probe-<live-pid>.bin file is NEVER removed", fs.existsSync(liveFile));
}

// --- an unrelated file in the SAME directory is never touched (scope is strictly the .disk-probe-*.bin
// filename shape, never a blanket sweep of gate-timing/) ---
{
  const home = makeFixtureHome();
  const unrelated = path.join(home, "gate-timing", "daemon-per-file-timing.ndjson");
  fs.writeFileSync(unrelated, "{}");
  const deadFile = path.join(home, "gate-timing", `.disk-probe-${DEAD_PID}.bin`);
  fs.writeFileSync(deadFile, "stale");
  sweepOrphanedDiskProbeFiles(home);
  check("an unrelated gate-timing/ file is left untouched", fs.existsSync(unrelated));
  check("the dead-pid file alongside it still IS removed (scope check didn't just no-op the whole sweep)", !fs.existsSync(deadFile));
}

// --- a missing gate-timing/ directory entirely (first-ever run) never throws ---
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "loom-disk-probe-sweep-nodir-"));
  let threw = false;
  try { sweepOrphanedDiskProbeFiles(home); } catch { threw = true; }
  check("a missing gate-timing/ directory never throws", !threw);
}

console.log(`\n${failures === 0 ? "✅" : "❌"} test-daemon-disk-probe-sweep: ${failures} check(s) failed.`);
await finishAndExit(failures === 0 ? 0 : 1);
