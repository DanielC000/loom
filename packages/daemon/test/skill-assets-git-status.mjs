import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card bb76b8d8 — `skillStoreStaleness()` (skills/store.ts) compares the STORE against the assets
// WORKING TREE (a plain `fs.readFileSync`) and never consults git. So a live, UNCOMMITTED
// `assets/skills/**` edit — once also reflected in the store some other way (a manual sync, a publish) —
// makes store/base/shipped all agree, and `skillStoreStaleness()` reports a fully clean bill even though
// the edit exists in NO commit and a `git checkout -- .` / clean clone would silently destroy it. This was
// live on the real host for ~3 hours on 2026-09-02. `skillAssetsGitStatus()` (skills/assets-git-status.ts)
// is the missing git-aware half; `deriveSkillAssetsSyncState()` combines both signals into the three (plus
// one honest "can't tell") states the card's DoD #4 requires kept distinct.
//
// HERMETIC: a real throwaway git repo (execSync git, real commits) containing a real
// `packages/daemon/assets/skills/**` subtree, driven through the `repoRoot` test seam — mirrors
// deploy-staleness.mjs's own hermetic-repo discipline. LOOM_ASSET_SKILLS points AT that same fixture
// repo's assets/skills dir, so `skillStoreStaleness()` and `skillAssetsGitStatus()` are both reading the
// SAME on-disk files, exactly like production (where both ultimately point at
// `packages/daemon/assets/skills`).
//
// Proves:
//   (1) no .git at repoRoot ⇒ available:false, reasonKind:"not-applicable", uncommitted:false — never a
//       false "uncommitted" claim for a packaged install (card DoD #2).
//   (2) in-sync AND committed ⇒ skillAssetsGitStatus.uncommitted:false, tri-state "clean".
//   (3) 🔴 THE RED HALF — reproduces the exact 2026-09-02 state: the shipped asset is edited on disk
//       WITHOUT committing, and that edit is also synced into the store + base snapshot (so mine==base==
//       shipped). skillStoreStaleness() still reports a clean bill (stale:false) — proving the pre-existing
//       blind spot is real, not hypothetical. skillAssetsGitStatus() correctly reports uncommitted:true,
//       and the combined tri-state reads "uncommitted", not "clean" — THE FIX.
//   (4) CLOSE BY MUTATION: committing that same edit flips uncommitted back to false and the tri-state
//       back to "clean" — proves the signal actually tracks live git state both ways, not a one-shot latch.
//   (5) a brand-new, entirely untracked skill file (never synced anywhere) is ALSO caught as uncommitted —
//       an even starker case of "invisible to skillStoreStaleness" (the skill isn't even in the store).
//   (6) a genuinely-stale STORE (pristine skill, shipped update, but the shipped update itself IS
//       committed — git clean) ⇒ tri-state "stale", distinct from both "clean" and "uncommitted".
//   (7) PRECEDENCE: store stale AND git uncommitted at once ⇒ tri-state still "stale" (checked first —
//       the store fact is the more actionable one), proving the three states don't just alternate by
//       whichever was set last.
//   (8) git itself unreadable (a corrupt `.git`) ⇒ available:false, reasonKind:"could-not-measure",
//       uncommitted:false — never a fabricated verdict, never a thrown exception.
//   (9) wired end-to-end through `buildServedStatus()` (served-status.ts) — the real human-facing surface.
//
// Run: 1) build (turbo builds shared first), 2) node test/skill-assets-git-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const reasonSuffix = (r) => r?.reason ? ` — reason: ${JSON.stringify(r.reason)}` : "";

const createdDirs = [];
const trackDir = (dir) => { createdDirs.push(dir); return dir; };

process.env.LOOM_HOME = trackDir(path.join(os.tmpdir(), `loom-sags-home-${Date.now()}-${process.pid}`));
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const repo = trackDir(path.join(os.tmpdir(), `loom-sags-repo-${Date.now()}-${process.pid}`));
const assetSkillsDir = path.join(repo, "packages", "daemon", "assets", "skills");
fs.mkdirSync(assetSkillsDir, { recursive: true });
// Must be set BEFORE skills/store.js is first imported (a module-load-time const) — points the store's
// OWN "shipped asset" read at the SAME physical dir this test's git repo tracks, so both signals under
// test read identical on-disk files, matching production (where both are simply `packages/daemon/assets/skills`
// under one real repo root).
process.env.LOOM_ASSET_SKILLS = assetSkillsDir;

const git = (args, dateIso) => execSync(`git ${args}`, {
  cwd: repo,
  env: { ...process.env, ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}) },
});
git("init -q");
git('-c user.email=t@loom -c user.name=t commit -q -m init --allow-empty', "2026-01-01T00:00:00Z");

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { skillStoreStaleness } = await import("../dist/skills/store.js");
const { skillAssetsGitStatus, deriveSkillAssetsSyncState } = await import("../dist/skills/assets-git-status.js");

const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
const homeSkillsDir = path.join(process.env.LOOM_HOME, "skills");
const homeBaseDir = path.join(process.env.LOOM_HOME, "skill-base");

