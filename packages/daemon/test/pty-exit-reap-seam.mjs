// Regression guard for board card d634cd2e (review lane b14d3441, finding M4): `test/_seam-host-fixture.mjs`'s
// shared fake pty — used by ~279 test files — returns a fixed, FICTIONAL `pid: 4242`, and its `kill()`
// synchronously fires the REAL `onExit` callback PtyHost's own `spawn()` registers (the same one production
// uses). Before this card, that `onExit` called `reapOrphanedDescendants(live.pid)` UNCONDITIONALLY — so
// every hermetic test using that fixture's `kill()` ran a real `ps -eo pid,ppid` / `Get-CimInstance
// Win32_Process` enumeration and SIGKILL-walked the real descendants of whatever pid 4242 happens to be on
// the host — harmless on a Windows dev box, but a real pid 4242 on Linux CI is plausible (the card 4e762baf
// flaky-lane class).
//
// This proves the FIX (PtyHost.reapExitedDescendants — the injectable seam `_seam-host-fixture.mjs` now
// overrides to a no-op) by OBSERVING THE SIDE EFFECT, not by trusting the override exists: the real reaper
// (card 7d58a1aa) is the ONE place this is observable — it logs `[pty-reap] root=<pid>: ...` whenever it
// actually runs. We capture console output, trigger the fixture's fake exit, and assert no such line ever
// names pid 4242.
//
// NEGATIVE-ASSERTION ANCHOR (not a blind sleep — see test/_wait.mjs's own header and project doctrine on
// fixed-wait negative assertions): a bare timeout guarding "it never happened" can't tell "absent" from
// "hasn't happened YET". Instead we fire a WITNESS call directly against the real, exported
// `reapOrphanedDescendants` (a real, harmless child process we spawn ourselves as its root) strictly AFTER
// triggering the fixture's exit, and `waitUntil` the witness's OWN completion log. Both calls do the
// identical OS-level enumeration; ours started later, so if the fixture's exit had also triggered a real
// reap (the pre-fix bug), it had a head start and is certain to have logged by the time our later-started,
// equal-cost witness call finishes. The witness's own completion is also a POSITIVE control: it proves the
// console-capture mechanism actually observes a real reap when one genuinely runs, so the main assertion's
// silence is informative rather than a broken instrument reporting nothing either way.
//
// RUN (no daemon needed): node test/pty-exit-reap-seam.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon run `pnpm build`.
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-reapseam-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
requireHermeticEnv();

const { PtyHost, reapOrphanedDescendants } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

// Capture every console.log line written from here on (both the fixture's own `onExit` chain and the
// real reaper's `[pty-reap]` lines route through console.log — card 7d58a1aa). Restored in `finally`.
const capturedLines = [];
const realLog = console.log;
console.log = (...args) => { capturedLines.push(args.join(" ")); realLog(...args); };

const fakes = [];
class CapturingSeamHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const fake = super.createPty(opts);
    fakes.push(fake);
    return fake;
  }
}

const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
};

let witnessChild = null;
try {
  const host = new CapturingSeamHost(events);
  host.spawn({
    sessionId: "sess-reap-seam-test",
    cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 },
    sessionEnv: {},
  });
  const fake = fakes[0];
  check("spawn used the injected fixture pty (fake pid 4242)", !!fake && fake.pid === 4242);

  // The fixture's own kill() is synchronous (see _seam-host-fixture.mjs's doc) — this fully runs the
  // real onExit handler, including whatever it does with reapExitedDescendants, before returning.
  fake.kill();

  // WITNESS, fired strictly AFTER the fixture's exit above: a real, harmless short-lived child process,
  // reaped directly through the SAME exported function production/the seam's default both call.
  witnessChild = spawnProcess(process.execPath, ["-e", "setTimeout(() => {}, 50)"], { stdio: "ignore" });
  const witnessPid = witnessChild.pid;
  reapOrphanedDescendants(witnessPid);

  await waitUntil(
    () => capturedLines.some((l) => l.includes(`[pty-reap] root=${witnessPid}`)),
    { timeoutMs: 15_000, label: "witness reapOrphanedDescendants(witnessPid) completion log" },
  );
  check(
    "positive control: the witness's own real reap WAS observed via console capture",
    capturedLines.some((l) => l.includes(`[pty-reap] root=${witnessPid}`)),
  );

  check(
    "fixture exit (fake pid 4242) never invoked the real reaper",
    !capturedLines.some((l) => l.includes("[pty-reap] root=4242")),
  );
} finally {
  console.log = realLog;
  try { witnessChild?.kill(); } catch { /* already gone */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
