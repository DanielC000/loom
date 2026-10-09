import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card bf58c19c — REAL-`ps` equivalence check, darwin/other non-Linux POSIX only.
//
// BACKGROUND: `verifyRootDeadOrForceKill`'s mac/POSIX branch used to compare a fresh `ps`-reported
// `lstart` against `owner.startedAt` (Loom's own `Date.now()` at spawn) — two different clocks read at
// two different instants, desynced by any wall-clock step in between. The fix mirrors win32's own
// verified-capture mechanism: capture the pid's own `lstart` once, verified, right after spawn
// (`enumeratePosixSweepRowForPid`), then compare it against a FRESH `lstart` read of the same pid at
// verify time (`checkRootSurvival`, via `enumerateProcessesPosixViaPs`) — both forced `TZ=UTC`/`LC_ALL=C`
// and parsed deterministically, so an exact match is the correct comparison. This test cross-checks those
// two real reads for a real pid (a child this test itself spawns) — read-only, kills nothing but its own
// spawned child.
//
// DISCLOSURE (docs/decisions/bf58c19c-*.md — read before trusting this file's coverage): this was authored
// and run only on a non-darwin host. It has NEVER been run against a real macOS process. Everything it
// checks about `ps -p <pid> -o pid=,ppid=,lstart=` output shape, UTC/C-locale behavior, and whether BSD
// `ps` floors or rounds `lstart` to the second is an ASSUMPTION encoded in the fix, not a measurement — this
// file documents what SHOULD be true and gives a maintainer with real macOS access a ready-made check, it
// does not itself constitute that verification.
//
// Run: 1) build (turbo builds shared first), 2) node test/pty-root-reap-posix-lstart-real-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as spawnCp } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform === "win32" || process.platform === "linux") {
  // Card 85bd4052 convention (see pty-root-reap-win32-ticks-real-spawn.mjs's own header) — a WARN line
  // (never a bare SKIP) survives test-daemon.mjs's own filtering once this file reports a pass, so a
  // win32/Linux CI runner still shows this file's real coverage never ran there. Win32 has its own CIM
  // equivalence test; Linux has its own boot-relative-ticks mechanism — neither reaches this `ps`-based
  // POSIX path at all (see `armRootCreationTime`'s own platform gate, pty/host.ts).
  console.log(`WARN  SKIP  pty-root-reap-posix-lstart-real-spawn.mjs — darwin/other non-Linux POSIX only; process.platform is '${process.platform}' here.`);
  process.exit(0);
}

const tmpHome = path.join(os.tmpdir(), `loom-posix-lstart-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
requireHermeticEnv();

const {
  enumeratePosixSweepRowForPid, checkRootSurvival, resolveVerifiedRootCreationTime,
  POSIX_CREATION_TIME_MATCH_TOLERANCE_MS,
} = await import("../dist/pty/host.js");

try {
  let root = null;
  try {
    root = spawnCp(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const rootPid = root.pid;
    // Mirrors PtyHost.spawn()'s own real ordering: the OS process is created FIRST, `startedAt` is
    // stamped only AFTER — never the reverse.
    const startedAt = Date.now();

    const row = await enumeratePosixSweepRowForPid(rootPid);
    check("[enumeratePosixSweepRowForPid] the filtered single-pid query found the real child's row", row !== null);
    check("[enumeratePosixSweepRowForPid] the row's own creationTime is non-null", row?.creationTime != null);
    // The anchor this whole predicate rests on: a direct `child_process.spawn` child's own ppid IS the
    // spawning process's pid — true by POSIX convention (never detached here), UNVERIFIED specifically
    // under this test's own `ps -p <pid> -o ppid=` column on a REAL macOS host (see the file's own
    // DISCLOSURE above).
    check("[enumeratePosixSweepRowForPid] the row's ppid is THIS process's own pid (the predicate's anchor)", row?.ppid === process.pid);

    const verified = resolveVerifiedRootCreationTime(row, process.pid, startedAt);
    check("[resolveVerifiedRootCreationTime] the real predicate POSITIVELY IDENTIFIES the genuine root (non-null)", verified !== null);
    check("[resolveVerifiedRootCreationTime] the accepted value equals the row's own creationTime exactly", verified === row?.creationTime);
    // Negative controls, same real row: a WRONG expected ppid, and a `startedAt` well BEFORE the row's own
    // creationTime (the row is "too late" relative to it) — neither may be partially trusted.
    check("[resolveVerifiedRootCreationTime, negative control] a wrong expected ppid against the SAME real row is rejected (null)",
      resolveVerifiedRootCreationTime(row, process.pid + 1, startedAt) === null);
    if (row?.creationTime != null) {
      check("[resolveVerifiedRootCreationTime, negative control] a row later than startedAt+slack (too late) against the SAME real row is rejected (null)",
        resolveVerifiedRootCreationTime(row, process.pid, row.creationTime - 10_000) === null);
    }

    // [THE FIX] cross-check the single-pid capture query's own reported creationTime against
    // `checkRootSurvival`'s INDEPENDENT read of the SAME pid (the general `ps` fallback enumeration,
    // filtered down to this one row) — the exact pair `verifyRootDeadOrForceKill`'s POSIX branch compares.
    // Both reads go through the SAME forced `TZ=UTC`/`LC_ALL=C` env and the SAME deterministic UTC parse,
    // so — UNLIKE win32's cross-source 1ms tolerance — exact agreement (delta 0) is what correctness
    // actually requires here, not merely "close enough".
    const survival = await checkRootSurvival(rootPid, "pty-root-reap-posix-lstart-real-spawn-no-such-session");
    check("[sanity] checkRootSurvival's own real `ps` read ALSO found this process alive", survival.foundAlive === true);
    check("[sanity] checkRootSurvival's own creationTime is non-null", survival.creationTime != null);
    check("[sanity] checkRootSurvival's own ppid is non-null", survival.ppid != null);
    if (row?.creationTime != null && survival.creationTime != null) {
      const deltaMs = Math.abs(row.creationTime - survival.creationTime);
      check(`[THE FIX] the single-pid capture's creationTime (${row.creationTime}) agrees EXACTLY with checkRootSurvival's (${survival.creationTime}) — delta=${deltaMs}ms, tolerance=${POSIX_CREATION_TIME_MATCH_TOLERANCE_MS}ms`,
        deltaMs <= POSIX_CREATION_TIME_MATCH_TOLERANCE_MS);
    }
    if (row?.ppid != null && survival.ppid != null) {
      check("[THE FIX] the single-pid capture's ppid agrees with checkRootSurvival's own ppid read for the same pid", row.ppid === survival.ppid);
    }
  } finally {
    try { root?.kill(); } catch { /* best-effort — our own spawned process */ }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the POSIX single-pid lstart capture agrees with checkRootSurvival's independent lstart read for a real pid."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
