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
import { requireHermeticEnv, enableRootCreationCapture, awaitRootCreationCapture } from "./_guard.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-reapseam-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
requireHermeticEnv();
// @decision 85ae7768 — the witness below is a REGISTERED root handed directly to the real
// reapOrphanedDescendants sweep (not just a fabricated-data wiring check), so arm the real capture —
// same reasoning as dev-server-teardown.mjs.
enableRootCreationCapture();

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
  // 5s (not the original 50ms) so it survives the capture's own ~560-630ms real latency below — a
  // witness that already died on its own timer before the await settles would flip this from "a LIVE
  // registered root" into "a dead one", changing which branch of the real tripwire/filter this exercises.
  //
  // @decision 2d57e1c7 — card 2d57e1c7 (full-gate flake, op e0a9731e): under real gate contention, the
  // witness's OWN diagnostic capture can itself fail to even complete — spawning its powershell.exe/CIM
  // helper competes with every OTHER concurrent reap-capture across overlapping gates/lanes for the same
  // process-table headroom. `_guard.mjs`'s own capture chain turns that kind of INFRASTRUCTURE failure
  // into a resolved `null` (same shape as a genuine verification rejection — see `CAPTURE_STATS.failed`,
  // which only the infra-failure path increments), so a bare `typeof === number` check on the FIRST
  // attempt can't tell "the filter genuinely has nothing to arm" from "we never got a clean chance to
  // ask". ⚠️ Manager review correction: retrying on ANY null (as a first pass did) would mask exactly
  // the regression class this witness exists for — a filter that intermittently REJECTS a valid capture
  // would then pass whenever any one of several attempts happened to succeed. So ONLY an infra failure
  // (`captureStats.failed` advanced during the attempt) or a thrown rejection is retried; a genuine
  // verification rejection (row/ppid/slack check ran and said no, with NO infra failure) fails
  // IMMEDIATELY — no retry, loud diagnostic, same break-the-loop shape as a successful capture.
  // Deterministic RED/GREEN proof (no real host load, two independent controls): a scratch repro
  // injecting N synthetic powershell.exe spawn failures reproduced the resolved-null INFRA shape on a
  // single attempt (RED pre-fix), and the bounded retry recovered once the injected failures were
  // exhausted (GREEN) while still failing loudly, not vacuously, once injected failures exceeded the
  // retry bound. A second repro forced a genuine VERIFICATION rejection (no infra failure at all) on the
  // first attempt, via the real `resolveVerifiedRootCreationTime` ppid-mismatch branch — confirmed this
  // fails immediately, is never retried into green, and exits the loop on attempt 1. Non-win32 never
  // arms a capture at all (`armRootCreationTime` returns early there), so the loop is skipped entirely
  // off-platform and a single witness is spawned directly.
  const WITNESS_CAPTURE_ATTEMPTS = 3;
  let capturedCreationTime = null;
  let witnessPid = null;
  if (process.platform === "win32") {
    const captureStats = globalThis.__LOOM_TEST_CAPTURE_STATS__;
    const attemptLog = [];
    for (let attempt = 1; attempt <= WITNESS_CAPTURE_ATTEMPTS; attempt++) {
      const candidate = spawnProcess(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
      const candidatePid = candidate.pid;
      const failedBefore = captureStats.failed;
      let result = null;
      try {
        // @decision 85ae7768 (CR 85360986, MAJOR) — await + assert BEFORE reaping, same reasoning as
        // dev-server-teardown.mjs: the capture is async while reapOrphanedDescendants reads the registry
        // synchronously, so reaping immediately races the capture and almost always loses.
        result = await awaitRootCreationCapture(candidatePid);
      } catch (err) {
        attemptLog.push(`attempt ${attempt}/${WITNESS_CAPTURE_ATTEMPTS} pid=${candidatePid}: REJECTED (infra — retrying) — ${err?.message ?? err}`);
        try { candidate.kill(); } catch { /* already gone */ }
        continue;
      }
      if (typeof result === "number" && result > 0) {
        capturedCreationTime = result;
        witnessPid = candidatePid;
        witnessChild = candidate;
        break;
      }
      const infra = captureStats.failed > failedBefore;
      try { candidate.kill(); } catch { /* already gone */ }
      if (!infra) {
        // Genuine verification rejection — the filter ran and said no. This is the exact regression
        // this witness protects against, so it must NEVER be masked by a retry: fail immediately.
        attemptLog.push(`attempt ${attempt}/${WITNESS_CAPTURE_ATTEMPTS} pid=${candidatePid}: resolved ${result === null ? "null" : result} — VERIFICATION REJECTED (row/ppid/slack check ran and said no; NOT retrying)`);
        break;
      }
      attemptLog.push(`attempt ${attempt}/${WITNESS_CAPTURE_ATTEMPTS} pid=${candidatePid}: resolved ${result === null ? "null" : result} — capture attempt FAILED (infra; retrying)`);
    }
    if (capturedCreationTime == null) {
      console.log(`witness capture never armed:\n  ${attemptLog.join("\n  ")}`);
    }
    check("witness: creationTime is armed before reap (the filter this card protects)",
      typeof capturedCreationTime === "number" && capturedCreationTime > 0);
  }
  if (witnessPid == null) {
    witnessChild = spawnProcess(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
    witnessPid = witnessChild.pid;
  }
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
