import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e21cfd5f — boot reconcile can never remove a project's primary repo checkout. Decision record:
// docs/decisions/e21cfd5f-worktree-removal-never-touches-a-repo-checkout.md
//
// A session row whose `worktreePath` names a project's primary checkout (a plain / run / mis-set row) used to be force-removed by boot
// Pass B: `worktreeHasWork` reads a clean, branchless checkout as "no work", and neither `gcWorktreeDir` nor `removeWorktree` checked the
// path. REAL git + REAL dirs in temp locations, real `reconcileOrchestrationOnBoot()`, isolated LOOM_HOME (so WORKTREES_DIR is a temp
// sibling, never the real ~/.loom-worktrees). No claude, no live daemon.
//   (A) an exited row whose worktreePath IS the project's primary repo ⇒ the repo (and its .git and files) survives the reconcile.
//   (B) an exited row whose worktreePath is a real dir OUTSIDE the worktrees root (dead-leftover shape: no .git) ⇒ survives.
//   (C) CONTROL: a real, clean, zero-commit worktree created under the worktrees root IS still reclaimed by the same reconcile.
//   (D) predicate unit cases: root itself, repo == target, target CONTAINING a registered repo (under the root), outside the root,
//       a normal worktree (allowed), and a junction/symlink under the root that resolves into a repo (refused).
// Run: 1) build daemon, 2) LOOM_CODEX_BIN=<nonexistent> node test/worktree-removal-never-reaches-repo.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { mkdtempManaged, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("loom-wrr-home-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const wt = await import("../dist/git/worktrees.js");
const { WORKTREES_DIR } = await import("../dist/paths.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=wrr@loom -c user.name=wrr";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "tracked.txt"), "wrr\n");
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  git(repo, "branch -M main");
}
const row = (id, projectId, agentId, worktreePath, extra = {}) => ({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown",
  busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", worktreePath, ...extra,
});

// Fixture roots live in the managed temp dir, NOT under WORKTREES_DIR — the fixture that removed a repo before was exactly a repo whose
// path sat where the removal was allowed to reach.
const base = mkdtempManaged("loom-wrr-fx-");
const repo = path.join(base, "primary-repo");
const outside = path.join(base, "outside-root-leftover");
const projId = `wrr-proj-${sfx}`, agentId = `wrr-agent-${sfx}`;
initRepo(repo);
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, "keep.txt"), "leftover\n");
db.insertProject({ id: projId, name: "WRR", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });

// (A) a session pointing at the primary checkout itself; (B) one pointing outside the worktrees root.
db.insertSession(row(`wrr-a-${sfx}`, projId, agentId, repo));
db.insertSession(row(`wrr-b-${sfx}`, projId, agentId, outside));

