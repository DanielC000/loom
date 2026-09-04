import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b866ab64: a review spawn's branch is cut from the tip of the REVIEWED branch (createWorktree's
// `forkFrom` param), not from mainline HEAD — so a reviewer's worktree starts out already carrying every
// commit the reviewed branch had at fork time, even though the reviewer (by design) authors nothing. The
// worker_report(done) ahead-of-base precheck (precheckWorkerDone) used to unconditionally compare against
// mainline HEAD, so that inherited commit always counted as "ahead of base" — making noChanges:true
// STRUCTURALLY UNREACHABLE for every review spawn. Fixed by stamping `Session.reviewBaseSha` (the
// reviewed branch's tip sha, captured at spawn time — see sessions/service.ts spawnWorker) and comparing
// against THAT instead of "HEAD" whenever it's set.
//
// REAL git on temp repos, NO claude and NO live daemon — drives SessionService.workerReport() directly
// against an isolated LOOM_HOME (mirrors worker-report-precheck.mjs's in-process style). Taskless, as a
// real review spawn is (see sessions/service.ts spawnWorker's review-spawn branch).
//
// TWO ARMS — DoD b866ab64 is explicit that BOTH are required; fixing only (A) would remove a real guard:
//   (A) POSITIVE — a review worker that authored NOTHING (worktree byte-identical to the reviewed tip,
//       clean) reports done+noChanges:true and is NOT refused (auto-retires via the noCommit-role path).
//   (B) NEGATIVE control — a review worker that DID commit something of its own is STILL REFUSED when it
//       (incorrectly) claims noChanges:true, and the refusal message names the REAL base (the reviewed
//       tip) instead of sending the reviewer hunting for "uncommitted" work or leaving it to wonder
//       whether its branch should be merged.
// Run: 1) build daemon (pnpm build), 2) node test/review-spawn-nochanges.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rsn-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=rsn@loom -c user.name=rsn";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const db = new Db();
// workerReport only touches pty.enqueueStdin (manager notification) on this path; a stub returning
// {delivered} keeps it hermetic — no real claude, no live daemon.
const ptyStub = { enqueueStdin() { return { delivered: true }; } };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# rsn\n");
  execSync(`git init -q && git config user.email rsn@loom && git config user.name rsn`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

const repo = path.join(os.tmpdir(), `loom-rsn-repo-${sfx}`);
const projId = `rsn-proj-${sfx}`;
const agentId = `rsn-ag-${sfx}`;
const mgrId = `rsn-mgr-${sfx}`;
const cleanupDirs = [repo];

initRepo(repo);
db.insertProject({ id: projId, name: "RSN", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

// ── The "author" branch under review: cut off mainline HEAD, one real commit — exactly what a review
// spawn's `reviewOfWorkerSessionId`/`reviewOfTaskId` resolves to (sessions/service.ts spawnWorker).
const authorTaskId = `rsn-author-task-${sfx}`;
const { worktreePath: authorWt, branch: authorBranch } = await createWorktree(repo, projId, authorTaskId);
cleanupDirs.push(authorWt);
fs.writeFileSync(path.join(authorWt, "feature.txt"), "the reviewed change\n");
commitAll(authorWt, "feature", GIT_ID);
// The exact value spawnWorker captures as `reviewForkFrom.headSha` (resolveGitRef on the reviewed branch)
// BEFORE cutting the review worktree — see Session.reviewBaseSha's doc.
const reviewedHeadSha = execSync(`git rev-parse ${authorBranch}`, { cwd: repo }).toString().trim();

// Build one review worker: a taskless worktree forked from the reviewed branch's tip (mirrors
// createWorktree's `forkFrom` call in spawnWorker), with Session.reviewBaseSha stamped exactly as
// spawnWorker stamps it.
async function buildReviewWorker(tag, { authoredExtraCommit }) {
  const taskKeySeed = `rsn-${tag}-review-${sfx}`;
  const workerId = `rsn-${tag}-wkr-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskKeySeed, {}, undefined, authorBranch);
  cleanupDirs.push(worktreePath);
  if (authoredExtraCommit) {
    fs.writeFileSync(path.join(worktreePath, "review-note.txt"), "an actual review-authored change\n");
    commitAll(worktreePath, "review edit", GIT_ID);
  }
  db.insertSession({
    id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "worker", noCommit: true, parentSessionId: mgrId, taskId: null, worktreePath, branch,
    reviewBaseSha: reviewedHeadSha,
  });
  return { workerId, worktreePath, branch };
}

try {
  // ── (A) POSITIVE: reviewer authored NOTHING — worktree is byte-identical to the reviewed tip ───────
  const A = await buildReviewWorker("a", { authoredExtraCommit: false });
  const rA = await sessions.workerReport(A.workerId, { status: "done", summary: "no findings", noChanges: true });
  check("(A) review spawn, authored nothing: reported:true, NOT refused", rA.reported === true && !rA.refused);
  check("(A) review spawn, authored nothing: no error", rA.error === undefined);
  check("(A) review spawn, authored nothing: auto-retires (noCommit role, 0-ahead of the REAL base)", rA.autoRetired === true);
  check("(A) review spawn, authored nothing: session actually retired (processState exited)", db.getSession(A.workerId).processState === "exited");

  // ── (B) NEGATIVE control: reviewer DID commit something of its own, still claims noChanges:true ────
  const B = await buildReviewWorker("b", { authoredExtraCommit: true });
  const rB = await sessions.workerReport(B.workerId, { status: "done", summary: "no findings", noChanges: true });
  check("(B) review spawn, DID author a commit: REFUSED despite noChanges:true (guard still catches real work)",
    rB.reported === false && rB.refused === true);
  check("(B) review spawn refusal names exactly 1 commit ahead of the REVIEWED TIP (not mainline)",
    typeof rB.error === "string" && rB.error.includes("1 commit(s)") && rB.error.includes(reviewedHeadSha));
  check("(B) review spawn refusal does NOT send the reviewer hunting for 'uncommitted' work",
    !/UNCOMMITTED/i.test(rB.error));
  check("(B) review spawn refusal explicitly says this branch must never be merged",
    /never be merged/i.test(rB.error));
  check("(B) review spawn refusal event recorded with aheadCount:1",
    db.listEvents(mgrId).some((e) => e.kind === "worker_report_rejected" && e.detail && e.detail.reason === "nochanges-with-commits" && e.detail.aheadCount === 1));
  check("(B) session stays live (refused, not retired)", db.getSession(B.workerId).processState === "live");
} finally {
  db.close();
  for (const dir of cleanupDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a review spawn's ahead-of-base check now compares against Session.reviewBaseSha (the reviewed branch's tip), not mainline HEAD: a reviewer that authors nothing can report noChanges:true and auto-retires; one that DID author a commit is still refused, with a message naming the real base instead of sending it hunting for uncommitted work or leaving merge status ambiguous."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
