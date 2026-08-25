// temp-reaper.mjs — bounded, age-gated reaper for orphaned `loom-*` temp dirs (card f273ebb9).
// Full diagnosis: docs/investigations/temp-fixture-leak-f273ebb9-diagnosis.md; mechanism also recorded in
// project memory `temp-fixture-leak-f273ebb9-killtree-mechanism`.
//
// WHY THIS EXISTS: the daemon test suite's own cleanup (`cleanupPathSync`/`mkdtempManaged` in
// _tmp-fixture.mjs) is bypassed whenever the gate force-kills its own process tree (`taskkill /pid <pid>
// /T /F` on win32, fired on BOTH a step timeout and a cancel — see gate-runner.ts's
// `killGateProcessTree`) — a forced kill bypasses Node's `beforeExit`/`exit` hooks entirely, regardless of
// how correct the killed file's own cleanup code is. This reaper is the backstop: run on a LATER suite
// invocation, it sweeps the OS temp root for anything a prior (possibly force-killed) run left behind.
//
// HARD SAFETY CONSTRAINTS (from the card — do not relax):
//  - Scope STRICTLY to entries named `loom-*` DIRECTLY under the given temp root. Never a blanket sweep —
//    this runs on the owner's real machine, and %TEMP% holds other applications' live state.
//  - AGE-GATE, not a liveness probe: only reap entries older than `ageMs` (default a few hours, well past
//    any real single test file or gate run), so this can never race a still-in-progress run's own
//    directory. Simpler and strictly safer than trying to positively detect "still in use".
//  - Reuse `_tmp-fixture.mjs`'s `cleanupPathSync` VERBATIM for the actual removal — the SAME bounded retry
//    (5 attempts, a REAL 100ms delay between attempts), the same "log and move on, never throw, never
//    retry a hung fs.rm" contract. Per project memory `worktree-gc-threadpool-leak`: a retry LOOP over a
//    hung `fs.rm` previously leaked libuv threadpool threads and wedged the whole daemon — this reaper
//    must never grow a second retry loop of its own.
//  - Bounded total work per invocation: `maxReap` caps how many entries one call will actually remove, so
//    a huge backlog can't turn "run automatically at suite start" into a multi-minute blocking step —
//    anything past the cap is reported, not touched, this run (picked up on a later invocation instead).
//
// Never throws: a scan failure (unreadable tmpRoot) or a per-entry stat/remove problem is reported in the
// returned summary, not thrown — a reaper problem must never fail the suite invoking it.
import fs from "node:fs";
import path from "node:path";
import { cleanupPathSync } from "../test/_tmp-fixture.mjs";

export const REAP_AGE_MS = 6 * 60 * 60 * 1000; // a few hours — well past any real single test/gate run
export const MAX_REAP_PER_RUN = 500; // bound the removal work per invocation — see file header

/**
 * @param {string} tmpRoot directory to scan (the OS temp root in real use; a throwaway dir in tests)
 * @param {{ ageMs?: number, now?: number, maxReap?: number }} [opts]
 * @returns {{ scanned: number, candidates: number, reaped: number, skippedTooYoung: number, skippedOverCap: number, errors: string[] }}
 */
// NOTE (observed while testing the never-settling-`fs.rm` case): a FAILED `cleanupPathSync` attempt can
// still partially succeed — e.g. removing a sidecar file before hitting a genuinely locked one — and that
// partial progress bumps the target directory's own mtime forward. So an entry that was already past the
// age gate can read as "too young" again on the VERY NEXT invocation, purely as a side effect of the
// failed attempt that just touched it. This only ever pushes reaping LATER, never earlier — it cannot
// cause a live directory to be reaped prematurely — so it's safe under the hard age-gate constraint, just
// worth knowing if a stubbornly-locked entry seems to survive more invocations than `ageMs` alone implies.
export function reapStaleLoomTempDirs(tmpRoot, opts = {}) {
  const ageMs = opts.ageMs ?? REAP_AGE_MS;
  const now = opts.now ?? Date.now();
  const maxReap = opts.maxReap ?? MAX_REAP_PER_RUN;

  let entries;
  try {
    entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
  } catch (err) {
    return { scanned: 0, candidates: 0, reaped: 0, skippedTooYoung: 0, skippedOverCap: 0, errors: [`readdir ${tmpRoot}: ${err.message}`] };
  }

  const candidateNames = entries.filter((e) => e.name.startsWith("loom-")).map((e) => e.name);

  let reaped = 0;
  let skippedTooYoung = 0;
  let skippedOverCap = 0;
  const errors = [];

  for (const name of candidateNames) {
    const full = path.join(tmpRoot, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (err) {
      if (err.code === "ENOENT") continue; // raced away between readdir and stat — already gone, not an error
      errors.push(`stat ${name}: ${err.message}`);
      continue;
    }
    if (now - stat.mtimeMs < ageMs) {
      skippedTooYoung++;
      continue;
    }
    if (reaped >= maxReap) {
      skippedOverCap++;
      continue;
    }
    cleanupPathSync(full); // bounded retry + real delay, logs and moves on — see file header, never a new retry loop
    reaped++;
  }

  return { scanned: entries.length, candidates: candidateNames.length, reaped, skippedTooYoung, skippedOverCap, errors };
}
