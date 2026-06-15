import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Merge-gate STRANDED-WORK backstop test. REAL git on temp repos, NO claude and NO live daemon —
// drives SessionService.reviewWorkerMerge() / confirmWorkerMerge() directly against an isolated
// LOOM_HOME (mirrors merge-finalize-resilient.mjs's in-process style).
//
// THE BUG IT GUARDS (incident: worker 712fd5aa, commit 1309552): a worker that commits to a
// SELF-CREATED branch instead of its assigned `loom/<key>` leaves the assigned branch 0 commits ahead
// of canonical main, so reviewWorkerMerge reads an EMPTY diff and confirmWorkerMerge does an empty
// `--no-ff` merge — the real work is silently LOST.
//
// Proves:
//   (A) STRANDED — worktree HEAD is on a self-created branch with a commit while the assigned branch is
//       empty: reviewWorkerMerge surfaces a WARNING naming the divergent branch + tip SHA + ahead-count,
//       AND confirmWorkerMerge REFUSES (merged:false, names the branch) WITHOUT running the empty merge
//       (canonical repo untouched, branch not deleted, task NOT moved to done).
//   (B) NORMAL — a worker that committed on its ASSIGNED branch reviews (no warning, real diff) and
//       merges (merged:true) exactly as before — the non-stranded path is unchanged.
// Run: 1) build daemon (pnpm build), 2) node test/merge-stranded-backstop.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-msb-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, detectStrandedWork } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=msb@loom -c user.name=msb";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

const db = new Db();
// These paths only touch pty.stop / pty.isAlive / pty.enqueueStdin; a no-pty (exited) worker row makes
// isAlive false, so a stub keeps it hermetic.
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

const mergeDoneCount = (mgrId) => db.listEvents(mgrId).filter((e) => e.kind === "merge_done").length;

