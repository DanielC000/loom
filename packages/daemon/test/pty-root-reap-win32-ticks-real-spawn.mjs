import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2897acc4 (round 6, item 1) — REAL-PowerShell equivalence check, win32 only.
//
// BACKGROUND: `reapOrphanedDescendants`'s own sweep enumeration reads a win32 CIM row's
// `CreationDate.Ticks` directly. `.Ticks` on a LOCAL-kind `[DateTime]` is LOCAL ticks, but
// `parseWin32SweepTicks` (pty/host.ts) subtracts the UTC epoch's own Ticks constant, assuming a UTC
// value. On any UTC-offset host (measured: exactly +2h on a CEST host) this under/over-reports every
// row's creationTime by the local offset — silently defeating `computeOrphanSweepPlan`'s stale-pid filter
// in the direction that matters: a genuine descendant younger than the root can look "stale" (older) and
// get wrongly skipped, which is the exact orphan-survivor defect this whole card exists to fix.
// `checkRootSurvival`'s OWN enumeration (`enumerateProcessesWin32`, a DIFFERENT PowerShell query using
// `ConvertTo-Json`) was already verified correct — its legacy `/Date(<ms>)/` serialization is UTC by
// construction, independent of this bug. This test cross-checks the sweep's reported creationTime
// against that independently-correct one, for a REAL pid (this test's own node process) — read-only,
// kills nothing.
//
// Run: 1) build (turbo builds shared first), 2) node test/pty-root-reap-win32-ticks-real-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as spawnPty } from "node-pty";
import { spawn as spawnCp } from "node:child_process";
import { requireHermeticEnv, enableRootCreationCapture } from "./_guard.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  // Card 85bd4052 convention (see codex-version-real-spawn.mjs's own header): a WARN line (NOT a bare
  // SKIP) survives test-daemon.mjs's own filtering once this file reports a pass, so a non-win32 CI
  // runner still shows this file's real coverage never ran there. The win32 CIM ticks-domain mismatch
  // this file proves has no POSIX analogue — POSIX's own sweep enumeration never populates a row's
  // creationTime at all (reapOrphanedDescendants's own doc).
  console.log("WARN  SKIP  pty-root-reap-win32-ticks-real-spawn.mjs — win32-only (CIM CreationDate ticks-domain equivalence); process.platform !== 'win32' here.");
  process.exit(0);
}

