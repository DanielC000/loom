// @decision 31f997e7 — the plain cross-process lost update this test pins at (1f) is ACCEPTED, not a
// bug: do not "fix" it by widening the interleave mechanism below without re-reading "CARD 4c2a0bfd" in
// that record first (card 4c2a0bfd itself has no file of its own — its narrative is a section there).
//
// Sets LOOM_HOME to a temp dir BEFORE importing (paths.ts reads it at module load). No claude.
// Run after build: node test/skills-inject-sidecar-rmw-race.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-skills-rmw-race-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const skillsDir = path.join(home, "skills");
const cwd = path.join(root, "repo");
fs.mkdirSync(path.join(skillsDir, "loom-a"), { recursive: true });
fs.writeFileSync(path.join(skillsDir, "loom-a", "SKILL.md"), "---\nname: loom-a\ndescription: A\n---\nA");
fs.mkdirSync(cwd, { recursive: true });
execSync("git init -q", { cwd }); // a real .git — exercises the hideFromGit/exclude path too, not just the writes

process.env.LOOM_HOME = home; // BEFORE importing — paths.ts computes SKILLS_DIR at load
const { injectSkills } = await import("../dist/skills/inject.js");
const { __setRenameSyncForTest } = await import("../dist/pty/claude-config.js");

const tdir = path.join(cwd, ".claude", "skills");
const manifestPath = path.join(tdir, ".loom-skills.json");
const fingerprintsPath = path.join(tdir, ".loom-skills-fingerprints.json");
const MANIFEST_TMP_GLOB = ".loom-skills.json.*.loom.tmp";
const FINGERPRINTS_TMP_GLOB = ".loom-skills-fingerprints.json.*.loom.tmp";

const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(" ")); };
const sawLog = (re) => logs.some((l) => re.test(l));

try {
  // ============ Baseline: sess-A alone first, so there's a real claim for sess-B to race against. ============
  injectSkills(cwd, "sess-A", null);
  check("baseline: sess-A alone places loom-a", fs.existsSync(path.join(tdir, "loom-a", "SKILL.md")));
  check("baseline: manifest records sess-A's claim", JSON.parse(fs.readFileSync(manifestPath, "utf8"))["sess-A"]?.includes("loom-a"));

  // ============ (1) THE B-IN-THE-GAP INTERLEAVE ============
  let hookFired = 0;
  let nestedRan = false;
  __setRenameSyncForTest((from, to) => {
    hookFired++;
    // Only the FIRST manifest rename of THIS run triggers the nested "other daemon" cycle — sess-B's own
    // rename calls must fall straight through to the real rename below, never re-trigger another nest.
    if (!nestedRan && to === manifestPath) {
      nestedRan = true;
      // sess-B's full read-modify-write cycle, completing END TO END (including its own successful
      // rename of both sidecar files) BEFORE sess-A's own pending rename (below) ever runs.
      injectSkills(cwd, "sess-B", null);
    }
    fs.renameSync(from, to); // the real rename, for whichever call is currently in progress
  });

  logs.length = 0;
  injectSkills(cwd, "sess-A", null); // sess-A's SECOND call: its in-memory manifest/fingerprints were read before sess-B's nested cycle ever ran
  __setRenameSyncForTest(undefined); // restore the real renameSyncImpl immediately — never leak the hook into a later call

  check("(1a) the hook actually intercepted real rename calls (both sides route through writeJsonAtomic)", hookFired >= 4);
  check("(1b) sess-B's nested cycle actually ran", nestedRan);
  check("(1c) no spurious '[skills] failed to write ...' log from EITHER side (unique tmp names never collide)", !sawLog(/\[skills\] failed to write/));

  const manifestAfter = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const fingerprintsAfter = JSON.parse(fs.readFileSync(fingerprintsPath, "utf8"));
  check("(1d) the manifest is still valid, parseable JSON after the race (no torn/corrupt write)", manifestAfter && typeof manifestAfter === "object");
  check("(1d) the fingerprints sidecar is still valid, parseable JSON after the race", fingerprintsAfter && typeof fingerprintsAfter === "object");
  check("(1e) sess-A's own claim survived (it's the LAST writer)", Array.isArray(manifestAfter["sess-A"]) && manifestAfter["sess-A"].includes("loom-a"));
  // *** THE ACCEPTED RESIDUAL — must NEVER be asserted as fixed; see docs/decisions/31f997e7-*.md "CARD
  // 4c2a0bfd" *** : sess-A's write is built from a snapshot taken BEFORE sess-B's nested cycle committed
  // its own claim, so sess-A's later rename (landing last) overwrites sess-B's claim entirely. This is a
  // plain, inherent, unlocked lost update — the card explicitly decided NOT to close this (costs a freeze
  // or a re-copy next time, per the decision record's cost analysis, never data loss) and only closed the
  // same-tmp-name COLLISION hazard checks (1a)-(1d) above pin.
  check("(1f) *** ACCEPTED RESIDUAL, NOT A REGRESSION ***: sess-B's claim is LOST to sess-A's later, stale-snapshot write (plain lost update — still present post-fix, by design)", !("sess-B" in manifestAfter));

  // ============ (2) the new git-exclude glob entries for the (now-unique-named) tmp files ============
  const excl = fs.readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf8");
  check("(2a) the manifest tmp glob is excluded", excl.includes(`/.claude/skills/${MANIFEST_TMP_GLOB}`));
  check("(2b) the fingerprints tmp glob is excluded", excl.includes(`/.claude/skills/${FINGERPRINTS_TMP_GLOB}`));
  // A real stray tmp file (as a crash mid-write would leave) must actually be git-ignored by that glob —
  // not just that the literal glob string is present in the exclude file (which proves nothing about
  // whether git itself treats it as a pattern). Verified with `git check-ignore` itself (exit 0 = git
  // agrees it's ignored), never by re-deriving glob syntax by hand or parsing porcelain text.
  const strayManifestTmp = path.join(tdir, `.loom-skills.json.${process.pid}.deadbeef-0000-0000-0000-000000000000.loom.tmp`);
  fs.writeFileSync(strayManifestTmp, "stray crash-stranded tmp");
  const strayFingerprintsTmp = path.join(tdir, `.loom-skills-fingerprints.json.${process.pid}.deadbeef-0000-0000-0000-000000000000.loom.tmp`);
  fs.writeFileSync(strayFingerprintsTmp, "stray crash-stranded tmp");
  const isIgnored = (p) => { try { execSync(`git check-ignore -q "${p}"`, { cwd }); return true; } catch { return false; } };
  check("(2c) a real stray crash-stranded manifest tmp is actually recognized as ignored by git itself", isIgnored(strayManifestTmp));
  check("(2d) a real stray crash-stranded fingerprints tmp is actually recognized as ignored by git itself", isIgnored(strayFingerprintsTmp));
  fs.rmSync(strayManifestTmp, { force: true });
  fs.rmSync(strayFingerprintsTmp, { force: true });
} catch (e) {
  console.error(e);
  failures++;
} finally {
  console.log = origLog;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ ALL PASS — sidecar RMW race: the same-tmp-name collision is closed (unique names, no spurious failures, valid JSON), the plain unlocked lost-update is unchanged by design, and the new tmp globs are real git-exclude entries." : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
