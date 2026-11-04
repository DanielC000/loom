// Hermetic unit test for card 6db94dfe: skills/inject.ts must never overwrite or prune a Loom-injected
// skill copy that was MODIFIED since THIS SAME session last placed it — the same-session-resume residual
// 31f997e7's own fingerprint mechanism deliberately did not cover (docs/decisions/31f997e7-*.md, "What
// remains" point 4, now closed here). The two pre-existing paths this proves:
//   - the myPrev re-copy in the main `want` loop (copySkillAtomic), gated by the "repo's own" skip;
//   - the myPrev-vs-want stale-prune loop.
//
// Contract proved:
//   - a resume (same cwd, same sessionId) that would RE-COPY a myPrev name (still in `want`) SKIPS the
//     overwrite when on-disk content no longer matches what THIS session recorded placing there — a hand
//     edit, or an added file, both survive;
//   - a resume that would PRUNE a myPrev name (dropped out of `want`) skips the delete under the same gate;
//   - an UNTOUCHED resume still refreshes/prunes normally — the fix must not regress today's behavior;
//   - a LEGACY claim (no recorded fingerprint — predates this mechanism) is refreshed/pruned when it's
//     already byte-identical to the CURRENT store copy (nothing would be lost), but kept when it diverges.
//
// useOwnLoomHome sets up a managed temp LOOM_HOME with guaranteed cleanup; WORKTREES_DIR (a sibling of
// LOOM_HOME) is separately registered. dist is imported only AFTER useOwnLoomHome.
// Run after build: node test/skills-inject-same-session-fingerprint.mjs
import fs from "node:fs";
import path from "node:path";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("loom-same-session-fp-");
const { injectSkills } = await import("../dist/skills/inject.js");
const { WORKTREES_DIR, OBSIDIAN_PREFLIGHT_FRAGMENT } = await import("../dist/paths.js");
registerForCleanup(WORKTREES_DIR); // a sibling of LOOM_HOME, not nested under it — clean it up too

const skillsDir = path.join(process.env.LOOM_HOME, "skills");
fs.mkdirSync(skillsDir, { recursive: true });

const skillMd = (name, body) => `---\nname: ${name}\ndescription: test skill ${name}\n---\n\n# ${body}\n`;
const writeStoreSkill = (name, body) => {
  fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, name, "SKILL.md"), skillMd(name, body));
};
writeStoreSkill("skill-a", "skill-a");
writeStoreSkill("skill-b", "skill-b");
// A REAL bundled asset name (OBSIDIAN_FRAGMENT_SKILLS member) — used only by cases (10)/(11) below, to
// exercise the obsidian-fragment transform in wouldPlaceFingerprint. Its content here is this test's own
// fixture text, not the real shipped doctrine; isBundledSkill("loom-pickup") is still true (it reads the
// real asset dir list), so needsPermissionStrip's own pristine-content check runs too (a harmless no-op,
// since this fixture body has no permission-widening construct either way).
writeStoreSkill("loom-pickup", "loom-pickup store base");