try {
  // ===================== (1) no .git at all — the packaged-install case =====================
  {
    const noRepo = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), "loom-sags-norepo-")));
    const r = skillAssetsGitStatus({ repoRoot: noRepo });
    check("(1) no .git ⇒ available:false, never throws" + reasonSuffix(r), r.available === false && typeof r.reason === "string");
    check("(1) no .git ⇒ reasonKind:\"not-applicable\"", r.reasonKind === "not-applicable");
    check("(1) no .git ⇒ uncommitted:false (never a false-positive claim)", r.uncommitted === false && Array.isArray(r.uncommittedPaths) && r.uncommittedPaths.length === 0);
    fs.rmSync(noRepo, { recursive: true, force: true });
  }

  // ===================== (2) in-sync AND committed — the ordinary healthy state =====================
  mkdirp(path.join(assetSkillsDir, "demo"));
  const demoV1 = "---\nname: demo\ndescription: A demo skill for testing.\n---\nDemo skill body v1.\n";
  fs.writeFileSync(path.join(assetSkillsDir, "demo", "SKILL.md"), demoV1);
  git("add packages/daemon/assets/skills/demo/SKILL.md");
  git('-c user.email=t@loom -c user.name=t commit -q -m "docs(assets): add demo skill v1"', "2026-01-02T00:00:00Z");
  mkdirp(homeBaseDir);
  fs.writeFileSync(path.join(homeBaseDir, "demo.md"), demoV1);
  mkdirp(path.join(homeSkillsDir, "demo"));
  fs.writeFileSync(path.join(homeSkillsDir, "demo", "SKILL.md"), demoV1);
  {
    const store = skillStoreStaleness();
    check("(2) store: stale:false (mine == base == shipped)", store.stale === false);
    const git2 = skillAssetsGitStatus({ repoRoot: repo });
    check("(2) git: available:true, uncommitted:false" + reasonSuffix(git2), git2.available === true && git2.uncommitted === false);
    check("(2) tri-state: \"clean\"", deriveSkillAssetsSyncState(store, git2) === "clean");
  }

  // ===================== (3) 🔴 THE RED HALF — reproduce the exact 2026-09-02 defect =====================
  const demoV2 = "---\nname: demo\ndescription: A demo skill for testing.\n---\nDemo skill body v2, edited LIVE on disk, never committed.\n";
  fs.writeFileSync(path.join(assetSkillsDir, "demo", "SKILL.md"), demoV2); // working-tree edit, NOT committed
  fs.writeFileSync(path.join(homeBaseDir, "demo.md"), demoV2); // synced into base some other way (manual copy / publish)
  fs.writeFileSync(path.join(homeSkillsDir, "demo", "SKILL.md"), demoV2); // synced into the store too
  {
    const store = skillStoreStaleness();
    check("🔴 (3) RED CONTROL: skillStoreStaleness() STILL reports a clean bill despite the live uncommitted edit — the pre-existing bug, reproduced" + JSON.stringify(store), store.stale === false && store.pendingRestart.length === 0 && store.pendingAdopt.length === 0);
    const git3 = skillAssetsGitStatus({ repoRoot: repo });
    check("✅ (3) GREEN: skillAssetsGitStatus() catches it — available:true, uncommitted:true" + reasonSuffix(git3), git3.available === true && git3.uncommitted === true);
    check("(3) uncommittedPaths names the dirty file", git3.uncommittedPaths.some((p) => p.includes("demo/SKILL.md") || p.includes("demo\\SKILL.md")));
    check("✅ (3) tri-state distinguishes this from \"clean\": \"uncommitted\"", deriveSkillAssetsSyncState(store, git3) === "uncommitted");
  }

  // ===================== (4) CLOSE BY MUTATION — commit it, the signal must flip back =====================
  git("add packages/daemon/assets/skills/demo/SKILL.md");
  git('-c user.email=t@loom -c user.name=t commit -q -m "docs(assets): land demo skill v2"', "2026-01-03T00:00:00Z");
  {
    const store = skillStoreStaleness();
    const git4 = skillAssetsGitStatus({ repoRoot: repo });
    check("(4) after committing: uncommitted:false again — proves this tracks LIVE git state, not a one-shot latch", git4.available === true && git4.uncommitted === false);
    check("(4) tri-state back to \"clean\"", deriveSkillAssetsSyncState(store, git4) === "clean");
  }

  // ===================== (5) a brand-new, entirely untracked skill file =====================
  mkdirp(path.join(assetSkillsDir, "newskill"));
  fs.writeFileSync(path.join(assetSkillsDir, "newskill", "SKILL.md"), "---\nname: newskill\ndescription: Never synced anywhere.\n---\nBody.\n");
  {
    const git5 = skillAssetsGitStatus({ repoRoot: repo });
    check("(5) a new UNTRACKED asset file ⇒ uncommitted:true" + reasonSuffix(git5), git5.available === true && git5.uncommitted === true);
    // git collapses a wholly-untracked NEW DIRECTORY to the directory path itself ("newskill/"), not each
    // file inside it — real, standard porcelain behavior, not a bug in this module.
    check("(5) uncommittedPaths names the new directory", git5.uncommittedPaths.some((p) => p.includes("newskill")));
  }
  fs.rmSync(path.join(assetSkillsDir, "newskill"), { recursive: true, force: true }); // isolate from later sections

  // ===================== (6) genuinely-stale STORE, git-clean — the third, distinct state =====================
  mkdirp(path.join(assetSkillsDir, "pristine-skill"));
  const pristineV2 = "---\nname: pristine-skill\ndescription: Pristine with a shipped update.\n---\nv2 (shipped)\n";
  fs.writeFileSync(path.join(assetSkillsDir, "pristine-skill", "SKILL.md"), pristineV2);
  git("add packages/daemon/assets/skills/pristine-skill/SKILL.md");
  git('-c user.email=t@loom -c user.name=t commit -q -m "docs(assets): ship pristine-skill v2"', "2026-01-04T00:00:00Z");
  fs.writeFileSync(path.join(homeBaseDir, "pristine-skill.md"), "v1 (last synced base)\n");
  mkdirp(path.join(homeSkillsDir, "pristine-skill"));
  fs.writeFileSync(path.join(homeSkillsDir, "pristine-skill", "SKILL.md"), "v1 (last synced base)\n");
  {
    const store = skillStoreStaleness();
    check("(6) store: stale:true (pristine-skill pending restart)", store.stale === true && store.pendingRestart.includes("pristine-skill"));
    const git6 = skillAssetsGitStatus({ repoRoot: repo });
    check("(6) git: uncommitted:false — the shipped update is fully committed" + reasonSuffix(git6), git6.available === true && git6.uncommitted === false);
    check("(6) tri-state: \"stale\" — distinct from both \"clean\" and \"uncommitted\"", deriveSkillAssetsSyncState(store, git6) === "stale");
  }

  // ===================== (7) PRECEDENCE — store stale AND git uncommitted at the same time =====================
  fs.writeFileSync(path.join(assetSkillsDir, "pristine-skill", "SKILL.md"), "v3 (shipped, edited again, NOT committed)\n");
  {
    const store = skillStoreStaleness();
    const git7 = skillAssetsGitStatus({ repoRoot: repo });
    check("(7-setup) store still stale, git now ALSO uncommitted", store.stale === true && git7.uncommitted === true);
    check("(7) precedence: tri-state reads \"stale\" (checked first), not \"uncommitted\"", deriveSkillAssetsSyncState(store, git7) === "stale");
  }
  // revert to (6)'s state so it doesn't leak into later sections
  git("checkout -q -- packages/daemon/assets/skills/pristine-skill/SKILL.md");

  // ===================== (8) git itself unreadable — never throws, never fabricates a verdict =====================
  {
    const brokenRepo = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), "loom-sags-broken-")));
    fs.writeFileSync(path.join(brokenRepo, ".git"), "not a real gitdir pointer\n"); // .git EXISTS but git itself will refuse it
    const r = skillAssetsGitStatus({ repoRoot: brokenRepo });
    check("(8) a corrupt .git ⇒ available:false, never throws" + reasonSuffix(r), r.available === false && typeof r.reason === "string");
    check("(8) a corrupt .git ⇒ reasonKind:\"could-not-measure\" (reachable in principle, git itself failed — NOT the same as \"not-applicable\")", r.reasonKind === "could-not-measure");
    check("(8) a corrupt .git ⇒ uncommitted:false (never a fabricated verdict)", r.uncommitted === false);
    fs.rmSync(brokenRepo, { recursive: true, force: true });
  }

  // ===================== (9) wired end-to-end through buildServedStatus (served-status.ts) =====================
  {
    const { buildServedStatus } = await import("../dist/served-status.js");
    process.env.LOOM_REPO_ROOT = repo;
    const fakeDb = { listAllSessions: () => [] };
    const status = buildServedStatus(fakeDb);
    check("(9) served status returns a skillAssetsGitStatus field", status.skillAssetsGitStatus !== undefined);
    check("(9) served status: skillAssetsGitStatus.available:true against the LOOM_REPO_ROOT fixture" + reasonSuffix(status.skillAssetsGitStatus), status.skillAssetsGitStatus.available === true);
    check("(9) served status: skillAssetsGitStatus.uncommitted:false (repo is clean at this point in the test)", status.skillAssetsGitStatus.uncommitted === false);
    check("(9) served status returns a skillAssetsSyncState field", typeof status.skillAssetsSyncState === "string");
    check("(9) served status: skillAssetsSyncState is \"stale\" (pristine-skill from (6) is still pending restart)", status.skillAssetsSyncState === "stale");
    check("(9) served status: skillStoreStaleness is still present and unaffected (independent signals)", status.skillStoreStaleness !== undefined);
    delete process.env.LOOM_REPO_ROOT;
  }
} finally {
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — skillAssetsGitStatus() catches a live, uncommitted assets/skills/** edit that skillStoreStaleness() alone reads as fully clean, distinguishes clean/uncommitted/stale as three separate states (with correct precedence), degrades cleanly for a packaged install or a git failure, and is wired end-to-end through served_status."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
