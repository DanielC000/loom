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
// Cases (12)-(13) are card 3b2a8707: the SAME myPrev gate now also covers a FRESH session's first-time
// otherClaimed claim. (14)-(16) add the cross-variant co-claim + wouldPlaceFingerprint's own strip-
// failure paths. (17)-(21c) are Code Review rounds 2-4 of card 3b2a8707: closing the LAST-WRITER-DIED
// false freeze, in-process (17)-(18) and surviving a simulated daemon restart (19)-(21c).
//
// card f4272888 retired the multi-source gate (17)-(21c) were written to probe (the daemon-side registry
// union, the merged/capped `__lastPlaced` carry-forward) in favor of ONE persisted per-(cwd,name) fact,
// written at every real placement and read directly by the gate — never session-scoped, so a session's
// death (or `freshInjectModule`'s simulated restart, below) has NOTHING to carry forward or lose. Cases
// (17)-(21c) still PASS and are kept as black-box regression coverage of the same end-to-end outcomes,
// but they no longer isolate restart-survival specifically — there is nothing left in this area that
// COULD fail across a restart. See docs/decisions/31f997e7-*.md's "CARD f4272888" section for the full
// redesign and why every one of these scenarios still resolves correctly. (22)-(23) are new for f4272888:
// the one-shot migration fold of a pre-card legacy sidecar, and the forged-`"__proto__"`-key hazard.
// (24)/(24b)-(25a)/(25b) are a round-6 Code Review pass on f4272888's own implementation: (24)/(24b) prove
// the migration fold is order-independent (the fold used to REPLACE rather than UNION when `__lastPlaced`
// was reached after a legacy section in the real pre-card key order); (25a)/(25b) close a pre-existing
// gap at the PRUNE loop's own `wouldPlaceFingerprint` fallback call, the prune-site sibling of (10)/(11).
// @decision 31f997e7
//
// useOwnLoomHome sets up a managed temp LOOM_HOME with guaranteed cleanup; WORKTREES_DIR (a sibling of
// LOOM_HOME) is separately registered. dist is imported only AFTER useOwnLoomHome.
// Run after build: node test/skills-inject-same-session-fingerprint.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("loom-same-session-fp-");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// card 3b2a8707 Code Review round 3: a stable, re-importable module URL — `freshInjectModule` below
// appends a cache-busting query to force Node to evaluate a GENUINELY FRESH module instance (its own
// empty `loomPlacedFingerprintsByCwd`), simulating a daemon restart's effect on in-memory state while
// every import `inject.js` itself makes (paths.js, store.js, …) stays the SAME already-cached instance —
// same technique as merge-quarantine-lazy-graduation-multi-pending.mjs's own `freshBootModule`.
const injectModuleHref = pathToFileURL(path.join(__dirname, "..", "dist", "skills", "inject.js")).href;
const { injectSkills, fingerprintSkillDir } = await import(injectModuleHref);
const { isValidSkillName } = await import("../dist/skills/store.js");
const { WORKTREES_DIR, OBSIDIAN_PREFLIGHT_FRAGMENT } = await import("../dist/paths.js");
registerForCleanup(WORKTREES_DIR); // a sibling of LOOM_HOME, not nested under it — clean it up too

let restartCounter = 0;
async function freshInjectModule() {
  restartCounter++;
  return await import(`${injectModuleHref}?restart=${restartCounter}`);
}

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
// card 3b2a8707, item 2 — a simple, UNSTAMPED strippable hazard (same shape as
// skills-inject-permission-strip.mjs's own `hazardMd`): not bundled, not human-provenance-stamped, so
// `needsPermissionStrip` is true, and this specific construct (a frontmatter key + one inline shell
// trigger) strips cleanly to a verified-clean result — used only by case (15) below.
const hazardMd = (name) => `---\nname: ${name}\ndescription: test skill ${name}\nallowed-tools: Bash(*)\n---\n\n# ${name}\n\nRun: !\`node sentinel.js\`\n`;
const writeHazardStoreSkill = (name, md) => {
  fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, name, "SKILL.md"), md);
};
writeHazardStoreSkill("skill-hazard", hazardMd("skill-hazard"));
// card 3b2a8707, item 2 — card 712148f1's own flow-mapping-form hazard: the ONE construct that
// genuinely, unassistedly (no fault injection) defeats the strip's fixpoint loop, returning null rather
// than a stripped result — used only by case (16) below to exercise `wouldPlaceFingerprint`'s own
// undeliverable `return null` branch.
const flowMapHazardMd = (name) => `---\n{name: ${name}, allowed-tools: Bash(*)}\n---\n\n# ${name}\n`;
writeHazardStoreSkill("skill-flowmap-hazard", flowMapHazardMd("skill-flowmap-hazard"));