let seq = 0;
const isolatedCwd = (sub) => { const d = path.join(WORKTREES_DIR, "proj", `${sub}-${seq++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const sharedCwd = (sub) => { const d = path.join(process.env.LOOM_HOME, "shared-cwds", `${sub}-${seq++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const live = () => true; // every session in this file's co-claimant cases is live throughout

const deliveredPath = (cwd, name, file = "SKILL.md") => path.join(cwd, ".claude", "skills", name, file);
const manifestPath = (cwd) => path.join(cwd, ".claude", "skills", ".loom-skills.json");
const readManifestClaims = (cwd, sid) => {
  const p = manifestPath(cwd);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"))[sid] ?? [];
};

try {
  // --- (1) OVERWRITE-SKIP: a same-session resume with a hand-edited SKILL.md + an added file; the name
  //     stays in `want` on resume (same subset). The edit must survive, and the claim must relinquish. ---
  {
    const cwd = isolatedCwd("case1-overwrite-hand-edit-survives");
    injectSkills(cwd, "S1", ["skill-a"], "worker", false);
    const skillMdPath = deliveredPath(cwd, "skill-a");
    const notesPath = deliveredPath(cwd, "skill-a", "notes.md");
    fs.writeFileSync(skillMdPath, "# hand edit, uncommitted\n");
    fs.writeFileSync(notesPath, "extra file\n");
    injectSkills(cwd, "S1", ["skill-a"], "worker", false); // resume: same sid, same cwd, STILL wants it
    check("(1) hand-edited SKILL.md SURVIVES a same-session resume overwrite", fs.existsSync(skillMdPath) && fs.readFileSync(skillMdPath, "utf8") === "# hand edit, uncommitted\n");
    check("(1) the extra notes.md file SURVIVES too", fs.existsSync(notesPath));
    check("(1) manifest no longer claims it (the edit relinquishes Loom's claim)", !readManifestClaims(cwd, "S1").includes("skill-a"));
  }

  // --- (2) UNTOUCHED resume: no edit — must still refresh to a CHANGED store copy (regression check: the
  //     fix must not freeze an unmodified copy at its old content). -------------------------------------
  {
    const cwd = isolatedCwd("case2-untouched-resume-refreshes");
    injectSkills(cwd, "S2", ["skill-a"], "worker", false);
    const storeMd = path.join(skillsDir, "skill-a", "SKILL.md");
    const orig = fs.readFileSync(storeMd, "utf8");
    fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v2")); // store content changes between placements
    injectSkills(cwd, "S2", ["skill-a"], "worker", false); // resume, untouched on disk
    const refreshed = fs.readFileSync(deliveredPath(cwd, "skill-a"), "utf8");
    fs.writeFileSync(storeMd, orig); // restore immediately
    check("(2) untouched resume refreshes to the new store content", refreshed.includes("skill-a v2"));
    check("(2) untouched resume keeps the claim", readManifestClaims(cwd, "S2").includes("skill-a"));
  }

  // --- (3) PRUNE-SKIP: a hand-edited name that drops OUT of `want` on resume (subset narrows) must be
  //     KEPT, not deleted. -------------------------------------------------------------------------------
  {
    const cwd = isolatedCwd("case3-prune-hand-edit-survives");
    injectSkills(cwd, "S3", ["skill-a", "skill-b"], "worker", false);
    const skillMdPath = deliveredPath(cwd, "skill-a");
    fs.writeFileSync(skillMdPath, "# hand edit before narrowing\n");
    injectSkills(cwd, "S3", ["skill-b"], "worker", false); // resume: subset narrows, skill-a no longer wanted
    check("(3) hand-edited skill-a SURVIVES being dropped from the subset", fs.existsSync(skillMdPath) && fs.readFileSync(skillMdPath, "utf8") === "# hand edit before narrowing\n");
    check("(3) skill-b (still wanted) is unaffected", fs.existsSync(deliveredPath(cwd, "skill-b")));
  }

  // --- (4) UNTOUCHED prune: no edit, drops out of `want` on resume — must still be pruned (regression). -
  {
    const cwd = isolatedCwd("case4-untouched-prune-still-fires");
    injectSkills(cwd, "S4", ["skill-a", "skill-b"], "worker", false);
    injectSkills(cwd, "S4", ["skill-b"], "worker", false); // resume, untouched, narrower subset
    check("(4) untouched skill-a IS pruned when no longer wanted", !fs.existsSync(deliveredPath(cwd, "skill-a")));
  }

  // --- (5) LEGACY claim (no recorded fingerprint) that is BYTE-IDENTICAL to the current store copy: safe
  //     to refresh normally — nothing would be lost. Simulates a pre-card-6db94dfe manifest: the OLD flat-
  //     map shape, with no fingerprints sidecar at all. ------------------------------------------------
  {
    const cwd = isolatedCwd("case5-legacy-identical-refreshes");
    const skillsDest = path.join(cwd, ".claude", "skills");
    fs.mkdirSync(skillsDest, { recursive: true });
    fs.cpSync(path.join(skillsDir, "skill-a"), path.join(skillsDest, "skill-a"), { recursive: true }); // byte-identical to the store right now
    fs.writeFileSync(manifestPath(cwd), JSON.stringify({ S5: ["skill-a"] })); // legacy shape, no fingerprints file
    injectSkills(cwd, "S5", ["skill-a"], "worker", false); // resume: still wants it
    check("(5) legacy + byte-identical to store: refreshed/claimed normally", readManifestClaims(cwd, "S5").includes("skill-a"));
  }

  // --- (6) LEGACY claim that DIFFERS from the current store copy: cannot verify, so kept. ---------------
  {
    const cwd = isolatedCwd("case6-legacy-diverged-kept");
    const skillsDest = path.join(cwd, ".claude", "skills");
    fs.mkdirSync(path.join(skillsDest, "skill-a"), { recursive: true });
    fs.writeFileSync(path.join(skillsDest, "skill-a", "SKILL.md"), "# legacy content, diverged from store\n");
    fs.writeFileSync(manifestPath(cwd), JSON.stringify({ S6: ["skill-a"] })); // legacy, no fingerprints
    injectSkills(cwd, "S6", ["skill-a"], "worker", false);
    check("(6) legacy + diverged from store: content KEPT, not overwritten", fs.readFileSync(deliveredPath(cwd, "skill-a"), "utf8") === "# legacy content, diverged from store\n");
  }

  // --- (7) LEGACY claim that DIFFERS, and on resume drops OUT of `want`: must be kept (not pruned). ------
  {
    const cwd = isolatedCwd("case7-legacy-diverged-prune-kept");
    const skillsDest = path.join(cwd, ".claude", "skills");
    fs.mkdirSync(path.join(skillsDest, "skill-a"), { recursive: true });
    fs.writeFileSync(path.join(skillsDest, "skill-a", "SKILL.md"), "# legacy content, diverged, about to be unwanted\n");
    fs.writeFileSync(manifestPath(cwd), JSON.stringify({ S7: ["skill-a"] }));
    injectSkills(cwd, "S7", ["skill-b"], "worker", false); // skill-a never in `want`
    check("(7) legacy + diverged, dropped from subset: content KEPT, not pruned", fs.existsSync(deliveredPath(cwd, "skill-a")));
  }

  // --- (8) SHARED CWD, TWO LIVE CO-CLAIMANTS (Code Review finding, reviewer cb4d6528's coclaim2.mjs repro
  //     — a MAJOR regression this card introduced): a store reseed between resumes must NOT make a
  //     co-claimant's own legitimate refresh look like a hand edit to a SIBLING claimant, and a sibling's
  //     own subset-narrowing prune must NOT destroy a skill the OTHER live co-claimant still claims. -----
  {
    const cwd = sharedCwd("case8-two-live-coclaimants");
    injectSkills(cwd, "A8", ["skill-a", "skill-b"], "manager", false, live);
    injectSkills(cwd, "B8", ["skill-a"], "manager", false, live);
    const storeMd = path.join(skillsDir, "skill-a", "SKILL.md");
    const orig = fs.readFileSync(storeMd, "utf8");
    fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v2")); // reseed between resumes
    injectSkills(cwd, "A8", ["skill-a", "skill-b"], "manager", false, live); // A legitimately refreshes to v2
    injectSkills(cwd, "B8", ["skill-a"], "manager", false, live); // B must NOT read A's refresh as a hand edit
    fs.writeFileSync(storeMd, orig); // restore immediately
    check("(8) B does NOT falsely relinquish its claim after A's legitimate refresh", readManifestClaims(cwd, "B8").includes("skill-a"));
    check("(8) no false 'hand-modified' happened: disk reflects the real refresh", fs.readFileSync(deliveredPath(cwd, "skill-a"), "utf8").includes("skill-a v2"));
    injectSkills(cwd, "A8", ["skill-b"], "manager", false, live); // A narrows away from skill-a
    check("(8) skill-a SURVIVES A's narrowing — B still claims and wants it", fs.existsSync(deliveredPath(cwd, "skill-a")));
    check("(8) skill-b (still wanted by A) is unaffected", fs.existsSync(deliveredPath(cwd, "skill-b")));
  }

  // --- (9) LEGACY claim, BYTE-IDENTICAL to store, dropped from `want` on resume: must be PRUNED — the
  //     missing prune-site case (reviewer's mutant D disabling this branch survived the whole suite). ----
  {
    const cwd = isolatedCwd("case9-legacy-identical-pruned");
    const skillsDest = path.join(cwd, ".claude", "skills");
    fs.mkdirSync(path.join(skillsDest, "skill-a"), { recursive: true });
    fs.cpSync(path.join(skillsDir, "skill-a"), path.join(skillsDest, "skill-a"), { recursive: true }); // byte-identical to the store right now
    fs.writeFileSync(manifestPath(cwd), JSON.stringify({ S9: ["skill-a"] })); // legacy shape, no fingerprints file
    injectSkills(cwd, "S9", ["skill-b"], "worker", false); // resume: narrower subset, skill-a no longer wanted
    check("(9) legacy + byte-identical to store + dropped from want: PRUNED", !fs.existsSync(deliveredPath(cwd, "skill-a")));
  }

  // --- (10)/(11) wouldPlaceFingerprint is TRANSFORM-AWARE, not a raw-store comparison: a legacy claim
  //     whose on-disk bytes equal what placement-WITH-the-obsidian-fragment would produce must match when
  //     THIS session also has the fragment enabled, and must NOT match when it doesn't (the fragment
  //     legitimately wouldn't be there) — proving the fallback reflects this session's real settings. ----
  {
    // Generate the REAL transformed bytes via a real placement (obsidianEnabled=true), rather than
    // hand-replicating appendObsidianFragment's own exact algorithm here.
    const probeCwd = isolatedCwd("case10-probe-transformed-bytes");
    injectSkills(probeCwd, "probe10", ["loom-pickup"], "worker", true);
    const transformedBytes = fs.readFileSync(deliveredPath(probeCwd, "loom-pickup"), "utf8");
    const rawStoreBytes = fs.readFileSync(path.join(skillsDir, "loom-pickup", "SKILL.md"), "utf8");
    check("(10) precondition: the fragment-appended bytes actually differ from the raw store bytes", transformedBytes !== rawStoreBytes && transformedBytes.length > rawStoreBytes.length);

    // (10) obsidianEnabled=true on resume: the legacy on-disk (fragment-appended) bytes match what
    // placement would ACTUALLY produce right now — refreshed/claimed normally, not kept as "diverged".
    {
      const cwd = isolatedCwd("case10-legacy-transformed-match");
      const skillsDest = path.join(cwd, ".claude", "skills");
      fs.mkdirSync(path.join(skillsDest, "loom-pickup"), { recursive: true });
      fs.writeFileSync(path.join(skillsDest, "loom-pickup", "SKILL.md"), transformedBytes);
      fs.writeFileSync(manifestPath(cwd), JSON.stringify({ S10: ["loom-pickup"] })); // legacy, no fingerprints file
      injectSkills(cwd, "S10", ["loom-pickup"], "worker", true); // obsidianEnabled=true, still wants it
      check("(10) legacy + matches the TRANSFORMED bytes (obsidianEnabled=true): refreshed/claimed normally", readManifestClaims(cwd, "S10").includes("loom-pickup"));
    }

    // (11) SAME on-disk (fragment-appended) bytes, but THIS session has obsidianEnabled=false — what
    // placement would produce NOW has no fragment, so it must NOT match: kept, not falsely refreshed.
    {
      const cwd = isolatedCwd("case11-legacy-transformed-no-false-match");
      const skillsDest = path.join(cwd, ".claude", "skills");
      fs.mkdirSync(path.join(skillsDest, "loom-pickup"), { recursive: true });
      fs.writeFileSync(path.join(skillsDest, "loom-pickup", "SKILL.md"), transformedBytes);
      fs.writeFileSync(manifestPath(cwd), JSON.stringify({ S11: ["loom-pickup"] }));
      injectSkills(cwd, "S11", ["loom-pickup"], "worker", false); // obsidianEnabled=false this time
      check("(11) legacy + fragment-appended bytes, obsidianEnabled=false: does NOT false-match, content KEPT", fs.readFileSync(deliveredPath(cwd, "loom-pickup"), "utf8") === transformedBytes);
    }
  }
} catch (e) {
  console.log(`FAIL  unexpected throw: ${e.stack}`);
  failures++;
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a same-session resume never overwrites or prunes a hand-modified (or added-to) injected skill copy; an untouched resume still refreshes/prunes normally; a legacy no-fingerprint claim is refreshed only when matching ANY current claimant's recorded fingerprint or what placement would ACTUALLY produce right now (transform-aware, not a raw-store comparison); two LIVE co-claimants sharing a cwd never misread each other's legitimate refresh as a hand edit, and one's narrowing never destroys what the other still claims."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
