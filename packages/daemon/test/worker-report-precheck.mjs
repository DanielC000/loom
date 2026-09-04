import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_report(done) PRE-CHECK test (board card 907b9f50). REAL git on temp repos, NO claude and NO
// live daemon — drives SessionService.workerReport() directly against an isolated LOOM_HOME (mirrors
// merge-stranded-backstop.mjs's in-process style).
//
// THE GAP IT GUARDS: a worker that forgets to commit reports done; the merge gate only ever sees
// COMMITTED work on the assigned branch, so the task sails to `review` and bounces back a wasted
// round-trip. The pre-check catches it AT THE SOURCE, while the worker can still fix it.
//
// Proves:
//   (U) UNCOMMITTED — worktree dirty (real uncommitted changes): workerReport REFUSES (reported:false,
//       refused:true, error NAMES the uncommitted files), the task STAYS in_progress (NOT moved to
//       review), and a worker_report_rejected(reason:uncommitted) event is recorded.
//   (C) COMMITTED on the assigned branch (+ injected `.claude/` untracked noise): ALLOWED UNCHANGED
//       (reported:true, no warning), task → review — proving the `.claude/` noise is ignored.
//   (Z) CLEAN + 0-ahead — clean worktree, assigned branch 0 commits ahead of base: ALLOWED with a
//       WARNING (reported:true, warning present), task → review (a real no-op task can report done).
//   (E) GIT-ERROR — worktree path is not a git repo so `git status` throws: FAIL-SAFE ALLOWED
//       (reported:true, no warning), task → review (a flaky git call must never wedge a legit done).
//   (N) NOCHANGES-WITH-COMMITS (board card 6b605d15) — clean worktree, assigned branch HAS commits ahead
//       of base, but the report DECLARES noChanges:true: workerReport REFUSES (reported:false,
//       refused:true, error names the verified commit count), the task STAYS in_progress (NOT moved to
//       review), and a worker_report_rejected(reason:nochanges-with-commits) event is recorded. This is
//       the ONLY refuse direction — the opposite (report implies work, 0 commits) is the Code Reviewer's
//       normal filesChanged:0 shape and must NEVER be refused (see no-commit-reviewer.mjs / (Z) above).
//   plus a UNIT check of precheckWorkerDone's fail-safe bound via an injected throwing git seam.
// Run: 1) build daemon (pnpm build), 2) node test/worker-report-precheck.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wrp-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, precheckWorkerDone } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=wrp@loom -c user.name=wrp";
const now = new Date().toISOString();

const db = new Db();
// workerReport only touches pty.enqueueStdin (manager notification); a stub returning {delivered} keeps
// it hermetic. No pty.stop/isAlive on this path.
const ptyStub = { enqueueStdin() { return { delivered: true }; } };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

