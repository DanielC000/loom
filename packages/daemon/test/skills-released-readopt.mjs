// Card 8b38b920: surface injected skill copies Loom stopped managing, plus a human-only re-adopt action.
//
// Covers every recorded release site the manager approved (see docs/decisions/8b38b920-*.md "Scope
// decisions"): the two LIVE-session sites (want-loop re-copy skip -> "modified"; myPrev stale-prune skip
// -> "modified") and the four shared-cwd dead-claim give-up sites ("unverifiable-legacy" for no recorded
// fingerprint; "modified" for an edited dead claim; "abandoned" for the age give-up and the per-cwd cap).
// Each is proven RED (API-keeping mutant: the call site is present but a no-op) before GREEN (the real
// code). Also covers the clear-on-(re)placement visibility, the re-adopt function (incl. the stale-
// fingerprint refusal) and the next-live-session re-claim bridge.
//
// Fully hermetic: useOwnLoomHome (fresh temp LOOM_HOME) BEFORE any dist import. Run after build:
//   node test/skills-released-readopt.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const home = useOwnLoomHome("loom-8b38b920-", { fresh: true }); // BEFORE importing — paths.ts computes SKILLS_DIR at load
const skillsDir = path.join(home, "skills");
fs.mkdirSync(path.join(skillsDir, "loom-x"), { recursive: true });
fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: v1\n---\nV1 BODY");

const DIST_SKILLS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "dist", "skills");
const REAL_INJECT = path.join(DIST_SKILLS_DIR, "inject.js");

const mod = await import("../dist/skills/inject.js");
const {
  injectSkills, fingerprintSkillDir,
  releasedSkillsAt, releasedSkillDiffSummary, releasedSkillDiffFile, reAdoptReleasedSkill,
} = mod;
const awaitPendingChecks = typeof mod.__awaitPendingSkillTrackChecks === "function" ? mod.__awaitPendingSkillTrackChecks : async () => {};

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function initRepo(cwd) {
  execFileSync("git", ["init", "-q"], { cwd, env: GIT_ENV });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd, env: GIT_ENV });
  execFileSync("git", ["config", "user.name", "t"], { cwd, env: GIT_ENV });
}
function freshRepoCwd() { return mkdtempManaged("loom-8b38b920-repo-"); }
function readBody(cwd, name) { try { return fs.readFileSync(path.join(cwd, ".claude", "skills", name, "SKILL.md"), "utf8"); } catch { return null; } }
function readSidecar(cwd) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "skills", ".loom-skills-fingerprints.json"), "utf8")); }
  catch { return {}; }
}

