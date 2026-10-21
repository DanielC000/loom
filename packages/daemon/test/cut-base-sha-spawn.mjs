import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0eaaa693 round 2 — a REAL spawnWorker test for WorktreeInfo.cutBaseAdvanced's own cutBaseSha
// derivation (`cutBaseAdvanced ? cutBaseMainSha : this.priorCutBaseShaForWorktree(...)`,
// sessions/service.ts's spawnWorker). cut-base-sha-recycle-carry.mjs proves recycleWorker/resume CARRY an
// already-stamped value forward; this file proves the STAMPING itself, through the real spawnWorker path
// (never a hand-constructed Session row), for all three cut/reuse shapes WorktreeInfo.cutBaseAdvanced
// distinguishes:
//   (1) a FRESH `-b` cut stamps cutBaseSha to the canonical repo's real HEAD at cut time.
//   (2) a 0-AHEAD respawn on the SAME task (no commits made by the prior worker) RECUTS onto the
//       (now-advanced) main — the new worker's cutBaseSha ADVANCES to the new main tip, never the stale
//       original.
//   (3) a >0-AHEAD respawn on the SAME task (the prior worker left a real, unmerged commit) RETAINS the
//       branch — the new worker's cutBaseSha CARRIES FORWARD the prior worker's own recorded value (via
//       priorCutBaseShaForWorktree), never the reuse-time HEAD.
//   (4) round 5 (Code Review ff5de408, item 2): the SAME carry-forward as (3), through createWorktree's
//       OTHER cutBaseAdvanced:false route — the REATTACH path (worktree dir removed via `git worktree
//       remove`, branch retained; `branchExists:true`, `reattachRecut:false` since the branch is >0
//       ahead). (3) only exercises the dir-still-present reuse route; this closes the untested sibling.
//
// REAL Db + SessionService driven against a FAKE pty (createPty seam), a real temp git repo behind
// createWorktree — mirrors worker-spawn-live-task-guard.mjs's own harness. DETERMINISTIC + CLAUDE-FREE +
// NETWORK-FREE.
//
// Run: 1) build (turbo builds shared first), 2) node test/cut-base-sha-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-cbss-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { removeWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=cbss@loom -c user.name=cbss";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const repo = path.join(os.tmpdir(), `loom-cbss-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# cut-base-sha-spawn test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", GIT_ID);

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

