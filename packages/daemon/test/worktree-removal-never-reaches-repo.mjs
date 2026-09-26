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

const sha0 = git(repo, "rev-parse HEAD");
await sessions.reconcileOrchestrationOnBoot(new Set());

check("(A) the primary repo directory survives a real boot reconcile", fs.existsSync(repo));
check("(A) the primary repo's .git survives", fs.existsSync(path.join(repo, ".git")));
check("(A) the primary repo's tracked file survives", fs.existsSync(path.join(repo, "tracked.txt")));
check("(A) the repo is still a usable git repo at the same HEAD", fs.existsSync(repo) && git(repo, "rev-parse HEAD") === sha0);
check("(B) a dir outside the worktrees root is refused (survives, contents intact)", fs.existsSync(path.join(outside, "keep.txt")));
check("(C) CONTROL: a normal worktree under the root is still reclaimed", !fs.existsSync(created.worktreePath));

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

db.close?.();
if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nall checks passed");
