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

const { enumerateWin32SweepRows, checkRootSurvival } = await import("../dist/pty/host.js");

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
    // genuine agreement should be near-exact. 2000ms of slack covers the two queries' differing time
    // precision (.NET Ticks, 100ns, vs the ConvertTo-Json `/Date(<ms>)/` form's ms rounding) and ordinary
    // scheduling jitter between the two spawns — it is NOT slack for a timezone-offset bug, which
    // (pre-fix, measured on a CEST host) was a full UTC-offset's worth of error (hours, not
    // milliseconds) and would blow through this bound by orders of magnitude.
    check(`[THE FIX] the sweep's own creationTime (${selfRow.creationTime}) agrees with checkRootSurvival's (${survival.creationTime}) within 2000ms — delta=${deltaMs}ms`,
      deltaMs <= 2000);
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the win32 sweep's own CIM-ticks creationTime agrees with checkRootSurvival's independent CIM-ConvertTo-Json creationTime for a real pid."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
