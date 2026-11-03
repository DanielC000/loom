// Core RED/GREEN proof for card f4e93dbf, isolated into its own small file SPECIFICALLY so it stays
// structurally runnable against BOTH the pre-fix and post-fix build of skills/inject.ts (the
// `negative-control` script reverts the source file, rebuilds, and runs this exact test against each
// state — see scripts/negative-control.mjs). The full guard/mutant battery lives in the sibling file
// skills-dead-claim-reclaim-shared-cwd.mjs, which depends on post-fix-only internals and is NOT
// negative-control-compatible.
//
// Scenario: a manager-shaped session injects a store skill into a SHARED (non-worktree) cwd, dies; a
// successor's injectSkills call prunes the dead claim (card 9d73e537) and, pre-fix, permanently treats
// the now-unclaimed dir as "the repo's own" — never refreshed even after the store moves on. Post-fix,
// the successor's FIRST call only discovers + kicks a bounded async check (never touches the dir that
// call); a SECOND call at the same cwd, after the check resolves, performs the repair.
//
// At the pre-fix sha there is no async mechanism at all (no `__awaitPendingSkillTrackChecks` export), so
// this test reads it defensively (absent ⇒ a no-op) — the RED here is a genuine BEHAVIORAL failure (the
// content never moves off v1, call after call, forever) rather than a missing-export crash.
// Run after build: node test/skills-dead-claim-reclaim-shared-cwd-core.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const home = useOwnLoomHome("loom-f4e93dbf-core-", { fresh: true }); // BEFORE importing — paths.ts computes SKILLS_DIR at load
const skillsDir = path.join(home, "skills");
const cwd = mkdtempManaged("loom-f4e93dbf-core-repo-"); // a SHARED cwd — never under WORKTREES_DIR
fs.mkdirSync(path.join(skillsDir, "loom-x"), { recursive: true });
fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: v1\n---\nV1 BODY");

// A REAL (if minimal) git repo — matches the realistic shared-cwd shape (project.repoPath is always a
// real git checkout); the skill dir itself is left untracked (never committed), which is the ordinary,
// expected case this fix repairs.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
execFileSync("git", ["init", "-q"], { cwd, env: GIT_ENV });
execFileSync("git", ["config", "user.email", "t@t"], { cwd, env: GIT_ENV });
execFileSync("git", ["config", "user.name", "t"], { cwd, env: GIT_ENV });

const mod = await import("../dist/skills/inject.js");
const { injectSkills } = mod;
const awaitPendingChecks = typeof mod.__awaitPendingSkillTrackChecks === "function" ? mod.__awaitPendingSkillTrackChecks : async () => {};

const r1 = injectSkills(cwd, "dead-mgr", null, "manager");
check("dead-mgr placed loom-x v1", r1.claimedNames.includes("loom-x"));

// dead-mgr dies; the store moves to v2 — the fact that should reach every live session but, pre-fix,
// never reaches this cwd again once the claim is orphaned.
fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: v2\n---\nV2 BODY");
const isLive = (sid) => sid !== "dead-mgr";

injectSkills(cwd, "new-mgr", null, "manager", false, isLive); // discovers the orphan (post-fix); a no-op either way, pre-fix
await awaitPendingChecks(); // real async resolution (post-fix); nothing pending at all (pre-fix)
injectSkills(cwd, "new-mgr", null, "manager", false, isLive); // the repair call (post-fix); still a no-op, pre-fix

const body = fs.readFileSync(path.join(cwd, ".claude", "skills", "loom-x", "SKILL.md"), "utf8");
check("die -> prune -> stale is REPAIRED: refreshed to v2 across the two follow-up calls", body.includes("V2 BODY"));

// SECTION 2 (card f4e93dbf round 2, MAJOR #1): the verified-untracked FACT has a 60s TTL
// (`UNTRACKED_CACHE_TTL_MS`); round 1 shipped NO separate, persisted "remember the orphan" record, so a
// dead claim whose fact expired before a LATER call ever consumed it was abandoned forever — round 1's
// own cache is the only thing that ever carried the discovery forward, and once it expires, nothing does.
// Monkeypatch the global `Date.now` (this codebase's own test-clock convention, e.g.
// temp-path-collision-guard.mjs) to advance PAST that TTL between two calls, without a real 60s sleep.
const cwd2 = mkdtempManaged("loom-f4e93dbf-core-repo2-");
execFileSync("git", ["init", "-q"], { cwd: cwd2, env: GIT_ENV });
execFileSync("git", ["config", "user.email", "t@t"], { cwd: cwd2, env: GIT_ENV });
execFileSync("git", ["config", "user.name", "t"], { cwd: cwd2, env: GIT_ENV });
fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: s2v1\n---\nS2 V1 BODY");
injectSkills(cwd2, "dead-mgr2", null, "manager");
fs.writeFileSync(path.join(skillsDir, "loom-x", "SKILL.md"), "---\nname: loom-x\ndescription: s2v2\n---\nS2 V2 BODY"); // store moves on
const isLive2 = (sid) => sid !== "dead-mgr2";
injectSkills(cwd2, "new-mgr2", null, "manager", false, isLive2); // discover + kick
await awaitPendingChecks(); // real async resolution (post-fix); nothing pending at all (pre-fix)

const realDateNow = Date.now;
Date.now = () => realDateNow() + 61_000; // advance PAST the 60s verified-fact TTL before any call consumes it
let stillUnrepaired;
try {
  injectSkills(cwd2, "new-mgr2", null, "manager", false, isLive2); // round 1: the expired fact is simply dropped, nothing re-kicked, orphan abandoned forever
  stillUnrepaired = fs.readFileSync(path.join(cwd2, ".claude", "skills", "loom-x", "SKILL.md"), "utf8").includes("S2 V1 BODY");
} finally {
  Date.now = realDateNow;
}
await awaitPendingChecks(); // round 2: resolves the RE-KICKED check (a no-op pre-round-2, nothing was ever re-kicked)
injectSkills(cwd2, "new-mgr2", null, "manager", false, isLive2); // the repair call
const body2 = fs.readFileSync(path.join(cwd2, ".claude", "skills", "loom-x", "SKILL.md"), "utf8");
check("TTL-expired orphan is REPAIRED by a later call, not abandoned forever (round 2 MAJOR #1)", stillUnrepaired && body2.includes("S2 V2 BODY"));

console.log(failures === 0
  ? "\n✅ ALL PASS — the shared-cwd dead-claim orphan is repaired within two follow-up calls."
  : `\n❌ ${failures} FAILURE(S) — expected at the pre-fix sha (no repair mechanism existed); unexpected at the post-fix sha.`);
process.exit(failures === 0 ? 0 : 1);
