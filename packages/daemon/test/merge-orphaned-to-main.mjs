import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Merge-gate ORPHANED-COMMIT-TO-MAIN hard-flag test (PL Auditor finding #2, card 1550eb87 — silent
// work loss). REAL git on temp repos, NO claude and NO live daemon — drives SessionService
// .confirmWorkerMerge() directly against an isolated LOOM_HOME (mirrors merge-stranded-backstop.mjs /
// merge-confirm-idempotent.mjs's in-process style).
//
// THE BUG IT GUARDS (incident: a worker committed 28ae791 straight to MAIN from its worktree): the
// assigned branch then stays 0 commits ahead of main, so the squash merge stages nothing. The merge gate
// only SOFT-warned ("0 ahead — nothing to merge, allowing the done") and a later main sync ORPHANED that
// commit — silent work loss. THE FIX: confirmWorkerMerge now SPLITS the STAGE_EMPTY_RETRY (0-ahead) case
// on whether the worker REPORTED work — a 0-ahead branch WHILE the worker reported done/blocked is a HARD
// error (hardError:true) requiring the manager to recover the commit, NOT merged:true.
//
// Proves:
//   (A) ORPHAN — assigned branch 0-ahead of main WHILE the worker reported done → confirmWorkerMerge
//       returns merged:false + hardError:true + emptyKind STAGE_EMPTY_RETRY + reportedState 'done', a
//       merge_rejected(reason:orphaned_zero_ahead) event, canonical repo UNTOUCHED, worktree RETAINED,
//       task NOT moved to done.
//   (B) ALREADY_MERGED — the branch already landed in main (its trailer) WHILE the worker reported done →
//       STILL merged:true + emptyKind ALREADY_MERGED + NO hardError (the reported-work check must not
//       break the legitimate idempotent re-confirm).
//   (C) SOFT no-op — a 0-diff branch (+1 empty commit) with NO worker report → merged:false +
//       emptyKind STAGE_EMPTY_RETRY + NO hardError (the gentle soft retry is preserved for a genuine no-op).
//   (D) DOCTRINE — the shipped /worker SKILL.md contains the never-commit-to-main rule.
// Run: 1) build daemon (pnpm build), 2) node test/merge-orphaned-to-main.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mom-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, mergeBranch } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mom@loom -c user.name=mom";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

const db = new Db();
// confirmWorkerMerge only touches pty.stop / pty.isAlive / pty.enqueueStdin on these paths; a no-pty
// worker row (processState 'exited') is !isAlive anyway, so a stub keeps the test hermetic.
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

const mergeRejectedReasons = (mgrId) =>
  db.listEvents(mgrId).filter((e) => e.kind === "merge_rejected").map((e) => e.detail?.reason);

// gateCommand left EMPTY (config {}) so confirmWorkerMerge skips the build gate and goes straight to
// the merge path we're exercising.
function seed(p) {
  db.insertProject({ id: p.projId, name: "MOM", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MOM-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

// Append a worker_report event (the signal the merge gate keys the orphan hard-flag off of), exactly the
// shape SessionService.workerReport writes.
function reportEvent(p, status) {
  db.appendEvent({
    id: randomUUID(), ts: new Date().toISOString(),
    managerSessionId: p.mgrId, workerSessionId: p.workerId, taskId: p.taskId, kind: "worker_report",
    detail: { status, summary: `${status} report` },
  });
}

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mom\n");
  // Configure a git identity so the daemon's PLAIN squash `git commit` (no `-c` overrides) has an author.
  execSync(`git init -q && git config user.email mom@loom && git config user.name mom && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label, file) => ({
  projId: `mom-${label}-proj-${sfx}`, agentId: `mom-${label}-agent-${sfx}`, taskId: `mom-${label}-task-${sfx}`,
  mgrId: `mom-${label}-mgr-${sfx}`, workerId: `mom-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mom-${label}-${sfx}`), file,
});
const A = mk("a", "feat-a.txt");   // (A) orphaned-to-main: 0-ahead + reported done → HARD error
const B = mk("b", "feat-b.txt");   // (B) already-merged + reported done → merged:true (idempotent)
const C = mk("c", "feat-c.txt");   // (C) soft no-op: 0-diff + NO report → soft retry

try {
  // ── (A) ORPHAN: the worker committed to MAIN; its assigned branch is 0-ahead, but it reported done ──
  makeRepo(A);
  {
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = worktreePath; A.branch = branch;
    // Simulate the incident: the worker's work landed on MAIN directly (not the assigned branch). The
    // assigned branch stays at the old base — 0 commits ahead of the advanced main HEAD.
    fs.writeFileSync(path.join(A.repo, "orphaned.txt"), "work that went to main\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "orphaned commit on main"`, { cwd: A.repo });
    seed(A);
    reportEvent(A, "done"); // the worker REPORTED done — the orphan hard-flag signal
    check("(A) precondition: assigned branch is 0 commits ahead of main", git(A.repo, `rev-list --count HEAD..${branch}`) === "0");

    const headBefore = git(A.repo, "rev-parse HEAD");
    const confirmA = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
    check("(A) ORPHAN → merged:false (HARD refusal, not a soft pass-through to done)", confirmA.merged === false);
    check("(A) hardError:true", confirmA.hardError === true);
    check("(A) emptyKind === 'STAGE_EMPTY_RETRY'", confirmA.emptyKind === "STAGE_EMPTY_RETRY");
    check("(A) reportedState === 'done'", confirmA.reportedState === "done");
    check("(A) reason names the orphaned-work case", /orphaned work/i.test(confirmA.reason ?? ""));
    check("(A) a merge_rejected(reason:orphaned_zero_ahead) event recorded", mergeRejectedReasons(A.mgrId).includes("orphaned_zero_ahead"));
    check("(A) canonical HEAD UNCHANGED (no empty merge committed)", git(A.repo, "rev-parse HEAD") === headBefore);
    check("(A) assigned branch NOT deleted (worktree retained for recovery)", git(A.repo, `branch --list ${branch}`) !== "");
    check("(A) worktree RETAINED (manager can recover the commit)", fs.existsSync(A.worktreePath));
    check("(A) task NOT moved to done", db.getTask(A.taskId).columnKey !== "done");
  }

  // ── (B) ALREADY_MERGED while the worker reported done — idempotent re-confirm must STILL succeed ──────
  makeRepo(B);
  {
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    fs.writeFileSync(path.join(worktreePath, B.file), "already merged work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${B.file}"`, { cwd: worktreePath });
    B.worktreePath = worktreePath; B.branch = branch;
    // Land the branch into main with its deterministic Loom-Worker-Branch trailer (an out-of-band confirm),
    // WITHOUT deleting the branch — the idempotent re-confirm shape.
    const landed = await mergeBranch(B.repo, branch, "MOM already-merged");
    check("(B) precondition: branch landed in main with its trailer", landed.ok === true && typeof landed.sha === "string");
    seed(B);
    reportEvent(B, "done"); // the worker reported done — must NOT turn the legitimate ALREADY_MERGED into a hard error

    const headBefore = git(B.repo, "rev-parse HEAD");
    const confirmB = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
    check("(B) ALREADY_MERGED → merged:true (idempotent completion, despite the done report)", confirmB.merged === true);
    check("(B) emptyKind === 'ALREADY_MERGED'", confirmB.emptyKind === "ALREADY_MERGED");
    check("(B) NOT hard-flagged (hardError absent)", confirmB.hardError === undefined);
    check("(B) NO new commit on main (nothing re-committed)", git(B.repo, `rev-list --count ${headBefore}..HEAD`) === "0");
    check("(B) task moved to done (bookkeeping finished)", db.getTask(B.taskId).columnKey === "done");
    check("(B) worktree removed (idempotent cleanup)", !fs.existsSync(B.worktreePath));
  }

  // ── (C) SOFT no-op: a 0-diff branch with NO worker report — the gentle soft retry is preserved ───────
  makeRepo(C);
  {
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    // +1 empty commit: ahead of main but its tree is identical, so the squash stages nothing and no prior
    // trailer landing exists → STAGE_EMPTY_RETRY. NO worker_report event is appended.
    execSync(`git ${GIT_ID} commit -q --allow-empty -m "empty change ahead"`, { cwd: worktreePath });
    C.worktreePath = worktreePath; C.branch = branch;
    seed(C);

    const headBefore = git(C.repo, "rev-parse HEAD");
    const confirmC = await sessions.confirmWorkerMerge(C.mgrId, C.workerId);
    check("(C) SOFT no-op → merged:false (fail-closed)", confirmC.merged === false);
    check("(C) emptyKind === 'STAGE_EMPTY_RETRY'", confirmC.emptyKind === "STAGE_EMPTY_RETRY");
    check("(C) NOT hard-flagged (no report → soft retry, hardError absent)", confirmC.hardError === undefined);
    check("(C) reason names the no-diff case", /STAGE_EMPTY_RETRY|no diff/i.test(confirmC.reason ?? ""));
    check("(C) a merge_rejected(reason:stage_empty) event recorded (soft, not orphaned)",
      mergeRejectedReasons(C.mgrId).includes("stage_empty") && !mergeRejectedReasons(C.mgrId).includes("orphaned_zero_ahead"));
    check("(C) canonical repo UNTOUCHED (no new commit)", git(C.repo, `rev-list --count ${headBefore}..HEAD`) === "0");
    check("(C) worktree RETAINED", fs.existsSync(C.worktreePath));
    check("(C) task NOT moved to done", db.getTask(C.taskId).columnKey !== "done");
  }

  // ── (D) DOCTRINE: the shipped /worker skill carries the never-commit-to-main rule ────────────────────
  const skillPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "skills", "worker", "SKILL.md");
  const skill = fs.readFileSync(skillPath, "utf8");
  check("(D) /worker SKILL.md says 'never commit to main'", /never commit to\s+`?main/i.test(skill));
  check("(D) /worker SKILL.md says 'commit ONLY to your assigned branch loom/<id>'",
    /commit ONLY to your assigned branch\s+`?loom\/<id>/i.test(skill));
} finally {
  db.close();
  for (const p of [A, B, C]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a 0-ahead assigned branch WHILE the worker reported work is HARD-flagged (orphaned-commit-to-main, merged:false + hardError), while the legitimate ALREADY_MERGED idempotent re-confirm and a genuine no-report no-op are preserved; the /worker doctrine carries the never-commit-to-main rule."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