class SeamHost extends createSeamHost(PtyHost) {}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const worktrees = [];
try {
  // ===================== (1) a FRESH cut stamps cutBaseSha to the real canonical HEAD =====================
  const taskA = randomUUID();
  db.insertTask({ id: taskA, projectId: "pP", title: "task A", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  const c0 = git(repo, "rev-parse HEAD");
  const wA1 = await svc.spawnWorker("mgr1", { taskId: taskA, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(wA1.worktreePath);
  check("(1) a fresh cut's cutBaseSha equals the canonical HEAD at cut time", wA1.cutBaseSha === c0);
  check("(1) persisted via getSession too", db.getSession(wA1.id)?.cutBaseSha === c0);

  // ===================== (2) a 0-AHEAD respawn on the SAME task RECUTS and ADVANCES cutBaseSha =====================
  // Worker A1 dies with NO commits of its own (0 ahead) — the legit re-spawn-after-rejected-merge case.
  db.setProcessState(wA1.id, "exited");
  // Main advances AFTER the first cut, BEFORE the re-spawn.
  fs.writeFileSync(path.join(repo, "main-advance-1.txt"), "main advanced\n");
  commitAll(repo, "main advances before re-spawn", GIT_ID);
  const c1 = git(repo, "rev-parse HEAD");
  check("(2 setup) main genuinely advanced past the first cut", c1 !== c0);

  const wA2 = await svc.spawnWorker("mgr1", { taskId: taskA, agentId: "agentDev", kickoffPrompt: "GO AGAIN" });
  worktrees.push(wA2.worktreePath);
  check("(2) a 0-ahead respawn's cutBaseSha ADVANCES to the new main tip", wA2.cutBaseSha === c1);
  check("(2) NOT the stale original cut base", wA2.cutBaseSha !== c0);
  check("(2) the respawn reused the SAME worktree dir as the first cut", wA2.worktreePath === wA1.worktreePath);

  // ===================== (3) a >0-AHEAD respawn on the SAME task CARRIES the PRIOR cutBaseSha forward =====================
  const taskB = randomUUID();
  db.insertTask({ id: taskB, projectId: "pP", title: "task B", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
  const wB1 = await svc.spawnWorker("mgr1", { taskId: taskB, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(wB1.worktreePath);
  check("(3 setup) worker B1's fresh cut stamps cutBaseSha to the (now-advanced) canonical HEAD", wB1.cutBaseSha === c1);

  // Worker B1 leaves a REAL, unmerged commit on its own branch — now >0 ahead of main.
  fs.writeFileSync(path.join(wB1.worktreePath, "b-work.txt"), "unmerged work\n");
  commitAll(wB1.worktreePath, "worker B1 commit (never merged)", GIT_ID);
  db.setProcessState(wB1.id, "exited"); // died / rejected merge — the legit re-spawn case, but with real unmerged work

  // Main advances AGAIN before the re-spawn.
  fs.writeFileSync(path.join(repo, "main-advance-2.txt"), "main advanced again\n");
  commitAll(repo, "main advances again before B re-spawn", GIT_ID);
  const c2 = git(repo, "rev-parse HEAD");
  check("(3 setup) main genuinely advanced again", c2 !== c1);

  const wB2 = await svc.spawnWorker("mgr1", { taskId: taskB, agentId: "agentDev", kickoffPrompt: "GO AGAIN" });
  worktrees.push(wB2.worktreePath);
  check("(3) a >0-ahead respawn's cutBaseSha CARRIES FORWARD the prior worker's recorded value", wB2.cutBaseSha === c1);
  check("(3) NOT the reuse-time HEAD (the branch was RETAINED, never recut)", wB2.cutBaseSha !== c2);
  check("(3) the retained branch still carries B1's unmerged commit (never reset --hard)", fs.existsSync(path.join(wB2.worktreePath, "b-work.txt")));
  check("(3) the respawn reused the SAME worktree dir as B1", wB2.worktreePath === wB1.worktreePath);

  // ===================== (4) round 5 (Code Review ff5de408, item 2): the REATTACH path (worktree dir
  // GONE, branch RETAINED) must carry the PRIOR cutBaseSha forward too — same outcome as (3) above, but
  // through createWorktree's OTHER `cutBaseAdvanced:false` route (`!branchExists || reattachRecut` —
  // `branchExists:true` here, and `reattachRecut:false` since the retained branch is >0 ahead, so
  // `recutStaleReusedBranch` never resets it). (3) above only exercises the DIR-STILL-PRESENT reuse
  // route (`fs.existsSync(worktreePath)` true) — a regression that stamped the reuse-time HEAD on THIS
  // route specifically would pass (3) unchanged and still let a diverged branch's cutBaseSha silently
  // read as "current", defeating card 0eaaa693's whole fork-point check on exactly the worker whose
  // worktree happened to get cleaned up (e.g. a disk-reclaim sweep) while its branch survived. =====================
  const taskC = randomUUID();
  db.insertTask({ id: taskC, projectId: "pP", title: "task C", body: "", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });
  const wC1 = await svc.spawnWorker("mgr1", { taskId: taskC, agentId: "agentDev", kickoffPrompt: "GO" });
  worktrees.push(wC1.worktreePath);
  check("(4 setup) worker C1's fresh cut stamps cutBaseSha to the (now-twice-advanced) canonical HEAD", wC1.cutBaseSha === c2);

  // A REAL, unmerged commit on C1's own branch — now >0 ahead of main, so the branch must be RETAINED
  // (never recut) on reattach.
  fs.writeFileSync(path.join(wC1.worktreePath, "c-work.txt"), "unmerged work\n");
  commitAll(wC1.worktreePath, "worker C1 commit (never merged)", GIT_ID);
  db.setProcessState(wC1.id, "exited");

  // Remove the WORKTREE (directory + admin record) while leaving the BRANCH itself intact — `git
  // worktree remove` never deletes the branch ref, only the checkout. This is the reattach precondition:
  // `fs.existsSync(worktreePath)` now reads false, so createWorktree's `branchExists` path runs instead
  // of the dir-reuse path (3) above exercises.
  const removal = await removeWorktree(repo, wC1.worktreePath);
  check("(4 setup) the worktree directory was actually removed (branch untouched)", removal.removed === true && !fs.existsSync(wC1.worktreePath));
  check("(4 setup) the branch itself survived the worktree removal", git(repo, `branch --list ${wC1.branch}`) !== "");

  // Main advances AGAIN after the removal, before the respawn — the reuse-time HEAD a regression would
  // wrongly stamp, distinct from both c2 (C1's real cut base) and c1.
  fs.writeFileSync(path.join(repo, "main-advance-3.txt"), "main advanced a third time\n");
  commitAll(repo, "main advances again before C re-spawn (reattach)", GIT_ID);
  const c3 = git(repo, "rev-parse HEAD");
  check("(4 setup) main genuinely advanced again past C1's cut base", c3 !== c2);

  const wC2 = await svc.spawnWorker("mgr1", { taskId: taskC, agentId: "agentDev", kickoffPrompt: "GO AGAIN (reattach)" });
  worktrees.push(wC2.worktreePath);
  check("(4) a REATTACH respawn's cutBaseSha CARRIES FORWARD the prior worker's recorded value", wC2.cutBaseSha === c2);
  check("(4) NOT the reuse-time HEAD (the branch was RETAINED via reattach, never recut)", wC2.cutBaseSha !== c3);
  check("(4) persisted via getSession too", db.getSession(wC2.id)?.cutBaseSha === c2);
  check("(4) the reattached branch still carries C1's unmerged commit (never reset --hard)", fs.existsSync(path.join(wC2.worktreePath, "c-work.txt")));
  check("(4) the respawn reattached the SAME worktree path as C1", wC2.worktreePath === wC1.worktreePath);
} finally {
  try {
    for (const wt of [...new Set(worktrees.filter(Boolean))]) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — spawnWorker stamps a fresh cut's cutBaseSha to the real canonical HEAD, advances it on a 0-ahead recut respawn, and carries the PRIOR worker's recorded value forward (never the reuse-time HEAD) on BOTH a >0-ahead retained-dir respawn (3) and a >0-ahead REATTACH respawn whose worktree dir was removed first (4) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
