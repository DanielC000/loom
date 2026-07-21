import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// STALE-BASE merge-review backstop test (card 5150fdc2 part 4). REAL git on temp repos, NO claude and NO
// live daemon — drives SessionService.reviewWorkerMerge() directly against an isolated LOOM_HOME (mirrors
// merge-stranded-backstop.mjs's in-process style).
//
// THE GAP IT GUARDS: a worker's branch can fall behind main (a recovery branch whose base moved on, or one
// spawned before card 5150fdc2's spawn-time detection existed) with NO signal at review time — the manager
// approves `worker_merge` blind to the fact that confirmWorkerMerge's own union-merge is about to try
// (and might fail) to forward the branch. This is "cheap honesty" — independent of whether the spawn-time
// staleBase detection ran for this worker at all.
//
// Proves:
//   (A) BEHIND — main advanced past the branch's fork point: reviewWorkerMerge surfaces `behindMain:<n>`
//       plus a "STALE BASE" clause folded into `warning`, and the diff fields are still the real ones.
//   (B) CAUGHT UP — a branch whose base is NOT behind main (the normal case): no `behindMain`, no
//       stale-base warning clause — the unchanged path.
// Run: 1) build daemon (pnpm build), 2) node test/merge-stale-base-backstop.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-msbb-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, countCommitsBehind } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=msbb@loom -c user.name=msbb";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

const db = new Db();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

function seed(p) {
  db.insertProject({ id: p.projId, name: "MSBB", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MSBB-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# msbb\n");
  execSync(`git init -q && git config user.email msbb@loom && git config user.name msbb && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const A = { projId: `msbb-a-proj-${sfx}`, agentId: `msbb-a-top-${sfx}`, taskId: `msbb-a-task-${sfx}`, mgrId: `msbb-a-mgr-${sfx}`, workerId: `msbb-a-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-msbb-behind-${sfx}`), file: "behind.txt" };
const B = { projId: `msbb-b-proj-${sfx}`, agentId: `msbb-b-top-${sfx}`, taskId: `msbb-b-task-${sfx}`, mgrId: `msbb-b-mgr-${sfx}`, workerId: `msbb-b-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-msbb-caughtup-${sfx}`), file: "caughtup.txt" };

try {
  // ── (A) BEHIND: worker commits on its branch, THEN main advances past the branch's fork point ──────
  initRepo(A.repo);
  {
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = worktreePath; A.branch = branch;
    fs.writeFileSync(path.join(worktreePath, A.file), "work for A\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${A.file}"`, { cwd: worktreePath });
    // Main advances AFTER the branch was cut — the branch's history now misses this commit.
    fs.writeFileSync(path.join(A.repo, "main-advance-a.txt"), "main moved forward\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "main advance a"`, { cwd: A.repo });
    seed(A);

    const behind = await countCommitsBehind(A.repo, A.branch, "HEAD");
    check("(A) precondition: countCommitsBehind reports 1", behind === 1);

    const review = await sessions.reviewWorkerMerge(A.mgrId, A.workerId);
    check("(A) reviewWorkerMerge surfaces behindMain:1", review.behindMain === 1);
    check("(A) warning carries a STALE BASE clause", typeof review.warning === "string" && /STALE BASE/.test(review.warning));
    check("(A) warning names the behind-by count", review.warning.includes("1 commit(s) behind"));
    check("(A) diff fields still reflect the real branch diff (not clobbered by the stale-base check)",
      review.filesChanged === 1 && review.files.some((f) => f.file === A.file));
    check("(A) merge_request event carries behindMain",
      db.listEvents(A.mgrId).some((e) => e.kind === "merge_request" && e.detail?.behindMain === 1));
  }

  // ── (B) CAUGHT UP: worker commits on its branch, main does NOT advance — the unchanged path ─────────
  initRepo(B.repo);
  {
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    B.worktreePath = worktreePath; B.branch = branch;
    fs.writeFileSync(path.join(worktreePath, B.file), "work for B\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${B.file}"`, { cwd: worktreePath });
    seed(B);

    const behind = await countCommitsBehind(B.repo, B.branch, "HEAD");
    check("(B) precondition: countCommitsBehind reports 0 (branch forked at current HEAD)", behind === 0);

    const review = await sessions.reviewWorkerMerge(B.mgrId, B.workerId);
    check("(B) reviewWorkerMerge → NO behindMain", review.behindMain === undefined);
    check("(B) reviewWorkerMerge → NO warning at all", review.warning === undefined);
    check("(B) diff fields reflect the real branch diff", review.filesChanged === 1 && review.files.some((f) => f.file === B.file));
    const mergeRequestB = db.listEvents(B.mgrId).find((e) => e.kind === "merge_request");
    check("(B) a merge_request event was recorded", mergeRequestB !== undefined);
    check("(B) merge_request event carries NO behindMain", mergeRequestB?.detail?.behindMain === undefined);
  }
} finally {
  db.close();
  for (const p of [A, B]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_merge's review step now surfaces a branch's staleness against current main independent of the spawn-time detection: `behindMain` + a STALE BASE warning clause when the branch is behind, absent entirely when it's caught up."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
