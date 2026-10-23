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
import { requireHermeticEnv, enableRootCreationCapture, awaitRootCreationCapture, armWitnessWithFreshRetry } from "./_guard.mjs";
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
// @decision 85ae7768 — scenarios (A)/(B) below hand REGISTERED roots directly to the real
// reapOrphanedDescendants sweep (no injected deps.enumerate); (B2)/(B3) deliberately inject fabricated
// rows and set the registry directly instead, so they're unaffected either way. Arm the real capture so
// a genuine stale-ppid stranger in this run's own OS process table would be filtered, not swept.
enableRootCreationCapture();

const hostMod = await import("../dist/pty/host.js");
const { PtyHost, reapOrphanedDescendants, isDescendantPid, reapProcessesRootedInWorktree, resolveTestGuardEnumerationTimeoutMs } = hostMod;
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

// =====================================================================================================
// (unit) resolveTestGuardEnumerationTimeoutMs — card b1ea823d, CR 79a80cd5 minor 2: a non-finite/
// non-integer/non-positive raw env value must NEVER reach execFileSync's own `timeout` option (an
// out-of-range value THROWS ERR_OUT_OF_RANGE there, failing EVERY enumeration, not just skipping the
// override). Pure, hermetic, no OS calls, no risk.
// =====================================================================================================
{
  check("(unit, timeout-clamp) Infinity falls back to the floor, never passed through",
    resolveTestGuardEnumerationTimeoutMs("Infinity", 10_000) === 10_000);
  check("(unit, timeout-clamp) -Infinity falls back to the floor",
    resolveTestGuardEnumerationTimeoutMs("-Infinity", 10_000) === 10_000);
  check("(unit, timeout-clamp) a fractional value falls back to the floor (never truncated/rounded through)",
    resolveTestGuardEnumerationTimeoutMs("12345.5", 10_000) === 10_000);
  check("(unit, timeout-clamp) NaN (unparsable) falls back to the floor",
    resolveTestGuardEnumerationTimeoutMs("not-a-number", 10_000) === 10_000);
  check("(unit, timeout-clamp) unset (undefined) falls back to the floor",
    resolveTestGuardEnumerationTimeoutMs(undefined, 10_000) === 10_000);
  check("(unit, timeout-clamp) zero and negative values fall back to the floor",
    resolveTestGuardEnumerationTimeoutMs("0", 10_000) === 10_000 && resolveTestGuardEnumerationTimeoutMs("-5000", 10_000) === 10_000);
  check("(unit, timeout-clamp) a valid integer BELOW the floor is clamped UP to the floor, never accepted as a lower bound",
    resolveTestGuardEnumerationTimeoutMs("5000", 10_000) === 10_000);
  check("(unit, timeout-clamp) a valid integer ABOVE the floor is honored",
    resolveTestGuardEnumerationTimeoutMs("20000", 10_000) === 20_000);
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
let liveRootLikeChild = null;
let mismatchedRootChild = null;
let toctouGrandchild = null;
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
    // @decision 85ae7768 (CR 85360986, MAJOR) — await + assert BEFORE reaping: the capture is async
    // (~560-630ms measured) while reapOrphanedDescendants reads the registry synchronously.
    // @decision 0d8270b2 — retry with a FRESH candidate on a genuine INFRA failure only (spawn/CIM error);
    // a verification rejection (no-row/ppid-mismatch/slack-margin) is a HARD, non-retried failure — see
    // armWitnessWithFreshRetry's own doc.
    const armed = await armWitnessWithFreshRetry(
      () => spawnProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" }),
    );
    fabWitnessChild = armed.child;
    const witnessPid = armed.pid;
    if (process.platform === "win32") {
      check("(A, positive control) witness creationTime is armed before reap (the filter this card protects)",
        typeof armed.creationTime === "number" && armed.creationTime > 0);
    }
    if (witnessPid == null) {
      console.log(`(A, positive control) witness capture never armed:\n  ${armed.log.join("\n  ")}`);
      throw new Error("(A, positive control) could not arm a real witness after retrying — see log above");
    }
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
    const isAlive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
    // @decision 85ae7768 (CR 85360986, MAJOR) — THE card's own primary scenario: await + assert BEFORE
    // killing — kill first and this races the capture's own ~560-630ms real latency and loses almost
    // every time, leaving the dead-registered-root filter silently un-armed (started, never recorded).
    // @decision 0d8270b2 — retry with a FRESH candidate on a genuine INFRA failure only (spawn/CIM error);
    // a verification rejection (no-row/ppid-mismatch/slack-margin) is a HARD, non-retried failure — see
    // armWitnessWithFreshRetry's own doc.
    const armed = await armWitnessWithFreshRetry(
      () => spawnProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" }),
    );
    deadChild = armed.child;
    const deadPid = armed.pid;
    if (deadPid == null) {
      console.log(`(B) deadPid capture never armed:\n  ${armed.log.join("\n  ")}`);
      throw new Error("(B) could not arm a real dead-to-be candidate after retrying — see log above");
    }
    check("(B) the soon-to-be-dead child is alive right after spawn", isAlive(deadPid));
    if (process.platform === "win32") {
      check("(B) deadPid's creationTime is armed BEFORE it dies (the filter this card protects)",
        typeof armed.creationTime === "number" && armed.creationTime > 0);
    }
    deadChild.kill();
    await waitUntil(() => !isAlive(deadPid), { timeoutMs: 8_000, label: "deadChild actually dead" });
    check("(B) the child is confirmed dead before reaping it", !isAlive(deadPid));
    let threw = null;
    try { reapOrphanedDescendants(deadPid); } catch (err) { threw = err; }
    check("(B) reapOrphanedDescendants(deadPid) does NOT throw — the registry (branch b) recognizes it despite the pid having no live OS row",
      threw === null);

    // =================================================================================================
    // (behavioral B2) card 85ae7768 — DoD: a stale-ppid child created BEFORE this SAME dead registered
    // root must NOT be swept, once the root's own captured creationTime is known. Exercises the REAL
    // reapOrphanedDescendants via its test-only deps.enumerate/deps.kill seam: deps.enumerate supplies
    // the fabricated stale-ppid row (a real OS enumeration can never be forced to report a fake
    // parent/child relationship — no amount of platformOverride changes that), deps.kill RECORDS every
    // pid the real code would have tried to kill rather than ever calling a real process.kill — so even
    // the pre-fix RED shape (where the sentinel WOULD be swept) never reaches a real kill syscall against
    // a fabricated pid. The companion registry's own entry for `deadPid` is set directly here, simulating
    // what test/_guard.mjs's real win32-only capture would have produced — deliberately platform-agnostic
    // (exercises the FALLBACK WIRING reapOrphanedDescendants -> creationTimeFromTestSpawnRegistry ->
    // computeOrphanSweepPlan, never the real win32 CIM capture itself, which is a separate, win32-only,
    // WARN-SKIP'd proof in pty-root-reap-win32-ticks-real-spawn.mjs).
    // =================================================================================================
    {
      const rootCreationTimeSim = 1_700_000_000_000;
      globalThis.__LOOM_TEST_SPAWNED_PID_CREATION_TIMES__.set(deadPid, rootCreationTimeSim);
      const staleChildRow = { pid: SENTINEL_PID, ppid: deadPid, creationTime: rootCreationTimeSim - 10_000 };
      const killedPids = [];
      reapOrphanedDescendants(deadPid, null, {
        enumerate: async () => [staleChildRow],
        kill: (pid) => { killedPids.push(pid); },
      });
      await waitUntil(
        () => capturedLines.some((l) => l.includes(`[pty-reap] root=${deadPid}:`) && l.includes("skippedStale=1")),
        { timeoutMs: 8_000, label: "(B2) injected-enumerate sweep completion log" },
      );
      check("(B2) the stale-ppid child (created BEFORE the root, per its own creationTime) is NOT swept",
        !killedPids.includes(SENTINEL_PID));
      check("(B2) nothing else was (attempted to be) killed — toKill was genuinely empty, not a filtered-after-attempt",
        killedPids.length === 0);
    }

    // =================================================================================================
    // (behavioral B3) a rejecting deps.enumerate() (the injected-seam counterpart of a real enumeration
    // helper failing to spawn) must log + return, never throw past reapOrphanedDescendants — same
    // best-effort posture as every other enumeration-failure path in this function.
    // =================================================================================================
    {
      const killedPids = [];
      let threw = null;
      try {
        reapOrphanedDescendants(deadPid, null, {
          enumerate: async () => { throw new Error("simulated injected-enumerate rejection (card 85ae7768 test)"); },
          kill: (pid) => { killedPids.push(pid); },
        });
      } catch (err) { threw = err; }
      check("(B3) a synchronously-called reapOrphanedDescendants with a rejecting deps.enumerate does not throw synchronously",
        threw === null);
      await waitUntil(
        () => capturedLines.some((l) => l.includes(`[pty-reap] root=${deadPid}: injected enumerate() rejected`)),
        { timeoutMs: 8_000, label: "(B3) injected-enumerate rejection log" },
      );
      check("(B3) the rejection was logged, naming the root pid and the real error message",
        capturedLines.some((l) => l.includes(`[pty-reap] root=${deadPid}: injected enumerate() rejected`) && l.includes("simulated injected-enumerate rejection")));
      check("(B3) nothing was killed when the injected enumeration itself failed", killedPids.length === 0);
    }
  }

  // ===================================================================================================
  // (behavioral B4) card 85ae7768 (CR 85360986, MINOR 2) — the live-root-abort -> walk TRANSITION,
  // both directions, via deps.enumerate against a REAL live descendant: when the injected occupant row
  // AT the root pid carries a creationTime that agrees with the root's own REAL captured value, the walk
  // PROCEEDS (not aborted) and a fabricated child IS swept; when it disagrees, the abort still fires and
  // nothing is swept — proving computeOrphanSweepPlan's own fail-safe agreement check, not just that a
  // non-null rootCreationTime exists.
  // ===================================================================================================
  {
    // @decision 0d8270b2 — retry with a FRESH candidate on a genuine INFRA failure only (spawn/CIM error);
    // a verification rejection (no-row/ppid-mismatch/slack-margin) is a HARD, non-retried failure — see
    // armWitnessWithFreshRetry's own doc.
    const armed = await armWitnessWithFreshRetry(
      () => spawnProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" }),
    );
    liveRootLikeChild = armed.child;
    const liveRootPid = armed.pid;
    const capturedCreationTime = armed.creationTime;
    check("(B4) the live root's own creationTime is armed (needed for both legs below)",
      process.platform !== "win32" || (typeof capturedCreationTime === "number" && capturedCreationTime > 0));
    if (liveRootPid == null) {
      console.log(`(B4) live-root capture never armed:\n  ${armed.log.join("\n  ")}`);
      throw new Error("(B4) could not arm a real live-root candidate after retrying — see log above");
    }

    if (process.platform === "win32") {
      // @decision 914c9363 — never let the guard's own real OS enumeration run here (it can ETIMEDOUT
      // under gate load); fabricate it instead, installed after the capture above settles and scoped to
      // only the two calls below. See docs/decisions/914c9363-b4-guard-enumeration-fabricated-not-real.md.
      const requireHere = createRequire(import.meta.url);
      const cp = requireHere("node:child_process");
      const originalExecFileSync = cp.execFileSync;
      const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000;
      const toTicks = (ms) => ms * 10_000 + DOTNET_UNIX_EPOCH_TICKS;
      // One "pid,ppid,ticks" line, matching enumerateLivePidPpidRowsForTestGuard's real win32 parse
      // format exactly (parseOrphanSweepLine / WIN32_SWEEP_FOREACH_BODY): ppid=process.pid proves
      // ancestry to this test process, and ticks round-trips to the EXACT real captured creationTime
      // (an integer ms*10_000 offset — no agreement-check slop introduced by the round trip).
      cp.execFileSync = () => `${liveRootPid},${process.pid},${toTicks(capturedCreationTime)}\n`;
      syncBuiltinESMExports();
      try {
        // (B4a) the occupant's own creationTime AGREES with the real captured value -> proven own root -> walk.
        {
          const killedPids = [];
          reapOrphanedDescendants(liveRootPid, null, {
            enumerate: async () => [
              { pid: liveRootPid, ppid: process.pid, creationTime: capturedCreationTime },
              { pid: SENTINEL_PID, ppid: liveRootPid, creationTime: capturedCreationTime + 1000 },
            ],
            kill: (pid) => { killedPids.push(pid); },
          });
          await waitUntil(
            () => capturedLines.some((l) => l.includes(`[pty-reap] root=${liveRootPid}:`)),
            { timeoutMs: 8_000, label: "(B4a) agreeing-occupant sweep completion log" },
          );
          check("(B4a) a creationTime-PROVEN own root is NOT aborted",
            !capturedLines.some((l) => l.includes(`[pty-reap] root=${liveRootPid}: ABORTED`)));
          check("(B4a) the walk genuinely proceeded — the fabricated child WAS recorded as swept",
            killedPids.includes(SENTINEL_PID));
        }

        // (B4b) the occupant's own creationTime DISAGREES with the real captured value -> still aborts.
        {
          const killedPids = [];
          reapOrphanedDescendants(liveRootPid, null, {
            enumerate: async () => [
              { pid: liveRootPid, ppid: process.pid, creationTime: capturedCreationTime + 10_000 },
              { pid: SENTINEL_PID, ppid: liveRootPid, creationTime: capturedCreationTime + 11_000 },
            ],
            kill: (pid) => { killedPids.push(pid); },
          });
          await waitUntil(
            () => capturedLines.some((l) => l.includes(`[pty-reap] root=${liveRootPid}: ABORTED`)),
            { timeoutMs: 8_000, label: "(B4b) mismatched-occupant abort log" },
          );
          check("(B4b) a mismatched creationTime still ABORTS the whole walk",
            capturedLines.some((l) => l.includes(`[pty-reap] root=${liveRootPid}: ABORTED`)));
          check("(B4b) nothing was (attempted to be) swept when aborted", killedPids.length === 0);
        }
      } finally {
        cp.execFileSync = originalExecFileSync;
        syncBuiltinESMExports();
      }
    } else {
      console.log("WARN  SKIP  (B4) live-root-abort->walk transition — win32-only (no POSIX creationTime data); process.platform !== 'win32' here.");
    }
  }

  // ===================================================================================================
  // (helper) card 0d8270b2 round 2 — armWitnessWithFreshRetry must classify a null capture result PER
  // PID, never via the GLOBAL CAPTURE_STATS.failed counter: a concurrent capture failure for an unrelated
  // ("foreign") pid, happening DURING this pid's own await, must never cause THIS pid's own genuine hard
  // rejection (no-row/ppid-mismatch/slack-margin) to be misread as a retryable infra failure and retried
  // past it — that would mask the exact regression this mechanism exists to catch. Uses `__testHooks`
  // (test-only — see armWitnessWithFreshRetry's own doc) to fully control the per-attempt outcome
  // deterministically, without depending on a real win32 CIM race: the hook itself simulates the
  // concurrent foreign-pid failure (bumping the global counter) in the SAME tick it classifies THIS pid's
  // own result as a genuine, non-infra rejection.
  // ===================================================================================================
  {
    if (process.platform === "win32") {
      const reasons = globalThis.__LOOM_TEST_CAPTURE_REJECTION_REASONS__;
      const stats = globalThis.__LOOM_TEST_CAPTURE_STATS__;
      let spawnCount = 0;
      // Fabricated pids, never a real OS process — this scenario tests armWitnessWithFreshRetry's own
      // classification logic in isolation, not the real win32 CIM capture (already covered elsewhere in
      // this file and in pty-root-reap-identity.mjs).
      const spawnCandidate = () => { spawnCount++; return { pid: 999_000_100 + spawnCount, kill() {} }; };
      const armed = await armWitnessWithFreshRetry(spawnCandidate, {
        attempts: 3,
        __testHooks: {
          awaitCapture: async (pid) => {
            // Simulate the race: a DIFFERENT, unrelated pid's capture fails concurrently (the global
            // counter advances) while THIS pid's own capture settles to a genuine, non-infra rejection.
            stats.failed++;
            reasons.set(pid, "slack-margin");
            return null;
          },
        },
      });
      check("(helper) a concurrent foreign-pid failure does NOT misclassify this pid's own slack-margin rejection as infra",
        armed.hardRejected === true && armed.reason === "slack-margin");
      check("(helper) only ONE attempt was made — a misclassified retry would have spawned a second candidate",
        spawnCount === 1);
    } else {
      console.log("WARN  SKIP  (helper) armWitnessWithFreshRetry per-pid classification — win32-only (capture mechanism disabled on POSIX).");
    }
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
      // Card d2bd6255 — force win32 regardless of the REAL host platform: this scenario's whole point is
      // reaching the real killRoot (per this block's own header), and its owner/probe below are win32-shaped
      // (creationTime only, no startTicksLinux/creationTicks) — on an unforced real Linux host, guard 2's
      // Linux-ticks branch always refused for lack of those fields before ever reaching killRoot, which is
      // a test gap (an encoded win32 assumption), not a product bug.
      resolveRootReapPlatform() { return "win32"; }
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

  // ===================================================================================================
  // (behavioral G) card b1ea823d — PtyHost.reapExitedDescendants (the real onExit chokepoint both the
  // claude and codex pty.onExit handlers call) swallows ONLY an enumeration-failure refusal; a lineage
  // refusal through the SAME chokepoint must still propagate (the genuine tripwire finding stays loud).
  // ===================================================================================================
  {
    const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
    const host = new PtyHost(events);
    // Never let the real post-sweep verify step run any real OS probe here — it is not what this
    // scenario tests, and reapExitedDescendants's own catch must decide before it is ever reached.
    host.verifyRootDeadOrForceKill = async () => ({ pid: SENTINEL_PID, dead: false, identityConfirmed: null, forceKilled: false, checkFailed: true, identity: "unreadable" });
    // CR 018fba2a — force win32 regardless of the REAL host platform, same reasoning + same seam as
    // RealKillRootHost above (~L353): G3 below is win32-shaped (a win32 CIM-ticks mismatch, no
    // startTicksLinux/creationTicks), and reapExitedDescendants's own await-the-capture gate (card
    // 0201b378, item B) is ITSELF gated on `resolveRootReapPlatform() !== "linux"` — on an unpinned real
    // Linux host this reads "linux", the await is correctly skipped (by design — armRootCreationTime never
    // arms creationTimeReady there), creationTime stays null, and G3's mismatch check never gets a chance
    // to run at all, falling through to the throwing ancestry walk. Pinning win32 here makes G3 exercise
    // the win32 mechanism it actually tests on every OS, including a real Linux CI runner.
    host.resolveRootReapPlatform = () => "win32";

    // (G1) enumeration failure through reapExitedDescendants: caught, logged, NOT a crash.
    {
      const requireHere = createRequire(import.meta.url);
      const cp = requireHere("node:child_process");
      const originalExecFileSync = cp.execFileSync;
      cp.execFileSync = () => { throw new Error("simulated enumeration failure (card b1ea823d test, G1)"); };
      syncBuiltinESMExports();
      let threw = null;
      try {
        // @decision b1ea823d — reapExitedDescendants is now async (card 0201b378, item B); await it so a
        // rejection is caught by this SAME try/catch, exactly as the old synchronous throw was.
        try { await host.reapExitedDescendants(SENTINEL_PID, "sess-b1ea823d-enum-fail", { creationTime: null, creationTimeReady: Promise.resolve() }); }
        catch (err) { threw = err; }
      } finally {
        cp.execFileSync = originalExecFileSync;
        syncBuiltinESMExports();
      }
      check("(G1) an enumeration-failure refusal through the real onExit chokepoint does NOT crash (no throw escapes reapExitedDescendants)",
        threw === null);
      check("(G1) the swallowed refusal was logged, naming the chokepoint and that it did not crash",
        capturedLines.some((l) => l.includes("onExit sweep's enumeration-failure refusal caught at the exit chokepoint, not crashing")));
    }

    // (G2) a lineage refusal through the SAME chokepoint must still propagate — unchanged from before this
    // card. Feeds the guard's OWN enumeration a FABRICATED, deterministic empty snapshot (same execFileSync
    // monkeypatch technique as G1/scenario E) rather than letting the real OS enumeration run: a real
    // `powershell.exe`/`ps` call can itself ETIMEDOUT under exactly the load this card targets, which would
    // make this specific assertion flake for a reason unrelated to what it's checking (CR 79a80cd5, minor 4).
    {
      const requireHere = createRequire(import.meta.url);
      const cp = requireHere("node:child_process");
      const originalExecFileSync = cp.execFileSync;
      cp.execFileSync = () => ""; // zero rows: SENTINEL_PID is provably absent, never a descendant.
      syncBuiltinESMExports();
      let threw = null;
      try {
        // @decision b1ea823d — reapExitedDescendants is now async (card 0201b378, item B); await it so a
        // rejection is caught by this SAME try/catch, exactly as the old synchronous throw was.
        try { await host.reapExitedDescendants(SENTINEL_PID, "sess-b1ea823d-lineage", { creationTime: null, creationTimeReady: Promise.resolve() }); }
        catch (err) { threw = err; }
      } finally {
        cp.execFileSync = originalExecFileSync;
        syncBuiltinESMExports();
      }
      check("(G2) a lineage refusal through the real onExit chokepoint STILL throws (propagates, unswallowed)",
        threw instanceof Error && threw.message.includes("not a live descendant"));
      check("(G2) the lineage refusal is NOT the enumeration-failure code — this stays an unswallowed REFUSAL, never routed through the one code reapExitedDescendants's own catch tolerates",
        threw instanceof Error && threw.code !== "LOOM_REAP_TEST_GUARD_ENUMERATION_FAILED");
    }

    // (G3) card 0201b378, item B — the ORIGINAL specimen: a fast-exiting root whose creation-time capture
    // resolves SHORTLY AFTER onExit fires is now correctly VERIFIED (a proven pid-reuse mismatch → silent
    // skip), not REFUSED. Before this fix, `liveRef.creationTime` was read synchronously at onExit and was
    // always still `null` here (the capture hadn't settled yet) — the mismatch check never got a chance to
    // run, and execution fell through to the unconditional, throwing ancestry walk (the
    // mcp-config-secret-lifecycle incident's exact shape, since SENTINEL_PID is never a real descendant of
    // this process). Same monkeypatch technique as scenario H: the guard's own synchronous enumeration
    // reports SENTINEL_PID as LIVE with a foreign ppid and a creationTime that will mismatch our own, once
    // ours actually arrives.
    {
      const requireHere = createRequire(import.meta.url);
      const cp = requireHere("node:child_process");
      const originalExecFileSync = cp.execFileSync;
      const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000;
      const occupantTicks = Date.now() * 10_000 + DOTNET_UNIX_EPOCH_TICKS; // guard's view: "occupant is live right now"
      cp.execFileSync = () => `${SENTINEL_PID},999999,${occupantTicks}\n`;
      syncBuiltinESMExports();

      let resolveCreationTime;
      const creationTimeReady = new Promise((resolve) => { resolveCreationTime = resolve; });
      const liveRef = { creationTime: null, creationTimeReady };
      // Mirrors armRootCreationTime's own real side effect: the capture settles by MUTATING `creationTime`
      // on the live object, not merely resolving a value nobody reads. "Our real root" was created a day
      // ago — provably mismatched against the guard's "live right now" occupant above.
      setTimeout(() => {
        liveRef.creationTime = Date.now() - 86_400_000;
        resolveCreationTime();
      }, 50); // well inside ROOT_CREATION_CAPTURE_AWAIT_MS's 3000ms default — this is the specimen's whole point

      let threw = null;
      try {
        try { await host.reapExitedDescendants(SENTINEL_PID, "sess-0201b378-timing", liveRef); }
        catch (err) { threw = err; }
      } finally {
        cp.execFileSync = originalExecFileSync;
        syncBuiltinESMExports();
      }
      check("(G3) a fast-exiting root whose capture resolves shortly AFTER onExit does NOT throw (the await gave the mismatch check real data)",
        threw === null);
      check("(G3) the guard's own SKIPPED log line fired — the mismatch was genuinely VERIFIED, not an unresolved fallthrough",
        capturedLines.some((l) => l.includes(`[pty-reap-test-guard] SKIPPED reapOrphanedDescendants(pid=${SENTINEL_PID})`)));
    }
  }

  // ===================================================================================================
  // (behavioral H) card b1ea823d, CR 79a80cd5 (BLOCKING fix) — the TOCTOU this card's guard-level mismatch
  // check must NOT paper over: the guard's own enumeration and reapOrphanedDescendants' DOWNSTREAM
  // enumeration are two SEPARATE, independently-timed OS reads (up to the semaphore's own queue-wait
  // apart, decision 6d484a46). A proven creation-time mismatch at the guard must be a SILENT SKIP — no
  // throw, no further enumeration, no kill — never a "proceed", because the downstream read can see a
  // DIFFERENT, later snapshot where the occupant has since exited, letting a genuinely foreign child of
  // the reused pid number pass the stale-ppid filter and get SIGKILLed for real. (The original, reverted
  // fix returned `true` here — proceed — which is exactly the bug this scenario controls against.)
  //
  // Both reads are independently controlled: the GUARD's own enumeration (`execFileSync`, monkeypatched —
  // same technique as scenario E/G1) reports a live, foreign-ppid occupant at SENTINEL_PID with a
  // mismatched creationTime (the guard's own view of "the race is happening"). The DOWNSTREAM sweep's
  // enumeration (`deps.enumerate`, the file's existing injection seam — same technique as scenario B4)
  // reports NO live row at all for SENTINEL_PID (the occupant has since exited) but DOES report a real,
  // still-alive grandchild `K` whose ppid is SENTINEL_PID and whose creationTime is AFTER the stale-ppid
  // filter's cutoff — the exact row shape that widened the kill set before this fix. `deps.kill` is
  // deliberately left UNSET so a real SIGKILL would actually reach K if the bug were still present.
  // ===================================================================================================
  {
    toctouGrandchild = spawnProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const grandchildPid = toctouGrandchild.pid;

    const requireHere = createRequire(import.meta.url);
    const cp = requireHere("node:child_process");
    const originalExecFileSync = cp.execFileSync;
    const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000;
    const occupantTicks = Date.now() * 10_000 + DOTNET_UNIX_EPOCH_TICKS; // guard's view: "occupant is live right now"
    cp.execFileSync = () => `${SENTINEL_PID},999999,${occupantTicks}\n`;
    syncBuiltinESMExports();

    const ourOriginalRootCreationTime = Date.now() - 86_400_000; // "our real root" was supposedly created a day ago
    let enumerateCalled = false;
    let threw = null;
    try {
      try {
        reapOrphanedDescendants(SENTINEL_PID, ourOriginalRootCreationTime, {
          // DOWNSTREAM read: occupant already gone (no row at all for SENTINEL_PID itself), but its real
          // grandchild K is live, ppid=SENTINEL_PID, created well AFTER ourOriginalRootCreationTime — the
          // exact row the pre-fix code would have swept. Must NEVER be reached on the fixed code.
          enumerate: async () => {
            enumerateCalled = true;
            return [{ pid: grandchildPid, ppid: SENTINEL_PID, creationTime: Date.now() }];
          },
        });
      } catch (err) { threw = err; }
    } finally {
      cp.execFileSync = originalExecFileSync;
      syncBuiltinESMExports();
    }

    // card 0201b378, item D — wait for a POSITIVE witness that this call actually settled, never a blind
    // fixed-turn flush: the guard's own `SKIPPED` log line (fired SYNCHRONOUSLY, same tick, on the fixed
    // code) OR the downstream `deps.enumerate()` actually being invoked (only reachable on a regression,
    // and possibly delayed behind `rootReapEnumerationSemaphore`'s own queue under contention — NOT
    // reachable via a fixed microtask count, since a queued waiter resolves only via another release() or
    // a real 30s timeout). Whichever happens first is a genuine, observable settling — not an assumption
    // about which path the semaphore happened to take.
    const guardSkippedLine = `[pty-reap-test-guard] SKIPPED reapOrphanedDescendants(pid=${SENTINEL_PID})`;
    await waitUntil(
      () => capturedLines.some((l) => l.includes(guardSkippedLine)) || enumerateCalled,
      { timeoutMs: 8_000, label: "(H) guard SKIPPED witness or downstream enumerate() fired" },
    );
    const guardSkipped = capturedLines.some((l) => l.includes(guardSkippedLine));
    if (enumerateCalled) {
      // Only reachable on the (reverted) buggy code — wait for the real kill's own completion log before
      // checking survival below, so that assertion never races the kill.
      await waitUntil(
        () => capturedLines.some((l) => l.includes(`[pty-reap] root=${SENTINEL_PID}:`)),
        { timeoutMs: 8_000, label: "(H) sweep completion log (only reachable pre-fix)" },
      );
    }

    check("(H) a proven pid-reuse at the guard does NOT throw (silent skip, not a crash)", threw === null);
    check("(H) the guard's own SKIPPED log line fired — the skip path genuinely ran (a positive witness, not an absence)",
      guardSkipped === true);
    check("(H) the downstream enumeration was NEVER invoked — the guard's skip is a genuine no-op, not merely 'no throw' (CR 79a80cd5)",
      enumerateCalled === false);
    const grandchildAlive = (() => { try { process.kill(grandchildPid, 0); return true; } catch { return false; } })();
    check("(H) THE REGRESSION THIS CONTROLS AGAINST: the real grandchild of the reused pid SURVIVES (would be SIGKILLed on the reverted fix — CR 79a80cd5)",
      grandchildAlive);
  }

  // ===================================================================================================
  // (behavioral H2) card b1ea823d — when NO expected creation time is available on either side (caller
  // passes null AND the registry's own entry is cleared), behavior is byte-identical to before this card:
  // the mismatch branch is gated on `expectedCreationTime != null` and never evaluates, so the REAL
  // (unmonkeypatched) guard enumeration runs and a genuinely own, still-live descendant passes via the
  // unchanged ancestry walk alone — same path scenario (A, positive control) above already exercises.
  // ===================================================================================================
  {
    mismatchedRootChild = spawnProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const mismatchedPid = mismatchedRootChild.pid;
    // Awaited (value unused) so the real async capture settles BEFORE the registry delete below — else a
    // still-in-flight capture could re-populate the entry right after the delete.
    await awaitRootCreationCapture(mismatchedPid);
    globalThis.__LOOM_TEST_SPAWNED_PID_CREATION_TIMES__.delete(mismatchedPid);
    let threw2 = null;
    try { reapOrphanedDescendants(mismatchedPid, null); }
    catch (err) { threw2 = err; }
    check("(H2) with no expected creation time available on either side, a genuine own descendant still does not throw (unchanged ancestry-walk path)",
      threw2 === null);
  }
} finally {
  console.log = realLog;
  console.error = realErr;
  try { fabWitnessChild?.kill(); } catch { /* already gone */ }
  try { deadChild?.kill(); } catch { /* already gone */ }
  try { liveRootLikeChild?.kill(); } catch { /* already gone */ }
  try { mismatchedRootChild?.kill(); } catch { /* already gone */ }
  try { toctouGrandchild?.kill(); } catch { /* already gone */ }
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
