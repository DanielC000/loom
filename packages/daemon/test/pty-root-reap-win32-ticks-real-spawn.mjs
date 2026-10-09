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
import { requireHermeticEnv } from "./_guard.mjs";

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
  } finally {
    try { child?.kill(); } catch { /* best-effort — this is our own spawned process, never a reap/kill seam */ }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the win32 sweep's own CIM-ticks creationTime agrees with checkRootSurvival's independent CIM-ConvertTo-Json creationTime for a real pid."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
