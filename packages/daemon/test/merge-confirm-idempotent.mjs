import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_merge_confirm IDEMPOTENCY test (board card 2eddf573). REAL git on temp repos, NO claude and
// NO live daemon — drives SessionService.confirmWorkerMerge() directly against an isolated LOOM_HOME
// (mirrors merge-finalize-resilient.mjs's in-process style).
//
// THE BUG: confirmWorkerMerge returned "nothing staged" on a valid +N-commit fast-forward branch, then
// merged on a byte-identical RETRY (evidence: a prior Homelab session). The root cause is a stale
// in-progress-merge residue in the canonical repo (a leftover MERGE_HEAD / partial index from an
// aborted op): the FIRST `git merge --squash` aborts ("You have not concluded your merge") and stages
// NOTHING, so the merge bounced — and only the failure path's own `reset --hard` let the retry succeed.
//
// THE FIX: mergeBranch re-derives the staged set from a CLEAN index — it clears any affirmative
// in-progress-merge residue up front, so the +N branch merges on the FIRST call. And when the index is
// GENUINELY empty after a clean squash, the result is DISTINGUISHABLE via emptyKind: ALREADY_MERGED
// (the branch's work already landed in main, identified by the deterministic Loom-Worker-Branch trailer)
// vs STAGE_EMPTY_RETRY (no diff to merge) — never a "nothing staged" that then succeeds on retry.
//
// Proves:
//   (a) FIRST-CALL: a +2-commit branch with a stale MERGE_HEAD planted in the canonical repo merges on
//       the FIRST confirm (merged:true, both commits collapsed to ONE squash commit, MERGE_HEAD cleared)
//       — NOT a spurious "nothing staged".
//   (b1) ALREADY_MERGED: a branch whose work already landed in main → confirm returns merged:true with
//       emptyKind 'ALREADY_MERGED' and finishes the bookkeeping idempotently (worktree gone, task done).
//   (b2) STAGE_EMPTY_RETRY: a branch ahead but with NO diff to merge → confirm returns merged:false with
//       emptyKind 'STAGE_EMPTY_RETRY', fail-closed (worktree RETAINED), NOT a "nothing staged" no-op.
// Run: 1) build daemon (pnpm build), 2) node test/merge-confirm-idempotent.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mci-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, mergeBranch } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mci@loom -c user.name=mci";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

const db = new Db();
// confirmWorkerMerge only touches pty.stop / pty.isAlive / pty.enqueueStdin on these paths; a no-pty
// worker row (processState 'exited') is !isAlive anyway, so a stub keeps the test hermetic.
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

