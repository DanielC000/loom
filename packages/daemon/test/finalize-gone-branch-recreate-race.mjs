import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ed2d878e — finalizeMerge's own tail (finalizeWorktreeAndBranch) called `deleteBranch` with no
// `expectedTip` whenever the branch was confirmed gone at lookup time (`soloFinalizeTipGuard`'s
// `branchGone:true` contract, i.e. `expectedBranchTip` undefined) — a plain, unconditional `git branch
// -D` (git/worktrees.ts). That lookup runs well BEFORE this tail's own quarantine/held checks, sibling
// sweep, worktree removal and terminal bookkeeping (all real awaits), so a re-task spawn that recreates
// the SAME branch name with new, never-landed work in that window had its work silently destroyed. This
// is the exact "recreated-between-check-and-delete" shape `e34d475c` round 5 already closed for Pass A's
// sibling/own-row CLEANUP-ONLY caller (which sets `skipDeleteWhenBranchGone`) but left open for
// `finalizeMerge`'s own tail — reached by three production callers, all of which can genuinely see
// `expectedBranchTip` undefined: the solo ALREADY_MERGED finish (`finishSoloAlreadyLanded`/the in-confirm
// `amGuard` detection, both via `finishAlreadyMerged`), `confirmWorkerMergeTracked`'s own catch-recovery
// path (`crGuard`), and boot-reconcile Pass A's own GENUINE (non-cleanup-only) finalize. NOT
// `confirmWorkerMergeTracked`'s Green path (its own `soloFinalizeTipGuard` call passes no `branchGone` at
// all, so its tip can never be undefined) and NOT `mergeBatchTracked`'s per-branch landing (it retains
// instead of finalizing whenever its own `assembledTip` is falsy).
//
// SEVERITY, qualified: a real re-task spawn recreates the branch via `createWorktree`'s own `git worktree
// add <path> -b <branch>`, which checks the branch out in that same call — and `git branch -D` refuses a
// checked-out branch (silently, via `deleteBranch`'s own catch), so the common "re-task immediately cuts
// a worktree" shape does NOT lose data through this mechanism; git's own checked-out-branch protection
// already covers it. The genuinely vulnerable window needs the recreated branch to exist as a ref that is
// NOT checked out anywhere — scenarios (A)/(B) below model exactly that (a deliberate detach after the
// recreation), not "any concurrent recreation." See `docs/decisions/ed2d878e-…` for the full reasoning.
//
// Fix: `finalizeMerge`'s own call to `finalizeWorktreeAndBranch` now always passes
// `skipDeleteWhenBranchGone: true` too — strictly safer either way, since it no longer depends on git's
// checked-out protection as an accidental safety net. See `docs/decisions/ed2d878e-finalize-skips-delete-
// on-confirmed-gone-branch.md` for the full reasoning (including why a compare-and-delete inside
// `deleteBranch` itself was rejected).
//
// REAL git on temp repos, NO claude and NO live daemon. Three scenarios:
//   (A) boot-reconcile Pass A's GENUINE finalize (reconcileOrchestrationOnBoot) — mirrors
//       pass-a-stuck-worktree-no-replay.mjs's own rig, but with NO merge_done recorded anywhere (the
//       genuine, non-cleanup-only finalize precondition), driven via a real squash-trailer lookup.
//   (B) confirmWorkerMerge → finishSoloAlreadyLanded → finishAlreadyMerged → finalizeMerge (the solo
//       ALREADY_MERGED finish's "worktree already gone, branch already landed+gone" early-detection path).
//   (A)+(B) each inject the recreation (as a bare, NOT-checked-out ref — see SEVERITY above) at the ONE
//       point `finalizeWorktreeAndBranch`'s own doc guarantees runs strictly BEFORE `deleteBranch`
//       (`betweenRemovalAndDelete`'s `merge_done` append —
//       `@decision sha:252e57ec`'s "ORDER IS CRASH-CRITICAL"), via a `Db.appendEvent` monkeypatch (the
//       same injection technique `merge-finalize-bookkeeping-throw-skips-delete.mjs` already uses for
//       this exact bookkeeping write) — never a `gitFactory` seam, since `finalizeMerge`'s own args type
//       has none (confirmed: only `finalizeWorktreeAndBranch`'s OWN `gitFactory` param exists, and only
//       Pass A's already-fixed cleanup-only call site threads it in).
//   (C) POSITIVE CONTROL — an ordinary, non-race Green-path merge (branch genuinely present, a real
//       commit, no prior landing) must still have its branch CAS-deleted exactly as before this card:
//       `skipDeleteWhenBranchGone:true` only ever matters when `expectedBranchTip` is undefined, so this
//       proves the fix is inert for the common case.
// Run: 1) build daemon (pnpm build), 2) node test/finalize-gone-branch-recreate-race.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-fgbr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=fgbr@loom -c user.name=fgbr";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const tryRevParse = (repo, ref) => { try { return execSync(`git rev-parse ${ref}`, { cwd: repo }).toString().trim(); } catch { return null; } };
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# fgbr\n");
  execSync(`git init -q && git config user.email fgbr@loom && git config user.name fgbr`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

// Recreates `branch` in `repo` with a BRAND NEW commit, as a bare ref NOT checked out anywhere (see this
// file's own SEVERITY note at the top — a real re-task's `createWorktree` checks the branch out
// immediately, which `git branch -D` would refuse; this models the narrower, genuinely-vulnerable shape:
// the branch recreated in the window between the earlier "branch confirmed gone" check and finalize's own
// (much later) delete attempt, but never checked out). Returns the new tip.
function recreateBranchWithNewWork(repo, branch, label) {
  execSync(`git ${GIT_ID} checkout -b ${branch}`, { cwd: repo });
  fs.writeFileSync(path.join(repo, `late-recreated-${label}.txt`), "brand new, never-landed work\n");
  commitAll(repo, `late recreation (${label}): new worker's real work`, GIT_ID);
  const tip = execSync(`git rev-parse HEAD`, { cwd: repo }).toString().trim();
  execSync(`git checkout -q --detach HEAD`, { cwd: repo }); // vacate so the delete attempt (or skip) can proceed
  return tip;
}

const db = new Db();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {});