function seed(p) {
  // `dbRepoPath`, when set, overrides `p.repo` as the PROJECT's registered repoPath — used by (P) below
  // to simulate a moved/renamed canonical repo (the actual worktree, created from the real `p.repo`,
  // stays physically intact; only the DB's resolved repoPath diverges from it).
  db.insertProject({ id: p.projId, name: "WRP", repoPath: p.dbRepoPath ?? p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "WRP-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# wrp\n");
  execSync(`git init -q && git config user.email wrp@loom && git config user.name wrp`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (tag, extra = {}) => ({
  projId: `wrp-${tag}-proj-${sfx}`, agentId: `wrp-${tag}-ag-${sfx}`, taskId: `wrp-${tag}-task-${sfx}`,
  mgrId: `wrp-${tag}-mgr-${sfx}`, workerId: `wrp-${tag}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-wrp-${tag}-${sfx}`), ...extra,
});
const U = mk("u", { file: "work.txt" });
const C = mk("c", { file: "done.txt" });
const Z = mk("z");
const E = mk("e");
const N = mk("n", { file: "sneaky.txt" });
const P = mk("p", { file: "p-work.txt" });
const all = [U, C, Z, E, N, P];

try {
  // ── (U) UNCOMMITTED → REFUSED ───────────────────────────────────────────────────────────────────
  initRepo(U.repo);
  { const { worktreePath, branch } = await createWorktree(U.repo, U.projId, U.taskId); U.worktreePath = worktreePath; U.branch = branch; }
  fs.writeFileSync(path.join(U.worktreePath, U.file), "uncommitted worker change\n"); // written, NOT committed
  seed(U);
  const rU = await sessions.workerReport(U.workerId, { status: "done", summary: "I think I'm done" });
  check("(uncommitted) workerReport → reported:false, refused:true", rU.reported === false && rU.refused === true);
  check("(uncommitted) error NAMES the uncommitted file", typeof rU.error === "string" && rU.error.includes(U.file));
  check("(uncommitted) error tells the worker not to checkout -b", rU.error.includes("git checkout -b") || rU.error.toLowerCase().includes("checkout"));
  check("(uncommitted) uncommittedFiles lists the file", Array.isArray(rU.uncommittedFiles) && rU.uncommittedFiles.includes(U.file));
  check("(uncommitted) task STAYS in_progress (NOT moved to review)", db.getTask(U.taskId).columnKey === "in_progress");
  check("(uncommitted) a worker_report_rejected(reason:uncommitted) event recorded",
    db.listEvents(U.mgrId).some((e) => e.kind === "worker_report_rejected" && e.detail && e.detail.reason === "uncommitted"));
  check("(uncommitted) NO worker_report(done) event recorded (the done never landed)",
    !db.listEvents(U.mgrId).some((e) => e.kind === "worker_report" && e.detail && e.detail.status === "done"));

  // ── (C) COMMITTED on assigned branch (+ `.claude/` noise) → ALLOWED UNCHANGED ────────────────────
  initRepo(C.repo);
  { const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId); C.worktreePath = worktreePath; C.branch = branch; }
  fs.writeFileSync(path.join(C.worktreePath, C.file), "committed worker change\n");
  commitAll(C.worktreePath, `${C.file}`, GIT_ID);
  // daemon-injected untracked `.claude/` noise must NOT count as uncommitted work:
  fs.mkdirSync(path.join(C.worktreePath, ".claude", "skills"), { recursive: true });
  fs.writeFileSync(path.join(C.worktreePath, ".claude", "skills", "noise.md"), "injected\n");
  seed(C);
  const rC = await sessions.workerReport(C.workerId, { status: "done", summary: "committed it" });
  check("(committed) workerReport → reported:true, NOT refused", rC.reported === true && !rC.refused);
  check("(committed) NO warning (clean + ahead, `.claude/` noise ignored)", rC.warning === undefined);
  check("(committed) task moved to review", db.getTask(C.taskId).columnKey === "review");

  // ── (Z) CLEAN + 0-ahead → ALLOWED with WARNING ───────────────────────────────────────────────────
  initRepo(Z.repo);
  { const { worktreePath, branch } = await createWorktree(Z.repo, Z.projId, Z.taskId); Z.worktreePath = worktreePath; Z.branch = branch; }
  seed(Z); // fresh worktree: clean working tree, assigned branch 0 commits ahead of base
  const rZ = await sessions.workerReport(Z.workerId, { status: "done", summary: "nothing to change, no-op task" });
  check("(zero-ahead) workerReport → reported:true (NOT refused — a no-op task can report done)", rZ.reported === true && !rZ.refused);
  check("(zero-ahead) a WARNING is surfaced in the result", typeof rZ.warning === "string" && rZ.warning.length > 0);
  check("(zero-ahead) warning mentions 0 commits ahead", rZ.warning.includes("0 commits ahead"));
  check("(zero-ahead) task moved to review (allowed)", db.getTask(Z.taskId).columnKey === "review");
  check("(zero-ahead) worker_report event carries the warning",
    db.listEvents(Z.mgrId).some((e) => e.kind === "worker_report" && e.detail && typeof e.detail.warning === "string"));

  // ── (E) GIT-ERROR → FAIL-SAFE ALLOWED ────────────────────────────────────────────────────────────
  // worktreePath exists but is NOT a git repo, so `git status --porcelain` throws → precheck degrades to ALLOW.
  E.worktreePath = path.join(os.tmpdir(), `loom-wrp-notgit-${sfx}`);
  fs.mkdirSync(E.worktreePath, { recursive: true });
  E.branch = "loom/whatever";
  E.repo = path.join(os.tmpdir(), `loom-wrp-e-repo-${sfx}`);
  initRepo(E.repo); // a real repo for the project's repoPath; the WORKTREE is the broken one
  seed(E);
  const rE = await sessions.workerReport(E.workerId, { status: "done", summary: "git is flaky but I'm done" });
  check("(git-error) workerReport → reported:true (fail-safe, NOT refused)", rE.reported === true && !rE.refused);
  check("(git-error) task moved to review (legit done not blocked by a flaky check)", db.getTask(E.taskId).columnKey === "review");

  // ── (N) NOCHANGES-WITH-COMMITS → REFUSED ─────────────────────────────────────────────────────────
  initRepo(N.repo);
  { const { worktreePath, branch } = await createWorktree(N.repo, N.projId, N.taskId); N.worktreePath = worktreePath; N.branch = branch; }
  fs.writeFileSync(path.join(N.worktreePath, N.file), "real committed work, but the report will lie about it\n");
  commitAll(N.worktreePath, `${N.file}`, GIT_ID); // 1 real commit ahead of base
  seed(N);
  const rN = await sessions.workerReport(N.workerId, { status: "done", summary: "nothing to see here", noChanges: true });
  check("(nochanges-with-commits) workerReport → reported:false, refused:true", rN.reported === false && rN.refused === true);
  check("(nochanges-with-commits) error names the verified commit count", typeof rN.error === "string" && rN.error.includes("1 commit"));
  check("(nochanges-with-commits) task STAYS in_progress (NOT moved to review)", db.getTask(N.taskId).columnKey === "in_progress");
  check("(nochanges-with-commits) a worker_report_rejected(reason:nochanges-with-commits) event recorded",
    db.listEvents(N.mgrId).some((e) => e.kind === "worker_report_rejected" && e.detail && e.detail.reason === "nochanges-with-commits" && e.detail.aheadCount === 1));
  check("(nochanges-with-commits) NO worker_report(done) event recorded (the done never landed)",
    !db.listEvents(N.mgrId).some((e) => e.kind === "worker_report" && e.detail && e.detail.status === "done"));

  // ── UNIT: precheckWorkerDone fail-safe bound via an injected throwing git seam ────────────────────
  const throwingGit = { raw: async () => { throw new Error("simulated hung/failed git child"); } };
  const det = await precheckWorkerDone(C.repo, C.worktreePath, C.branch, "HEAD", { gitFactory: () => throwingGit, timeoutMs: 200 });
  check("(unit) injected git error → fail-safe {uncommitted:false, zeroAhead:false}", det.uncommitted === false && det.zeroAhead === false);

  // ── (P) UNCONTAINED PATH (board card 0f965ab7, DoD-5) — precheckRepoPath GONE, worktreePath SURVIVES.
  // `resolveRepoByKey`'s primary path resolves the project's OWN `repoPath` — simulate a moved/renamed
  // canonical repo (or a stale multi-repo registry entry) by pointing the DB's repoPath at a directory
  // that was never created, while the worker's worktree (cut from a REAL repo before the "move") stays
  // physically intact, clean, and genuinely ahead of base. Pre-fix, `precheckWorkerDone`'s bare
  // `boundedGit(repoPath, ...)` construct call threw SYNCHRONOUSLY here and workerReport() rejected
  // outright instead of honouring its fail-safe contract; post-fix it must ALLOW like any other precheck
  // git failure (E, above) — the worker never authored the missing-repo condition and must not be
  // blocked by it.
  initRepo(P.repo);
  { const { worktreePath, branch } = await createWorktree(P.repo, P.projId, P.taskId); P.worktreePath = worktreePath; P.branch = branch; }
  fs.writeFileSync(path.join(P.worktreePath, P.file), "real committed work behind a moved repo\n");
  commitAll(P.worktreePath, `${P.file}`, GIT_ID); // clean + 1 ahead
  P.dbRepoPath = path.join(os.tmpdir(), `loom-wrp-p-missing-${sfx}`); // never created on disk
  seed(P);
  let threwP = false;
  let rP;
  try {
    rP = await sessions.workerReport(P.workerId, { status: "done", summary: "repo moved out from under me but I'm done" });
  } catch {
    threwP = true;
  }
  check("(uncontained-repo) workerReport does NOT throw (the exact bug this card fixes)", threwP === false);
  check("(uncontained-repo) workerReport → reported:true (fail-safe, NOT refused)", rP?.reported === true && !rP?.refused);
  check("(uncontained-repo) task moved to review (a legitimate done is not blocked by a moved canonical repo)",
    db.getTask(P.taskId).columnKey === "review");
} finally {
  db.close();
  for (const p of all) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_report(done) pre-check: uncommitted work is REFUSED (task stays in_progress, files named); committed-on-assigned-branch is allowed unchanged; clean+0-ahead is allowed with a warning; a git error fails safe to allowed; noChanges:true against a branch with verified commits ahead is REFUSED (task stays in_progress, commit count named); a moved/missing canonical repoPath with the worktree still intact fails safe to allowed, never throws (board card 0f965ab7)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
