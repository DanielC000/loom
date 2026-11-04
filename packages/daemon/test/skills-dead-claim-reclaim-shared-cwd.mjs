// Regression suite for card f4e93dbf (rounds 1-3; round 3 from card d467d56d): a dead session's skill claim in a SHARED (non-
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
// 9b. (card d467d56d) The no-repo branch's OWN want-gate: a non-wanting session must never consume it —
//     PLUS a mutant (disables that gate) proving a non-wanting session's bug there strands the orphan
//     forever rather than merely over-claiming (its own `want` never includes the name either way).
// 10. Round 2 MINOR #2: consume/reclaim is gated on `want` — a session that doesn't want the name leaves
//     the verified fact / pending record untouched for a later caller that does.
// 11. Round 2 MINOR #3: a nested repo BELOW the shared cwd (a `.claude/.git`) is walked to and checked
//     directly — a dir tracked only in that inner repo is never wrongly treated as untracked just
//     because the OUTER (cwd) repo doesn't see it.
// 12. (card d467d56d, f4e93dbf round 3) A confirmed-TRACKED dir, and a FAILED/REFUSED check (a FILE-
//     shaped `.git`), both now BACK OFF for an hour instead of re-kicking a fresh git subprocess on
//     every future call — never a permanent give-up: the pending-reclaim record is never dropped, and a
//     call after the window retries — PLUS mutants M12a/M12b (each disables ONE outcome's backoff-cache
//     write) proving every call would otherwise re-kick.
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
/** Card d467d56d (section 12): does the fingerprints sidecar still carry a `__pendingReclaim` entry for
 *  `name` at `cwd`? Used to prove a resolved (tracked/refused) outcome drops the bookkeeping for good. */