// Shared appendEvent hook across all scenarios, each gated on its OWN workerId + a single-fire guard —
// never interferes with another scenario's bookkeeping or with scenario (C)'s own ordinary merge_done.
const realAppendEvent = db.appendEvent.bind(db);
const recreateOnMergeDone = {}; // workerId -> { repo, branch, label, fired, tip }
db.appendEvent = (evt) => {
  const seq = realAppendEvent(evt);
  const entry = evt.kind === "merge_done" ? recreateOnMergeDone[evt.workerSessionId] : undefined;
  if (entry && !entry.fired) {
    entry.fired = true;
    entry.tip = recreateBranchWithNewWork(entry.repo, entry.branch, entry.label);
  }
  return seq;
};

const mk = (label) => ({
  projId: `fgbr-${label}-proj-${sfx}`, agentId: `fgbr-${label}-agent-${sfx}`, taskId: `fgbr-${label}-task-${sfx}`,
  mgrId: `fgbr-${label}-mgr-${sfx}`, workerId: `fgbr-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-fgbr-${label}-repo-${sfx}`),
});
const A = mk("a"); // Pass A genuine finalize
const B = mk("b"); // confirmWorkerMerge -> finishSoloAlreadyLanded -> finishAlreadyMerged
const C = mk("c"); // positive control: ordinary Green-path merge

