// Hermetic unit test for skills/inject.ts — mirrors Loom's managed skills (~/.loom/skills) into a
// session's <cwd>/.claude/skills as project-local skills, without clobbering the repo's own skills.
// Sets LOOM_HOME to a temp dir BEFORE importing (paths.ts reads it at module load). No claude.
// Run after build: node test/skills-inject.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-inject-test-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const skillsDir = path.join(home, "skills");
const cwd = path.join(root, "repo");
fs.mkdirSync(path.join(skillsDir, "loom-a"), { recursive: true });
fs.mkdirSync(path.join(skillsDir, "loom-b"), { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(skillsDir, "loom-a", "SKILL.md"), "---\nname: loom-a\ndescription: A\n---\nA");
fs.writeFileSync(path.join(skillsDir, "loom-b", "SKILL.md"), "---\nname: loom-b\ndescription: B\n---\nB");
// The repo has its OWN project-local skill that must NEVER be clobbered.
fs.mkdirSync(path.join(cwd, ".claude", "skills", "repo-own"), { recursive: true });
fs.writeFileSync(path.join(cwd, ".claude", "skills", "repo-own", "SKILL.md"), "---\nname: repo-own\ndescription: theirs\n---\nKEEP");
execSync("git init -q", { cwd });

process.env.LOOM_HOME = home; // BEFORE importing — paths.ts computes SKILLS_DIR at load
const { injectSkills } = await import("../dist/skills/inject.js");

const SID = "sess-inject"; // single-session run: the manifest is keyed per session (map form)
try {
  injectSkills(cwd, SID, null); // null subset ⇒ deliver ALL store skills (today's default)
  const tdir = path.join(cwd, ".claude", "skills");
  const has = (n) => fs.existsSync(path.join(tdir, n, "SKILL.md"));
  const manifest = () => JSON.parse(fs.readFileSync(path.join(tdir, ".loom-skills.json"), "utf8"));
  check("loom-a injected (readable SKILL.md)", has("loom-a") && fs.readFileSync(path.join(tdir, "loom-a", "SKILL.md"), "utf8").includes("name: loom-a"));
  check("loom-b injected", has("loom-b"));
  check("repo's own skill left untouched", fs.readFileSync(path.join(tdir, "repo-own", "SKILL.md"), "utf8").includes("KEEP"));
  check("manifest records only Loom-placed names under the session key", JSON.stringify(manifest()[SID].sort()) === JSON.stringify(["loom-a", "loom-b"]));
  const excl = fs.readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf8");
  check(".git/info/exclude hides loom-a and loom-b (not repo-own)", excl.includes("/.claude/skills/loom-a") && excl.includes("/.claude/skills/loom-b") && !excl.includes("repo-own"));

  // Idempotent: a second run doesn't duplicate exclude lines.
  injectSkills(cwd, SID, null);
  const excl2 = fs.readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf8");
  check("idempotent — exclude not duplicated on re-run", (excl2.match(/\/\.claude\/skills\/loom-a/g) || []).length === 1);

  // Stale removal: delete loom-b from the store, re-inject → loom-b removed, repo-own + loom-a kept.
  fs.rmSync(path.join(skillsDir, "loom-b"), { recursive: true, force: true });
  injectSkills(cwd, SID, null);
  check("stale Loom skill removed when deleted from the store", !fs.existsSync(path.join(tdir, "loom-b")));
  check("loom-a still present after stale sweep", has("loom-a"));
  check("repo-own STILL untouched after stale sweep", fs.existsSync(path.join(tdir, "repo-own", "SKILL.md")));

  // =================================================================================================
  // card 22813c50 round 2, mutant (d)(i): `recordLoomPlacedFingerprint` REPLACES a name's recorded
  // fingerprint on every placement rather than accumulating one per content version ever placed — by
  // the time a scan reads this, the dir's on-disk content is always whatever the LATEST placement
  // wrote, so an older fingerprint can never legitimately match again and is pure dead weight.
  // =================================================================================================
  {
    const cwdReplace = path.join(root, "replace-cwd");
    fs.mkdirSync(cwdReplace, { recursive: true });
    const sidReplace = "sess-replace";
    const r1 = injectSkills(cwdReplace, sidReplace, ["loom-a"], null, false, () => true);
    const fpSet1 = r1.claimedFingerprints.get("loom-a");
    check("[REPLACE] a fresh placement records exactly ONE fingerprint for the name", fpSet1?.size === 1);
    const fp1 = [...(fpSet1 ?? [])][0];

    // Change the STORE skill's content — a DIFFERENT fingerprint for the SAME name on the next placement.
    fs.writeFileSync(path.join(skillsDir, "loom-a", "SKILL.md"), "---\nname: loom-a\ndescription: A v2\n---\nA v2");
    const r2 = injectSkills(cwdReplace, sidReplace, ["loom-a"], null, false, () => true);
    const fpSet2 = r2.claimedFingerprints.get("loom-a");
    check("[REPLACE] a SECOND placement with CHANGED content still records exactly ONE fingerprint — REPLACE, never accumulate",
      fpSet2?.size === 1);
    const fp2 = [...(fpSet2 ?? [])][0];
    check("[REPLACE] ...and it's the NEW fingerprint, not a stale leftover of the old one",
      fp2 !== undefined && fp2 !== fp1);

    fs.writeFileSync(path.join(skillsDir, "loom-a", "SKILL.md"), "---\nname: loom-a\ndescription: A\n---\nA"); // restore for the rest of this file
  }

  // =================================================================================================
  // card 22813c50 round 2, mutant (d)(ii): the registry's outer map is capped at a bounded number of
  // distinct cwds, LRU-evicted — bounding the OTHER growth axis (one entry per cwd this process has
  // ever injected into, which never shrinks on its own). LOOM_PLACED_FINGERPRINTS_MAX_CWDS below
  // mirrors inject.ts's own same-named constant (not exported for test import) — CLAUDE.md's "Do not
  // raise it casually" note is why this isn't expected to drift silently out from under this test.
  // =================================================================================================
  {
    const LOOM_PLACED_FINGERPRINTS_MAX_CWDS = 300;
    const cwdLru = path.join(root, "lru-cwd-0");
    fs.mkdirSync(cwdLru, { recursive: true });
    injectSkills(cwdLru, "sess-lru-0", ["loom-a"], null, false, () => true);

    // Precondition: a DIFFERENT (but live) session sharing cwdLru, claiming "loom-a" only through the
    // on-disk manifest (want:[] ⇒ places nothing of its own), sees the registry's fingerprint for it
    // right after placement — proves the lookup path itself works before testing eviction below.
    // NOTE: `["__probe-none__"]`, not `[]` — injectSkills treats an EMPTY subset array as falsy and
    // falls back to "deliver all store skills" (`subset && subset.length ? … : storeNames.filter(…)`),
    // which would make the probe place loom-a itself and defeat this whole test. A subset naming a
    // name that matches nothing in the store genuinely intersects to empty (`want = []`) instead.
    const probeBefore = injectSkills(cwdLru, "sess-lru-probe-before", ["__probe-none__"], null, false, () => true);
    check("[LRU] (precondition) a sibling session sharing cwdLru sees loom-a's fingerprint via the registry, before any eviction",
      (probeBefore.claimedFingerprints.get("loom-a")?.size ?? 0) === 1);

    // Push LOOM_PLACED_FINGERPRINTS_MAX_CWDS brand-new, distinct cwds through the registry — regardless
    // of how many OTHER cwds this process's registry already held before this test ran, cwdLru's
    // recency distance from the most-recently-touched entry is now >= the cap, so it MUST be the one
    // evicted (only the `cap` most-recently-placed-into cwds can ever survive).
    for (let i = 0; i < LOOM_PLACED_FINGERPRINTS_MAX_CWDS; i++) {
      const cwdFiller = path.join(root, `lru-filler-${i}`);
      fs.mkdirSync(cwdFiller, { recursive: true });
      injectSkills(cwdFiller, `sess-lru-filler-${i}`, ["loom-a"], null, false, () => true);
    }

    const probeAfter = injectSkills(cwdLru, "sess-lru-probe-after", ["__probe-none__"], null, false, () => true);
    check(`[LRU] after ${LOOM_PLACED_FINGERPRINTS_MAX_CWDS} newer cwds, cwdLru's own registry entry is EVICTED — a sibling session sharing it with NO placement of its own now sees no fingerprint (never unboundedly retained)`,
      (probeAfter.claimedFingerprints.get("loom-a")?.size ?? 0) === 0);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ ALL PASS — injectSkills delivers Loom skills project-local without clobbering the repo's own." : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
