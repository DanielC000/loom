import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e34d475c, Round 4, MINOR item 2 — a POSITIVE CONTROL for the own-row/sibling cleanup-only path's
// branch delete: today's other own-row fixtures (pass-a-stuck-worktree-no-replay.mjs's DIRTY/
// NESTEDBLOCKED, and its own base fixture) all either pre-delete the branch before reconciling or exist
// specifically to prove the branch SURVIVES. None of them proves the ordinary case — nothing dirty,
// nothing nested, and the worktree is GENUINELY removable — still deletes the branch at its landed tip.
// This needs its OWN SessionService with a REAL (non-stubbed) `removeDir`, deliberately NOT the one
// pass-a-stuck-worktree-no-replay.mjs shares across its fixtures: that file's `removeDir` ALWAYS reports
// a clean-reject failure (by design, to prove the stuck-forever case), so a worktree there can NEVER be
// genuinely de-registered — `listCheckedOutBranches` would correctly keep holding its branch, which is
// NOT "nothing blocking it," it's the same retained shape as a dirty/nested-blocked worktree via a
// different gcWorktreeDir outcome. Proving the real positive case needs a worktree that actually comes
// off disk.
// Run: 1) build daemon (pnpm build), 2) node test/pass-a-own-row-cleanup-deletes-branch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";

const tmpHome = path.join(os.tmpdir(), `loom-paownclean-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=paownclean@loom -c user.name=paownclean";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const repo = path.join(os.tmpdir(), `loom-paownclean-repo-${sfx}`);
const projId = `paownclean-proj-${sfx}`, agentId = `paownclean-agent-${sfx}`, taskId = `paownclean-task-${sfx}`;
const mgrId = `paownclean-mgr-${sfx}`, workerId = `paownclean-wkr-${sfx}`;

const db = new Db();
// NO removeDir override — the real, killable removal runs, so a clean worktree genuinely comes off disk.
const sessions = new SessionService(db, {}, new OrchestrationControl());

try {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# paownclean\n");
  execSync(`git init -q && git config user.email paownclean@loom && git config user.name paownclean`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feat.txt"), "landed work\n");
  commitAll(worktreePath, "feat", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "PAOWNCLEAN-TASK" -m "Loom-Worker-Branch: ${branch}"`, { cwd: repo });

  db.insertProject({ id: projId, name: "PAOWNCLEAN", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "PAOWNCLEAN-TASK", body: "", columnKey: "done", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  // An own-row "already finalized" landing: a merge_request followed by its own merge_done, for this
  // exact task+branch — the shape `alreadyFinalized` matches on (see service.ts's eventPresenceMap /
  // workerEventPresenceKey(taskId, branch) lookup).
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerId, taskId, kind: "merge_request", detail: { branch, filesChanged: 1, tip: branch, repoKey: null } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerId, taskId, kind: "merge_done", detail: { branch, repoKey: null } });

  check("(pre) worktree present, nothing dirty/nested", fs.existsSync(worktreePath));
  check("(pre) branch present at its landed tip", git(repo, `branch --list ${branch}`) !== "");

  const result = await sessions.reconcileOrchestrationOnBoot();

  check("(post) worktree ACTUALLY REMOVED — nothing blocked it", !fs.existsSync(worktreePath));
  check("(post) branch ACTUALLY DELETED — the own-row cleanup-only path still deletes at the landed tip when nothing retains it", git(repo, `branch --list ${branch}`) === "");
  check("(post) still exactly ONE merge_done (no replay, never re-finalized)", db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_done").length === 1);
  check("(post) no worker_retired filed (cleanup-only, never a genuine finalize)", db.listEventsForWorker(workerId).every((e) => e.kind !== "worker_retired"));
  check("(post) reconcile reports no fresh 'finished' merge for this cleanup-only pass", result.mergesFinished === 0);
  check("(post) reconcile reports no failure for this worker", result.mergesFailed === 0);
} finally {
  db.close();
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an own-row cleanup-only retry whose worktree is genuinely removable (nothing dirty, nothing nested) still removes the worktree AND deletes the branch at its landed tip, exactly as before the Round-4 gating fix — the fix only changed behavior for a RETAINED worktree, never for the ordinary case."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
