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
// succeeds): hold a REAL, OS-level lock on a file inside the target dir for the ENTIRE duration, so every
// one of `cleanupPathSync`'s bounded retry attempts fails with a genuine, persistent EBUSY/EPERM — never
// resolving within the call. (A plain `fs.openSync` fd does NOT reproduce this on Windows — Node's own
// file opens set FILE_SHARE_DELETE, so a bare open fd does not block removal, confirmed empirically while
// writing this test. An open better-sqlite3 handle does — same mechanism `skills-adopt-fastforward.mjs`
// already relies on for its own "REST server + separate sqlite handle" fixture shape.) The reaper must
// reuse the existing bounded retry VERBATIM (5 attempts, a real 100ms delay each — ~500ms total) rather
// than looping on it itself, so this call must return promptly and without throwing even though the
// removal itself never actually succeeds.
{
  const locked = path.join(scratchRoot, "loom-locked-old");
  fs.mkdirSync(locked);
  const dbFile = path.join(locked, "inner-locked.db");
  const db = new Db(dbFile); // kept open for the whole reap call below — never closed mid-call
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
  check("(4) the locked entry is still present — removal genuinely failed, this isn't a false pass", fs.existsSync(locked));

  db.close(); // release the lock — proves the failure above was the lock, not something else broken
  // A negative ageMs here, deliberately — the failed attempt above partially removed this dir's sidecar
  // files before hitting the still-locked one, and that partial progress bumps the dir's OWN mtime forward
  // (see temp-reaper.mjs's own note on this) to within sub-millisecond clock-resolution noise of "now",
  // which an ageMs of exactly 0 can't reliably clear. This assertion is about the REMOVAL mechanism
  // succeeding once unlocked, not about the age gate, so the gate isn't re-exercised here — (1)/(2)/(3)
  // above already cover it.
  const secondAttempt = reapStaleLoomTempDirs(scratchRoot, { ageMs: -60_000 });
  check("(4) ...and once unlocked, the SAME mechanism successfully removes it on a later pass", !fs.existsSync(locked));
  void result;
  void secondAttempt;
}

console.log(failures === 0
  ? "\n✅ ALL PASS"
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