const tmpHome = path.join(os.tmpdir(), `loom-win32-ticks-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
requireHermeticEnv();

const {
  enumerateWin32SweepRows, checkRootSurvival, enumerateWin32SweepRowForPid, resolveVerifiedRootCreationTime,
  ROOT_CREATION_MATCH_TOLERANCE_MS,
} = await import("../dist/pty/host.js");

try {
  // The SAME real pid (this test's own process) probed by BOTH independent, real PowerShell enumerations
  // — in parallel, since neither mutates anything and the two queries are entirely independent.
  const [sweepRows, survival] = await Promise.all([
    enumerateWin32SweepRows(),
    checkRootSurvival(process.pid, "pty-root-reap-win32-ticks-real-spawn-no-such-session"),
  ]);

  const selfRow = sweepRows.find((r) => r.pid === process.pid);
  check("[sanity] the sweep enumeration's own real PowerShell query found THIS process alive", selfRow !== undefined);
  check("[sanity] checkRootSurvival's own (different) real PowerShell query ALSO found THIS process alive", survival.foundAlive === true);
  // Guard against a vacuous pass (worker doctrine's own "assert on what survives a check, not merely
  // that it fired"): both sides must report a REAL, non-null creationTime — not have silently degraded
  // to "unknown" on both sides, which would make the agreement check below pass for the wrong reason.
  check("[sanity] the sweep's own creationTime is non-null", selfRow?.creationTime != null);
  check("[sanity] checkRootSurvival's own creationTime is non-null", survival.creationTime != null);

  if (selfRow?.creationTime != null && survival.creationTime != null) {
    const deltaMs = Math.abs(selfRow.creationTime - survival.creationTime);
    // Both sides read a FIXED, unchanging OS attribute (when this process was created) via two SEPARATE
    // PowerShell queries moments apart — the underlying value never changes between the two reads, so
    // genuine agreement should be near-exact. It is NOT slack for a timezone-offset bug, which (pre-fix,
    // measured on a CEST host) was a full UTC-offset's worth of error (hours, not milliseconds) and would
    // blow through this bound by orders of magnitude.
    //
    // Card 64d7a914 (CR 33ae2f8a round 2, minor 3): `verifyRootDeadOrForceKill`'s win32 guard-2 branch now
    // compares EXACTLY this pair (its own `owner.creationTime` capture vs `checkRootSurvival`'s occupant
    // read) at `ROOT_CREATION_MATCH_TOLERANCE_MS` — tightened here from a loose 2000ms to that SAME bound,
    // so this real-spawn test actually pins the premise guard 2 depends on, rather than merely confirming
    // "not a timezone bug" with 2000ms of unrelated headroom. Independently re-measured across 15 fresh
    // real conpty children before tightening this: deltas in {0, 1}ms only, roughly 60/40, max 1ms — never
    // more (matching the CR's own measured Δ ∈ {0, -1}ms, same magnitude, opposite subtraction order).
    check(`[THE FIX] the sweep's own creationTime (${selfRow.creationTime}) agrees with checkRootSurvival's (${survival.creationTime}) within ROOT_CREATION_MATCH_TOLERANCE_MS (${ROOT_CREATION_MATCH_TOLERANCE_MS}ms) — delta=${deltaMs}ms`,
      deltaMs <= ROOT_CREATION_MATCH_TOLERANCE_MS);
  }

  // =====================================================================================================
  // Card 87691385 (CR 376c51de round 2, CRITICAL) — armWin32RootCreationTime's real end-to-end wiring:
  // a genuine conpty root, spawned by THIS test via node-pty (never a fabricated pid), must be positively
  // identified by `enumerateWin32SweepRowForPid` + `resolveVerifiedRootCreationTime` together — proving
  // the filtered single-pid query and the positive-identity predicate are actually wired to each other
  // against a real OS process, not merely unit-tested in isolation (pty-root-reap-identity.mjs covers the
  // predicate's own pure logic hermetically; this is the one real-process cross-check). Read-only: this
  // test never calls any reap/kill function, and cleans up via node-pty's own `kill()` directly.
  // =====================================================================================================
  let child = null;
  try {
    // Mirrors PtyHost.spawn()'s own real ordering exactly: the OS process is created FIRST (`createPty`),
    // `startedAt` is stamped only AFTER — never the reverse, which would wrongly expect the OS creation
    // time to precede a stamp taken before the process even existed.
    child = spawnPty("cmd.exe", [], { name: "xterm-color", cols: 80, rows: 30, cwd: tmpHome, env: process.env });
    const startedAt = Date.now();
    const row = await enumerateWin32SweepRowForPid(child.pid);
    check("[armWin32RootCreationTime wiring] the filtered single-pid query found the real conpty child's row", row !== null);
    check("[armWin32RootCreationTime wiring] the row's own creationTime is non-null", row?.creationTime != null);
    // The empirical anchor this whole predicate rests on: a real conpty-spawned child's CIM-reported
    // ppid IS the daemon's own process.pid directly (verified this session via a throwaway real-spawn
    // probe) — never an intermediary like conhost.exe/OpenConsole.exe.
    check("[armWin32RootCreationTime wiring] the row's ppid is THIS process's own pid (the predicate's anchor)", row?.ppid === process.pid);
    const verified = resolveVerifiedRootCreationTime(row, process.pid, startedAt);
    check("[armWin32RootCreationTime wiring] the real predicate POSITIVELY IDENTIFIES the genuine root (non-null)", verified !== null);
    check("[armWin32RootCreationTime wiring] the accepted value equals the row's own creationTime exactly", verified === row?.creationTime);
    // Negative control, same real row: a WRONG expected ppid (simulating the capture race's own headline
    // shape — the pid reused by some other process tree) must be rejected, never partially trusted.
    check("[armWin32RootCreationTime wiring, negative control] a wrong expected ppid against the SAME real row is rejected (null)",
      resolveVerifiedRootCreationTime(row, process.pid + 1, startedAt) === null);
    // Card 85ae7768 (CR 165cf2fa, item 4) — a REGISTRY-ABSENCE FACT, not a predicate result: this conpty
    // child is spawned via node-pty, never node:child_process's own spawn, so test/_guard.mjs's
    // companion-registry capture (cp.spawn-only, see docs/decisions/85ae7768) never even ATTEMPTS it for
    // this pid — the absence below is proven by that alone, independent of whether the predicate would
    // also have rejected it (already shown separately, two checks above). Label it for what it verifies.
    check("[companion registry] a never-captured (node-pty-spawned) pid has no companion-registry entry",
      !globalThis.__LOOM_TEST_SPAWNED_PID_CREATION_TIMES__?.has(child.pid));
    // A `startedAt` well BEFORE the row's own creationTime (the row is "too late" relative to it — the
    // OTHER of the predicate's two independently-required checks) must be rejected the same way — never
    // partially trusted either. 1000ms safely exceeds any slack this predicate would ever apply.
    check("[armWin32RootCreationTime wiring, negative control] a row later than startedAt+slack (too late) against the SAME real row is rejected (null)",
      resolveVerifiedRootCreationTime(row, process.pid, row.creationTime - 1000) === null);
  } finally {
    try { child?.kill(); } catch { /* best-effort — this is our own spawned process, never a reap/kill seam */ }
  }

  // =====================================================================================================
  // Card 85ae7768 — test/_guard.mjs's OWN companion-registry capture, end-to-end: a REAL
  // node:child_process.spawn root (the ONE spawn kind this suite ever hands directly to
  // reapOrphanedDescendants as a registered root — see docs/decisions/85ae7768) must end up with a
  // VERIFIED creationTime in the registry, via the SAME predicate proven above — never a fabricated
  // value. Also proves the re-entrancy guard: the capture's own powershell.exe helper spawn goes back
  // through this SAME wrapped cp.spawn, and must be recognized + skipped, not itself captured.
  //
  // The capture is OFF by default (every OTHER win32 test's cp.spawn calls — e.g. simple-git's real git
  // processes — must stay free of the real capture LATENCY, ~560-630ms measured on this host, not a
  // per-spawn CIM-query estimate). The opt-in rule is not "does this test's own assertion read a captured
  // creationTime" — it's "does this test hand a REGISTERED root to the real reaper"; THIS file opts in
  // because it's the one place that verifies the capture mechanism itself (the other reaper-root files
  // opt in too, for the SAME rule, not because their own assertions need the value — see
  // docs/decisions/85ae7768-win32-root-creation-leaf-module.md for the full rule and measured cost).
  // =====================================================================================================
  {
    enableRootCreationCapture();
    const statsBefore = { ...globalThis.__LOOM_TEST_CAPTURE_STATS__ };
    const root = spawnCp(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const rootPid = root.pid;
    try {
      await waitUntil(
        () => globalThis.__LOOM_TEST_SPAWNED_PID_CREATION_TIMES__.has(rootPid),
        { timeoutMs: 10_000, label: "_guard.mjs capture of the real cp.spawn root's creationTime" },
      );
      check("(capture) the real cp.spawn root ended up with a verified creationTime in the companion registry",
        globalThis.__LOOM_TEST_SPAWNED_PID_CREATION_TIMES__.has(rootPid));
      const captured = globalThis.__LOOM_TEST_SPAWNED_PID_CREATION_TIMES__.get(rootPid);
      check("(capture) the captured value is a real, positive epoch-ms number (never a fabricated/invented one)",
        typeof captured === "number" && captured > 0);

      // @decision 85ae7768 — the re-entrancy proof: exactly ONE capture was STARTED for this one real
      // root spawn (no runaway recursion through the capture's own helper spawn ballooning the count),
      // and the helper's OWN spawn was positively identified + skipped — not a vacuous "nothing
      // recursed because nothing was captured at all" (the `started` check above rules that out).
      // SNAPSHOT NOW, before the independent cross-check below — checkRootSurvival spawns its OWN real
      // powershell.exe via the SAME wrapped cp.spawn, which legitimately starts a SECOND, independent
      // capture (for ITS helper's pid, not a recursion of this one) and would otherwise inflate `started`.
      const statsAfter = { ...globalThis.__LOOM_TEST_CAPTURE_STATS__ };
      check("(capture, re-entrancy) exactly ONE capture was started for this one root spawn",
        statsAfter.started === statsBefore.started + 1);
      check("(capture, re-entrancy) the capture's own powershell.exe helper spawn was identified and skipped, never itself captured",
        statsAfter.skippedReentrant > statsBefore.skippedReentrant);
      check("(capture, re-entrancy) the capture never logged a failure for this root (a real, successful capture, not a masked one)",
        statsAfter.failed === statsBefore.failed);

      // Card 85ae7768 (CR 85360986, MINOR 3) — cross-check the captured value against this file's OWN
      // independent read (checkRootSurvival's DIFFERENT CIM-ConvertTo-Json query, same as the sanity
      // check at the top of this file), not just internal self-consistency within the capture's own code.
      const independentSurvival = await checkRootSurvival(rootPid, "pty-root-reap-win32-ticks-real-spawn-capture-crosscheck");
      check("(capture) the root is still alive for the independent cross-check", independentSurvival.foundAlive === true);
      check("(capture) the independent read's own creationTime is non-null", independentSurvival.creationTime != null);
      if (independentSurvival.creationTime != null) {
        const captureDeltaMs = Math.abs(captured - independentSurvival.creationTime);
        check(`(capture) the captured value (${captured}) agrees with the independent read (${independentSurvival.creationTime}) within ROOT_CREATION_MATCH_TOLERANCE_MS (${ROOT_CREATION_MATCH_TOLERANCE_MS}ms) — delta=${captureDeltaMs}ms`,
          captureDeltaMs <= ROOT_CREATION_MATCH_TOLERANCE_MS);
      }
    } finally {
      try { root.kill(); } catch { /* best-effort — our own spawned process */ }
    }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the win32 sweep's own CIM-ticks creationTime agrees with checkRootSurvival's independent CIM-ConvertTo-Json creationTime for a real pid."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
