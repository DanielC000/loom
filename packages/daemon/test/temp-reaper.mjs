import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Tests for scripts/temp-reaper.mjs (card f273ebb9) — the bounded, age-gated reaper that sweeps orphaned
// `loom-*` temp dirs a force-killed gate run leaves behind (see that module's own header for the full
// mechanism). Everything here runs against a THROWAWAY scratch root (never the real %TEMP%), so these
// assertions are hermetic and cannot race a real concurrent run on this shared, self-hosting host.
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { reapStaleLoomTempDirs, REAP_AGE_MS } from "../scripts/temp-reaper.mjs";
import { Db } from "../dist/db.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const scratchRoot = mkdtempManaged("loom-tmpreap-root-");

// Backdate an entry's mtime (and atime) so its AGE, not its creation order, drives the reaper's decision —
// avoids depending on real wall-clock sleeps to produce an "old" entry.
function backdate(p, ageMs) {
  const past = new Date(Date.now() - ageMs);
  fs.utimesSync(p, past, past);
}

// ============ (1) name-scoping + age-gate — nothing is touched that shouldn't be ============
{
  const nonLoomOld = path.join(scratchRoot, "not-loom-old-dir");
  fs.mkdirSync(nonLoomOld);
  backdate(nonLoomOld, REAP_AGE_MS * 10); // deliberately very old — proves this is a NAME check, not just an age check

  const loomYoung = path.join(scratchRoot, "loom-neg-young");
  fs.mkdirSync(loomYoung); // fresh — age ~0

  const result = reapStaleLoomTempDirs(scratchRoot); // real `now`, default ageMs — no fabricated clock

  check("(1a) a non-`loom-*` entry is NEVER touched, even when it is far older than the age gate", fs.existsSync(nonLoomOld));
  check("(1b) a `loom-*` entry younger than the age gate is left alone", fs.existsSync(loomYoung));
  check("(1b) ...and is reported as skipped-too-young, not silently ignored", result.skippedTooYoung === 1);
  check("(1a) the non-`loom-*` entry is never even counted as a candidate", result.candidates === 1);

  fs.rmSync(nonLoomOld, { recursive: true, force: true });
  fs.rmSync(loomYoung, { recursive: true, force: true });
}

// ============ (2) a genuinely stale `loom-*` entry IS reaped ============
{
  const stale = path.join(scratchRoot, "loom-pos-old");
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, "file.txt"), "x");
  backdate(stale, REAP_AGE_MS + 60_000); // just past the age gate

  const result = reapStaleLoomTempDirs(scratchRoot);

  check("(2) a `loom-*` entry older than the age gate is actually removed", !fs.existsSync(stale));
  check("(2) ...and counted as reaped", result.reaped === 1);
}

// ============ (3) bounded total work — a `maxReap` cap is honored, not silently exceeded ============
{
  const stale = ["loom-cap-a", "loom-cap-b", "loom-cap-c"].map((name) => {
    const p = path.join(scratchRoot, name);
    fs.mkdirSync(p);
    backdate(p, REAP_AGE_MS + 60_000);
    return p;
  });

  const result = reapStaleLoomTempDirs(scratchRoot, { maxReap: 1 });

  check("(3) exactly `maxReap` entries are reaped, never more in one call", result.reaped === 1);
  check("(3) the rest are reported over-cap, not silently dropped", result.skippedOverCap === 2);
  const stillPresent = stale.filter((p) => fs.existsSync(p));
  check("(3) exactly the un-reaped entries are still on disk", stillPresent.length === 2);

  for (const p of stillPresent) fs.rmSync(p, { recursive: true, force: true });
}