// gateCommand left EMPTY so confirmWorkerMerge skips the build gate and (when not stranded) goes
// straight to the merge — keeping the test claude-free and cwd-independent.
function seed(p) {
  db.insertProject({ id: p.projId, name: "MSB", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MSB-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# msb\n");
  // Configure a git identity so the daemon's PLAIN squash `git commit` (no `-c` overrides) has an author.
  execSync(`git init -q && git config user.email msb@loom && git config user.name msb && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

// STRANDED worker: create the worktree (on assigned `loom/<key>`), then have the worker cut its OWN
// branch and commit THERE — leaving the assigned branch empty, exactly the incident shape.
async function setupStranded(p) {
  initRepo(p.repo);
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  execSync(`git ${GIT_ID} checkout -q -b ${p.selfBranch}`, { cwd: worktreePath });
  fs.writeFileSync(path.join(worktreePath, p.file), "stranded worker change\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath });
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

// NORMAL worker: commit on the assigned branch (the worktree's default checkout) — the unchanged path.
async function setupNormal(p) {
  initRepo(p.repo);
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "normal worker change\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath });
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const S = { projId: `msb-s-proj-${sfx}`, agentId: `msb-s-top-${sfx}`, taskId: `msb-s-task-${sfx}`, mgrId: `msb-s-mgr-${sfx}`, workerId: `msb-s-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-msb-stranded-${sfx}`), file: "stranded.txt", selfBranch: "my-own-branch" };
const N = { projId: `msb-n-proj-${sfx}`, agentId: `msb-n-top-${sfx}`, taskId: `msb-n-task-${sfx}`, mgrId: `msb-n-mgr-${sfx}`, workerId: `msb-n-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-msb-normal-${sfx}`), file: "normal.txt" };

try {
  await setupStranded(S);
  await setupNormal(N);

  // ── (A) STRANDED ──────────────────────────────────────────────────────────────────────────────
  // detectStrandedWork (unit) names the divergent branch + tip + ahead-count.
  const det = await detectStrandedWork(S.repo, S.worktreePath, S.branch);
  check("(stranded) detectStrandedWork → stranded:true", det.stranded === true);
  check("(stranded) names the self-created branch", det.branch === S.selfBranch);
  check("(stranded) reports ahead=1", det.ahead === 1);
  check("(stranded) reports a tip SHA", typeof det.commit === "string" && det.commit.length >= 4);

  // reviewWorkerMerge surfaces the warning (and the diff fields still present).
  const review = await sessions.reviewWorkerMerge(S.mgrId, S.workerId);
  check("(stranded) reviewWorkerMerge surfaces a warning", typeof review.warning === "string" && review.warning.length > 0);
  check("(stranded) warning names the divergent branch", review.warning.includes(S.selfBranch));
  check("(stranded) warning names the assigned (empty) branch", review.warning.includes(S.branch));
  check("(stranded) warning names the tip SHA", review.warning.includes(det.commit));
  check("(stranded) diff fields still present (empty diff — assigned branch is 0-ahead)", review.filesChanged === 0);

  // confirmWorkerMerge REFUSES — no empty merge, repo/branch/task untouched.
  const mainBefore = git(S.repo, "rev-parse HEAD");
  const confirm = await sessions.confirmWorkerMerge(S.mgrId, S.workerId);
  check("(stranded) confirmWorkerMerge → merged:false", confirm.merged === false);
  check("(stranded) refusal reason names the divergent branch", typeof confirm.reason === "string" && confirm.reason.includes(S.selfBranch));
  check("(stranded) canonical HEAD UNCHANGED (no empty merge committed)", git(S.repo, "rev-parse HEAD") === mainBefore);
  check("(stranded) assigned branch NOT deleted (worktree retained for recovery)", git(S.repo, `branch --list ${S.branch}`) !== "");
  check("(stranded) task NOT moved to done", db.getTask(S.taskId).columnKey !== "done");
  check("(stranded) merge_done NOT recorded", mergeDoneCount(S.mgrId) === 0);
  check("(stranded) a merge_rejected(reason:stranded) event recorded",
    db.listEvents(S.mgrId).some((e) => e.kind === "merge_rejected" && e.detail && e.detail.reason === "stranded"));

  // ── (B) NORMAL (unchanged path) ───────────────────────────────────────────────────────────────
  const detN = await detectStrandedWork(N.repo, N.worktreePath, N.branch);
  check("(normal) detectStrandedWork → stranded:false (work is on the assigned branch)", detN.stranded === false);

  const reviewN = await sessions.reviewWorkerMerge(N.mgrId, N.workerId, { includePatch: true });
  check("(normal) reviewWorkerMerge → NO warning", reviewN.warning === undefined);
  check("(normal) reviewWorkerMerge shows the real diff", reviewN.filesChanged === 1 && reviewN.patch.includes(N.file));

  const headNBefore = git(N.repo, "rev-parse HEAD");
  const confirmN = await sessions.confirmWorkerMerge(N.mgrId, N.workerId);
  check("(normal) confirmWorkerMerge → merged:true", confirmN.merged === true);
  check("(normal) file landed on canonical repo", fs.existsSync(path.join(N.repo, N.file)));
  check("(normal) exactly ONE non-merge commit landed (squash, no `Merge branch` noise)",
    git(N.repo, `rev-list --count ${headNBefore}..HEAD`) === "1" &&
    git(N.repo, "rev-list --parents -n 1 HEAD").trim().split(/\s+/).length === 2);
  check("(normal) assigned branch deleted after merge", git(N.repo, `branch --list ${N.branch}`) === "");
  check("(normal) task moved to done", db.getTask(N.taskId).columnKey === "done");
  check("(normal) merge_done recorded (exactly 1)", mergeDoneCount(N.mgrId) === 1);
} finally {
  db.close();
  for (const p of [S, N]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a worker whose commits are stranded on a self-created branch is caught: reviewWorkerMerge warns and confirmWorkerMerge refuses the empty merge (work preserved); a normal worker on its assigned branch reviews + merges unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
