// Regression guard for card f432cbb8 (DoD-4, the scan-bound half) — HERMETIC, no daemon, no real claude.
//
// resolveTranscriptFile's fallback scan (sessions/transcript.ts) memoizes resolved engine-session-id ->
// path hits (`resolvedPathCache`) so a REPEAT lookup for an already-found id skips the O(n) scan
// entirely. There is deliberately NO cache on the raw `readdir` of the projects root itself — an earlier
// draft of this fix had one (TTL-based, with a "only re-check dirs new since the cached listing" delta
// optimization to avoid double-paying the dominant existsSync-per-candidate cost) and it was REMOVED
// before landing, not merely never added: a directory X already present in a cached listing is EXCLUDED
// from the delta rescan on a miss (it was "already scanned"), even though `scanFor` only checked X for
// the specific target FILE, not for whether a NEW file might appear inside X between the first pass and
// the forced-fresh rescan. Engine session rotation writes a new `.jsonl` into an already-existing project
// dir — exactly the shape this excludes.
//
// This IS a genuine correctness hole, but it's a TOCTOU race against an external writer (the real `claude`
// CLI process, not this daemon), and it does NOT reproduce via simple sequential "write the file, then
// call resolveTranscriptFile" test code: `fs.existsSync` always reflects LIVE filesystem state, so any
// directory already present in the listing being scanned gets a live check regardless of when that
// listing was captured — a file that exists BEFORE the call starts is always found in the first pass
// (verified: an earlier draft of this test tried exactly that shape and passed against the buggy code
// too, for this reason). The race can only land in the narrow window BETWEEN the delta design's first
// pass (which finds X but misses the target — file doesn't exist YET) and its forced-fresh rescan (which
// would find the target if it re-checked X, but excludes it). Case (C) below reproduces that exact window
// deterministically by patching `fs.readdirSync` to write the target file as a side effect of the SPECIFIC
// call that represents the external process's write landing — no real concurrency needed, but the same
// shape a genuine race would produce. Verified manually during development: reintroducing the delta-rescan
// design and rebuilding makes case (C) go RED; the current code (one plain readdirSync + full scan, no
// listing cache, no exclusion of any kind) has no such window and passes.
//
// Cases (A)/(B) cover resolvedPathCache's own (much simpler, no-hole) coherence: a stale cached hit must
// rescan, and a fresh scan must still find a file written into a dir some earlier, unrelated lookup saw.
//
// Sandbox HOME/USERPROFILE to a temp root BEFORE importing dist (os.homedir() is read at call time, not
// cached — see transcript.ts) — never touches the real ~/.claude/projects.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sandboxHome = path.join(os.tmpdir(), `loom-tfc-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { resolveTranscriptFile, engineTranscriptPath } = await import("../dist/sessions/transcript.js");