// ============ (4) the never-settling-`fs.rm` case — a hung removal must never become a hang or a crash ============
// Simulates the exact shape `_tmp-fixture.mjs`'s own header calls out as unmitigated (a removal that never
// succeeds): hold a REAL, OS-level lock for the ENTIRE duration, so every one of `cleanupPathSync`'s
// bounded retry attempts fails with a genuine, persistent error — never resolving within the call. The
// LOCK MECHANISM IS PLATFORM-SPECIFIC — the property under test (no hang, no throw, no new retry loop) is
// not:
//   - win32: an open better-sqlite3 handle blocks deletion. (A plain `fs.openSync` fd does NOT reproduce
//     this — Node's own file opens set FILE_SHARE_DELETE, so a bare open fd does not block removal,
//     confirmed empirically while writing this test. An open better-sqlite3 handle does — same mechanism
//     `skills-adopt-fastforward.mjs` already relies on for its own "REST server + separate sqlite handle"
//     fixture shape.)
//   - POSIX: `unlink` on an open file SUCCEEDS (the dirent goes away; the inode lives until the last fd
//     closes), so an open handle proves nothing here — this is exactly why the prior Windows-only version
//     of this scenario false-passed on `ubuntu-latest` (card f291c617). Instead, remove write permission
//     from `locked` — the PARENT directory of the file we're protecting — so unlinking that entry inside
//     it genuinely fails EACCES.
// Either way, the reaper must reuse the existing bounded retry VERBATIM (5 attempts, a real 100ms delay
// each — ~500ms total) rather than looping on it itself, so the call must return promptly and without
// throwing even though the removal itself never actually succeeds.
{
  const locked = path.join(scratchRoot, "loom-locked-old");
  fs.mkdirSync(locked);
  backdate(locked, REAP_AGE_MS + 60_000);

  const isWin = process.platform === "win32";
  let db = null;
  let restoreMode = null;

  if (isWin) {
    const dbFile = path.join(locked, "inner-locked.db");
    db = new Db(dbFile); // kept open for the whole reap call below — never closed mid-call
  } else {
    fs.writeFileSync(path.join(locked, "inner-locked.txt"), "x");
    restoreMode = fs.statSync(locked).mode;
    fs.chmodSync(locked, 0o555); // no write bit — unlinking anything inside `locked` now fails EACCES
  }

  try {
    // 🔴🔴 POSITIVE-CONTROL THE LOCK BEFORE TRUSTING IT — chmod does NOT restrain root, and some CI images
    // run as root, so without this an independent direct removal could silently succeed under the "locked"
    // label and every assertion below would pass for the wrong reason (or reproduce this exact card's
    // ubuntu-latest failure again, just for a different underlying reason). Prove removal genuinely fails
    // for an INDEPENDENT actor — not the reaper — before trusting the reaper's non-removal means anything.
    let controlErr = null;
    try {
      fs.rmSync(locked, { recursive: true, force: true });
    } catch (err) {
      controlErr = err;
    }

    if (controlErr === null) {
      console.log(
        `SKIP  (4) the lock could not be established on this platform/user (isWin=${isWin}` +
          `${isWin ? "" : `, uid=${process.getuid ? process.getuid() : "n/a"}`}) — an independent direct ` +
          `removal succeeded, so this scenario would prove nothing here; skipping rather than asserting on ` +
          `an unlocked directory`,
      );
    } else {
      check("(4) positive control: an independent, direct removal genuinely fails while the lock is held", controlErr !== null);

      // 🔴 The positive control above can itself partially succeed before hitting the locked file (e.g. on
      // win32, unlocked WAL/SHM sidecars get removed before the still-open .db throws) — and that partial
      // removal bumps `locked`'s OWN mtime forward to ~now. Left alone, the reaper below would then AGE-GATE
      // the entry out (`skippedTooYoung`) instead of genuinely attempting and failing it — every assertion
      // in this block would then pass VACUOUSLY (true of a call that never tried, not of a call that tried
      // and failed). Re-establish the precondition the control just disturbed before trusting the reaper's
      // behavior against it.
      backdate(locked, REAP_AGE_MS + 60_000);

      let threw = null;
      const startedAt = Date.now();
      let result;
      try {
        result = reapStaleLoomTempDirs(scratchRoot);
      } catch (err) {
        threw = err;
      }
      const elapsedMs = Date.now() - startedAt;

      check("(4) a persistently-locked entry never throws out of the reaper", threw === null);
      // Generous ceiling — the real bound is ~500ms (5 attempts x 100ms); this only guards against a runaway
      // NEW retry loop being added later, not against ordinary scheduling jitter on a loaded host.
      check(`(4) a persistently-locked entry does not hang the reaper (took ${elapsedMs}ms, bound 5000ms)`, elapsedMs < 5000);
      // `fs.existsSync(locked)` alone can't tell "attempted and failed" from "never attempted" — the
      // returned summary can. `reaped` counts ATTEMPTS (it increments right after `cleanupPathSync` is
      // called, unconditionally of whether the removal actually succeeded), so asserting all three together
      // makes this genuinely about a failed removal, not a skipped one.
      check(
        "(4) the reaper genuinely ATTEMPTED the locked entry (not age-gated out) and the removal genuinely failed — not a false pass",
        result?.skippedTooYoung === 0 && result?.reaped === 1 && fs.existsSync(locked),
      );

      // release the lock — proves the failure above was the lock, not something else broken
      if (isWin) db.close();
      else fs.chmodSync(locked, restoreMode);

      // A negative ageMs here, deliberately — on win32 a failed attempt can partially remove this dir's
      // sidecar files before hitting the still-locked one, and that partial progress bumps the dir's OWN
      // mtime forward (see temp-reaper.mjs's own note on this) to within sub-millisecond clock-resolution
      // noise of "now", which an ageMs of exactly 0 can't reliably clear. This assertion is about the
      // REMOVAL mechanism succeeding once unlocked, not about the age gate, so the gate isn't re-exercised
      // here — (1)/(2)/(3) above already cover it.
      const secondAttempt = reapStaleLoomTempDirs(scratchRoot, { ageMs: -60_000 });
      check(
        "(4) ...and once unlocked, the SAME mechanism genuinely reaps it (not merely absent for some other reason) on a later pass",
        secondAttempt?.reaped === 1 && !fs.existsSync(locked),
      );
    }
  } finally {
    // Always release the lock and clean up, even on a SKIP or if an assertion above threw — never leave
    // scratchRoot holding an unremovable entry for the fixture's own final cleanup to trip over.
    if (isWin) { try { db.close(); } catch { /* already closed above, or never fully opened */ } }
    else if (restoreMode !== null) { try { fs.chmodSync(locked, restoreMode); } catch { /* best-effort; ENOENT if already gone */ } }
    try { fs.rmSync(locked, { recursive: true, force: true }); } catch { /* best-effort; scratchRoot cleanup covers stragglers */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS"
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