// gateCommand left EMPTY (config {}) so confirmWorkerMerge skips the build gate and goes straight to
// the merge + finalize bookkeeping we're exercising.
function seed(p) {
  db.insertProject({ id: p.projId, name: "MCI", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MCI-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mci\n");
  // Configure a git identity so the daemon's PLAIN squash `git commit` (no `-c` overrides) has an author.
  execSync(`git init -q && git config user.email mci@loom && git config user.name mci && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label, file) => ({
  projId: `mci-${label}-proj-${sfx}`, agentId: `mci-${label}-agent-${sfx}`, taskId: `mci-${label}-task-${sfx}`,
  mgrId: `mci-${label}-mgr-${sfx}`, workerId: `mci-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mci-${label}-${sfx}`), file,
});
const A = mk("a", "feat-a.txt");   // (a) stale MERGE_HEAD → first-call merge
const B = mk("b", "feat-b.txt");   // (b1) already-merged
const C = mk("c", "feat-c.txt");   // (b2) stage-empty

try {
  // ── (a) FIRST-CALL merge despite a stale MERGE_HEAD in the canonical repo ──────────────────────────
  makeRepo(A);
  {
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    fs.writeFileSync(path.join(worktreePath, A.file), "part 1\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${A.file} part 1"`, { cwd: worktreePath });
    fs.writeFileSync(path.join(worktreePath, `${A.file}.2`), "part 2\n"); // 2 commits → must collapse to ONE
    execSync(`git add . && git ${GIT_ID} commit -q -m "${A.file} part 2"`, { cwd: worktreePath });
    A.worktreePath = worktreePath; A.branch = branch;
    seed(A);

    // Plant a stale in-progress-merge residue: a leftover MERGE_HEAD makes `git merge --squash` abort
    // ("You have not concluded your merge") and stage nothing — exactly the residue that produced the
    // spurious "nothing staged" the OLD code bounced on (and a byte-identical retry then merged).
    const head = git(A.repo, "rev-parse HEAD");
    fs.writeFileSync(path.join(A.repo, ".git", "MERGE_HEAD"), head + "\n");
    check("(a) precondition: stale MERGE_HEAD planted", fs.existsSync(path.join(A.repo, ".git", "MERGE_HEAD")));

    const headBefore = git(A.repo, "rev-parse HEAD");
    const confirmA = await sessions.confirmWorkerMerge(A.mgrId, A.workerId); // the FIRST (and only) call
    check("(a) FIRST confirm merges the +2-commit branch (no spurious 'nothing staged')", confirmA.merged === true);
    check("(a) NOT reported as an empty no-op (emptyKind absent on a real merge)", confirmA.emptyKind === undefined);
    check("(a) both worker files landed on the canonical repo", fs.existsSync(path.join(A.repo, A.file)) && fs.existsSync(path.join(A.repo, `${A.file}.2`)));
    check("(a) exactly ONE new commit on main (2 worker commits collapsed into the squash)",
      git(A.repo, `rev-list --count ${headBefore}..HEAD`) === "1");
    check("(a) the stale MERGE_HEAD was cleared before the merge", !fs.existsSync(path.join(A.repo, ".git", "MERGE_HEAD")));
    check("(a) task moved to done", db.getTask(A.taskId).columnKey === "done");
    check("(a) worktree removed after the merge", !fs.existsSync(A.worktreePath));
  }

  // ── (b1) ALREADY_MERGED: the branch's work is already in main ──────────────────────────────────────
  makeRepo(B);
  {
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    fs.writeFileSync(path.join(worktreePath, B.file), "already merged work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${B.file}"`, { cwd: worktreePath });
    B.worktreePath = worktreePath; B.branch = branch;
    // Land the branch into main DIRECTLY (the deterministic Loom-Worker-Branch trailer goes on the squash)
    // WITHOUT deleting the branch — simulating a merge that already happened (e.g. an out-of-band confirm).
    const landed = await mergeBranch(B.repo, branch, "MCI already-merged");
    check("(b1) precondition: branch landed in main with its trailer", landed.ok === true && typeof landed.sha === "string");
    check("(b1) precondition: branch ref still present (not yet finalized)", git(B.repo, `branch --list ${branch}`).includes(path.basename(worktreePath)) || git(B.repo, `branch --list ${branch}`) !== "");
    seed(B);

    const headBefore = git(B.repo, "rev-parse HEAD");
    const confirmB = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
    check("(b1) ALREADY_MERGED → merged:true (idempotent completion)", confirmB.merged === true);
    check("(b1) distinguishable emptyKind === 'ALREADY_MERGED'", confirmB.emptyKind === "ALREADY_MERGED");
    check("(b1) NO new commit on main (nothing re-committed)", git(B.repo, `rev-list --count ${headBefore}..HEAD`) === "0");
    check("(b1) task moved to done (bookkeeping finished)", db.getTask(B.taskId).columnKey === "done");
    check("(b1) worktree removed (idempotent cleanup)", !fs.existsSync(B.worktreePath));
  }

  // ── (b2) STAGE_EMPTY_RETRY: the branch is ahead but has NO diff to merge ─────────────────────────────
  makeRepo(C);
  {
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    // An EMPTY commit: the branch is +1 ahead (so it isn't read as stranded/zero-work) but its tree is
    // identical to main, so a squash merge stages NOTHING and no prior trailer landing exists.
    execSync(`git ${GIT_ID} commit -q --allow-empty -m "empty change ahead"`, { cwd: worktreePath });
    C.worktreePath = worktreePath; C.branch = branch;
    seed(C);

    const headBefore = git(C.repo, "rev-parse HEAD");
    const confirmC = await sessions.confirmWorkerMerge(C.mgrId, C.workerId);
    check("(b2) STAGE_EMPTY_RETRY → merged:false (fail-closed, not a silent no-op success)", confirmC.merged === false);
    check("(b2) distinguishable emptyKind === 'STAGE_EMPTY_RETRY'", confirmC.emptyKind === "STAGE_EMPTY_RETRY");
    check("(b2) reason names the no-diff case", /STAGE_EMPTY_RETRY|no diff/i.test(confirmC.reason ?? ""));
    check("(b2) canonical repo UNTOUCHED (no new commit)", git(C.repo, `rev-list --count ${headBefore}..HEAD`) === "0");
    check("(b2) worktree RETAINED (manager can investigate)", fs.existsSync(C.worktreePath));
    check("(b2) task NOT moved to done (still in review/in_progress)", db.getTask(C.taskId).columnKey !== "done");
  }
} finally {
  db.close();
  for (const p of [A, B, C]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_merge_confirm re-derives the staged set at confirm time: a +N branch merges on the FIRST call (stale MERGE_HEAD cleared), and a genuine no-op is distinguishable (ALREADY_MERGED finalizes idempotently; STAGE_EMPTY_RETRY is fail-closed)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
