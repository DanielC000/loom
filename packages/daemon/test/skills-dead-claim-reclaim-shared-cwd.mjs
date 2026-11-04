// Regression suite for card f4e93dbf (rounds 1-2): a dead session's skill claim in a SHARED (non-
// worktree) cwd — manager/platform/setup/auditor/plain sessions sharing project.repoPath — used to
// orphan permanently. See docs/decisions/f4e93dbf-shared-cwd-dead-claim-reclaim.md for the full design
// (never restated here): the two-mechanism split (a persisted, disk-durable "pending reclaim" record with
// no TTL, vs. an in-memory "verified untracked" fact with a 60s TTL), the want-gated consume/reclaim, and
// the innermost-repo walk for a nested `.git`.
//
// Sections:
//  0. Helpers: a real throwaway git repo per scenario, and a MUTANT dist builder (copies the real
//     dist/skills/inject.js into a SIBLING file inside the same dist/skills/ dir — so its relative
//     imports to ../git/bounded.js etc. keep resolving — with one exact text substitution disabled).
//  1. CORE: die -> prune -> stale -> (discover+kick, untouched) -> await -> (repair) GREEN. The TTL-
//     expiry variant of this proof (round 2 MAJOR #1) lives in the negative-control-compatible sibling
//     file skills-dead-claim-reclaim-shared-cwd-core.mjs instead — see that file's own header.
//  2. A repo-authored dir (name never in the store) stays untouched throughout.
//  3. A Loom-placed, then hand-edited dir stays untouched — PLUS mutant M1 (disables the fingerprint-
//     match check) proves that check is what protects it.
//  4. A Loom-placed dir whose files are git-TRACKED (real temp repo, `git add -f` + commit) is never
//     replaced — PLUS mutant M2 (disables the "ls-files output empty" cache-write gate) proves it.
//  5. A legacy claim with no recorded fingerprint stays untouched — PLUS mutant M3 (disables the
//     no-recorded-fingerprint skip) proves it.
//  6. A concurrently-live sibling's claim is respected (never reclaimed out from under it) — PLUS
//     mutant M4 (disables the otherClaimed check) proves it.
//  7. The re-verify-at-consume-time race guard: an edit landing AFTER the check kicked but BEFORE the
//     repair call is still protected — PLUS mutant M5 (disables the cache-entry validity re-check) proves
//     it.
//  8. The worktree-cwd behaviour is UNCHANGED: still an unconditional delete (never the shared-cwd
//     async path), same as before this card.
//  9. A shared cwd that is CLEARLY NOT a git repo at all (no `.git` anywhere up-tree) is reclaimed
//     immediately, synchronously, same call — no tracked-file risk to check at all.
// 10. Round 2 MINOR #2: consume/reclaim is gated on `want` — a session that doesn't want the name leaves
//     the verified fact / pending record untouched for a later caller that does.
// 11. Round 2 MINOR #3: a nested repo BELOW the shared cwd (a `.claude/.git`) is walked to and checked
//     directly — a dir tracked only in that inner repo is never wrongly treated as untracked just
//     because the OUTER (cwd) repo doesn't see it.
//
// Hermetic: a fresh temp LOOM_HOME + a fresh real git repo per scenario; no claude, no live daemon.
// Run after build: node test/skills-dead-claim-reclaim-shared-cwd.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const home = useOwnLoomHome("loom-f4e93dbf-reclaim-", { fresh: true }); // BEFORE importing — paths.ts computes SKILLS_DIR/WORKTREES_DIR at load
const skillsDir = path.join(home, "skills");
fs.mkdirSync(path.join(skillsDir, "loom-x"), { recursive: true });
fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: v1\n---\nV1 BODY");
const root = mkdtempManaged("loom-f4e93dbf-reclaim-root-"); // container for every scenario's own repo dir

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_SKILLS_DIR = path.join(__dirname, "..", "dist", "skills");
const REAL_INJECT = path.join(DIST_SKILLS_DIR, "inject.js");