/** Mirrors every sibling skills-*.mjs's own `buildMutant` helper: copy the REAL dist inject.js into a
 *  sibling file with exactly one text substitution, import it, return its exports. `oldStr` must occur
 *  EXACTLY once. Caller must delete the mutant file (see cleanupMutants). */
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
  // =====================================================================================================
  // SECTION 1 — site #1 (want-loop re-copy skip): a live claimant's hand-edited copy durably records
  // "modified", API-keeping mutant proves the write is load-bearing.
  // =====================================================================================================
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    injectSkills(cwd, "sess-a", null, "manager");
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "loom-x", "SKILL.md"), "HAND EDITED BY SESS-A");
    const r2 = injectSkills(cwd, "sess-a", null, "manager");
    check("(1) hand-edited content survives (real code)", readBody(cwd, "loom-x") === "HAND EDITED BY SESS-A");
    check("(1) not reclaimed by the editor's own resume", !r2.claimedNames.includes("loom-x"));
    const sidecar = readSidecar(cwd);
    check("(1) __released durably records reason 'modified'", sidecar.__released?.["loom-x"]?.reason === "modified");
    check("(1) firstSeenAt is a real number", typeof sidecar.__released?.["loom-x"]?.firstSeenAt === "number");

    // API-keeping mutant: the recordReleased call site is present in source text but turned into a no-op
    // (the function itself untouched) — proves the WRITE at this call site is load-bearing, not that the
    // function exists.
    const m1 = await buildMutant(
      "s1",
      `recordReleased(released, name, "modified"); // card 8b38b920 — durable; this is the actual "frozen doctrine" bug`,
      `/* MUTANT S1: recordReleased call disabled */`,
    );
    const cwdM1 = freshRepoCwd();
    initRepo(cwdM1);
    m1.injectSkills(cwdM1, "sess-a-m1", null, "manager");
    fs.writeFileSync(path.join(cwdM1, ".claude", "skills", "loom-x", "SKILL.md"), "HAND EDITED (M1)");
    m1.injectSkills(cwdM1, "sess-a-m1", null, "manager");
    check("(1) *** MUTANT PROOF ***: with the recordReleased call disabled, no durable record is written", readSidecar(cwdM1).__released?.["loom-x"] === undefined);
  }

  // =====================================================================================================
  // SECTION 2 — clear-on-(re)placement (the "hand-reverted, silently resumes management" residual), now
  // VISIBLE via a log line + the record actually clearing. Two LIVE co-claimants: A's resume releases it,
  // B's later resume (after the content is reverted back to the originally-placed bytes) legitimately
  // re-places it and must clear the record.
  // =====================================================================================================
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    injectSkills(cwd, "sess-a2", null, "manager");
    injectSkills(cwd, "sess-b2", null, "manager"); // B co-claims the same name in the same shared cwd
    const original = readBody(cwd, "loom-x");
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "loom-x", "SKILL.md"), "HAND EDITED, WILL BE REVERTED");
    injectSkills(cwd, "sess-a2", null, "manager"); // A's resume releases it
    check("(2) precondition: released after A's resume", readSidecar(cwd).__released?.["loom-x"]?.reason === "modified");
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "loom-x", "SKILL.md"), original); // hand-revert to the exact original bytes

    const origLog = console.log;
    let sawUnreleaseLine = false;
    console.log = (...args) => { if (String(args[0]).includes("is Loom-managed again")) sawUnreleaseLine = true; origLog(...args); };
    let r;
    try { r = injectSkills(cwd, "sess-b2", null, "manager"); } finally { console.log = origLog; } // B's resume re-places it
    check("(2) B's resume re-claims the reverted copy", r.claimedNames.includes("loom-x"));
    check("(2) *** RESIDUAL NOW VISIBLE ***: the released record is cleared", readSidecar(cwd).__released?.["loom-x"] === undefined);
    check("(2) the clear is LOGGED, never silent", sawUnreleaseLine);
  }

  // =====================================================================================================
  // SECTION 3 — site #2 (myPrev stale-prune skip): a no-longer-wanted, hand-edited name is KEPT and
  // records "modified"; once reverted, the SAME no-longer-wanted name is PRUNED and the record clears.
  // =====================================================================================================
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    injectSkills(cwd, "sess-a3", ["loom-x"], "manager");
    const original = readBody(cwd, "loom-x");
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "loom-x", "SKILL.md"), "HAND EDITED, NO LONGER WANTED");
    injectSkills(cwd, "sess-a3", ["some-other-skill"], "manager"); // no longer wants loom-x -> prune loop
    check("(3) hand-edited, unwanted content is KEPT, not pruned", readBody(cwd, "loom-x") === "HAND EDITED, NO LONGER WANTED");
    check("(3) durably records reason 'modified'", readSidecar(cwd).__released?.["loom-x"]?.reason === "modified");

    // API-keeping mutant for the prune-skip's own recordReleased call.
    const m2 = await buildMutant(
      "s2",
      `recordReleased(released, stale, "modified"); // card 8b38b920 — durable; this is the actual "frozen doctrine" bug's prune-sibling trigger\n            continue;`,
      `/* MUTANT S2: recordReleased call disabled */\n            continue;`,
    );
    const cwdM2 = freshRepoCwd();
    initRepo(cwdM2);
    m2.injectSkills(cwdM2, "sess-a3-m2", ["loom-x"], "manager");
    fs.writeFileSync(path.join(cwdM2, ".claude", "skills", "loom-x", "SKILL.md"), "HAND EDITED (M2)");
    m2.injectSkills(cwdM2, "sess-a3-m2", ["some-other-skill"], "manager");
    check("(3) *** MUTANT PROOF ***: with the prune-skip recordReleased disabled, no durable record is written", readSidecar(cwdM2).__released?.["loom-x"] === undefined);
    void original; // the revert-then-reprune shape isn't reachable here: once a name falls out of `want`,
    // it drops from this session's OWN manifest in this exact same call regardless of the prune outcome
    // (manifest.set(sessionId, placed) only ever records the want-loop's successes) — so a SECOND call
    // from the SAME session can never revisit the SAME stale name via this loop again. The clear-on-prune
    // line is exercised directly below via a fabricated manifest, mirroring how section 7 fabricates a
    // pending-reclaim sidecar to reach a path real call sequencing can't.
  }

  // =====================================================================================================
  // SECTION 3b — the prune loop's own clear-on-success line, reached via a fabricated manifest (the
  // normal call sequence can never revisit the same stale name twice via this loop — see the note above).
  // =====================================================================================================
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    injectSkills(cwd, "sess-fab", ["loom-x"], "manager"); // records the real lastPlaced fingerprint
    const targetDir = path.join(cwd, ".claude", "skills");
    // Force a STALE released record to exist (simulating an earlier release from any source) AND force
    // "sess-fab"'s manifest to still list "loom-x" as claimed, even though this call's own `want` won't.
    const sidecarPath = path.join(targetDir, ".loom-skills-fingerprints.json");
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    sidecar.__released = { "loom-x": { reason: "modified", firstSeenAt: Date.now() } };
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar));
    fs.writeFileSync(path.join(targetDir, ".loom-skills.json"), JSON.stringify({ "sess-fab": ["loom-x"] }));
    injectSkills(cwd, "sess-fab", ["some-other-skill"], "manager"); // "loom-x" now in myPrev, not in want, content UNCHANGED (matches) -> pruned
    check("(3b) the fabricated stale name is actually pruned (content matched)", !fs.existsSync(path.join(targetDir, "loom-x")));
    check("(3b) *** clear-on-prune ***: the stale released record is cleared", readSidecar(cwd).__released?.["loom-x"] === undefined);
  }

  // =====================================================================================================
  // SECTION 4 — site #5 (shared-cwd dead-claim, no recorded fingerprint at all): "unverifiable-legacy".
  // =====================================================================================================
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    const targetDir = path.join(cwd, ".claude", "skills");
    fs.mkdirSync(path.join(targetDir, "loom-x"), { recursive: true });
    fs.writeFileSync(path.join(targetDir, "loom-x", "SKILL.md"), "LEGACY, NO FINGERPRINT RECORD");
    fs.writeFileSync(path.join(targetDir, ".loom-skills.json"), JSON.stringify({ "dead-legacy4": ["loom-x"] })); // a claim, no fingerprints sidecar at all
    const isLive = (sid) => sid !== "dead-legacy4";
    injectSkills(cwd, "new-mgr4", null, "manager", false, isLive);
    check("(4) legacy no-fingerprint content untouched", readBody(cwd, "loom-x") === "LEGACY, NO FINGERPRINT RECORD");
    check("(4) durably records reason 'unverifiable-legacy'", readSidecar(cwd).__released?.["loom-x"]?.reason === "unverifiable-legacy");

    const m4 = await buildMutant(
      "s4",
      `recordReleased(released, stale, "unverifiable-legacy");\n                continue; // never trusted, with or without a pending record — same posture as before round 2`,
      `/* MUTANT S4: recordReleased call disabled */\n                continue; // never trusted, with or without a pending record — same posture as before round 2`,
    );
    const cwdM4 = freshRepoCwd();
    initRepo(cwdM4);
    const targetDirM4 = path.join(cwdM4, ".claude", "skills");
    fs.mkdirSync(path.join(targetDirM4, "loom-x"), { recursive: true });
    fs.writeFileSync(path.join(targetDirM4, "loom-x", "SKILL.md"), "LEGACY (M4)");
    fs.writeFileSync(path.join(targetDirM4, ".loom-skills.json"), JSON.stringify({ "dead-legacyM4": ["loom-x"] }));
    const isLiveM4 = (sid) => sid !== "dead-legacyM4";
    m4.injectSkills(cwdM4, "new-mgrM4", null, "manager", false, isLiveM4);
    check("(4) *** MUTANT PROOF ***: with recordReleased disabled, no durable record is written", readSidecar(cwdM4).__released?.["loom-x"] === undefined);
  }

  // =====================================================================================================
  // SECTION 5 — site #6 (shared-cwd dead-claim, edited): "modified". Single call: a dead claimant's
  // recorded fingerprint no longer matches the edited content.
  // =====================================================================================================
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    injectSkills(cwd, "dead-mgr5", null, "manager"); // places + records the fingerprint
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "loom-x", "SKILL.md"), "EDITED BY SOMEONE AFTER dead-mgr5 DIED");
    const isLive = (sid) => sid !== "dead-mgr5";
    const r = injectSkills(cwd, "new-mgr5", null, "manager", false, isLive);
    check("(5) edited dead-claim content survives", readBody(cwd, "loom-x") === "EDITED BY SOMEONE AFTER dead-mgr5 DIED");
    check("(5) not reclaimed", !r.claimedNames.includes("loom-x"));
    check("(5) durably records reason 'modified'", readSidecar(cwd).__released?.["loom-x"]?.reason === "modified");

    const m5 = await buildMutant(
      "s5",
      `pendingWorking.delete(name); // resolved: edited — drop the record and never touch it again\n                recordReleased(released, name, "modified"); // card 8b38b920`,
      `pendingWorking.delete(name); /* MUTANT S5: recordReleased call disabled */`,
    );
    const cwdM5 = freshRepoCwd();
    initRepo(cwdM5);
    m5.injectSkills(cwdM5, "dead-mgrM5", null, "manager");
    fs.writeFileSync(path.join(cwdM5, ".claude", "skills", "loom-x", "SKILL.md"), "EDITED (M5)");
    const isLiveM5 = (sid) => sid !== "dead-mgrM5";
    m5.injectSkills(cwdM5, "new-mgrM5", null, "manager", false, isLiveM5);
    check("(5) *** MUTANT PROOF ***: with recordReleased disabled, no durable record is written", readSidecar(cwdM5).__released?.["loom-x"] === undefined);
  }

  // =====================================================================================================
  // SECTION 6 — site #7 (shared-cwd dead-claim, age give-up): "abandoned" — content untouched, Loom just
  // gave up verifying it's safe to reclaim. Two calls: discover+seed (real Date.now), then advance past
  // PENDING_RECLAIM_MAX_AGE_MS (30 days) and call again. The non-wanting `want` subset keeps it pending
  // across the first call (never resolved via the no-repo immediate-reclaim branch).
  // =====================================================================================================
  {
    const cwd = freshRepoCwd(); // deliberately NO git repo at all — innermostGitRepoRoot returns null
    fs.mkdirSync(cwd, { recursive: true });
    injectSkills(cwd, "dead-mgr6", null, "manager"); // places + records the fingerprint
    const isLive = (sid) => sid !== "dead-mgr6";
    injectSkills(cwd, "narrow-mgr6", ["some-other-skill"], "manager", false, isLive); // discovers, but does NOT want loom-x -> stays pending
    check("(6) precondition: still pending, not yet reclaimed or released", readSidecar(cwd).__pendingReclaim?.["loom-x"] !== undefined && readSidecar(cwd).__released?.["loom-x"] === undefined);

    const realDateNow = Date.now;
    Date.now = () => realDateNow() + 31 * 24 * 60 * 60 * 1000; // past PENDING_RECLAIM_MAX_AGE_MS (30 days)
    let r;
    try { r = injectSkills(cwd, "narrow-mgr6", ["some-other-skill"], "manager", false, isLive); } finally { Date.now = realDateNow; }
    check("(6) content still untouched (never a claim of 'modified')", readBody(cwd, "loom-x")?.includes("V1 BODY") === true);
    check("(6) not reclaimed", !r.claimedNames.includes("loom-x"));
    check("(6) durably records reason 'abandoned' (never 'modified')", readSidecar(cwd).__released?.["loom-x"]?.reason === "abandoned");
    check("(6) pending record is dropped, never retried again", readSidecar(cwd).__pendingReclaim?.["loom-x"] === undefined);

    const m6 = await buildMutant(
      "s6",
      `pendingWorking.delete(name);\n                // card 8b38b920: content may be byte-identical to Loom's own placement — this is Loom giving up\n                // verifying it's SAFE to reclaim (persistently tracked, or a repeatedly-failing check), never a\n                // claim that a human edited it. Keep it a distinct reason from "modified".\n                recordReleased(released, name, "abandoned");`,
      `pendingWorking.delete(name); /* MUTANT S6: recordReleased call disabled */`,
    );
    const cwdM6 = freshRepoCwd();
    fs.mkdirSync(cwdM6, { recursive: true });
    m6.injectSkills(cwdM6, "dead-mgrM6", null, "manager");
    const isLiveM6 = (sid) => sid !== "dead-mgrM6";
    m6.injectSkills(cwdM6, "narrow-mgrM6", ["some-other-skill"], "manager", false, isLiveM6);
    Date.now = () => realDateNow() + 31 * 24 * 60 * 60 * 1000;
    try { m6.injectSkills(cwdM6, "narrow-mgrM6", ["some-other-skill"], "manager", false, isLiveM6); }
    finally { Date.now = realDateNow; }
    check("(6) *** MUTANT PROOF ***: with recordReleased disabled, no durable record is written", readSidecar(cwdM6).__released?.["loom-x"] === undefined);
  }

  // =====================================================================================================
  // SECTION 7 — site #8 (per-cwd pending-reclaim cap eviction): "abandoned". Fabricate a sidecar with
  // > PENDING_RECLAIM_MAX_PER_CWD (200) real, matching, unwanted pending orphans; one call evicts the
  // oldest beyond the cap.
  // =====================================================================================================
  {
    const cwd = freshRepoCwd();
    fs.mkdirSync(cwd, { recursive: true });
    const targetDir = path.join(cwd, ".claude", "skills");
    fs.mkdirSync(targetDir, { recursive: true });
    const N = 205;
    const pending = {};
    const baseTime = Date.now() - N; // all well within PENDING_RECLAIM_MAX_AGE_MS — ascending order is what the cap-eviction sort uses, not age
    for (let i = 0; i < N; i++) {
      const name = `legacy-stale-${i}`;
      const dir = path.join(targetDir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), `LEGACY STALE ${i}`);
      const fp = fingerprintSkillDir(dir);
      pending[name] = { deadFingerprints: [fp], firstSeenAt: baseTime + i }; // ascending — i=0 is OLDEST
    }
    fs.writeFileSync(path.join(targetDir, ".loom-skills-fingerprints.json"), JSON.stringify({ __pendingReclaim: pending }));
    // None of these names exist in the store, so they can never be in `want` regardless of subset —
    // the eviction-bound loop runs with none of them reclaimed.
    injectSkills(cwd, "some-mgr7", null, "manager");
    const sidecar = readSidecar(cwd);
    const evictedCount = N - 200;
    check(`(7) exactly ${evictedCount} oldest entries evicted beyond the ${200} cap`, Object.keys(sidecar.__pendingReclaim ?? {}).length === 200);
    let allEvictedRecorded = true;
    for (let i = 0; i < evictedCount; i++) {
      if (sidecar.__released?.[`legacy-stale-${i}`]?.reason !== "abandoned") allEvictedRecorded = false;
      if (sidecar.__pendingReclaim?.[`legacy-stale-${i}`] !== undefined) allEvictedRecorded = false;
    }
    check("(7) every evicted (oldest) name durably records reason 'abandoned'", allEvictedRecorded);
    check("(7) a NON-evicted (newer) name is untouched, still pending", sidecar.__pendingReclaim?.[`legacy-stale-${N - 1}`] !== undefined && sidecar.__released?.[`legacy-stale-${N - 1}`] === undefined);

    const m7 = await buildMutant(
      "s7",
      `pendingWorking.delete(name);\n                recordReleased(released, name, "abandoned"); // card 8b38b920 — same reason as the age give-up above: capped out, not necessarily edited`,
      `pendingWorking.delete(name); /* MUTANT S7: recordReleased call disabled */`,
    );
    const cwdM7 = freshRepoCwd();
    fs.mkdirSync(cwdM7, { recursive: true });
    const targetDirM7 = path.join(cwdM7, ".claude", "skills");
    fs.mkdirSync(targetDirM7, { recursive: true });
    const pendingM7 = {};
    for (let i = 0; i < N; i++) {
      const name = `legacy-stale-${i}`;
      const dir = path.join(targetDirM7, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), `LEGACY STALE M7 ${i}`);
      const fp = m7.fingerprintSkillDir(dir);
      pendingM7[name] = { deadFingerprints: [fp], firstSeenAt: baseTime + i };
    }
    fs.writeFileSync(path.join(targetDirM7, ".loom-skills-fingerprints.json"), JSON.stringify({ __pendingReclaim: pendingM7 }));
    m7.injectSkills(cwdM7, "some-mgrM7", null, "manager");
    check("(7) *** MUTANT PROOF ***: with recordReleased disabled, no durable record is written for the evicted entries", readSidecar(cwdM7).__released?.["legacy-stale-0"] === undefined);
  }

  // =====================================================================================================
  // SECTION 8 — the re-adopt function: list, diff summary/file, the stale-fingerprint REFUSAL (never
  // auto-overwrite), the successful re-adopt, and the next-live-session re-claim bridge.
  // =====================================================================================================
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    injectSkills(cwd, "sess-a8", null, "manager");
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "loom-x", "SKILL.md"), "HAND EDITED, TO BE READOPTED");
    injectSkills(cwd, "sess-a8", null, "manager"); // releases it

    const list = await releasedSkillsAt(cwd);
    check("(8) releasedSkillsAt lists the released name", list.some((r) => r.name === "loom-x" && r.reason === "modified"));
    check("(8) releasedSkillsAt: tracked:\"untracked\" for an untracked released dir", list.some((r) => r.name === "loom-x" && r.tracked === "untracked"));

    const diff = await releasedSkillDiffSummary(cwd, "loom-x");
    check("(8) releasedSkillDiffSummary returns a summary for a released name", diff !== null && diff.reason === "modified");
    check("(8) currentFingerprint matches the real on-disk fingerprint right now", diff.currentFingerprint === fingerprintSkillDir(path.join(cwd, ".claude", "skills", "loom-x")));
    check("(8) tracked:\"untracked\" for an untracked released dir", diff.tracked === "untracked");
    check("(8) files summary includes SKILL.md, marked as differing", diff.files.some((f) => f.path === "SKILL.md" && f.differs === true));
    check("(8) releasedSkillDiffSummary for a NON-released name is null", await releasedSkillDiffSummary(cwd, "loom-y") === null);

    const fileContent = releasedSkillDiffFile(cwd, "loom-x", "SKILL.md");
    check("(8) releasedSkillDiffFile returns onDisk/store content", fileContent?.onDisk === "HAND EDITED, TO BE READOPTED" && typeof fileContent.store === "string");
    check("(8) releasedSkillDiffFile for an untracked path is null", releasedSkillDiffFile(cwd, "loom-x", "../../etc/passwd") === null);

    // Never auto-overwrite: a STALE fingerprint (as if the disk changed since the diff was reviewed) is
    // refused, and the on-disk hand-edited content is left completely untouched.
    const refused = await reAdoptReleasedSkill(cwd, "loom-x", "0".repeat(64), false);
    check("(8) a stale/wrong fingerprint is REFUSED", refused.ok === false && refused.code === "fingerprint-mismatch");
    check("(8) the refusal leaves the on-disk copy COMPLETELY untouched", readBody(cwd, "loom-x") === "HAND EDITED, TO BE READOPTED");
    check("(8) the refusal does NOT clear the released record", readSidecar(cwd).__released?.["loom-x"]?.reason === "modified");

    // The real re-adopt: pass the CURRENT (correct) fingerprint.
    const ok = await reAdoptReleasedSkill(cwd, "loom-x", diff.currentFingerprint, false);
    check("(8) re-adopt with the correct fingerprint succeeds", ok.ok === true);
    check("(8) disk now reflects the CURRENT STORE content, not the stale hand-edit", readBody(cwd, "loom-x")?.includes("V1 BODY") === true);
    const afterSidecar = readSidecar(cwd);
    check("(8) the released record is cleared", afterSidecar.__released?.["loom-x"] === undefined);
    check("(8) a '__readopted' marker is now recorded, awaiting a live claimant", afterSidecar.__readopted?.["loom-x"] !== undefined);

    // A re-adopt attempted a SECOND time (nothing released anymore) must refuse as "not-released".
    const second = await reAdoptReleasedSkill(cwd, "loom-x", diff.currentFingerprint, false);
    check("(8) a second re-adopt of an already-resolved name refuses as not-released", second.ok === false && second.code === "not-released");

    // The bridge: a FRESH live session (no manifest claim at all) must now claim the re-adopted name —
    // without this, L1241's "unclaimed = the repo's own" skip would silently re-freeze it forever.
    const rClaim = injectSkills(cwd, "fresh-sess-8", null, "manager", false, () => true);
    check("(8) *** BRIDGE PROVEN ***: a fresh live session claims the re-adopted name", rClaim.claimedNames.includes("loom-x"));
    check("(8) the '__readopted' marker clears once claimed", readSidecar(cwd).__readopted?.["loom-x"] === undefined);
  }

  // =====================================================================================================
  // SECTION 9 — CR fix round (Code Review 202eb7be), item 1 (CRITICAL): a re-adopted name must NOT bypass
  // the overwrite fingerprint gate. Repro from the review: injectSkills -> edit -> release -> reAdopt
  // (correct fp) -> edit 2 -> injectSkills(fresh session) used to silently lose edit 2, with the window
  // unbounded (nothing claims the name between the re-adopt and the next live session).
  // =====================================================================================================
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    injectSkills(cwd, "sess-a9", null, "manager");
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "loom-x", "SKILL.md"), "EDIT 1 — TO BE RELEASED");
    injectSkills(cwd, "sess-a9", null, "manager"); // releases it ("modified")
    const diff9 = await releasedSkillDiffSummary(cwd, "loom-x");
    const readopt9 = await reAdoptReleasedSkill(cwd, "loom-x", diff9.currentFingerprint, false);
    check("(9) precondition: re-adopt succeeds", readopt9.ok === true);
    check("(9) precondition: disk now reflects the current store copy", readBody(cwd, "loom-x")?.includes("V1 BODY") === true);
    check("(9) precondition: '__readopted' is set, no live claimant yet", readSidecar(cwd).__readopted?.["loom-x"] !== undefined);

    // Edit 2 — a SECOND hand edit, made AFTER the re-adopt, before any live session claims the name.
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "loom-x", "SKILL.md"), "EDIT 2 — MADE AFTER READOPT");

    // A FRESH live session's injectSkills call must detect edit 2 and NOT overwrite it.
    const r9 = injectSkills(cwd, "fresh-sess-9", null, "manager", false, () => true);
    check("(9) *** CRITICAL FIX PROVEN ***: edit 2 survives — the fresh session does NOT overwrite it", readBody(cwd, "loom-x") === "EDIT 2 — MADE AFTER READOPT");
    check("(9) not claimed by the fresh session (content doesn't match)", !r9.claimedNames.includes("loom-x"));
    check("(9) the name is released again, reason 'modified'", readSidecar(cwd).__released?.["loom-x"]?.reason === "modified");
    check("(9) the stale '__readopted' marker is dropped once the mismatch is detected", readSidecar(cwd).__readopted?.["loom-x"] === undefined);

    // API-keeping mutant: drop `readopted.has(name)` from the fingerprint-match gate's OR (keep the
    // surrounding function and every other term present) — proves this ONE added term is load-bearing.
    const m9 = await buildMutant(
      "s9",
      `if (exists && (myPrev.includes(name) || otherClaimed.has(name) || readopted.has(name))) {`,
      `if (exists && (myPrev.includes(name) || otherClaimed.has(name) /* MUTANT S9: readopted.has(name) dropped */)) {`,
    );
    const cwdM9 = freshRepoCwd();
    initRepo(cwdM9);
    m9.injectSkills(cwdM9, "sess-a9-m9", null, "manager");
    fs.writeFileSync(path.join(cwdM9, ".claude", "skills", "loom-x", "SKILL.md"), "EDIT 1 (M9)");
    m9.injectSkills(cwdM9, "sess-a9-m9", null, "manager");
    const diffM9 = await m9.releasedSkillDiffSummary(cwdM9, "loom-x");
    await m9.reAdoptReleasedSkill(cwdM9, "loom-x", diffM9.currentFingerprint, false);
    fs.writeFileSync(path.join(cwdM9, ".claude", "skills", "loom-x", "SKILL.md"), "EDIT 2 (M9) — SHOULD SURVIVE BUT WON'T UNDER THE MUTANT");
    m9.injectSkills(cwdM9, "fresh-sess-9-m9", null, "manager", false, () => true);
    check("(9) *** MUTANT PROOF ***: with readopted.has(name) dropped from the gate, edit 2 IS silently overwritten",
      fs.readFileSync(path.join(cwdM9, ".claude", "skills", "loom-x", "SKILL.md"), "utf8").includes("V1 BODY"));
  }

  // =====================================================================================================
  // SECTION 10 — CR fix round, item 4 (LEAD DECISION): readopt REFUSES when the released dir has any
  // git-tracked file, and `tracked: "tracked"` is exposed on the list/diff so a human sees WHY.
  // =====================================================================================================
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    injectSkills(cwd, "sess-a10", null, "manager");
    const skillDirPath = path.join(cwd, ".claude", "skills", "loom-x");
    fs.writeFileSync(path.join(skillDirPath, "SKILL.md"), "HAND EDITED, THEN GIT-ADDED");
    // -f: injectSkills already added "/.claude/skills/loom-x" to .git/info/exclude (hideFromGit) by this
    // point, so a plain `git add` would be refused as ignored — force it, exactly as a real force-add
    // (the scenario this refusal protects against) would.
    execFileSync("git", ["add", "-f", path.join(skillDirPath, "SKILL.md")], { cwd, env: GIT_ENV });
    execFileSync("git", ["commit", "-m", "track the hand edit"], { cwd, env: GIT_ENV });
    injectSkills(cwd, "sess-a10", null, "manager"); // releases it ("modified")

    const list10 = await releasedSkillsAt(cwd);
    check("(10) releasedSkillsAt exposes tracked:\"tracked\" for the git-tracked released dir", list10.some((r) => r.name === "loom-x" && r.tracked === "tracked"));

    const diff10 = await releasedSkillDiffSummary(cwd, "loom-x");
    check("(10) releasedSkillDiffSummary exposes tracked:\"tracked\"", diff10.tracked === "tracked");

    const refuse10 = await reAdoptReleasedSkill(cwd, "loom-x", diff10.currentFingerprint, false);
    check("(10) readopt REFUSES a git-tracked released dir", refuse10.ok === false && refuse10.code === "tracked");
    check("(10) the refusal leaves disk untouched", readBody(cwd, "loom-x") === "HAND EDITED, THEN GIT-ADDED");
    check("(10) the refusal does NOT clear the released record", readSidecar(cwd).__released?.["loom-x"] !== undefined);

    // CONTROL: an UNTRACKED released dir still readopts fine — proves the tracked check isn't just
    // refusing everything.
    const cwdControl = freshRepoCwd();
    initRepo(cwdControl);
    injectSkills(cwdControl, "sess-a10c", null, "manager");
    fs.writeFileSync(path.join(cwdControl, ".claude", "skills", "loom-x", "SKILL.md"), "HAND EDITED, NEVER GIT-ADDED");
    injectSkills(cwdControl, "sess-a10c", null, "manager");
    const diffControl = await releasedSkillDiffSummary(cwdControl, "loom-x");
    check("(10) CONTROL: an untracked released dir reports tracked:\"untracked\"", diffControl.tracked === "untracked");
    const okControl = await reAdoptReleasedSkill(cwdControl, "loom-x", diffControl.currentFingerprint, false);
    check("(10) CONTROL: readopt succeeds for the untracked case", okControl.ok === true);

    // API-keeping mutant: force the tracked-check's real git read to always report "not tracked" (the
    // function and its call sites stay present) — proves the refusal above is actually gated on this
    // check's real answer, not some other mechanism.
    const m10 = await buildMutant(
      "s10",
      `return out.trim() !== "" ? "tracked" : "untracked";`,
      `return "untracked"; /* MUTANT S10: gitTrackedState always reports untracked */`,
    );
    const cwdM10 = freshRepoCwd();
    initRepo(cwdM10);
    m10.injectSkills(cwdM10, "sess-a10-m10", null, "manager");
    const skillDirPathM10 = path.join(cwdM10, ".claude", "skills", "loom-x");
    fs.writeFileSync(path.join(skillDirPathM10, "SKILL.md"), "HAND EDITED, THEN GIT-ADDED (M10)");
    execFileSync("git", ["add", "-f", path.join(skillDirPathM10, "SKILL.md")], { cwd: cwdM10, env: GIT_ENV });
    execFileSync("git", ["commit", "-m", "track the hand edit (m10)"], { cwd: cwdM10, env: GIT_ENV });
    m10.injectSkills(cwdM10, "sess-a10-m10", null, "manager");
    const diffM10 = await m10.releasedSkillDiffSummary(cwdM10, "loom-x");
    const refuseM10 = await m10.reAdoptReleasedSkill(cwdM10, "loom-x", diffM10.currentFingerprint, false);
    check("(10) *** MUTANT PROOF ***: with the tracked check forced false, a git-tracked released dir is WRONGLY readopted", refuseM10.ok === true);
  }

  // =====================================================================================================
  // SECTION 11 — CR fix round 2, item 3 (MINOR, tri-state): a tracked-check that could not be verified
  // either way reports "unknown", never a false "tracked" or "untracked" — and readopt REFUSES it too,
  // with its own honest code/message. Same FILE-shaped `.git` (no trustedMainRoot) fail-closed shape
  // skills-dead-claim-reclaim-shared-cwd.mjs's own section 12b exercises for the sibling dead-claim check.
  // =====================================================================================================
  {
    const cwd = freshRepoCwd();
    fs.writeFileSync(path.join(cwd, ".git"), "gitdir: ../nonexistent-main/.git\n"); // FILE-shaped .git; canonicalGit fail-closed refuses with no trustedMainRoot
    injectSkills(cwd, "sess-a11", null, "manager");
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "loom-x", "SKILL.md"), "HAND EDITED, UNVERIFIABLE TRACKED STATE");
    injectSkills(cwd, "sess-a11", null, "manager"); // releases it ("modified")

    const list11 = await releasedSkillsAt(cwd);
    check("(11) releasedSkillsAt exposes tracked:\"unknown\" when the check itself fails", list11.some((r) => r.name === "loom-x" && r.tracked === "unknown"));

    const diff11 = await releasedSkillDiffSummary(cwd, "loom-x");
    check("(11) releasedSkillDiffSummary exposes tracked:\"unknown\"", diff11.tracked === "unknown");

    const refuse11 = await reAdoptReleasedSkill(cwd, "loom-x", diff11.currentFingerprint, false);
    check("(11) readopt REFUSES when the tracked-check is unverifiable", refuse11.ok === false && refuse11.code === "track-unknown");
    check("(11) the refusal message is honest, never a false 'tracked' claim", refuse11.message.includes("could not verify"));
    check("(11) the refusal leaves disk untouched", readBody(cwd, "loom-x") === "HAND EDITED, UNVERIFIABLE TRACKED STATE");
    check("(11) the refusal does NOT clear the released record", readSidecar(cwd).__released?.["loom-x"] !== undefined);

    // API-keeping mutant: force the catch branch to report "untracked" instead of "unknown" (keeps the
    // function and every call site present) — proves the honest unknown-state reporting + refusal above
    // are actually gated on this exact return, not some other mechanism.
    const m11 = await buildMutant(
      "s11",
      `return "unknown";`,
      `return "untracked"; /* MUTANT S11: a failed/unverifiable tracked-check wrongly reported as untracked */`,
    );
    const cwdM11 = freshRepoCwd();
    fs.writeFileSync(path.join(cwdM11, ".git"), "gitdir: ../nonexistent-main/.git\n");
    m11.injectSkills(cwdM11, "sess-a11-m11", null, "manager");
    fs.writeFileSync(path.join(cwdM11, ".claude", "skills", "loom-x", "SKILL.md"), "HAND EDITED (M11)");
    m11.injectSkills(cwdM11, "sess-a11-m11", null, "manager");
    const diffM11 = await m11.releasedSkillDiffSummary(cwdM11, "loom-x");
    const refuseM11 = await m11.reAdoptReleasedSkill(cwdM11, "loom-x", diffM11.currentFingerprint, false);
    check("(11) *** MUTANT PROOF ***: with the failed check wrongly reported as untracked, an unverifiable released dir is WRONGLY readopted", refuseM11.ok === true);
  }

  // =====================================================================================================
  // SECTION 12 — CR fix round 2, item 5 (INVESTIGATE+FIX): the per-name dir itself (`.claude/skills/<name>`)
  // can be a symlink/junction escaping `cwd` even though `.claude`/`.claude/skills` above it are real —
  // `resolveSkillsTargetDir` never checked this. All three released/readopt readers/writer must refuse it.
  // =====================================================================================================
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    injectSkills(cwd, "sess-a12", null, "manager");
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "loom-x", "SKILL.md"), "HAND EDITED, TO BE RELEASED THEN ESCAPED");
    injectSkills(cwd, "sess-a12", null, "manager"); // releases it ("modified") — a real sidecar record now exists for "loom-x"

    // Replace the on-disk per-name dir with a junction escaping `cwd` — the released record is untouched
    // by this; only `.claude/skills/loom-x` itself now points somewhere else.
    const escapedTarget = mkdtempManaged("loom-8b38b920-s12-escaped-");
    fs.mkdirSync(path.join(escapedTarget, "loom-x"), { recursive: true });
    const escapedBody = "CONTENT AT THE ESCAPED TARGET — must never be read or overwritten through the per-name junction";
    fs.writeFileSync(path.join(escapedTarget, "loom-x", "SKILL.md"), escapedBody);
    const perNameDir = path.join(cwd, ".claude", "skills", "loom-x");
    fs.rmSync(perNameDir, { recursive: true, force: true });
    fs.symlinkSync(path.join(escapedTarget, "loom-x"), perNameDir, process.platform === "win32" ? "junction" : "dir");

    const diff12 = await releasedSkillDiffSummary(cwd, "loom-x");
    check("(12) releasedSkillDiffSummary refuses a per-name junction escape (null)", diff12 === null);

    const file12 = releasedSkillDiffFile(cwd, "loom-x", "SKILL.md");
    check("(12) releasedSkillDiffFile refuses a per-name junction escape (null)", file12 === null);

    const refuse12 = await reAdoptReleasedSkill(cwd, "loom-x", "0".repeat(64), false);
    check("(12) reAdoptReleasedSkill refuses a per-name junction escape", refuse12.ok === false && refuse12.code === "copy-failed");
    check("(12) the escaped target's content is untouched", fs.readFileSync(path.join(escapedTarget, "loom-x", "SKILL.md"), "utf8") === escapedBody);

    // API-keeping mutant: force perSkillDirEscapes to always report "not escaped" (the function and every
    // call site stay present) — proves the three refusals above are actually gated on this exact check.
    const m12 = await buildMutant(
      "s12",
      `function perSkillDirEscapes(cwd, dest) {\n    return escapedAncestor(cwd, [dest]) !== null;\n}`,
      `function perSkillDirEscapes(cwd, dest) {\n    return false; /* MUTANT S12: per-name escape check disabled */\n}`,
    );
    const diffM12 = await m12.releasedSkillDiffSummary(cwd, "loom-x");
    check("(12) *** MUTANT PROOF ***: with the per-name escape check disabled, the diff summary WRONGLY reads through the junction",
      diffM12 !== null && diffM12.files.some((f) => f.path === "SKILL.md" && f.differs === true));
  }

  // =====================================================================================================
  // SECTION 13 — manager-directed regression (3rd Code Review round): FORCE the TOCTOU interleave
  // deterministically, rather than relying on "the await moved, proven by inspection" — the exact claim
  // the round-1 author believed safe and shipped broken. A real git subprocess resolves far too fast to
  // race reliably, so this builds a mutant that replaces gitTrackedState's one real await with a
  // controllable, externally-resolved gate keyed by the `dest` path (so two concurrent readopts of
  // different names can be driven independently) — same buildMutant text-substitution idiom this file
  // already uses, just substituting a stub body rather than disabling a guard. The function's PUBLIC
  // shape (name, params, return) is unchanged; only its internal implementation is swapped. A second
  // skill, "loom-y", is seeded in the global store for the concurrent/cross-name sub-cases below.
  // =====================================================================================================
  {
    fs.mkdirSync(path.join(skillsDir, "loom-y"), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "loom-y", "SKILL.md"), "---\nname: loom-y\ndescription: v1\n---\nLOOM-Y V1 BODY");

    const GATE_OLD = `async function gitTrackedState(target) {\n    const repoRoot = innermostGitRepoRoot(target);\n    if (!repoRoot)\n        return "untracked";\n    // \`target\` itself can BE \`repoRoot\` (a released dir that is itself a nested repo's root, e.g. a\n    // vendored/submodule-like skill) — \`path.relative\` then yields \`""\`, and git rejects an empty pathspec\n    // outright ("empty string is not a valid pathspec"). \`"."\` means the same thing git DOES accept: every\n    // tracked file at/under \`repoRoot\`, which here is exactly \`target\`.\n    const relPath = path.relative(repoRoot, target).split(path.sep).join("/");\n    const pathspec = relPath === "" ? "." : relPath;\n    try {\n        const git = canonicalGit(repoRoot, UNTRACKED_CHECK_TIMEOUT_MS);\n        const out = await withTimeout(git.raw(["ls-files", "--", pathspec]), UNTRACKED_CHECK_TIMEOUT_MS, "git ls-files (released-skill tracked check)");\n        return out.trim() !== "" ? "tracked" : "untracked";\n    }\n    catch (e) {\n        console.log(\`[skills] tracked-check failed for \${target} (treating as unknown, refusing a readopt until it can be verified): \${e?.message ?? e}\`);\n        return "unknown";\n    }\n}`;
    const GATE_NEW = `export const __s13Gates = new Map();\nexport function __setS13Gate(key, p) { __s13Gates.set(key, p); }\nasync function gitTrackedState(target) {\n    const gate = __s13Gates.get(target);\n    if (gate) {\n        await gate;\n    }\n    return "untracked";\n}`;
    // card 8b38b920 fix round 3 (item 1): the await is now ALSO followed by a synchronous re-check of
    // both escape guards (`resolveSkillsTargetDir`/`perSkillDirEscapes`), before the sidecar is touched —
    // ORDER_OLD/ORDER_NEW below just relocate that whole await+recheck block, leaving its own internal
    // order (and every check's text) exactly as the real fixed code has it.
    const ORDER_OLD = `    const tracked = await gitTrackedState(dest);\n    // card 8b38b920 fix round 3 (minor): \`resolved\`/\`perSkillDirEscapes\` above only prove the path was safe\n    // BEFORE the await — the git subprocess can take up to UNTRACKED_CHECK_TIMEOUT_MS, long enough for\n    // something to swap \`.claude\`/\`.claude/skills\`/the per-name dir for a junction in the meantime (the\n    // \`gitTrackedState\` answer above is itself a pre-await fact for the same reason — see this function's\n    // own doc). Both checks are cheap and synchronous (\`fs.realpathSync\`), so re-running them here, before\n    // the sidecar is ever read, costs nothing and closes that window with the SAME codes/messages as the\n    // pre-await refusals.\n    if (resolveSkillsTargetDir(cwd, "readopt") === null) {\n        return { ok: false, code: "copy-failed", message: "this project's skills directory could not be safely resolved (a symlink/junction escapes its working directory) — refusing" };\n    }\n    if (perSkillDirEscapes(cwd, dest)) {\n        return { ok: false, code: "copy-failed", message: \`'\${name}' at this project is itself a symlink/junction escaping its working directory — refusing\` };\n    }\n    const fingerprintsPath = path.join(targetDir, FINGERPRINTS_FILE);\n    const fingerprintsFile = readFingerprintsFile(fingerprintsPath);\n    if (!fingerprintsFile.released.has(name)) {\n        return { ok: false, code: "not-released", message: \`'\${name}' is not currently released from Loom management at this project\` };\n    }\n    const currentFp = fingerprintSkillDir(dest);\n    if (currentFp !== expectedFingerprint) {\n        return { ok: false, code: "fingerprint-mismatch", message: "the on-disk copy has changed since you reviewed it — re-open the diff and try again" };\n    }`;
    const ORDER_NEW = `    const fingerprintsPath = path.join(targetDir, FINGERPRINTS_FILE);\n    const fingerprintsFile = readFingerprintsFile(fingerprintsPath);\n    if (!fingerprintsFile.released.has(name)) {\n        return { ok: false, code: "not-released", message: \`'\${name}' is not currently released from Loom management at this project\` };\n    }\n    const currentFp = fingerprintSkillDir(dest);\n    if (currentFp !== expectedFingerprint) {\n        return { ok: false, code: "fingerprint-mismatch", message: "the on-disk copy has changed since you reviewed it — re-open the diff and try again" };\n    }\n    const tracked = await gitTrackedState(dest); /* MUTANT S13-ORDER: await moved back after the sidecar read+fingerprint check, reproducing the round-1 TOCTOU bug */\n    // card 8b38b920 fix round 3 (minor): \`resolved\`/\`perSkillDirEscapes\` above only prove the path was safe\n    // BEFORE the await — the git subprocess can take up to UNTRACKED_CHECK_TIMEOUT_MS, long enough for\n    // something to swap \`.claude\`/\`.claude/skills\`/the per-name dir for a junction in the meantime (the\n    // \`gitTrackedState\` answer above is itself a pre-await fact for the same reason — see this function's\n    // own doc). Both checks are cheap and synchronous (\`fs.realpathSync\`), so re-running them here, before\n    // the sidecar is ever read, costs nothing and closes that window with the SAME codes/messages as the\n    // pre-await refusals.\n    if (resolveSkillsTargetDir(cwd, "readopt") === null) {\n        return { ok: false, code: "copy-failed", message: "this project's skills directory could not be safely resolved (a symlink/junction escapes its working directory) — refusing" };\n    }\n    if (perSkillDirEscapes(cwd, dest)) {\n        return { ok: false, code: "copy-failed", message: \`'\${name}' at this project is itself a symlink/junction escaping its working directory — refusing\` };\n    }`;

    // m13: the REAL (fixed, round-2-ordered) reAdoptReleasedSkill, with ONLY the tracked-check's real git
    // call replaced by the controllable gate — used for the three PASS sub-cases below (the fixed code
    // must survive every interleave).
    const m13 = await buildMutant("s13-gate", GATE_OLD, GATE_NEW);

    // --- Sub-case (A)+(B): a single suspended readopt racing a hand edit of ITS OWN name, and a
    // concurrent injectSkills release of a DIFFERENT name, during the SAME suspension window. ---
    const cwd13 = freshRepoCwd();
    initRepo(cwd13);
    m13.injectSkills(cwd13, "sess-s13-setup", null, "manager"); // places loom-x AND loom-y
    fs.writeFileSync(path.join(cwd13, ".claude", "skills", "loom-x", "SKILL.md"), "S13 PRE-EDIT — TO BE RELEASED");
    m13.injectSkills(cwd13, "sess-s13-setup", null, "manager"); // releases loom-x ("modified")
    const destX13 = path.join(cwd13, ".claude", "skills", "loom-x");
    const expectedFpX13 = fingerprintSkillDir(destX13);
    // loom-y is hand-edited on disk now, but the injectSkills call that DISCOVERS it and records
    // __released.loom-y happens DURING the suspension window below, not before it.
    fs.writeFileSync(path.join(cwd13, ".claude", "skills", "loom-y", "SKILL.md"), "S13 LOOM-Y PRE-EDIT");

    let resolveGateX13;
    m13.__setS13Gate(destX13, new Promise((r) => { resolveGateX13 = r; }));
    const pX13 = m13.reAdoptReleasedSkill(cwd13, "loom-x", expectedFpX13, false); // NOT awaited — suspends inside gitTrackedState's own gate

    // --- synchronously, DURING pX13's suspension ---
    fs.writeFileSync(path.join(destX13, "SKILL.md"), "S13 EDIT DURING SUSPENSION — MUST SURVIVE");
    m13.injectSkills(cwd13, "sess-s13-setup", null, "manager"); // (B): discovers loom-y's hand edit, records __released.loom-y = "modified"
    // --- end synchronous window ---

    resolveGateX13();
    const resX13 = await pX13;

    check("(13) (A) a hand edit made during the suspension is detected as fingerprint-mismatch, never silently overwritten", resX13.ok === false && resX13.code === "fingerprint-mismatch");
    check("(13) (A) the edit made during the suspension survives on disk", fs.readFileSync(path.join(destX13, "SKILL.md"), "utf8") === "S13 EDIT DURING SUSPENSION — MUST SURVIVE");
    const sidecarAfter13 = readSidecar(cwd13);
    check("(13) (B) loom-y's concurrently-recorded release record survives the eventual write-back", sidecarAfter13.__released?.["loom-y"]?.reason === "modified");
    check("(13) (B) loom-x's own released record is untouched (the refused readopt never cleared it)", sidecarAfter13.__released?.["loom-x"]?.reason === "modified");

    // --- Mutant proof: move the tracked-check await back BETWEEN the sidecar read and the write (the
    // round-1 shape) — the SAME scenario above must now flip WRONG on both (A) and (B). ---
    const m13orderBase = await buildMutant("s13-order-base", GATE_OLD, GATE_NEW);
    void m13orderBase; // only used to seed the file buildMutant just wrote; chain a second edit onto it
    const m13orderPath = mutantFiles[mutantFiles.length - 1];
    const m13orderSrc = fs.readFileSync(m13orderPath, "utf8");
    const m13orderOcc = m13orderSrc.split(ORDER_OLD).length - 1;
    if (m13orderOcc !== 1) throw new Error(`s13-order: expected exactly 1 occurrence of ORDER_OLD, found ${m13orderOcc}`);
    fs.writeFileSync(m13orderPath, m13orderSrc.replace(ORDER_OLD, ORDER_NEW));
    const m13order = await import(`file://${m13orderPath.replace(/\\/g, "/")}?v=${Date.now()}`); // cache-bust: same path, now-mutated-twice content

    const cwd13m = freshRepoCwd();
    initRepo(cwd13m);
    m13order.injectSkills(cwd13m, "sess-s13m-setup", null, "manager");
    fs.writeFileSync(path.join(cwd13m, ".claude", "skills", "loom-x", "SKILL.md"), "S13M PRE-EDIT — TO BE RELEASED");
    m13order.injectSkills(cwd13m, "sess-s13m-setup", null, "manager");
    const destXm = path.join(cwd13m, ".claude", "skills", "loom-x");
    const expectedFpXm = fingerprintSkillDir(destXm);
    fs.writeFileSync(path.join(cwd13m, ".claude", "skills", "loom-y", "SKILL.md"), "S13M LOOM-Y PRE-EDIT");

    let resolveGateXm;
    m13order.__setS13Gate(destXm, new Promise((r) => { resolveGateXm = r; }));
    const pXm = m13order.reAdoptReleasedSkill(cwd13m, "loom-x", expectedFpXm, false);
    fs.writeFileSync(path.join(destXm, "SKILL.md"), "S13M EDIT DURING SUSPENSION — SHOULD SURVIVE BUT WON'T UNDER THE MUTANT");
    m13order.injectSkills(cwd13m, "sess-s13m-setup", null, "manager");
    resolveGateXm();
    const resXm = await pXm;

    check("(13) *** MUTANT PROOF (A) ***: with the await moved back after the sidecar read, the mid-window edit is WRONGLY overwritten instead of refused", resXm.ok === true);
    check("(13) *** MUTANT PROOF (A), content ***: disk now shows the STORE content, not the mid-window edit", fs.readFileSync(path.join(destXm, "SKILL.md"), "utf8").includes("V1 BODY"));
    const sidecarAfter13m = readSidecar(cwd13m);
    check("(13) *** MUTANT PROOF (B) ***: with the stale pre-await snapshot written back, loom-y's concurrently-recorded release is LOST", sidecarAfter13m.__released?.["loom-y"] === undefined);

    // --- Sub-case: two concurrent readopts of DIFFERENT names, both suspended simultaneously, must not
    // clobber each other's __readopted/__lastPlaced on write-back (the FIXED code, m13). ---
    const cwd13c = freshRepoCwd();
    initRepo(cwd13c);
    m13.injectSkills(cwd13c, "sess-s13c-setup", null, "manager");
    fs.writeFileSync(path.join(cwd13c, ".claude", "skills", "loom-x", "SKILL.md"), "S13C LOOM-X PRE-EDIT");
    fs.writeFileSync(path.join(cwd13c, ".claude", "skills", "loom-y", "SKILL.md"), "S13C LOOM-Y PRE-EDIT");
    m13.injectSkills(cwd13c, "sess-s13c-setup", null, "manager"); // releases BOTH loom-x and loom-y ("modified")
    const destXc = path.join(cwd13c, ".claude", "skills", "loom-x");
    const destYc = path.join(cwd13c, ".claude", "skills", "loom-y");
    const expectedFpXc = fingerprintSkillDir(destXc);
    const expectedFpYc = fingerprintSkillDir(destYc);

    let resolveGateXc, resolveGateYc;
    m13.__setS13Gate(destXc, new Promise((r) => { resolveGateXc = r; }));
    m13.__setS13Gate(destYc, new Promise((r) => { resolveGateYc = r; }));
    const pXc = m13.reAdoptReleasedSkill(cwd13c, "loom-x", expectedFpXc, false);
    const pYc = m13.reAdoptReleasedSkill(cwd13c, "loom-y", expectedFpYc, false); // both now suspended simultaneously
    resolveGateXc();
    resolveGateYc();
    const [resXc, resYc] = await Promise.all([pXc, pYc]);

    check("(13) concurrent readopt of loom-x succeeds", resXc.ok === true);
    check("(13) concurrent readopt of loom-y succeeds", resYc.ok === true);
    const sidecarAfterC = readSidecar(cwd13c);
    check("(13) *** CONCURRENT READOPTS DON'T CLOBBER *** loom-x's __readopted/__lastPlaced survive loom-y's own write-back", sidecarAfterC.__readopted?.["loom-x"] !== undefined && sidecarAfterC.__lastPlaced?.["loom-x"] !== undefined);
    check("(13) *** CONCURRENT READOPTS DON'T CLOBBER *** loom-y's __readopted/__lastPlaced survive loom-x's own write-back", sidecarAfterC.__readopted?.["loom-y"] !== undefined && sidecarAfterC.__lastPlaced?.["loom-y"] !== undefined);
  }

  // =====================================================================================================
  // SECTION 14 — manager-directed regression (3rd Code Review round): batchGitTrackedStates' nested-repo
  // fallback (a name whose own innermost repo root diverges from the shared one still gets an individual
  // gitTrackedState check) had no direct test. A nested `.git` boundary makes the OUTER repo's own `git
  // ls-files` blind past it entirely (git treats a subdirectory with its own `.git` as a submodule/
  // gitlink boundary, never descending into it) — so without the fallback, a name like this ALWAYS reads
  // as untracked from the outer batch alone, regardless of what the nested repo itself actually tracks.
  // =====================================================================================================
  {
    const cwd = freshRepoCwd();
    initRepo(cwd); // the OUTER repo — this is `sharedRepoRoot` for batchGitTrackedStates
    injectSkills(cwd, "sess-s14", null, "manager");
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "loom-x", "SKILL.md"), "S14 HAND EDITED, TO BE RELEASED");
    injectSkills(cwd, "sess-s14", null, "manager"); // releases loom-x ("modified")

    // Make the per-name dir its OWN, SEPARATE git repo — a different `innermostGitRepoRoot` than `cwd`'s.
    const loomXDir = path.join(cwd, ".claude", "skills", "loom-x");
    initRepo(loomXDir);
    execFileSync("git", ["add", "SKILL.md"], { cwd: loomXDir, env: GIT_ENV });
    execFileSync("git", ["commit", "-q", "-m", "track inside the nested repo"], { cwd: loomXDir, env: GIT_ENV });

    const list14 = await releasedSkillsAt(cwd);
    check("(14) the nested-repo fallback correctly reports tracked:\"tracked\" (the OUTER repo alone can't see past the nested .git boundary)",
      list14.some((r) => r.name === "loom-x" && r.tracked === "tracked"));

    // API-keeping mutant: drop the fallback — a diverging name is left at whatever the OUTER batch alone
    // would say (never individually re-checked). Proves the fallback is load-bearing, not redundant.
    const m14 = await buildMutant(
      "s14",
      `    for (const name of individual)\n        out.set(name, await gitTrackedState(path.join(targetDir, name)));`,
      `    for (const name of individual)\n        out.set(name, "untracked"); /* MUTANT S14: nested-repo fallback disabled */`,
    );
    const list14m = await m14.releasedSkillsAt(cwd);
    check("(14) *** MUTANT PROOF ***: with the fallback disabled, the nested-repo-tracked name is WRONGLY reported untracked",
      list14m.some((r) => r.name === "loom-x" && r.tracked === "untracked"));
  }

  // =====================================================================================================
  // SECTION 15 — manager-directed regression (post-item-1-fix follow-up): behavioural proof that the
  // POST-await escape re-check (fix round 3, item 1) is actually load-bearing, not just present. Reuses
  // section 13's gate-stub idea: suspend reAdoptReleasedSkill inside gitTrackedState's own controllable
  // gate, and DURING that suspension, swap `.claude/skills` (case A) or `.claude` itself (case B) for a
  // REAL junction to an outside dir seeded with matching content — so the fingerprint/tracked/released
  // checks would all pass if the escape check didn't exist. The pre-await checks (which ran before the
  // swap, when nothing had escaped yet) can never catch this; only a check re-run AFTER the await can.
  // =====================================================================================================
  {
    const GATE_OLD = `async function gitTrackedState(target) {\n    const repoRoot = innermostGitRepoRoot(target);\n    if (!repoRoot)\n        return "untracked";\n    // \`target\` itself can BE \`repoRoot\` (a released dir that is itself a nested repo's root, e.g. a\n    // vendored/submodule-like skill) — \`path.relative\` then yields \`""\`, and git rejects an empty pathspec\n    // outright ("empty string is not a valid pathspec"). \`"."\` means the same thing git DOES accept: every\n    // tracked file at/under \`repoRoot\`, which here is exactly \`target\`.\n    const relPath = path.relative(repoRoot, target).split(path.sep).join("/");\n    const pathspec = relPath === "" ? "." : relPath;\n    try {\n        const git = canonicalGit(repoRoot, UNTRACKED_CHECK_TIMEOUT_MS);\n        const out = await withTimeout(git.raw(["ls-files", "--", pathspec]), UNTRACKED_CHECK_TIMEOUT_MS, "git ls-files (released-skill tracked check)");\n        return out.trim() !== "" ? "tracked" : "untracked";\n    }\n    catch (e) {\n        console.log(\`[skills] tracked-check failed for \${target} (treating as unknown, refusing a readopt until it can be verified): \${e?.message ?? e}\`);\n        return "unknown";\n    }\n}`;
    const GATE_NEW = `export const __s15Gates = new Map();\nexport function __setS13Gate(key, p) { __s15Gates.set(key, p); }\nasync function gitTrackedState(target) {\n    const gate = __s15Gates.get(target);\n    if (gate) {\n        await gate;\n    }\n    return "untracked";\n}`;
    // The post-await recheck block itself — comment + both `if` guards — immediately after the (unmoved)
    // `const tracked = await gitTrackedState(dest);` line. Removing ONLY this (keeping the pre-await
    // checks and the TOCTOU-correct await ordering untouched) isolates the proof to this one addition.
    const RECHECK_OLD = `\n    // card 8b38b920 fix round 3 (minor): \`resolved\`/\`perSkillDirEscapes\` above only prove the path was safe\n    // BEFORE the await — the git subprocess can take up to UNTRACKED_CHECK_TIMEOUT_MS, long enough for\n    // something to swap \`.claude\`/\`.claude/skills\`/the per-name dir for a junction in the meantime (the\n    // \`gitTrackedState\` answer above is itself a pre-await fact for the same reason — see this function's\n    // own doc). Both checks are cheap and synchronous (\`fs.realpathSync\`), so re-running them here, before\n    // the sidecar is ever read, costs nothing and closes that window with the SAME codes/messages as the\n    // pre-await refusals.\n    if (resolveSkillsTargetDir(cwd, "readopt") === null) {\n        return { ok: false, code: "copy-failed", message: "this project's skills directory could not be safely resolved (a symlink/junction escapes its working directory) — refusing" };\n    }\n    if (perSkillDirEscapes(cwd, dest)) {\n        return { ok: false, code: "copy-failed", message: \`'\${name}' at this project is itself a symlink/junction escaping its working directory — refusing\` };\n    }\n    `;
    const RECHECK_NEW = `\n    /* MUTANT S15: post-await escape recheck removed — pre-await checks and await ordering untouched */\n    `;

    async function buildGoodMutant(label) { return buildMutant(label, GATE_OLD, GATE_NEW); }
    async function buildNoRecheckMutant(label) {
      await buildMutant(label, GATE_OLD, GATE_NEW); // seeds mutantFiles with the gate-stubbed file
      const mutantPath = mutantFiles[mutantFiles.length - 1];
      const mutantSrc = fs.readFileSync(mutantPath, "utf8");
      const occ = mutantSrc.split(RECHECK_OLD).length - 1;
      if (occ !== 1) throw new Error(`${label}: expected exactly 1 occurrence of RECHECK_OLD, found ${occ}`);
      fs.writeFileSync(mutantPath, mutantSrc.replace(RECHECK_OLD, RECHECK_NEW));
      return import(`file://${mutantPath.replace(/\\/g, "/")}?v=${Date.now()}-${randomUUID()}`); // cache-bust: same path, now-mutated-twice content
    }

    function prepareRepo(mod, sessPrefix, editedBody) {
      const cwd = freshRepoCwd();
      mod.injectSkills(cwd, sessPrefix, null, "manager");
      fs.writeFileSync(path.join(cwd, ".claude", "skills", "loom-x", "SKILL.md"), editedBody);
      mod.injectSkills(cwd, sessPrefix, null, "manager"); // releases loom-x ("modified")
      const dest = path.join(cwd, ".claude", "skills", "loom-x");
      const expectedFp = fingerprintSkillDir(dest);
      return { cwd, dest, expectedFp };
    }

    // Seed an outside dir with content that would make EVERY other check (fingerprint, released,
    // tracked) pass identically to the real path — isolating the proof to the escape check alone.
    function seedOutside(swapKind, editedBody) {
      const outsideRoot = mkdtempManaged("loom-8b38b920-s15-outside-");
      const outsideSkillsDir = swapKind === "skills" ? outsideRoot : path.join(outsideRoot, "skills");
      fs.mkdirSync(path.join(outsideSkillsDir, "loom-x"), { recursive: true });
      fs.writeFileSync(path.join(outsideSkillsDir, "loom-x", "SKILL.md"), editedBody);
      fs.writeFileSync(path.join(outsideSkillsDir, ".loom-skills-fingerprints.json"), JSON.stringify({ __released: { "loom-x": { reason: "modified", firstSeenAt: Date.now() } } }));
      return { outsideSkillsDir, junctionTarget: outsideRoot };
    }

    function swapIn(cwd, swapKind, junctionTarget) {
      const swapPath = swapKind === "skills" ? path.join(cwd, ".claude", "skills") : path.join(cwd, ".claude");
      fs.rmSync(swapPath, { recursive: true, force: true });
      fs.symlinkSync(junctionTarget, swapPath, process.platform === "win32" ? "junction" : "dir");
    }

    async function runCase(caseLabel, swapKind) {
      // --- GOOD: real post-await recheck present ---
      {
        const editedBody = `SECTION15 ${caseLabel} PRE-EDIT (GOOD)`;
        const mGood = await buildGoodMutant(`s15-good-${swapKind}`);
        const { cwd, dest, expectedFp } = prepareRepo(mGood, `sess-s15-good-${swapKind}`, editedBody);
        const { outsideSkillsDir, junctionTarget } = seedOutside(swapKind, editedBody);

        let resolveGate;
        mGood.__setS13Gate(dest, new Promise((r) => { resolveGate = r; }));
        const p = mGood.reAdoptReleasedSkill(cwd, "loom-x", expectedFp, false); // suspends inside the gate
        swapIn(cwd, swapKind, junctionTarget); // synchronously, DURING the suspension
        resolveGate();
        const res = await p;

        check(`(15${caseLabel}) GOOD: readopt refuses via the post-await escape recheck`, res.ok === false && res.code === "copy-failed");
        check(`(15${caseLabel}) GOOD: the far-end seeded content is untouched`, fs.readFileSync(path.join(outsideSkillsDir, "loom-x", "SKILL.md"), "utf8") === editedBody);
        check(`(15${caseLabel}) GOOD: the far-end seeded sidecar is untouched`, JSON.parse(fs.readFileSync(path.join(outsideSkillsDir, ".loom-skills-fingerprints.json"), "utf8")).__released["loom-x"].reason === "modified");
      }

      // --- MUTANT: post-await recheck removed (pre-await check + TOCTOU-correct await ordering kept) ---
      {
        const editedBody = `SECTION15 ${caseLabel} PRE-EDIT (MUTANT)`;
        const mBad = await buildNoRecheckMutant(`s15-bad-${swapKind}`);
        const { cwd, dest, expectedFp } = prepareRepo(mBad, `sess-s15-bad-${swapKind}`, editedBody);
        const { outsideSkillsDir, junctionTarget } = seedOutside(swapKind, editedBody);

        let resolveGate;
        mBad.__setS13Gate(dest, new Promise((r) => { resolveGate = r; }));
        const p = mBad.reAdoptReleasedSkill(cwd, "loom-x", expectedFp, false);
        swapIn(cwd, swapKind, junctionTarget);
        resolveGate();
        const res = await p;

        check(`(15${caseLabel}) *** MUTANT PROOF ***: with the post-await recheck removed, readopt WRONGLY succeeds through the escape`, res.ok === true);
        check(`(15${caseLabel}) *** MUTANT PROOF ***: the far-end content was WRONGLY overwritten with the store copy`, fs.readFileSync(path.join(outsideSkillsDir, "loom-x", "SKILL.md"), "utf8").includes("V1 BODY"));
      }
    }

    await runCase("A (swap .claude/skills)", "skills");
    await runCase("B (swap .claude)", "claude");
  }

  // =====================================================================================================
  // SECTION 16 — manager-directed regression (fix round 3, item 2, quotePath): the ASCII-only fixtures in
  // section 10 (and elsewhere) parse identically with or without `-z` — a check that can't fail. Prove
  // the fix against a non-ASCII tracked FILENAME under the released dir, which git's default
  // `core.quotePath=true` C-quotes in `ls-files` output, exercised through `releasedSkillsAt` (the
  // BATCHED check `-z` actually fixed — `batchGitTrackedStates`, not the singular `gitTrackedState`).
  // =====================================================================================================
  {
    const cwd = freshRepoCwd();
    initRepo(cwd);
    injectSkills(cwd, "sess-a16", null, "manager"); // places loom-x
    const skillDirPath = path.join(cwd, ".claude", "skills", "loom-x");
    const nonAsciiPath = path.join(skillDirPath, "é.md");
    fs.writeFileSync(nonAsciiPath, "NON-ASCII TRACKED FILE");
    // -f: injectSkills already excluded "/.claude/skills/loom-x" via hideFromGit (card f452ac4f) by this
    // point, so a plain `git add` would be refused as ignored — force it, same as section 10.
    execFileSync("git", ["add", "-f", nonAsciiPath], { cwd, env: GIT_ENV });
    execFileSync("git", ["commit", "-m", "track a non-ASCII-named file"], { cwd, env: GIT_ENV });
    fs.writeFileSync(path.join(skillDirPath, "SKILL.md"), "HAND EDITED (SECTION 16, NON-ASCII)");
    injectSkills(cwd, "sess-a16", null, "manager"); // releases it ("modified")

    const list16 = await releasedSkillsAt(cwd);
    check("(16) releasedSkillsAt (batched) correctly reports tracked:\"tracked\" for a non-ASCII-named tracked file",
      list16.some((r) => r.name === "loom-x" && r.tracked === "tracked"));

    // API-keeping mutant: drop `-z` (back to the pre-fix default-quoted, "\n"-split parse) — proves the
    // fix is load-bearing, not merely present; the non-ASCII name is silently misreported "untracked"
    // again, which would have cleared the way for a readopt to overwrite real, repo-owned content.
    const m16 = await buildMutant(
      "s16",
      `const raw = await withTimeout(git.raw(["ls-files", "-z", "--", gitPathspec]), UNTRACKED_CHECK_TIMEOUT_MS, "git ls-files (released-skill batch tracked check)");\n        tracked = new Set(raw.split("\\u0000").map((l) => l.trim()).filter(Boolean));`,
      `const raw = await withTimeout(git.raw(["ls-files", "--", gitPathspec]), UNTRACKED_CHECK_TIMEOUT_MS, "git ls-files (released-skill batch tracked check)"); /* MUTANT S16: -z dropped */\n        tracked = new Set(raw.split("\\n").map((l) => l.trim()).filter(Boolean));`,
    );
    const list16m = await m16.releasedSkillsAt(cwd);
    check("(16) *** MUTANT PROOF ***: without -z, the non-ASCII-named tracked file is WRONGLY reported untracked",
      list16m.some((r) => r.name === "loom-x" && r.tracked === "untracked"));
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — every release site durably records a reason, clears visibly on legitimate (re)placement, and the human-only re-adopt path never auto-overwrites, never bypasses the fingerprint gate once re-adopted, refuses to overwrite git-tracked content, and correctly bridges back to live-session management."
    : `\n❌ ${failures} FAILURE(S)`);
} finally {
  cleanupMutants();
}
process.exit(failures === 0 ? 0 : 1);