try {
  // ── (A) boot-reconcile Pass A's GENUINE finalize ──────────────────────────────────────────────────
  initRepo(A.repo);
  {
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.branch = branch;
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "landed work\n");
    commitAll(worktreePath, "feat", GIT_ID);
    execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "FGBR-A-TASK" -m "Loom-Worker-Branch: ${branch}"`, { cwd: A.repo });

    // Simulate the branch already being gone at lookup time, with NOTHING recorded in the DB about it
    // (no merge_done anywhere) — the GENUINE (non-cleanup-only) finalize path's own precondition.
    fs.rmSync(worktreePath, { recursive: true, force: true });
    execSync(`git worktree prune`, { cwd: A.repo });
    git(A.repo, `branch -D ${branch}`);
    fs.mkdirSync(worktreePath, { recursive: true }); // leftover shell dir — worktreeOnDisk reads true

    db.insertProject({ id: A.projId, name: "FGBR-A", repoPath: A.repo, vaultPath: A.repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: A.agentId, projectId: A.projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: A.taskId, projectId: A.projId, title: "FGBR-A-TASK", body: "", columnKey: "done", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: A.mgrId, projectId: A.projId, agentId: A.agentId, engineSessionId: null, title: null, cwd: A.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: A.workerId, projectId: A.projId, agentId: A.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: A.mgrId, taskId: A.taskId, worktreePath, branch });
    // A real merge_request (so Pass A doesn't short-circuit on "never requested a merge") but
    // DELIBERATELY NO merge_done anywhere — alreadyFinalized=false, finalizedElsewhere=false.
    db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: A.mgrId, workerSessionId: A.workerId, taskId: A.taskId, kind: "merge_request", detail: { branch, filesChanged: 1, tip: branch, repoKey: null } });

    check("(A pre) branch confirmed GONE at lookup time", tryRevParse(A.repo, `refs/heads/${branch}`) === null);
    check("(A pre) no merge_done recorded anywhere (genuine-finalize precondition)", db.listEventsForWorker(A.workerId).every((e) => e.kind !== "merge_done"));

    recreateOnMergeDone[A.workerId] = { repo: A.repo, branch, label: "A", fired: false, tip: null };
    const result = await sessions.reconcileOrchestrationOnBoot(new Set());

    check("(A) the merge_done write fired (finalizeMerge's tail ran, right up to its delete step)", recreateOnMergeDone[A.workerId].fired === true);
    check("(A) Pass A recorded this as a finished merge (genuine finalize path, not a retain)", result.mergesFinished === 1);
    check("(A) FIX: the branch recreated during finalize's own window SURVIVES",
      tryRevParse(A.repo, `refs/heads/${branch}`) === recreateOnMergeDone[A.workerId].tip);
  }

  // ── (B) confirmWorkerMerge -> finishSoloAlreadyLanded -> finishAlreadyMerged -> finalizeMerge ──────
  initRepo(B.repo);
  {
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    B.branch = branch;
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "landed work\n");
    commitAll(worktreePath, "feat", GIT_ID);
    execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "FGBR-B-TASK" -m "Loom-Worker-Branch: ${branch}"`, { cwd: B.repo });

    // Branch already gone AND the worktree dir itself genuinely absent (never recreated) — this is what
    // makes confirmWorkerMerge's own `!fs.existsSync(worktreePath)` check route into
    // finishSoloAlreadyLanded, exactly like a worker whose worktree already finished cleanup.
    fs.rmSync(worktreePath, { recursive: true, force: true });
    execSync(`git worktree prune`, { cwd: B.repo });
    git(B.repo, `branch -D ${branch}`);

    db.insertProject({ id: B.projId, name: "FGBR-B", repoPath: B.repo, vaultPath: B.repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: B.agentId, projectId: B.projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: B.taskId, projectId: B.projId, title: "FGBR-B-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: B.mgrId, projectId: B.projId, agentId: B.agentId, engineSessionId: null, title: null, cwd: B.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: B.workerId, projectId: B.projId, agentId: B.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: B.mgrId, taskId: B.taskId, worktreePath, branch });

    check("(B pre) branch confirmed GONE", tryRevParse(B.repo, `refs/heads/${branch}`) === null);
    check("(B pre) worktree dir genuinely absent (routes confirmWorkerMerge into finishSoloAlreadyLanded)", !fs.existsSync(worktreePath));
    check("(B pre) no merge_done recorded anywhere", db.listEventsForWorker(B.workerId).every((e) => e.kind !== "merge_done"));

    recreateOnMergeDone[B.workerId] = { repo: B.repo, branch, label: "B", fired: false, tip: null };
    const result = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);

    check("(B) confirmWorkerMerge took the ALREADY_MERGED finish (not a fresh squash)", result.merged === true && result.emptyKind === "ALREADY_MERGED");
    check("(B) the merge_done write fired (finalizeMerge's tail ran, right up to its delete step)", recreateOnMergeDone[B.workerId].fired === true);
    check("(B) FIX: the branch recreated during finalize's own window SURVIVES",
      tryRevParse(B.repo, `refs/heads/${branch}`) === recreateOnMergeDone[B.workerId].tip);
  }

  // ── (C) POSITIVE CONTROL — an ordinary Green-path merge still deletes its branch as before ─────────
  initRepo(C.repo);
  {
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    C.branch = branch;
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "ordinary work\n");
    commitAll(worktreePath, "feat", GIT_ID);

    db.insertProject({ id: C.projId, name: "FGBR-C", repoPath: C.repo, vaultPath: C.repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: C.agentId, projectId: C.projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: C.taskId, projectId: C.projId, title: "FGBR-C-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: C.mgrId, projectId: C.projId, agentId: C.agentId, engineSessionId: null, title: null, cwd: C.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: C.workerId, projectId: C.projId, agentId: C.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: C.mgrId, taskId: C.taskId, worktreePath, branch });

    check("(C pre) branch genuinely exists (real worker branch, not yet landed)", tryRevParse(C.repo, `refs/heads/${branch}`) !== null);

    const result = await sessions.confirmWorkerMerge(C.mgrId, C.workerId);

    check("(C) ordinary Green-path merge succeeds", result.merged === true);
    check("(C) worktree removed after the merge", !fs.existsSync(worktreePath));
    check("(C) POSITIVE CONTROL: the branch was still CAS-deleted exactly as before this card (skipDeleteWhenBranchGone is inert when expectedBranchTip is set)",
      tryRevParse(C.repo, `refs/heads/${branch}`) === null);
  }
} finally {
  db.close();
  for (const p of [A, B, C]) { try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* best-effort */ } }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — finalizeMerge's own tail never attempts deleteBranch on a confirmed-gone ref (Pass A's genuine finalize AND confirmWorkerMerge's ALREADY_MERGED finish), while an ordinary Green-path merge still CAS-deletes its branch exactly as before."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