let seq = 0;
const isolatedCwd = (sub) => { const d = path.join(WORKTREES_DIR, "proj", `${sub}-${seq++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const sharedCwd = (sub) => { const d = path.join(process.env.LOOM_HOME, "shared-cwds", `${sub}-${seq++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const live = () => true; // every session in this file's co-claimant cases is live throughout

const deliveredPath = (cwd, name, file = "SKILL.md") => path.join(cwd, ".claude", "skills", name, file);
const manifestPath = (cwd) => path.join(cwd, ".claude", "skills", ".loom-skills.json");
const fingerprintsPath = (cwd) => path.join(cwd, ".claude", "skills", ".loom-skills-fingerprints.json");
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

  // --- (12) MAIN ITEM (card 3b2a8707): shared cwd, session A claims+hand-edits `skill-a`; session B,
  //     which has NEVER claimed `skill-a` before (the otherClaimed-not-myPrev branch), then wants it for
  //     the first time. Before this card that re-copy was unconditional — A's hand edit must now survive,
  //     and B must NOT claim a name whose on-disk content it never actually placed. --------------------
  {
    const cwd = sharedCwd("case12-otherclaimed-hand-edit-survives");
    injectSkills(cwd, "A12", ["skill-a"], "manager", false, live);
    const skillMdPath = deliveredPath(cwd, "skill-a");
    fs.writeFileSync(skillMdPath, "# A's hand edit, uncommitted\n"); // A hand-edits AFTER placing
    injectSkills(cwd, "B12", ["skill-a"], "manager", false, live); // B wants skill-a for the FIRST time
    check("(12) A's hand-edited SKILL.md SURVIVES B's first-time otherClaimed re-copy", fs.readFileSync(skillMdPath, "utf8") === "# A's hand edit, uncommitted\n");
    check("(12) B does NOT claim a name it never actually placed", !readManifestClaims(cwd, "B12").includes("skill-a"));
    check("(12) A still claims it (untouched)", readManifestClaims(cwd, "A12").includes("skill-a"));
  }

  // --- (13) REGRESSION: same shape as (12) but A's copy is UNTOUCHED (no hand edit) — B's first-time
  //     otherClaimed claim must still succeed normally; the fix must not block a legitimate second live
  //     session joining an existing claim. -------------------------------------------------------------
  {
    const cwd = sharedCwd("case13-otherclaimed-untouched-first-claim-succeeds");
    injectSkills(cwd, "A13", ["skill-a"], "manager", false, live);
    injectSkills(cwd, "B13", ["skill-a"], "manager", false, live); // B wants skill-a for the first time, untouched
    check("(13) B successfully co-claims an untouched otherClaimed name", readManifestClaims(cwd, "B13").includes("skill-a"));
    check("(13) A still claims it too", readManifestClaims(cwd, "A13").includes("skill-a"));
    check("(13) content is the plain store content (no divergence)", fs.readFileSync(deliveredPath(cwd, "skill-a"), "utf8").includes("skill-a"));
  }

  // --- (14) VARIANT DRIFT (manager's extra ask on card 3b2a8707): two LIVE co-claimants with DIFFERING
  //     obsidianEnabled settings on a fragment-target skill. A places WITH the fragment; B then
  //     first-claims the SAME name WITHOUT it. B's own placement overwrites with its own (fragment-free)
  //     variant and records its OWN fingerprint — so A's NEXT resume must see B's recorded fingerprint in
  //     the union and refresh normally, never read B's legitimate variant as a hand edit and freeze. ----
  {
    const cwd = sharedCwd("case14-variant-drift-coclaim");
    injectSkills(cwd, "A14", ["loom-pickup"], "manager", true, live); // A: obsidianEnabled=true
    const aVariant = fs.readFileSync(deliveredPath(cwd, "loom-pickup"), "utf8");
    injectSkills(cwd, "B14", ["loom-pickup"], "manager", false, live); // B: first claim, obsidianEnabled=false
    const bVariant = fs.readFileSync(deliveredPath(cwd, "loom-pickup"), "utf8");
    check("(14) precondition: A's and B's variants actually differ", aVariant !== bVariant);
    check("(14) B successfully claims (did not read A's variant as a hand edit)", readManifestClaims(cwd, "B14").includes("loom-pickup"));
    check("(14) disk now reflects B's own (fragment-free) variant", fs.readFileSync(deliveredPath(cwd, "loom-pickup"), "utf8") === bVariant);
    injectSkills(cwd, "A14", ["loom-pickup"], "manager", true, live); // A resumes: must NOT see B's variant as hand-modified
    check("(14) A's resume does NOT freeze as hand-modified (still claims it)", readManifestClaims(cwd, "A14").includes("loom-pickup"));
    check("(14) A's resume refreshes back to A's own (fragment-appended) variant", fs.readFileSync(deliveredPath(cwd, "loom-pickup"), "utf8") === aVariant);
  }

  // --- (15) item 2's exact recipe: an agent/unstamped STORE skill with a strippable construct
  //     (`skill-hazard`) — generate the REAL stripped delivered bytes via a genuine probe placement, then
  //     plant those EXACT bytes as a LEGACY claim (no recorded fingerprint) elsewhere. `wouldPlaceFingerprint`
  //     must apply the SAME strip to match them — a mutant that drops the strip step inside it would
  //     fingerprint the UNSTRIPPED store bytes instead, which would NOT match these on-disk (stripped)
  //     bytes, and this case would go RED (kept, not claimed) under that mutant. ----------------------
  {
    const probeCwd = isolatedCwd("case15-probe-stripped-bytes");
    injectSkills(probeCwd, "probe15", ["skill-hazard"], "worker", false);
    const strippedBytes = fs.readFileSync(deliveredPath(probeCwd, "skill-hazard"), "utf8");
    const rawStoreBytes = fs.readFileSync(path.join(skillsDir, "skill-hazard", "SKILL.md"), "utf8");
    check("(15) precondition: the real probe placement actually stripped the hazard (delivered bytes differ from raw store)", strippedBytes !== rawStoreBytes);

    const cwd = isolatedCwd("case15-legacy-stripped-match");
    const skillsDest = path.join(cwd, ".claude", "skills");
    fs.mkdirSync(path.join(skillsDest, "skill-hazard"), { recursive: true });
    fs.writeFileSync(path.join(skillsDest, "skill-hazard", "SKILL.md"), strippedBytes);
    fs.writeFileSync(manifestPath(cwd), JSON.stringify({ S15: ["skill-hazard"] })); // legacy, no fingerprints file
    injectSkills(cwd, "S15", ["skill-hazard"], "worker", false);
    check("(15) legacy claim matching the REAL stripped bytes: refreshed/claimed normally (mutant-killing — see header)", readManifestClaims(cwd, "S15").includes("skill-hazard"));
  }

  // --- (16) item 2's "also cover the undeliverable `return null` path": the store copy itself is the
  //     flow-mapping-form hazard that genuinely defeats the strip (card 712148f1) — real placement of this
  //     name would THROW (undeliverable), so there is no "real probe" bytes to generate. A legacy claim
  //     whose on-disk content is the RAW (unstripped) store bytes must still be KEPT, never claimed —
  //     proving `wouldPlaceFingerprint`'s own `return null` is reached and "cannot verify" fails toward
  //     keeping even though the on-disk bytes happen to equal the raw store (which real placement would
  //     never actually produce, since it's undeliverable). ------------------------------------------------
  {
    const cwd = isolatedCwd("case16-legacy-undeliverable-kept");
    const skillsDest = path.join(cwd, ".claude", "skills");
    const rawFlowMapBytes = fs.readFileSync(path.join(skillsDir, "skill-flowmap-hazard", "SKILL.md"), "utf8");
    fs.mkdirSync(path.join(skillsDest, "skill-flowmap-hazard"), { recursive: true });
    fs.writeFileSync(path.join(skillsDest, "skill-flowmap-hazard", "SKILL.md"), rawFlowMapBytes);
    fs.writeFileSync(manifestPath(cwd), JSON.stringify({ S16: ["skill-flowmap-hazard"] })); // legacy, no fingerprints file
    let thrown16;
    try { injectSkills(cwd, "S16", ["skill-flowmap-hazard"], "worker", false); } catch (e) { thrown16 = e; }
    check("(16) injectSkills does NOT throw (kept, never attempted a real undeliverable re-placement)", !thrown16);
    check("(16) content is KEPT exactly as the legacy raw bytes (undeliverable ⇒ cannot verify ⇒ not overwritten)", fs.readFileSync(deliveredPath(cwd, "skill-flowmap-hazard"), "utf8") === rawFlowMapBytes);
    check("(16) NOT claimed (never verified safe to claim)", !readManifestClaims(cwd, "S16").includes("skill-flowmap-hazard"));
  }

  // --- (17) CODE REVIEW regression (finding 1, round 2 on card 3b2a8707): the LAST WRITER died before
  //     anyone else refreshed. Sequence (reviewer's dist repro): A places v1; the store moves to v2; C (a
  //     fresh co-claimant) first-claims and refreshes to v2; C dies; B (a fresh co-claimant) must still
  //     succeed — not read C's now-unrecorded-but-genuinely-untouched v2 content as hand-modified and
  //     refuse forever. A's own resume afterward must also still succeed. ------------------------------
  {
    const cwd = sharedCwd("case17-last-writer-dies-fresh-coclaim");
    injectSkills(cwd, "A17", ["skill-a"], "manager", false, live); // A places v1
    const storeMd = path.join(skillsDir, "skill-a", "SKILL.md");
    const origStore = fs.readFileSync(storeMd, "utf8");
    fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v2")); // store moves to v2
    injectSkills(cwd, "C17", ["skill-a"], "manager", false, live); // C first-claims, refreshes to v2
    const v2Bytes = fs.readFileSync(deliveredPath(cwd, "skill-a"), "utf8");
    const deadC = (sid) => sid !== "C17"; // C is now dead
    injectSkills(cwd, "B17", ["skill-a"], "manager", false, deadC); // B first-claims; C is dead; store still at v2
    check("(17) B successfully claims the now-dead C's untouched v2 content (not frozen as hand-modified)", readManifestClaims(cwd, "B17").includes("skill-a"));
    check("(17) content is unchanged (still v2 — byte-identical overwrite, nothing lost)", fs.readFileSync(deliveredPath(cwd, "skill-a"), "utf8") === v2Bytes);
    injectSkills(cwd, "A17", ["skill-a"], "manager", false, deadC); // A's own resume must also still succeed
    check("(17) A's own resume also succeeds (not frozen)", readManifestClaims(cwd, "A17").includes("skill-a"));
    fs.writeFileSync(storeMd, origStore); // restore immediately, now that all placements for this case are done
  }

  // --- (18) CODE REVIEW regression (finding 2's "pre-existing variant" case): the SAME last-writer-dies
  //     shape, but reached through the myPrev branch instead of otherClaimed. A places WITH the obsidian
  //     fragment; B (a fresh co-claimant) places its OWN fragment-free variant; B dies; A's OWN resume
  //     must still succeed — the per-session record of B's variant is gone, but the daemon-side registry
  //     still has it. -------------------------------------------------------------------------------------
  {
    const cwd = sharedCwd("case18-myprev-last-writer-dies");
    injectSkills(cwd, "A18", ["loom-pickup"], "manager", true, live); // A: obsidianEnabled=true
    const aVariant = fs.readFileSync(deliveredPath(cwd, "loom-pickup"), "utf8");
    injectSkills(cwd, "B18", ["loom-pickup"], "manager", false, live); // B: first claim, obsidianEnabled=false
    const bVariant = fs.readFileSync(deliveredPath(cwd, "loom-pickup"), "utf8");
    check("(18) precondition: A's and B's variants actually differ", aVariant !== bVariant);
    const deadB = (sid) => sid !== "B18"; // B is now dead
    injectSkills(cwd, "A18", ["loom-pickup"], "manager", true, deadB); // A resumes; B is dead
    check("(18) A's resume succeeds (does NOT freeze on the now-dead B's untouched variant)", readManifestClaims(cwd, "A18").includes("loom-pickup"));
    check("(18) disk refreshes back to A's own fragment-appended variant", fs.readFileSync(deliveredPath(cwd, "loom-pickup"), "utf8") === aVariant);
  }

  // --- (19) CODE REVIEW round 3, reviewer's P2: case (17)'s shape, but with a daemon RESTART before B's
  //     claim and NO further store change. Valid, real coverage of the described repro — but EMPIRICALLY
  //     VERIFIED (ran the exact mutant below against it) this does NOT isolate fix (b): round 3's own
  //     `lastPlaced` carry-forward ALSO independently matches here (it carries forward C's own v2
  //     fingerprint, which still equals current disk, directly in the `recorded` set BEFORE
  //     `matchesRecordedFingerprint` ever reaches its `storeFallback` branch) — reverting JUST (b)'s rule
  //     leaves this case GREEN. See (19b) immediately below for a construction that genuinely isolates
  //     (b): round 3 only ever carries forward a DEAD session's own claim, so a case with no dead session
  //     at all is untouched by it.
  //     (card f4272888: `freshInjectModule`'s simulated restart no longer matters here at all — the gate
  //     reads only the persisted `lastPlaced` fact, which the restart never touches. Kept as regression
  //     coverage of the outcome, not as a restart-survival isolation.) ------------------------------------
  {
    const cwd = sharedCwd("case19-restart-no-store-change-fallback-b");
    injectSkills(cwd, "A19", ["skill-a"], "manager", false, live); // A places v1
    const storeMd = path.join(skillsDir, "skill-a", "SKILL.md");
    const origStore = fs.readFileSync(storeMd, "utf8");
    fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v2")); // store moves to v2
    injectSkills(cwd, "C19", ["skill-a"], "manager", false, live); // C first-claims, refreshes to v2
    const v2Bytes = fs.readFileSync(deliveredPath(cwd, "skill-a"), "utf8");
    const deadC = (sid) => sid !== "C19";
    const { injectSkills: injectAfterRestart } = await freshInjectModule(); // RESTART: fresh registry
    injectAfterRestart(cwd, "B19", ["skill-a"], "manager", false, deadC); // store UNCHANGED since C's write
    check("(19) B successfully claims across a restart with no store change", readManifestClaims(cwd, "B19").includes("skill-a"));
    check("(19) content is unchanged (still v2)", fs.readFileSync(deliveredPath(cwd, "skill-a"), "utf8") === v2Bytes);
    fs.writeFileSync(storeMd, origStore);
  }

  // --- (19b) TRUE isolation of fix (b), added because (19) doesn't provide one: NO dead session at all,
  //     so round 3's `lastPlaced` carry-forward has nothing to do with this case. A places v1 (recorded
  //     v1fp). The store moves to v2. Disk is then overwritten OUT OF BAND (never through injectSkills —
  //     simulating e.g. a git checkout/rebase bringing in tracked content) to EXACTLY v2's own bytes —
  //     content no claimant, the registry, or `lastPlaced` has ever recorded Loom itself placing. A's own
  //     resume: `recorded` = {v1fp} only — NON-EMPTY but STALE (round 2's old `!hasRecorded` gate would
  //     have skipped the fallback here entirely, since `recorded` isn't empty) — yet current disk is
  //     EXACTLY what `wouldPlaceFingerprint` computes fresh right now. Only fix (b)'s "always fall back,
  //     even when recorded is non-empty-but-stale" rule recognizes this as safe to refresh. -------------
  {
    const cwd = isolatedCwd("case19b-recorded-nonempty-stale-fallback-b");
    injectSkills(cwd, "A19b", ["skill-a"], "worker", false); // A places v1
    const storeMd = path.join(skillsDir, "skill-a", "SKILL.md");
    const origStore = fs.readFileSync(storeMd, "utf8");
    fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v2")); // store moves to v2
    fs.writeFileSync(deliveredPath(cwd, "skill-a"), skillMd("skill-a", "skill-a v2")); // out-of-band write, never through injectSkills
    injectSkills(cwd, "A19b", ["skill-a"], "worker", false); // A resumes: recorded={v1fp} (stale), disk=v2 (byte-identical to fresh wouldPlace)
    check("(19b) fix (b) rescues a non-empty-but-stale recorded set when disk matches wouldPlace fresh", readManifestClaims(cwd, "A19b").includes("skill-a"));
    fs.writeFileSync(storeMd, origStore);
  }

  // --- (20) CODE REVIEW round 3, reviewer's P1 (the one genuinely closed by this round): A places v1 →
  //     store v2 → C first-claims+writes v2 → C dies → RESTART (fresh, empty registry) → store v3 → B
  //     first-claims, A resumes, D first-claims. Unlike (19), the store has moved a SECOND time (v2→v3)
  //     AFTER C's death and the restart — `wouldPlaceFingerprint` (fix (b)) now computes v3, which does
  //     NOT match the still-v2 disk, so (b) CANNOT rescue this one; only round 3's persisted `lastPlaced`
  //     (the sidecar survives the restart even though the in-memory registry doesn't) can. On main before
  //     this round, ALL THREE ended claims=[] and the disk froze at v2 forever.
  //     (card f4272888: `lastPlaced` is now the ONLY source the gate reads, persisted from the start — the
  //     restart is a non-event; C's v2 fingerprint was already on disk, nothing to lose.) -----------------
  {
    const cwd = sharedCwd("case20-restart-store-moves-again-p1");
    injectSkills(cwd, "A20", ["skill-a"], "manager", false, live); // A places v1
    const storeMd = path.join(skillsDir, "skill-a", "SKILL.md");
    const origStore = fs.readFileSync(storeMd, "utf8");
    fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v2")); // store moves to v2
    injectSkills(cwd, "C20", ["skill-a"], "manager", false, live); // C first-claims, refreshes to v2
    const v2Bytes = fs.readFileSync(deliveredPath(cwd, "skill-a"), "utf8");
    const deadC = (sid) => sid !== "C20";
    const { injectSkills: injectAfterRestart } = await freshInjectModule(); // RESTART: fresh registry
    fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v3")); // store moves AGAIN, to v3, after the restart
    injectAfterRestart(cwd, "B20", ["skill-a"], "manager", false, deadC); // B first-claims
    check("(20) B successfully claims across a restart even though the store moved again", readManifestClaims(cwd, "B20").includes("skill-a"));
    const v3Bytes = fs.readFileSync(deliveredPath(cwd, "skill-a"), "utf8");
    check("(20) B's claim actually refreshed the dir to v3 (the current store, not frozen at v2)", v3Bytes !== v2Bytes && v3Bytes.includes("skill-a v3"));
    injectAfterRestart(cwd, "A20", ["skill-a"], "manager", false, deadC); // A's own resume must also succeed
    check("(20) A's own resume also succeeds (not frozen)", readManifestClaims(cwd, "A20").includes("skill-a"));
    injectAfterRestart(cwd, "D20", ["skill-a"], "manager", false, deadC); // D first-claims too
    check("(20) D (a THIRD fresh claimant) also succeeds", readManifestClaims(cwd, "D20").includes("skill-a"));
    fs.writeFileSync(storeMd, origStore);
  }

  // --- (21) CODE REVIEW ROUND 4, MAJOR: lastPlaced must MERGE a new prune's fingerprints with what an
  //     EARLIER prune already carried forward, never REPLACE — a second dead-session prune for the SAME
  //     name, after a restart, must not discard an earlier pass's own carry. Reviewer's repro: A and L
  //     place v1 → store v2 → C claims+refreshes to v2 → C dies, a non-wanting E's call prunes C
  //     (lastPlaced=[fp2]) → RESTART (fresh registry) → store v3 → A ALSO dies, a non-wanting F's call
  //     prunes A — under the pre-round-4 REPLACE, this call overwrites lastPlaced to [fp1] alone, losing
  //     fp2, and L's own resume AND a fresh co-claimant's first claim both then refuse (disk frozen at
  //     v2, matching neither the stale [fp1] record nor wouldPlaceFingerprint's now-v3 computation).
  //     Under MERGE, lastPlaced holds [fp1, fp2] after F's call, fp2 still vouches for the v2 disk, and
  //     both resolve normally, refreshing to v3. Built as a shared setup so the L-resume and fresh-claim
  //     checks each get their OWN cwd — proving either one alone is enough to go RED, not just their sum.
  //     (card f4272888: the whole REPLACE-vs-MERGE question is retired along with `carryDeadFingerprintsForward`
  //     itself — a real placement always REPLACES `lastPlaced.get(name)` with ONE fresh fingerprint, and
  //     nothing ever "carries forward" a dead session's value at all, because the fact was never
  //     session-scoped. These three cases still pass, now trivially, and are kept as regression coverage.) -
  const case21StoreMd = path.join(skillsDir, "skill-a", "SKILL.md");
  const case21OrigStore = fs.readFileSync(case21StoreMd, "utf8"); // captured ONCE, before any (21*) sub-case touches the store — restored at the very end
  async function buildCase21Scenario(label) {
    const cwd = sharedCwd(label);
    const storeMd = path.join(skillsDir, "skill-a", "SKILL.md");
    const aliveSet = new Set(["A21", "L21"]);
    const isLive = (sid) => aliveSet.has(sid);
    injectSkills(cwd, "A21", ["skill-a"], "manager", false, isLive); // A places v1
    injectSkills(cwd, "L21", ["skill-a"], "manager", false, isLive); // L places v1 too
    fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v2")); // store moves to v2
    aliveSet.add("C21");
    injectSkills(cwd, "C21", ["skill-a"], "manager", false, isLive); // C first-claims, refreshes to v2
    check(`(21 ${label}) precondition: C's claim refreshed disk to v2`, fs.readFileSync(deliveredPath(cwd, "skill-a"), "utf8").includes("skill-a v2"));
    aliveSet.delete("C21"); // C dies
    injectSkills(cwd, "E21", ["skill-b"], "manager", false, isLive); // E doesn't want skill-a — its call still prunes dead C, carrying C's v2 fp into lastPlaced (A/L still live-claim it)
    const { injectSkills: injectAfterRestart } = await freshInjectModule(); // RESTART: fresh in-memory registry; lastPlaced persists on disk
    fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v3")); // store moves AGAIN, to v3, after the restart
    aliveSet.delete("A21"); // A dies too, AFTER the restart — a SECOND dead-session prune for the same name
    injectAfterRestart(cwd, "F21", ["skill-b"], "manager", false, isLive); // F doesn't want skill-a either — its call is the SECOND prune pass (replaces or merges lastPlaced)
    return { cwd, injectAfterRestart, isLive };
  }
  {
    const { cwd, injectAfterRestart, isLive } = await buildCase21Scenario("case21a-second-prune-L-resume");
    injectAfterRestart(cwd, "L21", ["skill-a"], "manager", false, isLive); // L's own resume: still wants skill-a
    check("(21a) L's own resume succeeds after a SECOND dead-session prune pass (not frozen)", readManifestClaims(cwd, "L21").includes("skill-a"));
    check("(21a) L's resume actually refreshed disk to v3 (not frozen at v2)", fs.readFileSync(deliveredPath(cwd, "skill-a"), "utf8").includes("skill-a v3"));
  }
  {
    const { cwd, injectAfterRestart, isLive } = await buildCase21Scenario("case21b-second-prune-fresh-claim");
    injectAfterRestart(cwd, "B21", ["skill-a"], "manager", false, isLive); // B: a FRESH co-claimant, tested independently of L's own resume
    check("(21b) a fresh co-claimant's first claim succeeds after a SECOND dead-session prune pass (not frozen)", readManifestClaims(cwd, "B21").includes("skill-a"));
    check("(21b) B's claim actually refreshed disk to v3 (not frozen at v2)", fs.readFileSync(deliveredPath(cwd, "skill-a"), "utf8").includes("skill-a v3"));
  }
  {
    // --- (21c) CONTROL, per the reviewer's own verification: the SAME restart + second-store-move shape,
    //     but WITHOUT A's death (only ONE prune pass ever runs, for C) — confirms the fixture mechanics
    //     themselves are sane and the freeze in (21a)/(21b) is specifically the SECOND prune pass, not an
    //     artifact of restart+store-move alone. -------------------------------------------------------
    const cwd = sharedCwd("case21c-control-no-second-death");
    const aliveSet = new Set(["A21c", "L21c"]);
    const isLive = (sid) => aliveSet.has(sid);
    injectSkills(cwd, "A21c", ["skill-a"], "manager", false, isLive);
    injectSkills(cwd, "L21c", ["skill-a"], "manager", false, isLive);
    fs.writeFileSync(case21StoreMd, skillMd("skill-a", "skill-a v2"));
    aliveSet.add("C21c");
    injectSkills(cwd, "C21c", ["skill-a"], "manager", false, isLive);
    aliveSet.delete("C21c");
    injectSkills(cwd, "E21c", ["skill-b"], "manager", false, isLive); // ONE prune pass only — A stays alive throughout
    const { injectSkills: injectAfterRestart } = await freshInjectModule();
    fs.writeFileSync(case21StoreMd, skillMd("skill-a", "skill-a v3"));
    injectAfterRestart(cwd, "L21c", ["skill-a"], "manager", false, isLive); // L's own resume — A never died, so this is NOT the bug's trigger shape
    check("(21c) CONTROL: with only one prune pass ever, L's resume refreshes to v3 normally", fs.readFileSync(deliveredPath(cwd, "skill-a"), "utf8").includes("skill-a v3"));
  }
  fs.writeFileSync(case21StoreMd, case21OrigStore); // restore the shared store fixture, once, for any later case/test file

  // --- (22) card f4272888, owner-approved design decision (2): the ONE-SHOT MIGRATION FOLD closes the
  //     upgrade-boundary false freeze. Fabricate a sidecar in the PRE-f4272888 per-session shape (no
  //     `__lastPlaced` key at all — simulating a cwd this version has never written to) for a session
  //     that is still LIVE, placed at v1; reseed the store to v2; resume. Without the fold, `lastPlaced`
  //     would be empty for this name and `wouldPlaceFingerprint` would compute v2 — NOT matching the
  //     still-v1 disk — a false "hand-modified" freeze on content nobody ever touched by hand. With the
  //     fold, the legacy entry's own fp is folded into `lastPlaced` on THIS read, matches v1 disk, and the
  //     resume refreshes normally. A second, parallel setup proves a GENUINE hand edit still survives the
  //     exact same legacy sidecar shape — the fold only ever widens what counts as Loom's own, never
  //     admits a real divergence. -------------------------------------------------------------------------
  {
    const cwd = isolatedCwd("case22-legacy-sidecar-migration-fold-refreshes");
    const skillsDest = path.join(cwd, ".claude", "skills");
    fs.mkdirSync(skillsDest, { recursive: true });
    fs.cpSync(path.join(skillsDir, "skill-a"), path.join(skillsDest, "skill-a"), { recursive: true }); // v1, byte-identical to the store right now
    const v1Fp = fingerprintSkillDir(path.join(skillsDest, "skill-a"));
    fs.writeFileSync(manifestPath(cwd), JSON.stringify({ S22: ["skill-a"] }));
    // PRE-f4272888 shape: a real session id as a top-level key, mapping straight to { name: fp } — no
    // __lastPlaced key anywhere in this file.
    fs.writeFileSync(fingerprintsPath(cwd), JSON.stringify({ S22: { "skill-a": v1Fp } }));
    const storeMd = path.join(skillsDir, "skill-a", "SKILL.md");
    const origStore = fs.readFileSync(storeMd, "utf8");
    fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v2")); // the store reseeds AFTER the legacy placement
    injectSkills(cwd, "S22", ["skill-a"], "worker", false); // S22 (still live) resumes against the legacy sidecar
    check("(22) a legacy per-session fp with no __lastPlaced entry is folded on read: untouched content refreshes (no false freeze)", fs.readFileSync(deliveredPath(cwd, "skill-a"), "utf8").includes("skill-a v2"));
    check("(22) the claim survives the refresh", readManifestClaims(cwd, "S22").includes("skill-a"));

    // Parallel setup: the SAME legacy sidecar shape, but the content is GENUINELY hand-edited before the
    // resume — the fold must never let this be mistaken for untouched Loom output.
    const cwdEdited = isolatedCwd("case22-legacy-sidecar-handedit-survives");
    const skillsDestEdited = path.join(cwdEdited, ".claude", "skills");
    fs.mkdirSync(skillsDestEdited, { recursive: true });
    fs.cpSync(path.join(skillsDir, "skill-a"), path.join(skillsDestEdited, "skill-a"), { recursive: true });
    fs.writeFileSync(storeMd, origStore); // back to v1 so this copy's fp matches v1 too
    const v1FpEdited = fingerprintSkillDir(path.join(skillsDestEdited, "skill-a"));
    fs.writeFileSync(manifestPath(cwdEdited), JSON.stringify({ S22b: ["skill-a"] }));
    fs.writeFileSync(fingerprintsPath(cwdEdited), JSON.stringify({ S22b: { "skill-a": v1FpEdited } }));
    fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v2")); // reseed again
    const handEditedPath = deliveredPath(cwdEdited, "skill-a");
    fs.writeFileSync(handEditedPath, "# hand edit over a legacy (pre-f4272888) placement\n");
    injectSkills(cwdEdited, "S22b", ["skill-a"], "worker", false); // resume: still wants it
    check("(22) a GENUINE hand edit over the same legacy shape still SURVIVES (the fold never admits a real divergence)", fs.readFileSync(handEditedPath, "utf8") === "# hand edit over a legacy (pre-f4272888) placement\n");
    check("(22) the hand-edited claim is relinquished, not refreshed", !readManifestClaims(cwdEdited, "S22b").includes("skill-a"));
    fs.writeFileSync(storeMd, origStore);
  }

  // --- (23) card f4272888, owner-approved design decision (4): a forged sidecar carrying a top-level key
  //     literally `"__proto__"` (a pre-f4272888-shaped legacy "session" record) AND a nested `"__proto__"`
  //     name key inside a real `__lastPlaced` entry. `readFingerprintsFile`'s rewrite must neither throw
  //     nor pollute `Object.prototype` either way — the top-level case is reached purely as a loop
  //     discriminant (never an object/Map key), and the nested case is dropped by the existing
  //     `isSafeManifestEntry`/NAME_RE check before it ever reaches a `Map.set`. -------------------------
  {
    check('(23) precondition: "__proto__" is not a valid skill name (NAME_RE requires a leading [a-z0-9])', isValidSkillName("__proto__") === false);
    const cwd = isolatedCwd("case23-forged-proto-sidecar");
    const skillsDest = path.join(cwd, ".claude", "skills");
    fs.mkdirSync(skillsDest, { recursive: true });
    fs.writeFileSync(manifestPath(cwd), JSON.stringify({}));
    const forged = {
      "__proto__": { "legit-skill-name": "deadbeef".repeat(8) }, // legacy-shaped "session" record under a forged key
      "__lastPlaced": { "__proto__": ["deadbeef".repeat(8)] },   // real reserved key, forged NESTED name
    };
    fs.writeFileSync(fingerprintsPath(cwd), JSON.stringify(forged));
    let threw = null;
    try { injectSkills(cwd, "S23", ["skill-a"], "worker", false); } catch (e) { threw = e; }
    check("(23) injectSkills does NOT throw on a forged top-level/nested \"__proto__\" sidecar", threw === null);
    check("(23) Object.prototype is NOT polluted after parsing the forged sidecar", ({}).legitSkillName === undefined && ({}).__proto__ === Object.prototype);
    check('(23) a plain object\'s OWN keys are unaffected (no stray "legit-skill-name"/"__proto__" own property leaked onto {})', !Object.prototype.hasOwnProperty.call({}, "legit-skill-name"));
    // The sharper check (({}).someKey alone would NOT catch a bracket-assignment bug that only reassigns a
    // LOCAL accumulator's own prototype, never the global Object.prototype): the internal Map this forged
    // read feeds into must still behave normally for SUBSEQUENT, genuine data in the SAME cwd — a corrupted
    // accumulator would plausibly misbehave (lose entries, throw on iteration/serialize) on its very next use.
    injectSkills(cwd, "S23", ["skill-a", "skill-b"], "worker", false); // a second, perfectly ordinary call, same session+cwd
    check("(23) a subsequent ordinary claim in the SAME cwd still succeeds normally after the forged read", readManifestClaims(cwd, "S23").includes("skill-a") && readManifestClaims(cwd, "S23").includes("skill-b"));
    check("(23) the re-serialized sidecar file is still valid, parseable JSON", (() => { try { JSON.parse(fs.readFileSync(fingerprintsPath(cwd), "utf8")); return true; } catch { return false; } })());
  }

  // --- (24)/(24b) card f4272888 round 6 Code Review (MAJOR finding): the migration fold used to REPLACE
  //     rather than UNION whenever the loop reached `__lastPlaced` AFTER a legacy per-session section for
  //     the same name — exactly the real pre-card key order (`serializeFingerprintsFile` always wrote
  //     `{...bySession, __pendingReclaim, __lastPlaced}`, `__lastPlaced` LAST). A sidecar built in THAT
  //     order, carrying both a legacy fp matching current disk and a DIFFERENT, older `__lastPlaced` fp,
  //     must still refresh on a reseed (24) — and a genuine hand edit over the identical shape must still
  //     survive (24b), proving the fix widens what's recognized without ever admitting a real divergence. ---
  {
    const storeMd = path.join(skillsDir, "skill-a", "SKILL.md");
    const origStore = fs.readFileSync(storeMd, "utf8");

    // (24) refresh, not freeze.
    {
      const cwd = isolatedCwd("case24-order-dependent-fold-unions-not-replaces");
      const skillsDest = path.join(cwd, ".claude", "skills");
      fs.mkdirSync(path.join(skillsDest, "skill-a"), { recursive: true });
      fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v1-for-fold24")); // an OLDER version, never on disk here
      const v1Fp = fingerprintSkillDir(path.join(skillsDir, "skill-a"));
      fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v2-for-fold24")); // what disk actually holds
      fs.cpSync(path.join(skillsDir, "skill-a"), path.join(skillsDest, "skill-a"), { recursive: true });
      const v2Fp = fingerprintSkillDir(path.join(skillsDest, "skill-a"));
      fs.writeFileSync(manifestPath(cwd), JSON.stringify({ S24: ["skill-a"] }));
      // Real pre-card key order: a legacy per-session section FIRST, `__lastPlaced` LAST — the exact shape
      // `{...bySession, __pendingReclaim, __lastPlaced}` always produced. The legacy fp (v2Fp) matches
      // disk; the `__lastPlaced` fp (v1Fp) is a different, older value — a REPLACE would discard v2Fp.
      fs.writeFileSync(fingerprintsPath(cwd), JSON.stringify({ S24: { "skill-a": v2Fp }, "__lastPlaced": { "skill-a": [v1Fp] } }));
      fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v3-for-fold24")); // reseed AFTER the sidecar is written
      injectSkills(cwd, "S24", ["skill-a"], "worker", false); // S24 (still live) resumes
      check("(24) a sidecar in the real pre-card key order (legacy fp matching disk, __lastPlaced LAST with a different fp) refreshes, not freezes", fs.readFileSync(deliveredPath(cwd, "skill-a"), "utf8").includes("skill-a v3-for-fold24"));
      check("(24) the claim survives the refresh", readManifestClaims(cwd, "S24").includes("skill-a"));
    }

    // (24b) the SAME sidecar shape, but disk is a genuine hand edit matching NEITHER fp: must still SURVIVE.
    {
      const cwd = isolatedCwd("case24b-order-dependent-fold-handedit-survives");
      const skillsDest = path.join(cwd, ".claude", "skills");
      fs.mkdirSync(path.join(skillsDest, "skill-a"), { recursive: true });
      fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v1-for-fold24b"));
      const v1Fp = fingerprintSkillDir(path.join(skillsDir, "skill-a"));
      fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v2-for-fold24b"));
      const v2Fp = fingerprintSkillDir(path.join(skillsDir, "skill-a"));
      fs.writeFileSync(manifestPath(cwd), JSON.stringify({ S24b: ["skill-a"] }));
      fs.writeFileSync(fingerprintsPath(cwd), JSON.stringify({ S24b: { "skill-a": v2Fp }, "__lastPlaced": { "skill-a": [v1Fp] } }));
      const handEditedPath = deliveredPath(cwd, "skill-a");
      fs.writeFileSync(handEditedPath, "# hand edit over an order-dependent legacy+__lastPlaced sidecar\n");
      fs.writeFileSync(storeMd, skillMd("skill-a", "skill-a v3-for-fold24b")); // reseed again
      injectSkills(cwd, "S24b", ["skill-a"], "worker", false);
      check("(24b) a GENUINE hand edit over the same sidecar shape still SURVIVES", fs.readFileSync(handEditedPath, "utf8") === "# hand edit over an order-dependent legacy+__lastPlaced sidecar\n");
      check("(24b) the hand-edited claim is relinquished, not refreshed", !readManifestClaims(cwd, "S24b").includes("skill-a"));
    }

    fs.writeFileSync(storeMd, origStore);
  }

  // --- (25a)/(25b) card f4272888 round 6 Code Review (minor finding 3): the PRUNE loop's own
  //     `wouldPlaceFingerprint(stale, obsidianEnabled)` fallback call (~:1244) had no case distinguishing
  //     it from a wrong-variant mutant (obsidianEnabled negated) — the identical mutant at the RE-COPY
  //     site (10)/(11) already cover goes RED, but nothing exercised the prune loop's own copy of the
  //     same fallback. Same transform-aware probe technique as (10)/(11), for a LEGACY claim (no recorded
  //     fingerprint) that drops OUT of `want` on resume — triggering the prune loop, not the re-copy loop. ---
  {
    const probeCwd = isolatedCwd("case25-probe-transformed-bytes");
    injectSkills(probeCwd, "probe25", ["loom-pickup"], "worker", true);
    const transformedBytes = fs.readFileSync(deliveredPath(probeCwd, "loom-pickup"), "utf8");

    // (25a) obsidianEnabled=true on resume, dropped from `want`: disk (fragment-appended) bytes match what
    // the prune loop's own fallback computes right now ⇒ PRUNED. A mutant negating obsidianEnabled there
    // would compute the fragment-FREE bytes instead — a mismatch — turning this assertion RED.
    {
      const cwd = isolatedCwd("case25a-legacy-prune-obsidian-true-pruned");
      const skillsDest = path.join(cwd, ".claude", "skills");
      fs.mkdirSync(path.join(skillsDest, "loom-pickup"), { recursive: true });
      fs.writeFileSync(path.join(skillsDest, "loom-pickup", "SKILL.md"), transformedBytes);
      fs.writeFileSync(manifestPath(cwd), JSON.stringify({ S25a: ["loom-pickup"] })); // legacy, no fingerprints file
      injectSkills(cwd, "S25a", ["skill-b"], "worker", true); // a non-empty subset (empty means "ALL") excluding loom-pickup
      check("(25a) legacy prune, obsidianEnabled=true matches the transformed bytes already on disk: PRUNED", !fs.existsSync(deliveredPath(cwd, "loom-pickup")));
    }

    // (25b) SAME fragment-appended on-disk bytes, but THIS session has obsidianEnabled=false: the prune
    // loop's fallback now computes the fragment-free bytes, which must NOT match ⇒ KEPT, not pruned. The
    // SAME mutant, negated the other way, would compute the fragment-appended bytes — a false match —
    // turning THIS assertion RED instead, so either direction of the mutant is caught by one of the two.
    {
      const cwd = isolatedCwd("case25b-legacy-prune-obsidian-false-kept");
      const skillsDest = path.join(cwd, ".claude", "skills");
      fs.mkdirSync(path.join(skillsDest, "loom-pickup"), { recursive: true });
      fs.writeFileSync(path.join(skillsDest, "loom-pickup", "SKILL.md"), transformedBytes);
      fs.writeFileSync(manifestPath(cwd), JSON.stringify({ S25b: ["loom-pickup"] }));
      injectSkills(cwd, "S25b", ["skill-b"], "worker", false); // a non-empty subset excluding loom-pickup
      check("(25b) legacy prune, obsidianEnabled=false does NOT false-match the fragment-appended bytes: KEPT, not pruned", fs.existsSync(deliveredPath(cwd, "loom-pickup")));
    }
  }
} catch (e) {
  console.log(`FAIL  unexpected throw: ${e.stack}`);
  failures++;
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a same-session resume never overwrites or prunes a hand-modified (or added-to) injected skill copy; an untouched resume still refreshes/prunes normally; a legacy no-fingerprint claim is refreshed only when matching the one persisted `lastPlaced` fact or what placement would ACTUALLY produce right now (transform-aware, not a raw-store comparison); two LIVE co-claimants sharing a cwd never misread each other's legitimate refresh as a hand edit, and one's narrowing never destroys what the other still claims; a FRESH session claiming a name for the first time is held to the SAME gate — it never overwrites another live claimant's hand edit, it DOES succeed on an untouched co-claim, and two co-claimants with differing per-session variants (e.g. obsidian fragment on/off) never misread each other's legitimate variant as a hand edit either; wouldPlaceFingerprint applies the SAME permission-strip transform real placement does, and fails toward keeping (never a crash) when that strip is itself undeliverable; a session that died AFTER being the last one to legitimately write the dir never permanently freezes it for a fresh co-claimant OR the original claimant's own later resume, and neither does a daemon restart or a second dead-session discovery for the same name — the persisted `lastPlaced` fact was never session- or process-scoped to begin with (card f4272888); a pre-f4272888 legacy sidecar's per-session record is folded into `lastPlaced` on read exactly once, closing the upgrade-boundary false freeze without ever admitting a genuine hand edit; a forged sidecar carrying a literal \"__proto__\" key, top-level or nested, neither crashes the parser nor pollutes Object.prototype; the migration fold is order-INDEPENDENT (a legacy section and a `__lastPlaced` entry for the same name union regardless of which key the reader reaches first), while still never admitting a genuine hand edit; and the prune loop's own `wouldPlaceFingerprint` fallback (not just the re-copy loop's) correctly reflects this session's real obsidian setting."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
