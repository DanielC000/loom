// Card 8c8ee0ee — the STRUCTURAL runtime tripwire: under LOOM_TEST, the real reapOrphanedDescendants/
// killProcessById/killSingleProcessById refuse any target pid that is neither a live descendant of
// process.pid nor a pid this test process itself spawned (@decision 8c8ee0ee, pty/host.ts — see
// docs/decisions/8c8ee0ee-structural-reap-test-tripwire.md for the full narrative).
//
// ⛔ SAFETY (read before editing): every fabricated pid used below is the sentinel 2147483647 — asserted,
// not assumed, to be impossible as a REAL pid on any OS (odd; Windows pids/tids are always multiples of
// 4; also above Linux's pid_max ceiling of 2^22). A "very large" pid is NOT by itself safe: it could
// still coincidentally be a real live pid, and the real kill functions use PLATFORM-NATIVE mechanisms
// (`taskkill` on win32) a `process.kill` spy cannot observe — this is exactly the shape that put the live
// daemon inside a fake pid range twice in card 2897acc4. Never add a second fabricated pid without this
// same proof.
//
// RUN (no daemon needed): node test/pty-root-reap-test-tripwire.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon run `pnpm build`.
process.env.LOOM_ROOT_REAP_KILL_VERIFY_DELAY_MS = "30"; // shrinks verifyRootDeadOrForceKill's post-kill wait
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { spawn as spawnProcess } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// THE sentinel — see the header above. Asserted here too so a later edit can't silently swap in an
// unsafe value without this file itself going red.
const SENTINEL_PID = 2147483647;
check("[safety] SENTINEL_PID is provably impossible as a real pid on any OS (odd, > Linux pid_max 2^22)",
  SENTINEL_PID % 4 !== 0 && SENTINEL_PID > 4_194_304);