const { injectSkills, __awaitPendingSkillTrackChecks, fingerprintSkillDir } = await import(`file://${REAL_INJECT.replace(/\\/g, "/")}`);

// -------------------- section 0: helpers --------------------
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
const initRepo = (cwd) => { fs.mkdirSync(cwd, { recursive: true }); git(cwd, ["init", "-q"]); git(cwd, ["config", "user.email", "t@t"]); git(cwd, ["config", "user.name", "t"]); };
let scenarioCounter = 0;
const freshRepoCwd = () => path.join(root, `repo${++scenarioCounter}`);
const readSkillBody = (cwd, name) => { try { return fs.readFileSync(path.join(cwd, ".claude", "skills", name, "SKILL.md"), "utf8"); } catch { return null; } };

/** Copies the REAL dist inject.js into a SIBLING file (same dist/skills/ dir, so its relative imports
 *  keep resolving) with exactly one text substitution applied, then imports and returns the mutant's
 *  `injectSkills`/`__awaitPendingSkillTrackChecks`. `oldStr` must occur EXACTLY once — same discipline as
 *  the Edit tool, so a mutant can never silently mutate the wrong (or every) occurrence. Caller must
 *  delete the mutant file when done (see each section's own cleanup). Mutants stay BESIDE dist rather
 *  than under a temp dir specifically because their relative imports (`../git/bounded.js` etc.) resolve
 *  from the mutant file's own directory — moving it elsewhere would break every such import. */
const mutantFiles = [];
async function buildMutant(label, oldStr, newStr) {
  const src = fs.readFileSync(REAL_INJECT, "utf8");
  const occurrences = src.split(oldStr).length - 1;
  if (occurrences !== 1) throw new Error(`buildMutant(${label}): expected exactly 1 occurrence of oldStr, found ${occurrences}`);
  const mutated = src.replace(oldStr, newStr);
  const mutantPath = path.join(DIST_SKILLS_DIR, `inject.mutant-${label}-${Date.now()}-${process.pid}-${randomUUID()}.js`);
  fs.writeFileSync(mutantPath, mutated);
  mutantFiles.push(mutantPath);
  return import(`file://${mutantPath.replace(/\\/g, "/")}`);
}
function cleanupMutants() { for (const p of mutantFiles) { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } } mutantFiles.length = 0; }