try {
  // === (A) resolvedPathCache coherence: a deleted cached file must not be returned stale. ===
  {
    const cwdFound = path.join(sandboxHome, "cwd-a-found");
    fs.mkdirSync(cwdFound, { recursive: true });
    const idA = `tfc-a-${Date.now()}`;
    const fileA = engineTranscriptPath(cwdFound, idA);
    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, JSON.stringify({ role: "user" }) + "\n");

    const otherCwdA = path.join(sandboxHome, "cwd-a-other");
    const firstResolve = resolveTranscriptFile(otherCwdA, idA);
    check("(A setup) initial fallback resolve finds the file", firstResolve === fileA);

    const repeatResolve = resolveTranscriptFile(otherCwdA, idA);
    check("(A memoization) a repeat resolve for the same id returns the same cached file", repeatResolve === fileA);

    fs.rmSync(fileA, { force: true });
    const afterDelete = resolveTranscriptFile(otherCwdA, idA);
    check("(A coherence) after the cached file is deleted, a resolve does NOT return the stale path", afterDelete !== fileA);
    check("(A coherence) after the cached file is deleted and nothing replaces it, resolve returns null", afterDelete === null);
  }

  // === (B) a fresh scan still finds a file written into a dir an earlier, unrelated lookup already saw. ===
  {
    const rotDir = path.join(sandboxHome, "cwd-b-rotate");
    fs.mkdirSync(rotDir, { recursive: true });
    const decoyId = `tfc-b-decoy-${Date.now()}`;
    const decoyFile = engineTranscriptPath(rotDir, decoyId);
    fs.mkdirSync(path.dirname(decoyFile), { recursive: true });
    fs.writeFileSync(decoyFile, JSON.stringify({ role: "user" }) + "\n");

    const missId = `tfc-b-miss-${Date.now()}`;
    const missCwd = path.join(sandboxHome, "cwd-b-miss-probe");
    const missResult = resolveTranscriptFile(missCwd, missId);
    check("(B setup) the priming lookup for an unrelated missing id returns null", missResult === null);

    const rotatedId = `tfc-b-rotated-${Date.now()}`;
    const rotatedFile = engineTranscriptPath(rotDir, rotatedId);
    fs.writeFileSync(rotatedFile, JSON.stringify({ role: "user" }) + "\n");

    const otherCwdB = path.join(sandboxHome, "cwd-b-other");
    const rotatedResolve = resolveTranscriptFile(otherCwdB, rotatedId);
    check(
      "(B) a file written into an already-existing dir before the resolve call still resolves",
      rotatedResolve === rotatedFile,
    );
  }

  // === (C) THE CASE THAT WOULD HAVE CAUGHT THE REMOVED DESIGN'S BUG — a TOCTOU race against an
  // external writer, reproduced deterministically by patching fs.readdirSync. ===
  {
    const rotDir = path.join(sandboxHome, "cwd-c-rotate");
    fs.mkdirSync(rotDir, { recursive: true });
    const seedId = `tfc-c-seed-${Date.now()}`;
    const seedFile = engineTranscriptPath(rotDir, seedId);
    fs.mkdirSync(path.dirname(seedFile), { recursive: true });
    fs.writeFileSync(seedFile, JSON.stringify({ role: "user" }) + "\n"); // rotDir already exists before any resolve

    // Prime the module's cache with a listing that already includes rotDir (relevant only under the OLD
    // delta-rescan design — a no-op cost-wise under the current single-pass design, but keeps this test
    // usable against either implementation without modification).
    const primeId = `tfc-c-prime-${Date.now()}`;
    const primeCwd = path.join(sandboxHome, "cwd-c-prime-probe");
    resolveTranscriptFile(primeCwd, primeId);

    const rotatedId = `tfc-c-rotated-${Date.now()}`;
    const rotatedFile = engineTranscriptPath(rotDir, rotatedId);
    // NOT written yet — this models the file not existing when the fallback's first pass checks rotDir.

    // Patch fs.readdirSync so its VERY NEXT invocation writes rotatedFile as a side effect, THEN delegates
    // to the real implementation — modeling an external process's write landing exactly at the point a
    // forced-fresh rescan would happen. Restored immediately after firing once.
    const originalReaddirSync = fs.readdirSync;
    let armed = true;
    fs.readdirSync = function patchedReaddirSync(...args) {
      if (armed) {
        armed = false;
        fs.writeFileSync(rotatedFile, JSON.stringify({ role: "user" }) + "\n");
      }
      return originalReaddirSync.apply(fs, args);
    };

    let toctouResolve;
    try {
      const otherCwdC = path.join(sandboxHome, "cwd-c-other");
      toctouResolve = resolveTranscriptFile(otherCwdC, rotatedId);
    } finally {
      fs.readdirSync = originalReaddirSync; // never leave the global fs module patched
    }

    check(
      "(C) a file that appears (external-write race) between the fallback's own internal scans still resolves",
      toctouResolve === rotatedFile,
    );
    check("(C self-check) the patch actually armed and fired (positive control — a never-fired patch proves nothing)", armed === false);
  }
} finally {
  fs.rmSync(sandboxHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — resolvedPathCache never returns a stale (deleted) file, a fresh scan finds a file " +
    "written into an already-known dir, and a file appearing mid-scan (external-write race) still resolves " +
    "— no listing cache/delta-exclusion exists to create that window."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