const tmpHome = path.join(os.tmpdir(), `loom-reap-tripwire-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
requireHermeticEnv();

const hostMod = await import("../dist/pty/host.js");
const { PtyHost, reapOrphanedDescendants, isDescendantPid, reapProcessesRootedInWorktree } = hostMod;
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

// =====================================================================================================
// (unit) isDescendantPid — pure, hermetic, both polarities. No OS calls, no risk.
// =====================================================================================================
{
  check("(unit) a direct child (pid 5, ppid 1) IS a descendant of ancestor 1",
    isDescendantPid([{ pid: 5, ppid: 1 }], 5, 1) === true);
  check("(unit) a multi-hop chain (5->3->1) IS a descendant of ancestor 1",
    isDescendantPid([{ pid: 5, ppid: 3 }, { pid: 3, ppid: 1 }], 5, 1) === true);
  check("(unit, negative) a pid absent from the snapshot entirely is NOT a descendant",
    isDescendantPid([{ pid: 3, ppid: 1 }], 999, 1) === false);
  check("(unit, negative) a chain that terminates at an UNRELATED ancestor is NOT a descendant of a different one",
    isDescendantPid([{ pid: 5, ppid: 3 }, { pid: 3, ppid: 1 }], 5, 2) === false);
  check("(unit, negative) a cycle (5->3->5->...) never reaches the ancestor and returns false, not hangs",
    isDescendantPid([{ pid: 5, ppid: 3 }, { pid: 3, ppid: 5 }], 5, 1) === false);
  check("(unit, negative) a self-referential row (malformed) is NOT walked into",
    isDescendantPid([{ pid: 5, ppid: 5 }], 5, 1) === false);
  check("(unit, negative) exceeding maxHops fails closed (never a false 'yes')",
    isDescendantPid([{ pid: 2, ppid: 1 }, { pid: 3, ppid: 2 }, { pid: 4, ppid: 3 }], 4, 1, /* maxHops */ 1) === false);
  check("(unit, negative) targetPid === ancestorPid is NOT itself 'descendant'",
    isDescendantPid([{ pid: 1, ppid: 0 }], 1, 1) === false);
  // Card dbbb52db item 2: a stale ppid link — the OS reused a dead process's pid for the CLAIMED PARENT
  // before the child's own reported ppid field was updated. A genuine child can never have been created
  // BEFORE its real parent, so a claimed parent whose own creationTime is LATER than the child's own must
  // be rejected, not walked through.
  check("(unit, negative) a claimed parent whose creationTime is LATER than the child's own is NOT a descendant (stale/reused ppid link)",
    isDescendantPid([{ pid: 5, ppid: 1, creationTime: 1000 }, { pid: 1, ppid: 0, creationTime: 2000 }], 5, 1) === false);
  check("(unit, positive) a normal chain where child.creationTime >= the claimed parent's own still passes (the creation-time gate doesn't eat the legitimate case)",
    isDescendantPid([{ pid: 5, ppid: 1, creationTime: 2000 }, { pid: 1, ppid: 0, creationTime: 1000 }], 5, 1) === true);
  // CR bf7350d4 (post-dbbb52db follow-up): the two checks above only ever exercise the ANCESTOR-MATCH
  // branch's creationTime gate (the child's own hop lands directly on ancestorPid). The MID-HOP gate
  // (the `parentRow` branch, taken when ppid !== ancestorPid) was never independently exercised — deleting
  // its two lines left the suite green. A 3-hop chain forces that branch: 7's claimed parent is 5 (not the
  // ancestor), so 7's creationTime is checked against 5's, not against ancestor 1's.
  check("(unit, negative) a stale ppid link at a MID-HOP (not the final hop to the ancestor) is NOT a descendant",
    isDescendantPid(
      [{ pid: 7, ppid: 5, creationTime: 3000 }, { pid: 5, ppid: 1, creationTime: 4000 }, { pid: 1, ppid: 0, creationTime: 1000 }],
      7, 1,
    ) === false);
}

// Capture every console.log/error line from here on (mirrors pty-exit-reap-seam.mjs's own pattern) —
// restored in the outer `finally` at the bottom.
const capturedLines = [];
const realLog = console.log;
const realErr = console.error;
console.log = (...args) => { capturedLines.push(args.join(" ")); realLog(...args); };
console.error = (...args) => { capturedLines.push(args.join(" ")); realErr(...args); };

let fabWitnessChild = null;
let deadChild = null;
try {
  // ===================================================================================================
  // (behavioral A) reapOrphanedDescendants(SENTINEL_PID) — REFUSED, never enumerated, never killed.
  // ===================================================================================================
  {
    let threw = null;
    try { reapOrphanedDescendants(SENTINEL_PID); } catch (err) { threw = err; }
    check("(A) reapOrphanedDescendants(SENTINEL_PID) THROWS synchronously", threw instanceof Error);
    check("(A) the thrown message names the refusal + the function + the sentinel pid",
      !!threw && threw.message.includes("REFUSED") && threw.message.includes("reapOrphanedDescendants") && threw.message.includes(String(SENTINEL_PID)));
    // Card dbbb52db item 6: DROPPED the old "(A) no [pty-reap] completion log line ... ever appeared"
    // check. It ran synchronously, right after the synchronous throw above, before the real sweep's own
    // async spawn/close machinery could ever have produced that line even if the tripwire were fully
    // absent — the throw happens before reapOrphanedDescendants ever reaches its spawnProcess call, so
    // there was no race for this check to resolve either way: it was unfalsifiable in one trial, the
    // exact fixed-wait-negative-assertion shape the project's own guard polices. The positive-control
    // block immediately below already proves the capture mechanism genuinely observes a real completion
    // line when one is produced, so no coverage is lost by removing this vacuous negative check.
  }

  // ===================================================================================================
  // (behavioral A, positive control) a REAL child of THIS process IS accepted — proves (A) above isn't
  // vacuous (the capture mechanism genuinely observes a real reap when one happens) and proves the
  // tripwire doesn't collaterally break the real, legitimate call shape the two existing witness tests use.
  // ===================================================================================================
  {
    fabWitnessChild = spawnProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const witnessPid = fabWitnessChild.pid;
    let threw = null;
    try { reapOrphanedDescendants(witnessPid); } catch (err) { threw = err; }
    check("(A, positive control) reapOrphanedDescendants(realChildPid) does NOT throw", threw === null);
    await waitUntil(
      () => capturedLines.some((l) => l.includes(`[pty-reap] root=${witnessPid}:`)),
      { timeoutMs: 15_000, label: "witness reapOrphanedDescendants(realChildPid) completion log" },
    );
    check("(A, positive control) the real reap for a genuine descendant WAS observed (capture mechanism works)",
      capturedLines.some((l) => l.includes(`[pty-reap] root=${witnessPid}:`)));
  }

  // ===================================================================================================
  // (behavioral B) the test-spawn REGISTRY branch — a pid this test spawned but has ALREADY KILLED
  // (dev-server-teardown.mjs's own real shape: a dead root has NO row in a live OS enumeration at all).
  // ===================================================================================================
  {
    deadChild = spawnProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const deadPid = deadChild.pid;
    const isAlive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
    check("(B) the soon-to-be-dead child is alive right after spawn", isAlive(deadPid));
    deadChild.kill();
    await waitUntil(() => !isAlive(deadPid), { timeoutMs: 8_000, label: "deadChild actually dead" });
    check("(B) the child is confirmed dead before reaping it", !isAlive(deadPid));
    let threw = null;
    try { reapOrphanedDescendants(deadPid); } catch (err) { threw = err; }
    check("(B) reapOrphanedDescendants(deadPid) does NOT throw — the registry (branch b) recognizes it despite the pid having no live OS row",
      threw === null);
  }

  // ===================================================================================================
  // (behavioral C) killProcessById's OWN tripwire, exercised through its REAL, exported, production
  // caller (reapProcessesRootedInWorktree's default `kill`, deps.kill left UNSET) — killProcessById is
  // module-private, so this is the legitimate way to reach the real function, not a workaround.
  // ===================================================================================================
  {
    const fakeRow = { pid: SENTINEL_PID, exePath: null, cwd: "/fake/worktree-for-tripwire-test", commandLine: null, creationTime: null, creationTicks: null };
    const result = await reapProcessesRootedInWorktree("/fake/worktree-for-tripwire-test", {
      enumerate: async () => [fakeRow],
    });
    check("(C) the tripwire's own refusal log line for killProcessById fired",
      capturedLines.some((l) => l.includes("[pty-reap-test-guard] REFUSED killProcessById") && l.includes(String(SENTINEL_PID))));
    check("(C) the sentinel pid was NOT reported as killed (the real killProcessById's own try/catch swallowed the throw)",
      !result.killedPids.includes(SENTINEL_PID));
  }

  // ===================================================================================================
  // (behavioral D) killSingleProcessById's OWN tripwire, exercised through its REAL, exported, production
  // caller chain: verifyRootDeadOrForceKill -> the REAL (non-overridden) killRoot -> killSingleProcessById.
  // A bare `extends PtyHost` with probeRootSurvival faked to report a confirmed-alive survivor, but
  // killRoot deliberately left UNOVERRIDDEN (the true default), is the legitimate way to reach it.
  // ===================================================================================================
  {
    // Card 64d7a914 (CR 33ae2f8a round 2, follow-up) — verifyRootDeadOrForceKill now REFUSES before any
    // kill when no owner can be resolved at all, closing the exact gap this scenario used to rely on
    // (killing on command-line identity alone, no owner). A real creationTime (TRIPWIRE_CREATION_TIME,
    // shared by the probe and the registered owner below) is needed too, or win32's own M3 null-check
    // refuses first; both exist purely to let this scenario still reach the real killRoot, which is its
    // whole point — this file has nothing to do with creation-time matching.
    const TRIPWIRE_CREATION_TIME = Date.now() - 1_000;
    class RealKillRootHost extends PtyHost {
      reapExitedDescendants(_rootPid, _sessionId) { /* never used — verifyRootDeadOrForceKill is called directly */ }
      async probeRootSurvival(_rootPid, _sessionId) {
        return { foundAlive: true, identityConfirmed: true, enumerationFailed: false, creationTime: TRIPWIRE_CREATION_TIME };
      }
      async captureRootCreationRow(_pid) { return null; }
      sweepOrphanedDescendants(_rootPid) { /* never reached: probeRootSurvival always reports alive, so dead stays false */ }
    }
    const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
    const host = new RealKillRootHost(events);
    const owner = { pid: SENTINEL_PID, startedAt: Date.now() - 2_000, creationTime: TRIPWIRE_CREATION_TIME, creationTimeReady: Promise.resolve(), alive: true };
    host.live.set("sess-tripwire-killroot-test", owner);
    let rejected = null;
    try {
      await host.verifyRootDeadOrForceKill("sess-tripwire-killroot-test", SENTINEL_PID, "hard-stop");
    } catch (err) {
      rejected = err;
    }
    check("(D) verifyRootDeadOrForceKill(SENTINEL_PID) rejects — the real killRoot->killSingleProcessById tripwire fired",
      rejected instanceof Error && rejected.message.includes("REFUSED") && rejected.message.includes("killSingleProcessById"));
  }

  // ===================================================================================================
  // (behavioral E) card dbbb52db item 1: an ENUMERATION FAILURE always refuses — even for a pid this
  // test process itself spawned and already killed (the dead-root registry case (B) above, which the
  // registry ALONE would otherwise accept with no enumeration at all). Proves the fix never falls back
  // to the old registry-only accept when the OS process table can't be read.
  // ===================================================================================================
  let enumFailChild = null;
  try {
    enumFailChild = spawnProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const enumFailPid = enumFailChild.pid;
    const isAlive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
    enumFailChild.kill();
    await waitUntil(() => !isAlive(enumFailPid), { timeoutMs: 8_000, label: "enumFailChild actually dead" });

    const requireHere = createRequire(import.meta.url);
    const cp = requireHere("node:child_process");
    const originalExecFileSync = cp.execFileSync;
    cp.execFileSync = () => { throw new Error("simulated enumeration failure (card dbbb52db test)"); };
    syncBuiltinESMExports();
    let threw = null;
    try {
      try { reapOrphanedDescendants(enumFailPid); } catch (err) { threw = err; }
      check("(E) a registered DEAD pid is still REFUSED when the enumeration itself fails — never falls back to a registry-only accept",
        threw instanceof Error && threw.message.includes("REFUSED") && threw.message.includes("could not enumerate"));
    } finally {
      cp.execFileSync = originalExecFileSync;
      syncBuiltinESMExports();
    }
  } finally {
    try { enumFailChild?.kill(); } catch { /* already gone */ }
  }

  // ===================================================================================================
  // (behavioral F) card dbbb52db item 3: a LOOM_TEST=1 process with NO test-spawn registry at all (e.g. a
  // dist/index.js daemon spawned BY a test, or a web e2e fixture daemon, neither of which import
  // test/_guard.mjs) gets a silent, logged REFUSAL — never an uncaught throw that would crash it. The
  // child script below deliberately does NOT wrap the call in its own try/catch, mirroring the real
  // production call site (pty onExit -> reapExitedDescendants -> sweepOrphanedDescendants), which doesn't
  // either — so an old, unconditional throw here would surface as Node's own uncaught-exception exit.
  // ===================================================================================================
  {
    const distHostUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/pty/host.js")).href;
    const noRegistryTmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-no-registry-tripwire-"));
    const childScript = path.join(noRegistryTmp, "no-registry-child.mjs");
    try {
      fs.writeFileSync(childScript,
        `process.env.LOOM_TEST = "1";\n` +
        `const { reapOrphanedDescendants } = await import(${JSON.stringify(distHostUrl)});\n` +
        `const SENTINEL_PID = ${SENTINEL_PID};\n` +
        `reapOrphanedDescendants(SENTINEL_PID); // deliberately NOT wrapped — mirrors the real onExit call site\n` +
        `console.log("RESULT:no-throw");\n`);
      const out = await new Promise((resolve, reject) => {
        const child = spawnProcess(process.execPath, [childScript], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { stderr += d; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      check("(F) a no-registry LOOM_TEST process does NOT crash (exits 0, never an uncaught exception)", out.code === 0);
      check("(F) the function returned WITHOUT throwing (refused silently, not via an escaping exception)",
        out.stdout.includes("RESULT:no-throw"));
      check("(F) the refusal logged the fixed, greppable no-registry tag, naming the pid + function",
        out.stderr.includes("[pty-reap-test-guard] REFUSED (no registry)") &&
        out.stderr.includes(String(SENTINEL_PID)) &&
        out.stderr.includes("reapOrphanedDescendants"));
    } finally {
      try { fs.rmSync(noRegistryTmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
} finally {
  console.log = realLog;
  console.error = realErr;
  try { fabWitnessChild?.kill(); } catch { /* already gone */ }
  try { deadChild?.kill(); } catch { /* already gone */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// =======================================================================================================
// (production-unchanged) with LOOM_TEST/NODE_ENV unset, the SAME sentinel pid does NOT throw — proves the
// tripwire's own `inTestMode()` gate, shared by all 3 guarded functions, is a true no-op outside test mode.
// Mirrors seed-endpoint.mjs's own save/delete/restore precedent — the ONLY other file in this suite that
// does this. Safe to run for real: SENTINEL_PID cannot correspond to any real process, so the real
// (unguarded, byte-identical-to-before-this-card) sweep just finds zero descendants and no-ops.
// =======================================================================================================
{
  const savedLoomTest = process.env.LOOM_TEST;
  const savedNodeEnv = process.env.NODE_ENV;
  delete process.env.LOOM_TEST;
  delete process.env.NODE_ENV;
  try {
    let threw = null;
    try { reapOrphanedDescendants(SENTINEL_PID); } catch (err) { threw = err; }
    check("(production-unchanged) with LOOM_TEST/NODE_ENV unset, reapOrphanedDescendants(SENTINEL_PID) does NOT throw",
      threw === null);
  } finally {
    if (savedLoomTest === undefined) delete process.env.LOOM_TEST; else process.env.LOOM_TEST = savedLoomTest;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — under LOOM_TEST, the real reaper/kill functions refuse a target pid that is neither a live descendant of this process nor one it spawned itself; production is unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