// (C) control: a genuine Loom worktree (zero commits, clean) — Pass B must still reclaim it.
const taskId = `wrr-task-${sfx}`;
db.insertTask({ id: taskId, projectId: projId, title: "WRR", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
const created = await wt.createWorktree(repo, projId, taskId);
db.insertSession(row(`wrr-c-${sfx}`, projId, agentId, created.worktreePath, { taskId, branch: created.branch }));
check("control fixture: the real worktree sits strictly under WORKTREES_DIR", created.worktreePath.toLowerCase().startsWith(WORKTREES_DIR.toLowerCase() + path.sep));
check("control fixture: worktree exists before reconcile", fs.existsSync(created.worktreePath));

// (E) a junction/symlink PLANTED INSIDE a real worktree, pointing at a project's primary repo. `node_modules` is gitignored, so `git status` is
// clean and Pass B sees "no work". `git worktree remove -f -f` used to delete THROUGH the link (git 2.47 for Windows), emptying the repo.
const repoE = path.join(base, "junction-victim-repo");
const projE = `wrr-e-proj-${sfx}`, agentE = `wrr-e-agent-${sfx}`, taskE = `wrr-e-task-${sfx}`;
initRepo(repoE);
fs.writeFileSync(path.join(repoE, ".gitignore"), "node_modules\n");
commitAll(repoE, "ignore node_modules", GIT_ID);
db.insertProject({ id: projE, name: "WRR-E", repoPath: repoE, vaultPath: repoE, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentE, projectId: projE, name: "t", startupPrompt: "", position: 0 });
db.insertTask({ id: taskE, projectId: projE, title: "WRR-E", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
const wtE = await wt.createWorktree(repoE, projE, taskE);
let junctionOk = false;
try { fs.symlinkSync(repoE, path.join(wtE.worktreePath, "node_modules"), process.platform === "win32" ? "junction" : "dir"); junctionOk = true; } catch { /* no link privilege */ }
if (junctionOk) db.insertSession(row(`wrr-e-${sfx}`, projE, agentE, wtE.worktreePath, { taskId: taskE, branch: wtE.branch }));
else console.log("SKIP  (E) junction case — could not create a junction/symlink on this host");

// (H) a registered repo of an ARCHIVED project that lives UNDER the worktrees root (so only the repo list, not the root rule, can protect it).
const projH = `wrr-h-proj-${sfx}`, agentH = `wrr-h-agent-${sfx}`, projHLive = `wrr-h2-proj-${sfx}`;
const repoH = path.join(WORKTREES_DIR, projHLive, "repos", "api");
initRepo(repoH);
db.insertProject({ id: projH, name: "WRR-H-archived", repoPath: repoH, vaultPath: repoH, config: {}, createdAt: now, archivedAt: now });
db.insertProject({ id: projHLive, name: "WRR-H-live", repoPath: path.join(base, "h-live-repo"), vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentH, projectId: projHLive, name: "t", startupPrompt: "", position: 0 });
db.insertSession(row(`wrr-h-${sfx}`, projHLive, agentH, repoH));

// (G) a wedge entry for a path outside the root: the slow-retry sweep must not retry it forever.
const outsideWedge = path.join(base, "outside-wedged");
fs.mkdirSync(outsideWedge, { recursive: true });
db.recordWorktreeWedgeAttempt(outsideWedge, repo, "fixture wedge");

const sha0 = git(repo, "rev-parse HEAD");
const shaE = git(repoE, "rev-parse HEAD");
const res = await sessions.reconcileOrchestrationOnBoot(new Set());
await sessions.sweepWedgedWorktreesOnce();

check("(A) the primary repo directory survives a real boot reconcile", fs.existsSync(repo));
check("(A) the primary repo's .git survives", fs.existsSync(path.join(repo, ".git")));
check("(A) the primary repo's tracked file survives", fs.existsSync(path.join(repo, "tracked.txt")));
check("(A) the repo is still a usable git repo at the same HEAD", fs.existsSync(repo) && git(repo, "rev-parse HEAD") === sha0);
check("(B) a dir outside the worktrees root is refused (survives, contents intact)", fs.existsSync(path.join(outside, "keep.txt")));
check("(C) CONTROL: a normal worktree under the root is still reclaimed", !fs.existsSync(created.worktreePath));

if (junctionOk) {
  check("(E) the repo a planted node_modules junction points at survives (dir, .git, tracked file)",
    fs.existsSync(path.join(repoE, ".git")) && fs.existsSync(path.join(repoE, ".gitignore")) && fs.existsSync(path.join(repoE, "tracked.txt")));
  check("(E) that repo is intact at the same HEAD", fs.existsSync(path.join(repoE, ".git")) && git(repoE, "rev-parse HEAD") === shaE);
  check("(E) the worktree itself WAS reclaimed (the fix removes the link, not the target, rather than refusing everything)", !fs.existsSync(wtE.worktreePath));
}
check("(H) a registered repo of an ARCHIVED project, under the worktrees root, survives", fs.existsSync(path.join(repoH, ".git")) && fs.existsSync(path.join(repoH, "tracked.txt")));
check("(G) a wedge entry for a refused path is parked as needsHuman (not retried forever)", db.getWedgedWorktree(outsideWedge)?.needsHuman === true);
check("(2) the reconcile result COUNTS refused paths (A, B, H ⇒ ≥ 3)", (res.worktreesPathRefused ?? 0) >= 3);

// (F) reclaimNodeModulesDir: a node_modules that IS a link into a repo is refused; a real node_modules dir under the root is still reclaimed.
{
  const wtF = await wt.createWorktree(repo, projId, `wrr-f-task-${sfx}`);
  let ok = false;
  try { fs.symlinkSync(repoE, path.join(wtF.worktreePath, "node_modules"), process.platform === "win32" ? "junction" : "dir"); ok = true; } catch { /* no privilege */ }
  if (ok) {
    const out = await wt.reclaimNodeModulesDir(wtF.worktreePath, undefined, { protectedRepoPaths: [repo, repoE] });
    check("(F) node_modules junction into a repo is refused (left-on-disk)", out.outcome === "left-on-disk");
    check("(F) the repo behind the junction survives reclaim", fs.existsSync(path.join(repoE, ".git")) && fs.existsSync(path.join(repoE, "tracked.txt")));
    fs.unlinkSync(path.join(wtF.worktreePath, "node_modules")); // drop the link itself before any cleanup walks it
  } else console.log("SKIP  (F) junction case — could not create a junction/symlink on this host");
  const nm = path.join(wtF.worktreePath, "node_modules");
  fs.mkdirSync(path.join(nm, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(nm, "pkg", "index.js"), "x\n");
  const ctl = await wt.reclaimNodeModulesDir(wtF.worktreePath, undefined, { protectedRepoPaths: [repo, repoE] });
  check("(F) CONTROL: a real node_modules dir under the root is still reclaimed", ctl.outcome === "removed" && !fs.existsSync(nm));
}

// (D) the predicate itself. Uses a synthetic root/repo layout so `contains` is exercised for a target that IS under the root.
const R = mkdtempManaged("loom-wrr-root-");
const inRoot = (...p) => path.join(R, ...p);
const projDir = inRoot("proj");
const nestedRepo = path.join(projDir, "repos", "api");
fs.mkdirSync(nestedRepo, { recursive: true });
fs.mkdirSync(inRoot("proj", "task1"), { recursive: true });
const refuse = wt.worktreeRemovalRefusal;
check("(D) predicate is exported", typeof refuse === "function");
if (typeof refuse === "function") {
  check("(D) a normal worktree under the root is allowed", refuse(inRoot("proj", "task1"), [nestedRepo, repo], R) === null);
  check("(D) target == registered repo ⇒ refused", refuse(nestedRepo, [nestedRepo], R) !== null);
  check("(D) target CONTAINING a registered repo (under the root) ⇒ refused", refuse(projDir, [nestedRepo], R) !== null);
  check("(D) the root itself ⇒ refused", refuse(R, [], R) !== null);
  check("(D) a path outside the root ⇒ refused", refuse(outside, [], R) !== null);
  check("(D) a sibling that only shares the root's name prefix ⇒ refused", refuse(`${R}-evil${path.sep}x`, [], R) !== null);
  check("(D) trailing separators / redundant segments normalize", refuse(nestedRepo + path.sep + "." + path.sep, [nestedRepo], R) !== null);
  if (process.platform === "win32") {
    check("(D) win32: comparison is case-insensitive", refuse(nestedRepo.toUpperCase(), [nestedRepo.toLowerCase()], R) !== null);
  }
  let linkOk = false;
  const link = inRoot("proj", "linked");
  try { fs.symlinkSync(nestedRepo, link, "junction"); linkOk = true; } catch { /* no link privilege — case skipped, not passed */ }
  if (linkOk) {
    check("(D) a link under the root that resolves INTO a repo ⇒ refused (realpath checked)", refuse(link, [nestedRepo], R) !== null);
    fs.unlinkSync(link); // drop the link itself before cleanup can walk it
  } else console.log("SKIP  (D) link case — could not create a junction/symlink on this host");
  // negative control: the predicate is not simply refusing everything.
  check("(D) negative control: an allowed path stays allowed after the refusals above", refuse(inRoot("proj", "task1"), [nestedRepo], R) === null);
}

// (J) card 623a7a62 — pathsOverlap, the SYMMETRIC containment predicate findLiveSessionClaimingWorktreePath
// now uses: equal, descendant, OR ancestor must all overlap (in EITHER argument order — deleting an
// ancestor destroys a live worktree recursively, just as deleting a descendant does); an unrelated
// sibling, including a non-existent one, must not.
const overlap = wt.pathsOverlap;
check("(J) predicate is exported", typeof overlap === "function");
if (typeof overlap === "function") {
  const liveWt = inRoot("proj2", "live-worktree");
  const liveChild = path.join(liveWt, "child-dir");
  fs.mkdirSync(liveChild, { recursive: true });
  const sibling = inRoot("proj2", "sibling-worktree");
  fs.mkdirSync(sibling, { recursive: true });

  check("(J) equal paths overlap", overlap(liveWt, liveWt) === true);
  check("(J) a descendant overlaps its ancestor (child-as-first-arg)", overlap(liveChild, liveWt) === true);
  check("(J) SYMMETRIC: the ancestor-as-first-arg direction ALSO overlaps", overlap(liveWt, liveChild) === true);
  check("(J) an unrelated sibling does NOT overlap (either order)", overlap(sibling, liveWt) === false && overlap(liveWt, sibling) === false);

  const nonExistentChild = path.join(liveWt, "never-created-leaf");
  check("(J) a NON-EXISTENT target that would be a child of a live path still overlaps (errs toward refusing)",
    overlap(nonExistentChild, liveWt) === true && overlap(liveWt, nonExistentChild) === true);
  const nonExistentSibling = inRoot("proj2", "never-created-sibling");
  check("(J) a NON-EXISTENT, unrelated sibling does NOT overlap (absence alone isn't containment)",
    overlap(nonExistentSibling, liveWt) === false);

  if (process.platform === "win32") {
    check("(J) win32: case-variant forms still overlap", overlap(liveChild.toUpperCase(), liveWt.toLowerCase()) === true);
  } else {
    console.log("SKIP  (J-win32) case-insensitive matching is a win32-only guarantee (normForCompare only lowercases on win32) — not exercised on this platform.");
  }

  let jLinkOk = false;
  const jLink = inRoot("proj2", "linked-into-live");
  try { fs.symlinkSync(liveWt, jLink, "junction"); jLinkOk = true; } catch { /* no link privilege */ }
  if (jLinkOk) {
    check("(J) a junction/symlink that resolves INTO a live path overlaps (realpath checked)", overlap(jLink, liveWt) === true);
    fs.unlinkSync(jLink); // drop the link itself before cleanup can walk it
  } else console.log("SKIP  (J) junction case — could not create a junction/symlink on this host");

  // negative control: the predicate is not simply returning true for everything.
  check("(J) negative control: an unrelated sibling still doesn't overlap after the positives above", overlap(sibling, liveWt) === false);
}

// (K) card 623a7a62 round 3 — normForCompare folds a Windows extended-length ("\\?\"/"\\?\UNC\") path
// prefix to its ordinary drive/UNC form, so a long-path-prefixed form and its plain twin compare equal
// under BOTH pathsOverlap and worktreeRemovalRefusal (both share containmentForms). win32-only; realpath
// can hand back either form for the exact same path depending on length, and before this fix the two
// forms compared as unrelated paths, failing the containment check OPEN.
if (process.platform === "win32") {
  const BS = "\\"; // spelled out via a single escaped backslash, not a multi-backslash literal
  const EXT_PREFIX = BS + BS + "?" + BS; // \\?\
  const EXT_UNC_PREFIX = EXT_PREFIX + "UNC" + BS; // \\?\UNC\

  const kParent = inRoot("proj3", "k-parent");
  fs.mkdirSync(kParent, { recursive: true });
  const kChild = path.join(kParent, "k-child");
  fs.mkdirSync(kChild, { recursive: true });
  const kExtendedParent = EXT_PREFIX + kParent;
  check("(K) an extended-length-prefixed (\\\\?\\) ancestor overlaps its plain descendant",
    overlap(kChild, kExtendedParent) === true);
  check("(K) ...and the reverse argument order", overlap(kExtendedParent, kChild) === true);

  const uncPlain = BS + BS + "k3test-server" + BS + "k3test-share" + BS + "some" + BS + "dir";
  const uncExtended = EXT_UNC_PREFIX + "k3test-server" + BS + "k3test-share" + BS + "some" + BS + "dir";
  check("(K) the \\\\?\\UNC\\ extended form overlaps its plain \\\\server\\share twin",
    overlap(uncPlain, uncExtended) === true && overlap(uncExtended, uncPlain) === true);

  const kRepo = nestedRepo; // real, existing registered repo path from section (D)
  const kRepoExtended = EXT_PREFIX + kRepo;
  check("(K) the repo-root guard refuses a \\\\?\\-prefixed registered repo path (target plain, registry extended)",
    refuse(kRepo, [kRepoExtended], R) !== null);
  check("(K) ...and the reverse direction (target \\\\?\\-prefixed, registry plain)",
    refuse(kRepoExtended, [kRepo], R) !== null);

  // negative control: an unrelated extended-prefixed sibling must NOT overlap.
  const kSibling = inRoot("proj3", "k-sibling");
  fs.mkdirSync(kSibling, { recursive: true });
  check("(K) negative control: an extended-prefixed, UNRELATED sibling does not overlap",
    overlap(EXT_PREFIX + kSibling, kParent) === false);
} else {
  console.log("SKIP  (K) Windows extended-length path prefix folding is a win32-only concern — not exercised on this platform.");
}

db.close?.();
if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nall checks passed");
