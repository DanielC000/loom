import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// THE finalizeMerge CAS-SKIP UNIT — split out of batch-merge-retain-hold-release.mjs by card 03b4f491
// (see docs/decisions/03b4f491-*.md): that file ran 24-33s solo but was SIGTERM-killed at the 120s
// ceiling in an advisory ~695-file check on a loaded host. This case is fully independent of the real
// mixed-batch setup the sibling files share — it needs only its own single worktree.
//   (cas-skip) finalizeMerge must not CAS-delete a branch whose worktree was NOT removed (update-ref -d, unlike branch -D, would delete a
//              branch still checked out in a live worktree)
// Run: 1) pnpm build, 2) node packages/daemon/test/batch-merge-retain-hold-release-cas-skip.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmrh-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=bmrh@loom -c user.name=bmrh";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const refExists = (repo, ref) => { try { git(repo, `rev-parse --verify --quiet refs/heads/${ref}`); return true; } catch { return false; } };

const dbs = [];
function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-bmrh-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmrh\n");
  execSync(`git init -q && git config user.email bmrh@loom && git config user.name bmrh`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };

try {
  // ── (unit) finalizeMerge must not CAS-delete a branch whose worktree was NOT removed ──────────────────
  const repo2 = makeRepo("fin");
  const proj2 = `bmrh-proj-fin-${sfx}`, agent2 = `bmrh-agent-fin-${sfx}`, mgr2 = `bmrh-mgr-fin-${sfx}`, w2 = `bmrh-wkr-fin-${sfx}`, task2 = `bmrh-task-fin-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo2, proj2, task2);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "f.txt"), "f\n");
  commitAll(worktreePath, "f", GIT_ID);
  const tip = git(worktreePath, "rev-parse HEAD");
  const db2 = new Db(); dbs.push(db2);
  db2.insertProject({ id: proj2, name: "BMRH-fin", repoPath: repo2, vaultPath: repo2, config: {}, createdAt: now, archivedAt: null });
  db2.insertAgent({ id: agent2, projectId: proj2, name: "dev", startupPrompt: "", position: 0 });
  db2.insertSession({ id: mgr2, projectId: proj2, agentId: agent2, engineSessionId: null, title: null, cwd: repo2, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db2.insertTask({ id: task2, projectId: proj2, title: "feat(test): fin", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db2.insertSession({ id: w2, projectId: proj2, agentId: agent2, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgr2, taskId: task2, worktreePath, branch });
  // The worktree is recorded as needing a human (a wedged removal that gave up) ⇒ gcWorktreeDir returns "needs-human-skip" and
  // the worktree stays on disk (gc outcome is not "removed").
  db2.recordWorktreeWedgeAttempt(worktreePath, repo2, "test: simulated wedged removal");
  db2.markWorktreeNeedsHuman(worktreePath);
  const stuck = new SessionService(db2, ptyStub, new OrchestrationControl());
  let retained = false;
  await stuck.finalizeMerge({ managerSessionId: mgr2, workerSessionId: w2, taskId: task2, worktreePath, branch, repoPath: repo2, projectId: proj2, mergedSha: tip, repoKey: null, expectedBranchTip: tip, onBranchRetained: () => { retained = true; } });
  check("(cas-skip) the worktree really was NOT removed (setup)", fs.existsSync(worktreePath));
  check("(cas-skip) the branch is NOT deleted while its worktree is still checked out on it (update-ref -d would have deleted it)", refExists(repo2, branch));
  check("(cas-skip) it is not misreported as a moved-tip retain, and the finalize bookkeeping still ran (task moved, merge_done filed)",
    retained === false && db2.getTask(task2)?.columnKey !== "in_progress" && db2.listEventsForWorker(w2).some((e) => e.kind === "merge_done"));
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