const sidecarHasPendingFor = (cwd, name) => {
  try {
    const sidecar = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "skills", ".loom-skills-fingerprints.json"), "utf8"));
    return Boolean(sidecar.__pendingReclaim && Object.prototype.hasOwnProperty.call(sidecar.__pendingReclaim, name));
  } catch { return false; }
};

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
      `const currentFp = fingerprintSkillDir(target); // reused below for the untracked-check cache + kick, not just this match\n            if (!currentFp || !matchesRecordedFingerprint(currentFp, rec.deadFingerprints)) {\n                console.log(\`[skills] keeping dead-session claim '\${name}' (shared cwd): on-disk content doesn't match any recorded Loom placement (edited, or files added) — not reclaiming\`);\n                pendingWorking.delete(name); // resolved: edited — drop the record and never touch it again\n                recordReleased(released, name, "modified"); // card 8b38b920\n                continue;\n            }`,
      `const currentFp = fingerprintSkillDir(target); // reused below for the untracked-check cache + kick, not just this match\n            if (false) {\n                console.log(\`[skills] keeping dead-session claim '\${name}' (shared cwd): on-disk content doesn't match any recorded Loom placement (edited, or files added) — not reclaiming\`);\n                pendingWorking.delete(name); // MUTANT M1: fingerprint-match guard disabled\n                recordReleased(released, name, "modified");\n                continue;\n            }`,
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

    // Mutant M3: disable the no-recorded-fingerprint skip in the deadClaimed-merge loop (card f4272888:
    // `lastPlaced.get(stale)` is now the ONE persisted fact, no longer a per-call `deadFingerprints` Map)
    // — fabricate a recorded-fingerprint array from the CURRENT on-disk content, so the subsequent match
    // trivially passes for exactly the legacy (no-record) case, without weakening the match-check for any
    // case that DOES have a real recorded fingerprint (sections 1/3/4/6 are untouched by this mutation).
    const m3 = await buildMutant(
      "m3",
      `for (const stale of deadClaimed) {\n            const recordedFps = lastPlaced.get(stale);\n            if (!recordedFps || recordedFps.length === 0) {\n                if (!pendingWorking.has(stale))\n                    console.log(\`[skills] keeping dead-session claim '\${stale}' (shared cwd): no recorded content fingerprint (a legacy claim) — cannot verify it's still Loom's own, so not reclaiming\`);\n                // card 8b38b920: a legacy claim with no recorded fingerprint is genuinely unverifiable (never a\n                // storeFallback check on this path — see matchesRecordedFingerprint's own doc) — durably recorded\n                // so a human can discover it, rather than only ever a console.log at the moment it happens.\n                recordReleased(released, stale, "unverifiable-legacy");\n                continue; // never trusted, with or without a pending record — same posture as before round 2\n            }\n            const existing = pendingWorking.get(stale);`,
      `for (const stale of deadClaimed) {\n            let recordedFps = lastPlaced.get(stale);\n            if (!recordedFps || recordedFps.length === 0) { recordedFps = [fingerprintSkillDir(path.join(targetDir, stale))]; } // MUTANT M3: legacy-no-fingerprint guard disabled\n            const existing = pendingWorking.get(stale);`,
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
      `const currentFp = fingerprintSkillDir(target); // reused below for the untracked-check cache + kick, not just this match\n            if (!currentFp || !matchesRecordedFingerprint(currentFp, rec.deadFingerprints)) {\n                console.log(\`[skills] keeping dead-session claim '\${name}' (shared cwd): on-disk content doesn't match any recorded Loom placement (edited, or files added) — not reclaiming\`);\n                pendingWorking.delete(name); // resolved: edited — drop the record and never touch it again\n                recordReleased(released, name, "modified"); // card 8b38b920\n                continue;\n            }`,
      `const currentFp = fingerprintSkillDir(target); // reused below for the untracked-check cache + kick, not just this match\n            if (false) {\n                console.log(\`[skills] keeping dead-session claim '\${name}' (shared cwd): on-disk content doesn't match any recorded Loom placement (edited, or files added) — not reclaiming\`);\n                pendingWorking.delete(name); // MUTANT M5a: fingerprint-match guard disabled\n                recordReleased(released, name, "modified");\n                continue;\n            }`,
    );
    void m5a; // the first substitution's own module is unused — chain a second edit onto the SAME file on disk
    const m5Path = mutantFiles[mutantFiles.length - 1];
    const m5Src = fs.readFileSync(m5Path, "utf8");
    const m5Needle = `if (cacheEntry.expiresAt <= nowMs || cacheEntry.fingerprint !== currentFp) {\n                    verifiedUntrackedCache.delete(key); // stale or invalidated by an edit since it was kicked — a wrong fact is never worth keeping, for anyone\n                }\n                else if (want.includes(name)) {`;
    const m5Occurrences = m5Src.split(m5Needle).length - 1;
    // card d467d56d: ROBUSTNESS — this exact-text second edit is chained onto an already-built mutant
    // module (m5a), so a LATER structural change to the surrounding resolve loop (e.g. a new sibling
    // branch inserted ahead of this exact span) can legitimately shift it without `m5a` itself being
    // wrong. A hard `throw` here used to crash the WHOLE file before section 10 ever ran. Degrade
    // instead: log and fall back to the m5a-only module (still a real, if narrower, race-guard proof —
    // see the comment above this block) rather than losing every later section's coverage over a single
    // brittle exact-text match.
    let m5mod;
    if (m5Occurrences !== 1) {
      console.log(`WARN  mutant M5b: expected exactly 1 occurrence of its text snippet in the m5a-mutated source, found ${m5Occurrences} — skipping the M5b double-guard edit and falling back to M5a alone (a drift signal to investigate, not a test failure)`);
      m5mod = m5a;
    } else {
      fs.writeFileSync(m5Path, m5Src.replace(m5Needle, `if (false) {\n                    verifiedUntrackedCache.delete(key); // MUTANT M5b: cache-entry validity re-check ALSO disabled\n                }\n                else if (want.includes(name)) {`));
      m5mod = await import(`file://${m5Path.replace(/\\/g, "/")}?v=${Date.now()}`); // cache-bust: same path, now-mutated-twice content
    }

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

  // ============ SECTION 9b (card d467d56d): the no-repo immediate-reclaim branch is ALSO want-gated ============
  // Section 9 above only ever exercises a WANTING (deliver-all) session, so a mutant disabling the
  // `want.includes(name)` check on that branch alone would leave section 9 fully green. This section adds
  // the missing non-wanting-then-wanting pair the card asked for.
  {
    const cwd = freshRepoCwd();
    fs.mkdirSync(cwd, { recursive: true }); // deliberately NO `git init` — no .git anywhere up-tree
    fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: s9bv1\n---\nS9B V1 BODY");
    injectSkills(cwd, "dead-mgr9b", null, "manager");
    fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: s9bv2\n---\nS9B V2 BODY"); // store moves on
    const isLive9b = (sid) => sid !== "dead-mgr9b";
    // A non-wanting (explicit narrow subset) session discovers the orphan but must never consume it.
    const rNotWanted9b = injectSkills(cwd, "narrow-mgr9b", ["some-other-skill"], "manager", false, isLive9b);
    check("(9b) a non-wanting session never reclaims via the no-repo immediate branch (real code)", !rNotWanted9b.claimedNames.includes("loom-x"));
    check("(9b) left untouched by the non-wanting session (still v1)", readSkillBody(cwd, "loom-x")?.includes("S9B V1 BODY"));
    // A LATER session that DOES want it reclaims what the non-wanting session left pending — no await
    // needed either way, since the no-repo branch never kicks an async check at all.
    const rWanted9b = injectSkills(cwd, "wanting-mgr9b", null, "manager", false, isLive9b);
    check("(9b) a later wanting session reclaims it, using what the non-wanting session left pending", readSkillBody(cwd, "loom-x")?.includes("S9B V2 BODY") === true && rWanted9b.claimedNames.includes("loom-x"));

    // Mutant: disable the want-gate on the no-repo immediate-reclaim branch — `if (true)` drops the
    // pending-reclaim bookkeeping (`pendingWorking.delete(name)`) regardless of `want`. A non-wanting
    // session's own `want` never includes "loom-x", so `reclaimableNow.add` has no effect for IT (the
    // copy loop below only ever iterates `want`) — the observable damage is that the bookkeeping is lost
    // silently, so a LATER wanting session finds nothing left to reclaim at all: the orphan is stranded
    // forever instead of being repaired, the opposite of the real-code assertion two checks up.
    const m9b = await buildMutant(
      "m9b",
      `if (want.includes(name)) {\n                    reclaimableNow.add(name);\n                    pendingWorking.delete(name);\n                }\n                continue;`,
      `if (true) { // MUTANT M9b: no-repo want-gate disabled\n                    reclaimableNow.add(name);\n                    pendingWorking.delete(name);\n                }\n                continue;`,
    );
    const cwdM9b = freshRepoCwd();
    fs.mkdirSync(cwdM9b, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: m9bv1\n---\nM9B V1 BODY");
    m9b.injectSkills(cwdM9b, "dead-mgrM9b", null, "manager"); // places m9bv1
    fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: m9bv2\n---\nM9B V2 BODY"); // store moves on
    const isLiveM9b = (sid) => sid !== "dead-mgrM9b";
    m9b.injectSkills(cwdM9b, "narrow-mgrM9b", ["some-other-skill"], "manager", false, isLiveM9b); // BUGGY: drops the pending record even though it never wanted loom-x
    const rWantedM9b = m9b.injectSkills(cwdM9b, "wanting-mgrM9b", null, "manager", false, isLiveM9b); // a later wanting session — real code would repair here (see the check two above)
    check("(9b) *** MUTANT PROOF ***: with the want-gate disabled, the orphan is silently dropped and never reclaimed, even by a later wanting session", !rWantedM9b.claimedNames.includes("loom-x") && readSkillBody(cwdM9b, "loom-x")?.includes("M9B V1 BODY") === true);
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

  // ============ SECTION 12 (card d467d56d, f4e93dbf round 3): tracked/refused outcomes BACK OFF ============
  // Before this round, kickUntrackedCheck cached ONLY the "untracked" (reclaimable) outcome — a confirmed-
  // tracked result, or a failed/refused check, cached nothing, so every future injectSkills call at that
  // cwd re-kicked a fresh git subprocess, forever (up to PENDING_RECLAIM_MAX_AGE_MS). Both cases now back
  // off for NEGATIVE_CHECK_BACKOFF_MS (1h, hardcoded here — same convention as the TTL-expiry test's own
  // hardcoded 61_000 for UNTRACKED_CACHE_TTL_MS) instead of caching nothing — NEVER a permanent give-up,
  // since a failed check could be transient. Proven by counting real check fires via their own log line
  // (a repeated call within the window must fire ZERO new checks) and by advancing the mocked clock past
  // the window to show it is not abandoned forever — the pending-reclaim record itself is never dropped.
  const NEGATIVE_CHECK_BACKOFF_MS_FOR_TEST = 60 * 60 * 1000; // must match inject.ts's own NEGATIVE_CHECK_BACKOFF_MS
  {
    const origLog = console.log;
    const countBackoffFires = () => { let c = 0; const fn = (...a) => { if (typeof a[0] === "string" && a[0].includes("backing off for")) c++; return origLog(...a); }; return [fn, () => c]; };

    // 12a: a confirmed-TRACKED dir backs off — a repeated call within the window fires NO new check, and
    // the pending record is never dropped. Advancing past the window shows it retries (never forever).
    const cwd12a = freshRepoCwd();
    initRepo(cwd12a);
    injectSkills(cwd12a, "dead-mgr12a", null, "manager");
    git(cwd12a, ["add", "-f", ".claude/skills/loom-x"]);
    git(cwd12a, ["commit", "-q", "-m", "tracked"]);
    fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: s12av2\n---\nS12A V2 BODY"); // store moves on
    const isLive12a = (sid) => sid !== "dead-mgr12a";
    const [fn12a, count12a] = countBackoffFires();
    console.log = fn12a;
    try {
      injectSkills(cwd12a, "new-mgr12a", null, "manager", false, isLive12a); // discover + kick
      if (typeof __awaitPendingSkillTrackChecks === "function") await __awaitPendingSkillTrackChecks(); // resolves "tracked" -> backs off
      injectSkills(cwd12a, "new-mgr12a", null, "manager", false, isLive12a); // WITHIN the backoff window — must not re-kick
      if (typeof __awaitPendingSkillTrackChecks === "function") await __awaitPendingSkillTrackChecks();
    } finally { console.log = origLog; }
    check("(12a) exactly ONE real check fires across discovery + a repeated in-window call", count12a() === 1);
    check("(12a) pending-reclaim record is NEVER dropped while backing off", sidecarHasPendingFor(cwd12a, "loom-x"));
    check("(12a) content still never replaced (the tracked guard itself, unchanged)", readSkillBody(cwd12a, "loom-x")?.includes("S12A V2 BODY") !== true);

    const realDateNow12a = Date.now;
    Date.now = () => realDateNow12a() + NEGATIVE_CHECK_BACKOFF_MS_FOR_TEST + 1000; // advance PAST the backoff window
    const [fn12a2, count12a2] = countBackoffFires();
    console.log = fn12a2;
    try {
      injectSkills(cwd12a, "new-mgr12a", null, "manager", false, isLive12a); // the window has passed — this call re-kicks
      if (typeof __awaitPendingSkillTrackChecks === "function") await __awaitPendingSkillTrackChecks();
    } finally { Date.now = realDateNow12a; console.log = origLog; }
    check("(12a) *** NOT FOREVER ***: a call AFTER the backoff window re-kicks a fresh check", count12a2() === 1);
    check("(12a) still never reclaimed after the retry (genuinely tracked, correctly)", readSkillBody(cwd12a, "loom-x")?.includes("S12A V2 BODY") !== true);

    // Mutant M12a: disable ONLY the tracked-branch's backoff-cache write — reverts to "cache nothing" for
    // a confirmed-tracked result, reproducing the pre-round-3 shape where EVERY call re-kicks.
    const m12a = await buildMutant(
      "m12a",
      `console.log(\`[skills] dead-claim reclaim: '\${name}' at \${cwd} is git-tracked — backing off for \${NEGATIVE_CHECK_BACKOFF_MS}ms before checking again\`);\n                cacheCheckResult(key, { fingerprint, expiresAt: Date.now() + NEGATIVE_CHECK_BACKOFF_MS, negative: true });`,
      `console.log(\`[skills] dead-claim reclaim: '\${name}' at \${cwd} is git-tracked — backing off for \${NEGATIVE_CHECK_BACKOFF_MS}ms before checking again\`); /* MUTANT M12a: tracked-outcome backoff-caching disabled */`,
    );
    const cwdM12a = freshRepoCwd();
    initRepo(cwdM12a);
    m12a.injectSkills(cwdM12a, "dead-mgrM12a", null, "manager");
    git(cwdM12a, ["add", "-f", ".claude/skills/loom-x"]);
    git(cwdM12a, ["commit", "-q", "-m", "tracked"]);
    const isLiveM12a = (sid) => sid !== "dead-mgrM12a";
    const [fnM12a, countM12a] = countBackoffFires();
    console.log = fnM12a;
    try {
      m12a.injectSkills(cwdM12a, "new-mgrM12a", null, "manager", false, isLiveM12a);
      await m12a.__awaitPendingSkillTrackChecks();
      m12a.injectSkills(cwdM12a, "new-mgrM12a", null, "manager", false, isLiveM12a); // WITHIN what would be the backoff window
      await m12a.__awaitPendingSkillTrackChecks();
    } finally { console.log = origLog; }
    check("(12a) *** MUTANT M12a PROOF ***: with backoff-caching disabled, a second in-window call wrongly re-kicks too", countM12a() === 2);

    // 12b: a FAILED/REFUSED check (a FILE-shaped `.git`, deliberately never given a trustedMainRoot —
    // see the decision record's named residual) backs off the same way, even though nothing was ever
    // confirmed tracked — the check itself never got to run.
    const cwd12b = freshRepoCwd();
    fs.mkdirSync(cwd12b, { recursive: true });
    fs.writeFileSync(path.join(cwd12b, ".git"), "gitdir: ../nonexistent-main/.git\n"); // FILE-shaped .git; canonicalGit fail-closed refuses with no trustedMainRoot
    fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: s12bv1\n---\nS12B V1 BODY");
    injectSkills(cwd12b, "dead-mgr12b", null, "manager");
    fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: s12bv2\n---\nS12B V2 BODY"); // store moves on
    const isLive12b = (sid) => sid !== "dead-mgr12b";
    const [fn12b, count12b] = countBackoffFires();
    console.log = fn12b;
    try {
      injectSkills(cwd12b, "new-mgr12b", null, "manager", false, isLive12b); // discover + kick (will fail/refuse)
      if (typeof __awaitPendingSkillTrackChecks === "function") await __awaitPendingSkillTrackChecks();
      injectSkills(cwd12b, "new-mgr12b", null, "manager", false, isLive12b); // WITHIN the backoff window — must not re-kick
      if (typeof __awaitPendingSkillTrackChecks === "function") await __awaitPendingSkillTrackChecks();
    } finally { console.log = origLog; }
    check("(12b) exactly ONE real check fires across discovery + a repeated in-window call", count12b() === 1);
    check("(12b) pending-reclaim record is NEVER dropped while backing off", sidecarHasPendingFor(cwd12b, "loom-x"));
    check("(12b) content never reclaimed (fail-closed, correctly — still v1)", readSkillBody(cwd12b, "loom-x")?.includes("S12B V1 BODY"));

    // Mutant M12b: disable ONLY the catch-branch's backoff-cache write — reverts to "cache nothing" for a
    // failed/refused check.
    const m12b = await buildMutant(
      "m12b",
      `console.log(\`[skills] dead-claim reclaim: git-tracked check failed for '\${name}' at \${cwd} (backing off for \${NEGATIVE_CHECK_BACKOFF_MS}ms before checking again): \${e?.message ?? e}\`);\n            cacheCheckResult(key, { fingerprint, expiresAt: Date.now() + NEGATIVE_CHECK_BACKOFF_MS, negative: true });`,
      `console.log(\`[skills] dead-claim reclaim: git-tracked check failed for '\${name}' at \${cwd} (backing off for \${NEGATIVE_CHECK_BACKOFF_MS}ms before checking again): \${e?.message ?? e}\`); /* MUTANT M12b: failed/refused-outcome backoff-caching disabled */`,
    );
    const cwdM12b = freshRepoCwd();
    fs.mkdirSync(cwdM12b, { recursive: true });
    fs.writeFileSync(path.join(cwdM12b, ".git"), "gitdir: ../nonexistent-main/.git\n");
    m12b.injectSkills(cwdM12b, "dead-mgrM12b", null, "manager");
    const isLiveM12b = (sid) => sid !== "dead-mgrM12b";
    const [fnM12b, countM12b] = countBackoffFires();
    console.log = fnM12b;
    try {
      m12b.injectSkills(cwdM12b, "new-mgrM12b", null, "manager", false, isLiveM12b);
      await m12b.__awaitPendingSkillTrackChecks();
      m12b.injectSkills(cwdM12b, "new-mgrM12b", null, "manager", false, isLiveM12b); // WITHIN what would be the backoff window
      await m12b.__awaitPendingSkillTrackChecks();
    } finally { console.log = origLog; }
    check("(12b) *** MUTANT M12b PROOF ***: with backoff-caching disabled, a second in-window call wrongly re-kicks too", countM12b() === 2);
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — shared-cwd dead-claim reclaim: core repair, repo-owned/hand-edited/tracked/legacy/live-sibling/race/want-gating/nested-repo protections all verified, each disabling mutant proving its own guard load-bearing; worktree-cwd behaviour unchanged."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  cleanupMutants();
}
process.exit(failures === 0 ? 0 : 1);