try {
  // ============ SECTION 1: CORE — die -> prune -> stale -> repair ============
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    const r1 = injectSkills(cwd, "dead-mgr", null, "manager");
    check("(1) dead-mgr placed loom-x v1", r1.claimedNames.includes("loom-x"));
    fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: v2\n---\nV2 BODY");
    const isLive = (sid) => sid !== "dead-mgr";
    const r2 = injectSkills(cwd, "new-mgr", null, "manager", false, isLive);
    check("(1) discover call: still v1 (never touched this call — no delete-then-recopy window)", readSkillBody(cwd, "loom-x")?.includes("V1 BODY"));
    check("(1) discover call's own claimedNames does not include loom-x yet", !r2.claimedNames.includes("loom-x"));
    if (typeof __awaitPendingSkillTrackChecks === "function") await __awaitPendingSkillTrackChecks();
    const r3 = injectSkills(cwd, "new-mgr", null, "manager", false, isLive);
    check("(1) *** REPAIRED ***: refreshed to v2 after the repair call", readSkillBody(cwd, "loom-x")?.includes("V2 BODY"));
    check("(1) repair call's claimedNames includes loom-x, claimed as a normal placement", r3.claimedNames.includes("loom-x"));
  }

  // ============ SECTION 2: repo-authored dir (name never in the store) — untouched ============
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    fs.mkdirSync(path.join(cwd, ".claude", "skills", "my-personal"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "my-personal", "SKILL.md"), "PERSONAL CONTENT");
    const r1 = injectSkills(cwd, "some-mgr", null, "manager");
    if (typeof __awaitPendingSkillTrackChecks === "function") await __awaitPendingSkillTrackChecks();
    const r2 = injectSkills(cwd, "some-mgr", null, "manager", false, () => true);
    check("(2) repo-authored dir (never a store name) untouched", readSkillBody(cwd, "my-personal") === "PERSONAL CONTENT");
    check("(2) never claimed by anyone", !r1.claimedNames.includes("my-personal") && !r2.claimedNames.includes("my-personal"));
  }

  // ============ SECTION 3: hand-edited dir untouched, + mutant M1 proves the fingerprint-match guard ============
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    injectSkills(cwd, "dead-mgr3", null, "manager");
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "loom-x", "SKILL.md"), "HAND EDITED BY A WORKER");
    const isLive = (sid) => sid !== "dead-mgr3";
    const r2 = injectSkills(cwd, "new-mgr3", null, "manager", false, isLive);
    if (typeof __awaitPendingSkillTrackChecks === "function") await __awaitPendingSkillTrackChecks();
    const r3 = injectSkills(cwd, "new-mgr3", null, "manager", false, isLive);
    check("(3) hand-edited content survives (real code)", readSkillBody(cwd, "loom-x") === "HAND EDITED BY A WORKER");
    check("(3) never reclaimed (real code) — the fingerprint never matched, so no check was ever even kicked", !r2.claimedNames.includes("loom-x") && !r3.claimedNames.includes("loom-x"));

    // Mutant M1: disable the fingerprint-match guard in the unified resolve loop — `if (false)` never
    // skips, so even mismatched (hand-edited) content gets a check kicked and, once "untracked", reclaimed.
    const m1 = await buildMutant(
      "m1",
      `const currentFp = fingerprintSkillDir(target); // reused below for the untracked-check cache + kick, not just this match\n            if (!currentFp || !matchesRecordedFingerprint(currentFp, rec.deadFingerprints)) {\n                console.log(\`[skills] keeping dead-session claim '\${name}' (shared cwd): on-disk content doesn't match any recorded Loom placement (edited, or files added) — not reclaiming\`);\n                pendingWorking.delete(name); // resolved: edited — drop the record and never touch it again\n                continue;\n            }`,
      `const currentFp = fingerprintSkillDir(target); // reused below for the untracked-check cache + kick, not just this match\n            if (false) {\n                console.log(\`[skills] keeping dead-session claim '\${name}' (shared cwd): on-disk content doesn't match any recorded Loom placement (edited, or files added) — not reclaiming\`);\n                pendingWorking.delete(name); // MUTANT M1: fingerprint-match guard disabled\n                continue;\n            }`,
    );
    const cwdM1 = freshRepoCwd();
    initRepo(cwdM1);
    m1.injectSkills(cwdM1, "dead-mgrM1", null, "manager");
    fs.writeFileSync(path.join(cwdM1, ".claude", "skills", "loom-x", "SKILL.md"), "HAND EDITED BY A WORKER (M1)");
    const isLiveM1 = (sid) => sid !== "dead-mgrM1";
    m1.injectSkills(cwdM1, "new-mgrM1", null, "manager", false, isLiveM1);
    await m1.__awaitPendingSkillTrackChecks();
    m1.injectSkills(cwdM1, "new-mgrM1", null, "manager", false, isLiveM1);
    check("(3) *** MUTANT M1 PROOF ***: with the fingerprint-match guard disabled, hand-edited content IS wrongly reclaimed", readSkillBody(cwdM1, "loom-x") !== "HAND EDITED BY A WORKER (M1)");
  }

  // ============ SECTION 4: git-TRACKED dir untouched (real temp repo), + mutant M2 proves the ls-files guard ============
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    injectSkills(cwd, "dead-mgr4", null, "manager"); // places the CURRENT store content (v2, from section 1)
    git(cwd, ["add", "-f", ".claude/skills/loom-x"]); // -f: hideFromGit's info/exclude entry would otherwise refuse a plain add
    git(cwd, ["commit", "-q", "-m", "user committed the injected copy"]);
    fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: v3\n---\nV3 BODY"); // store moves AGAIN after the commit
    const isLive = (sid) => sid !== "dead-mgr4";
    const r2 = injectSkills(cwd, "new-mgr4", null, "manager", false, isLive);
    if (typeof __awaitPendingSkillTrackChecks === "function") await __awaitPendingSkillTrackChecks(); // the REAL git ls-files check runs here
    const r3 = injectSkills(cwd, "new-mgr4", null, "manager", false, isLive);
    check("(4) *** TRACKED GUARD ***: git-tracked content is never replaced, even though the fingerprint matched", readSkillBody(cwd, "loom-x")?.includes("V2 BODY") && !readSkillBody(cwd, "loom-x")?.includes("V3 BODY"));
    check("(4) never reclaimed (real code)", !r2.claimedNames.includes("loom-x") && !r3.claimedNames.includes("loom-x"));
    check("(4) working tree stays clean (nothing touched)", git(cwd, ["status", "--porcelain"]).trim() === "");

    // Mutant M2: disable the "ls-files output empty" cache-write gate in kickUntrackedCheck — `if (true)`
    // caches regardless of whether anything came back tracked.
    const m2 = await buildMutant("m2", `if (out.trim() === "") {`, `if (true) { /* MUTANT M2: tracked-status gate disabled */`);
    const cwdM2 = freshRepoCwd();
    initRepo(cwdM2);
    m2.injectSkills(cwdM2, "dead-mgrM2", null, "manager");
    git(cwdM2, ["add", "-f", ".claude/skills/loom-x"]);
    git(cwdM2, ["commit", "-q", "-m", "committed"]);
    fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: v4\n---\nV4 BODY (M2 mutant target)");
    const isLiveM2 = (sid) => sid !== "dead-mgrM2";
    m2.injectSkills(cwdM2, "new-mgrM2", null, "manager", false, isLiveM2);
    await m2.__awaitPendingSkillTrackChecks();
    m2.injectSkills(cwdM2, "new-mgrM2", null, "manager", false, isLiveM2);
    check("(4) *** MUTANT M2 PROOF ***: with the tracked-status gate disabled, a git-tracked dir IS wrongly replaced", readSkillBody(cwdM2, "loom-x")?.includes("V4 BODY") === true);
  }

  // ============ SECTION 5: legacy claim, no recorded fingerprint — untouched, + mutant M3 ============
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    const targetDir = path.join(cwd, ".claude", "skills");
    fs.mkdirSync(path.join(targetDir, "loom-x"), { recursive: true });
    fs.writeFileSync(path.join(targetDir, "loom-x", "SKILL.md"), "LEGACY, NO FINGERPRINT RECORD");
    fs.writeFileSync(path.join(targetDir, ".loom-skills.json"), JSON.stringify({ "dead-legacy": ["loom-x"] })); // claim exists, but no .loom-skills-fingerprints.json sidecar at all
    const isLive = (sid) => sid !== "dead-legacy";
    const r2 = injectSkills(cwd, "new-mgr5", null, "manager", false, isLive);
    if (typeof __awaitPendingSkillTrackChecks === "function") await __awaitPendingSkillTrackChecks();
    const r3 = injectSkills(cwd, "new-mgr5", null, "manager", false, isLive);
    check("(5) legacy no-fingerprint claim: content untouched", readSkillBody(cwd, "loom-x") === "LEGACY, NO FINGERPRINT RECORD");
    check("(5) never reclaimed (real code)", !r2.claimedNames.includes("loom-x") && !r3.claimedNames.includes("loom-x"));

    // Mutant M3: disable the no-recorded-fingerprint skip in the deadClaimed-merge loop — fabricate a
    // dead-fingerprint set from the CURRENT on-disk content, so the subsequent match trivially passes for
    // exactly the legacy (no-record) case, without weakening the match-check for any case that DOES have
    // a real recorded fingerprint (sections 1/3/4/6 are untouched by this mutation).
    const m3 = await buildMutant(
      "m3",
      `for (const stale of deadClaimed) {\n            const recordedFps = deadFingerprints.get(stale);\n            if (!recordedFps || recordedFps.size === 0) {\n                if (!pendingWorking.has(stale))\n                    console.log(\`[skills] keeping dead-session claim '\${stale}' (shared cwd): no recorded content fingerprint (a legacy claim) — cannot verify it's still Loom's own, so not reclaiming\`);\n                continue; // never trusted, with or without a pending record — same posture as before round 2\n            }\n            const existing = pendingWorking.get(stale);`,
      `for (const stale of deadClaimed) {\n            let recordedFps = deadFingerprints.get(stale);\n            if (!recordedFps || recordedFps.size === 0) { recordedFps = new Set([fingerprintSkillDir(path.join(targetDir, stale))]); } // MUTANT M3: legacy-no-fingerprint guard disabled\n            const existing = pendingWorking.get(stale);`,
    );
    const cwdM3 = freshRepoCwd();
    initRepo(cwdM3);
    const targetDirM3 = path.join(cwdM3, ".claude", "skills");
    fs.mkdirSync(path.join(targetDirM3, "loom-x"), { recursive: true });
    fs.writeFileSync(path.join(targetDirM3, "loom-x", "SKILL.md"), "LEGACY, NO FINGERPRINT RECORD (M3)");
    fs.writeFileSync(path.join(targetDirM3, ".loom-skills.json"), JSON.stringify({ "dead-legacyM3": ["loom-x"] }));
    const isLiveM3 = (sid) => sid !== "dead-legacyM3";
    m3.injectSkills(cwdM3, "new-mgrM3", null, "manager", false, isLiveM3);
    await m3.__awaitPendingSkillTrackChecks();
    m3.injectSkills(cwdM3, "new-mgrM3", null, "manager", false, isLiveM3);
    check("(5) *** MUTANT M3 PROOF ***: with the legacy-no-fingerprint guard disabled, it IS wrongly reclaimed", readSkillBody(cwdM3, "loom-x") !== "LEGACY, NO FINGERPRINT RECORD (M3)");
  }

  // ============ SECTION 6: a concurrently-live sibling's claim is respected, + mutant M4 ============
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    injectSkills(cwd, "dead-mgr6", null, "manager");
    injectSkills(cwd, "live-sibling6", null, "manager"); // sibling also claims loom-x (union semantics)
    const isLive = (sid) => sid === "live-sibling6";
    injectSkills(cwd, "new-mgr6", null, "manager", false, isLive);
    if (typeof __awaitPendingSkillTrackChecks === "function") await __awaitPendingSkillTrackChecks();
    injectSkills(cwd, "new-mgr6", null, "manager", false, isLive);
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "skills", ".loom-skills.json"), "utf8"));
    check("(6) dead-mgr6 pruned, live-sibling6 still claims loom-x", !("dead-mgr6" in manifest) && manifest["live-sibling6"]?.includes("loom-x"));

    // Mutant M4: disable the shared-cwd resolve loop's ONE otherClaimed guard — round 2 unified Pass 1 and
    // Pass 2 into a single loop with a single check, so there is only one site left to disable.
    const m4 = await buildMutant(
      "m4",
      `if (otherClaimed.has(name)) {\n                pendingWorking.delete(name);\n                continue;\n            } // resolved: a live session claims it`,
      `if (false) {\n                pendingWorking.delete(name);\n                continue;\n            } // MUTANT M4: otherClaimed guard disabled`,
    );
    const cwdM4 = freshRepoCwd();
    initRepo(cwdM4);
    m4.injectSkills(cwdM4, "dead-mgrM4", null, "manager");
    m4.injectSkills(cwdM4, "live-siblingM4", null, "manager");
    const isLiveM4 = (sid) => sid === "live-siblingM4";
    m4.injectSkills(cwdM4, "new-mgrM4", null, "manager", false, isLiveM4);
    await m4.__awaitPendingSkillTrackChecks();
    m4.injectSkills(cwdM4, "new-mgrM4", null, "manager", false, isLiveM4);
    const manifestM4 = JSON.parse(fs.readFileSync(path.join(cwdM4, ".claude", "skills", ".loom-skills.json"), "utf8"));
    check("(6) *** MUTANT M4 PROOF ***: with the otherClaimed guard disabled, new-mgrM4 wrongly self-claims loom-x out from under the live sibling", Array.isArray(manifestM4["new-mgrM4"]) && manifestM4["new-mgrM4"].includes("loom-x"));
  }

  // ============ SECTION 7: the re-verify-at-consume-time race guard, + mutant M5 ============
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    injectSkills(cwd, "dead-mgr7", null, "manager");
    const isLive = (sid) => sid !== "dead-mgr7";
    injectSkills(cwd, "new-mgr7", null, "manager", false, isLive); // discovers + kicks the check
    if (typeof __awaitPendingSkillTrackChecks === "function") await __awaitPendingSkillTrackChecks(); // resolves "untracked"
    // NOW a user edits the file, AFTER the check resolved but BEFORE the repair call consumes it.
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "loom-x", "SKILL.md"), "EDITED AFTER THE CHECK, BEFORE THE REPAIR");
    injectSkills(cwd, "new-mgr7", null, "manager", false, isLive); // the repair call — must re-verify and skip
    check("(7) *** RACE GUARD ***: an edit landing between the check and the repair call survives untouched", readSkillBody(cwd, "loom-x") === "EDITED AFTER THE CHECK, BEFORE THE REPAIR");

    // Mutant M5: round 2's unified resolve loop protects this exact race TWICE over — the earlier
    // "matches any recorded dead placement" check (the one M1 also exercises) already catches a single
    // edit before the cache is even consulted, AND the cache-entry validity re-check (expired OR
    // fingerprint changed) would catch it too if reached. Disabling only ONE of the two leaves the other
    // standing (verified: each alone still fully protects this scenario) — this mutant disables BOTH, in
    // one chained edit, to prove the race guard as a whole is load-bearing. (A scenario with TWO distinct
    // recorded dead fingerprints could isolate the cache-entry check alone, but is not needed to show the
    // guard matters here.)
    const m5a = await buildMutant(
      "m5a",
      `const currentFp = fingerprintSkillDir(target); // reused below for the untracked-check cache + kick, not just this match\n            if (!currentFp || !matchesRecordedFingerprint(currentFp, rec.deadFingerprints)) {\n                console.log(\`[skills] keeping dead-session claim '\${name}' (shared cwd): on-disk content doesn't match any recorded Loom placement (edited, or files added) — not reclaiming\`);\n                pendingWorking.delete(name); // resolved: edited — drop the record and never touch it again\n                continue;\n            }`,
      `const currentFp = fingerprintSkillDir(target); // reused below for the untracked-check cache + kick, not just this match\n            if (false) {\n                console.log(\`[skills] keeping dead-session claim '\${name}' (shared cwd): on-disk content doesn't match any recorded Loom placement (edited, or files added) — not reclaiming\`);\n                pendingWorking.delete(name); // MUTANT M5a: fingerprint-match guard disabled\n                continue;\n            }`,
    );
    void m5a; // the first substitution's own module is unused — chain a second edit onto the SAME file on disk
    const m5Path = mutantFiles[mutantFiles.length - 1];
    const m5Src = fs.readFileSync(m5Path, "utf8");
    const m5Needle = `if (cacheEntry.expiresAt <= nowMs || cacheEntry.fingerprint !== currentFp) {\n                    verifiedUntrackedCache.delete(key); // stale or invalidated by an edit since it was kicked — a wrong fact is never worth keeping, for anyone\n                }\n                else if (want.includes(name)) {`;
    const m5Occurrences = m5Src.split(m5Needle).length - 1;
    if (m5Occurrences !== 1) throw new Error(`mutant M5b: expected exactly 1 occurrence, found ${m5Occurrences}`);
    fs.writeFileSync(m5Path, m5Src.replace(m5Needle, `if (false) {\n                    verifiedUntrackedCache.delete(key); // MUTANT M5b: cache-entry validity re-check ALSO disabled\n                }\n                else if (want.includes(name)) {`));
    const m5mod = await import(`file://${m5Path.replace(/\\/g, "/")}?v=${Date.now()}`); // cache-bust: same path, now-mutated-twice content

    const cwdM5 = freshRepoCwd();
    initRepo(cwdM5);
    m5mod.injectSkills(cwdM5, "dead-mgrM5", null, "manager");
    const isLiveM5 = (sid) => sid !== "dead-mgrM5";
    m5mod.injectSkills(cwdM5, "new-mgrM5", null, "manager", false, isLiveM5);
    await m5mod.__awaitPendingSkillTrackChecks();
    fs.writeFileSync(path.join(cwdM5, ".claude", "skills", "loom-x", "SKILL.md"), "EDITED AFTER THE CHECK (M5)");
    m5mod.injectSkills(cwdM5, "new-mgrM5", null, "manager", false, isLiveM5);
    check("(7) *** MUTANT M5 PROOF ***: with the race guard disabled, the post-check edit IS wrongly clobbered", readSkillBody(cwdM5, "loom-x") !== "EDITED AFTER THE CHECK (M5)");
  }

  // ============ SECTION 8: worktree-cwd behaviour is UNCHANGED (still an unconditional delete) ============
  {
    // Mirrors packages/daemon/test/skills-capability-bound.mjs's own worktree dead-claim coverage; this
    // is a light confirmatory check, not a replacement for that suite.
    const { WORKTREES_DIR } = await import(`file://${path.join(__dirname, "..", "dist", "paths.js").replace(/\\/g, "/")}`);
    const worktreeCwd = path.join(WORKTREES_DIR, `f4e93dbf-worktree-check-${Date.now()}-${process.pid}-${randomUUID()}`);
    fs.mkdirSync(worktreeCwd, { recursive: true });
    try {
      injectSkills(worktreeCwd, "dead-wk", null, "worker");
      const isLive = (sid) => sid !== "dead-wk";
      // Worktree path: UNCHANGED, single-call behavior — the dead claim's dir is deleted AND the `want`
      // loop (deliver-all default already wants "loom-x") re-copies it fresh, all within this ONE call —
      // no two-call discover/repair split, unlike the shared-cwd async path above.
      const r2 = injectSkills(worktreeCwd, "new-wk", null, "worker", false, isLive);
      const currentStoreBody = fs.readFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "utf8");
      check("(8) worktree cwd: refreshed to the CURRENT store content, in the SAME single call (no discover/repair split)", r2.claimedNames.includes("loom-x") && readSkillBody(worktreeCwd, "loom-x") === currentStoreBody);
    } finally {
      fs.rmSync(worktreeCwd, { recursive: true, force: true });
    }
  }

  // ============ SECTION 9: a shared cwd that is CLEARLY NOT a git repo at all — reclaimed immediately, synchronously, no await needed ============
  {
    const cwd = freshRepoCwd();
    fs.mkdirSync(cwd, { recursive: true }); // deliberately NO `git init` — no .git anywhere up-tree
    injectSkills(cwd, "dead-mgr9", null, "manager");
    const isLive = (sid) => sid !== "dead-mgr9";
    const r2 = injectSkills(cwd, "new-mgr9", null, "manager", false, isLive);
    const currentStoreBody = fs.readFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "utf8");
    check("(9) no-repo cwd: reclaimed in the SAME call that discovered it (no tracked-file risk to check)", r2.claimedNames.includes("loom-x") && readSkillBody(cwd, "loom-x") === currentStoreBody);
  }

  // ============ SECTION 10 (round 2 MINOR #2): consume/reclaim is gated on `want` ============
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: s10v1\n---\nS10 V1 BODY");
    injectSkills(cwd, "dead-mgr10", null, "manager"); // deliver-all default — places loom-x
    fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: s10v2\n---\nS10 V2 BODY");
    const isLive = (sid) => sid !== "dead-mgr10";
    // An EXPLICIT SUBSET session that does NOT want "loom-x" — discovers the orphan, kicks the check,
    // but must never consume it: `want` excludes the name.
    const rNotWanted = injectSkills(cwd, "narrow-mgr10", ["some-other-skill"], "manager", false, isLive);
    if (typeof __awaitPendingSkillTrackChecks === "function") await __awaitPendingSkillTrackChecks();
    const rNotWanted2 = injectSkills(cwd, "narrow-mgr10", ["some-other-skill"], "manager", false, isLive); // still doesn't want it — must still leave it
    check("(10) a session that doesn't want 'loom-x' never consumes the verified fact for it", !rNotWanted.claimedNames.includes("loom-x") && !rNotWanted2.claimedNames.includes("loom-x"));
    check("(10) left untouched by the non-wanting sessions (still v1)", readSkillBody(cwd, "loom-x")?.includes("S10 V1 BODY"));
    // A LATER session that DOES want it — the fact (or pending record) the non-wanting sessions left
    // alone is still there for this call to consume.
    const rWanted = injectSkills(cwd, "wanting-mgr10", null, "manager", false, isLive); // deliver-all wants loom-x
    check("(10) *** MINOR FIX #2 PROVEN ***: the first wanting session repairs it, using what the non-wanting sessions left alone", readSkillBody(cwd, "loom-x")?.includes("S10 V2 BODY") === true && rWanted.claimedNames.includes("loom-x"));
  }

  // ============ SECTION 11 (round 2 MINOR #3): a nested repo BELOW the shared cwd ============
  {
    const cwd = freshRepoCwd();
    initRepo(cwd); // the OUTER repo — project.repoPath's own checkout
    injectSkills(cwd, "dead-mgr11", null, "manager"); // places loom-x, untracked in the outer repo
    // A SECOND, INNER repo rooted at `.claude` itself — the skill dir is tracked there, invisible to the
    // outer repo's own `git ls-files` (a nested .git is a repo boundary the outer repo never descends
    // into). Round 1 only ever checked `cwd`'s own (outer) repo and would have wrongly reported this as
    // untracked.
    const claudeDir = path.join(cwd, ".claude");
    git(claudeDir, ["init", "-q"]);
    git(claudeDir, ["config", "user.email", "t@t"]);
    git(claudeDir, ["config", "user.name", "t"]);
    git(claudeDir, ["add", "-f", "skills/loom-x"]);
    git(claudeDir, ["commit", "-q", "-m", "tracked in the INNER .claude repo"]);
    fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: s11v2\n---\nS11 V2 BODY"); // store moves on
    const isLive = (sid) => sid !== "dead-mgr11";
    const r2 = injectSkills(cwd, "new-mgr11", null, "manager", false, isLive);
    if (typeof __awaitPendingSkillTrackChecks === "function") await __awaitPendingSkillTrackChecks(); // the REAL check, against the INNER repo
    const r3 = injectSkills(cwd, "new-mgr11", null, "manager", false, isLive);
    check("(11) *** NESTED REPO GUARD ***: tracked only in the inner .claude repo — never replaced", !readSkillBody(cwd, "loom-x")?.includes("S11 V2 BODY"));
    check("(11) never reclaimed (real code)", !r2.claimedNames.includes("loom-x") && !r3.claimedNames.includes("loom-x"));
    // Scoped to the tracked skill dir alone — the inner repo's working tree also carries the UNTRACKED
    // manifest/fingerprints sidecars every injectSkills call writes under `.claude/skills/`, which is
    // expected and not what this check is about.
    check("(11) the tracked skill dir itself is untouched in the inner repo (no diff, nothing staged)", git(claudeDir, ["status", "--porcelain", "--", "skills/loom-x"]).trim() === "");
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — shared-cwd dead-claim reclaim: core repair, repo-owned/hand-edited/tracked/legacy/live-sibling/race/want-gating/nested-repo protections all verified, each disabling mutant proving its own guard load-bearing; worktree-cwd behaviour unchanged."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  cleanupMutants();
}
process.exit(failures === 0 ? 0 : 1);
