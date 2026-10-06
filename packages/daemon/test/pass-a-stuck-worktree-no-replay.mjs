import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e34d475c — boot-reconcile Pass A's cheap early-out (`alreadyFinalized && !worktreeOnDisk`) can
// never fire for a worker whose worktree dir can NEVER be removed (a stuck leftover directory shell) even
// though the landing is already fully recorded (a `merge_done` for this exact task+branch). Before this
// fix, execution fell through to `retireWorkerSession` + a full `finalizeMerge` call on EVERY boot —
// duplicating the `merge_done` and `worker_retired` events forever, and (once the branch ref is already
// gone, as in the real incident) attempting a destructive-path `deleteBranch` call against a ref with
// nothing left to delete.
//
// Also covers a Code Review follow-up on this same card: a LEGACY `merge_done` row (predates branch
// recording, so `detail.branch` is absent) must still match on task ALONE — not be forced through a full
// re-finalize every boot for want of a branch to compare — while a merge_done for an unrelated TASK must
// NEVER satisfy this row's own finalize, even when it (legacy-shaped) carries no branch to mismatch on.
//
// REAL git on a temp repo (a real `Loom-Worker-Branch` squash trailer), an injected `removeDir` seam that
// ALWAYS reports a clean-reject failure — the exact shape the real daemon-output.log line "[worktree]
// could not remove dir ... (left on disk for a later GC)" reports, never the "genuinely wedged/killed"
// shape — so the dir is genuinely, permanently un-removable for the whole test, exactly like the real
// incident. NO claude and NO live daemon. Drives reconcileOrchestrationOnBoot() directly across THREE
// boots, mirroring the real incident's "15+ times since 2026-09-30".
// Run: 1) build daemon, 2) node test/pass-a-stuck-worktree-no-replay.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { simpleGit } from "simple-git";
import { commitAll } from "./_git-commit.mjs";

const tmpHome = path.join(os.tmpdir(), `loom-pastuck-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=pastuck@loom -c user.name=pastuck";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
// A rev-parse that reports `null` instead of throwing when the ref is gone — a `check()` comparison must
// stay able to print a clean FAIL (not crash the whole run) when the very thing under test is "did this
// ref survive."
const tryRevParse = (repo, ref) => { try { return execSync(`git rev-parse ${ref}`, { cwd: repo }).toString().trim(); } catch { return null; } };
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// A real nested clone (same shape as worktree-nested-repo-guard.mjs's own helper): its own `git init` +
// a commit, living inside the worktree — makes gcWorktreeDir's nested-repo guard report
// "nested-repo-blocked" instead of removing anything.
function addNestedRepo(worktreePath, relDir) {
  const dir = path.join(worktreePath, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "unpushed.txt"), "unpushed work\n");
  execSync(`git init -q && git config user.email ext@loom && git config user.name ext`, { cwd: dir });
  commitAll(dir, "unpushed external work", GIT_ID);
  return dir;
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# pastuck\n");
  execSync(`git init -q && git config user.email pastuck@loom && git config user.name pastuck`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

// Never actually removes anything — always a CLEAN reject (removed:false, killed:false), the exact shape
// the real "[worktree] could not remove dir ... (left on disk for a later GC)" log line reports (never
// the "genuinely wedged/killed" shape). Counts invocations so the test can prove the removal retry keeps
// firing every boot even once the fix stops the bookkeeping replay.
function makeStuckRemoveDir() {
  const calls = { count: 0 };
  return { calls, removeDir: async () => { calls.count++; return { removed: false, killed: false }; } };
}

// Round 5 (card e34d475c): a `gitFactory` spy/seam (not timing) proving `deleteBranch`'s own plain
// `git branch -D` is NEVER attempted against a branch already confirmed gone — the standing destructive
// call this card exists to remove. Delegates every OTHER git op to the real git (the squash lookup +
// cleanup path still need a genuinely working git), so only the delete-attempt shape is ever recorded.
//
// Card ed2d878e, item 2 (Code Review de9506c6 minor): the gone-branch fixtures above never actually
// exercise `finalizeWorktreeAndBranch`'s own `listCheckedOutBranches`/`deleteBranch` calls at all (both
// are gated on `expectedBranchTip`, which is undefined precisely because the branch is already gone) —
// so `branchDeleteAttempts.length === 0` passing proves nothing about whether this spy is even WIRED to
// this tail's git calls; it would pass just as vacuously if a future change dropped `gitFactory:
// args.gitFactory` from the cleanup-only call site entirely. `worktreeListCalls`/`updateRefDeleteCalls`
// below are the positive control: the BRANCHPRESENT fixture (own-row retry, branch genuinely present at
// its landed tip — so `expectedBranchTip` IS set) proves the SAME spy instance genuinely sees
// `listCheckedOutBranches`' `git worktree list --porcelain` call for real.
const branchDeleteAttempts = [];
const worktreeListCalls = [];
const updateRefDeleteCalls = [];
const deleteBranchSpyFactory = (repoPath, blockTimeoutMs) => {
  const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
  return {
    raw: async (args) => {
      if (Array.isArray(args) && args[0] === "branch" && args[1] === "-D") branchDeleteAttempts.push({ repoPath, args });
      if (Array.isArray(args) && args[0] === "worktree" && args[1] === "list") worktreeListCalls.push({ repoPath, args });
      if (Array.isArray(args) && args[0] === "update-ref" && args[1] === "-d") updateRefDeleteCalls.push({ repoPath, args });
      return real.raw(args);
    },
  };
};

const repo = path.join(os.tmpdir(), `loom-pastuck-repo-${sfx}`);
const projId = `pastuck-proj-${sfx}`, agentId = `pastuck-agent-${sfx}`, taskId = `pastuck-task-${sfx}`;
const mgrId = `pastuck-mgr-${sfx}`, workerId = `pastuck-wkr-${sfx}`;

const db = new Db();
const stuck = makeStuckRemoveDir();
const sessions = new SessionService(db, {}, new OrchestrationControl(), { removeDir: stuck.removeDir });

try {
  initRepo(repo);
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feat.txt"), "landed work\n");
  commitAll(worktreePath, "feat", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "PASTUCK-TASK" -m "Loom-Worker-Branch: ${branch}"`, { cwd: repo });

  // Simulate a PRIOR boot's finalize having already fully succeeded at the branch/git-admin level (the
  // real incident's two dirs have no .git link left inside them at all — cleanup got this far) but the
  // physical directory shell got left behind afterward, exactly as `removeWorktree`'s own "left on disk
  // for a later GC" log line describes.
  fs.rmSync(worktreePath, { recursive: true, force: true });
  execSync(`git worktree prune`, { cwd: repo });
  git(repo, `branch -D ${branch}`);
  fs.mkdirSync(worktreePath, { recursive: true }); // the stuck leftover shell reappears on disk

  db.insertProject({ id: projId, name: "PASTUCK", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "PASTUCK-TASK", body: "", columnKey: "done", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerId, taskId, kind: "merge_request", detail: { branch, filesChanged: 1, tip: branch, repoKey: null } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerId, taskId, kind: "merge_done", detail: { branch, repoKey: null } });

  check("(pre) worktree dir present (the stuck leftover shell)", fs.existsSync(worktreePath));
  check("(pre) branch is ALREADY gone (a prior boot's own cleanup got this far)", git(repo, `branch --list ${branch}`) === "");
  check("(pre) exactly one merge_done recorded (own row, already finalized)", db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_done").length === 1);
  check("(pre) no worker_retired recorded yet", db.listEventsForWorker(workerId).every((e) => e.kind !== "worker_retired"));

  // --- boot 1, 2, 3: mirrors the real incident's "15+ times since 2026-09-30" ---
  const results = [];
  for (let i = 0; i < 3; i++) {
    results.push(await sessions.reconcileOrchestrationOnBoot(new Set(), { gitFactory: deleteBranchSpyFactory }));
  }

  const mergeDoneCount = db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_done").length;
  const workerRetiredCount = db.listEventsForWorker(workerId).filter((e) => e.kind === "worker_retired").length;

  check("(after 3 boots) worktree dir still present (genuinely un-removable the whole time)", fs.existsSync(worktreePath));
  check("(after 3 boots) exactly ONE merge_done total — never replayed across any of the 3 boots", mergeDoneCount === 1);
  check("(after 3 boots) ZERO worker_retired events — the own-row retry never re-retires an already-retired worker", workerRetiredCount === 0);
  check("(after 3 boots) none of the 3 boots counted this as a freshly 'finished' merge", results.every((r) => r.mergesFinished === 0));
  check("(after 3 boots) none of the 3 boots errored this worker's reconciliation", results.every((r) => r.mergesFailed === 0));
  check(
    "(after 3 boots) the removal retry genuinely fired on EVERY boot (never abandoned just because the bookkeeping stopped replaying)",
    stuck.calls.count >= 3,
  );
  check(
    "(after 3 boots) deleteBranch's own plain `git branch -D` was NEVER attempted against the already-gone branch (round 5 Major fix — the standing destructive call this card exists to remove)",
    branchDeleteAttempts.length === 0,
  );

  // Reusable rig for the follow-up fixtures below: EACH gets its OWN project row with its OWN repoPath —
  // reusing `projId`'s row (whose repoPath points at the ORIGINAL `repo`) silently sends Pass A's squash
  // lookup at the WRONG git repository, so landedSha resolves null regardless of alreadyFinalized,
  // making the whole check vacuous (the exact mistake this helper exists to make impossible to repeat).
  async function setupLandedWorker(tag) {
    const tagRepo = path.join(os.tmpdir(), `loom-pastuck-${tag}-repo-${sfx}`);
    const tagProjId = `pastuck-${tag}-proj-${sfx}`, tagTaskId = `pastuck-${tag}-task-${sfx}`, tagWorkerId = `pastuck-${tag}-wkr-${sfx}`;
    initRepo(tagRepo);
    db.insertProject({ id: tagProjId, name: `PASTUCK-${tag.toUpperCase()}`, repoPath: tagRepo, vaultPath: tagRepo, config: {}, createdAt: now, archivedAt: null });
    const tagAgentId = `${agentId}-${tag}`;
    db.insertAgent({ id: tagAgentId, projectId: tagProjId, name: "t", startupPrompt: "", position: 0 });
    const tagMgrId = `${mgrId}-${tag}`;
    db.insertSession({ id: tagMgrId, projectId: tagProjId, agentId: tagAgentId, engineSessionId: null, title: null, cwd: tagRepo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const wt = await createWorktree(tagRepo, tagProjId, tagTaskId);
    fs.writeFileSync(path.join(wt.worktreePath, "feat.txt"), "landed work\n");
    commitAll(wt.worktreePath, "feat", GIT_ID);
    execSync(`git ${GIT_ID} merge --squash ${wt.branch} && git ${GIT_ID} commit -q -m "PASTUCK-${tag.toUpperCase()}" -m "Loom-Worker-Branch: ${wt.branch}"`, { cwd: tagRepo });
    return { tagRepo, tagProjId, tagAgentId, tagMgrId, tagTaskId, tagWorkerId, worktreePath: wt.worktreePath, branch: wt.branch };
  }

  // ===================== LEGACY: own-row merge_done with NO recorded branch (predates branch recording) =====================
  // Gone-worktree leg: the cheap early-out must still fire on task alone — no squash lookup, no git calls.
  const L = await setupLandedWorker("legacy");
  fs.rmSync(L.worktreePath, { recursive: true, force: true });
  execSync(`git worktree prune`, { cwd: L.tagRepo });
  git(L.tagRepo, `branch -D ${L.branch}`);
  db.insertTask({ id: L.tagTaskId, projectId: L.tagProjId, title: "PASTUCK-LEGACY", body: "", columnKey: "done", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: L.tagWorkerId, projectId: L.tagProjId, agentId: L.tagAgentId, engineSessionId: null, title: null, cwd: L.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: L.tagMgrId, taskId: L.tagTaskId, worktreePath: L.worktreePath, branch: L.branch });
  // A `merge_request` too (never requested-merge is a DIFFERENT early-out — without this, a broken
  // branch-match would vacuously pass via THAT path instead of exercising the one under test here).
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: L.tagMgrId, workerSessionId: L.tagWorkerId, taskId: L.tagTaskId, kind: "merge_request", detail: { branch: L.branch, filesChanged: 1, tip: L.branch, repoKey: null } });
  // Legacy shape: NO `branch` key in detail at all (predates branch recording).
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: L.tagMgrId, workerSessionId: L.tagWorkerId, taskId: L.tagTaskId, kind: "merge_done", detail: { repoKey: null } });
  const legacyResult = await sessions.reconcileOrchestrationOnBoot();
  check("(legacy) a legacy merge_done with no branch field still matches on task alone — the cheap early-out fires, no replay", legacyResult.mergesFinished === 0 && legacyResult.mergesFailed === 0);
  check("(legacy) still exactly ONE merge_done for the legacy worker", db.listEventsForWorker(L.tagWorkerId).filter((e) => e.kind === "merge_done").length === 1);
  check("(legacy) no worker_retired filed for the legacy worker", db.listEventsForWorker(L.tagWorkerId).every((e) => e.kind !== "worker_retired"));

  // ===================== LEGACY-STUCK: same legacy shape, but the worktree dir can never be removed =====================
  const LS = await setupLandedWorker("legacystuck");
  fs.rmSync(LS.worktreePath, { recursive: true, force: true });
  execSync(`git worktree prune`, { cwd: LS.tagRepo });
  git(LS.tagRepo, `branch -D ${LS.branch}`);
  fs.mkdirSync(LS.worktreePath, { recursive: true }); // the stuck leftover shell
  db.insertTask({ id: LS.tagTaskId, projectId: LS.tagProjId, title: "PASTUCK-LEGACYSTUCK", body: "", columnKey: "done", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: LS.tagWorkerId, projectId: LS.tagProjId, agentId: LS.tagAgentId, engineSessionId: null, title: null, cwd: LS.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: LS.tagMgrId, taskId: LS.tagTaskId, worktreePath: LS.worktreePath, branch: LS.branch });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: LS.tagMgrId, workerSessionId: LS.tagWorkerId, taskId: LS.tagTaskId, kind: "merge_request", detail: { branch: LS.branch, filesChanged: 1, tip: LS.branch, repoKey: null } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: LS.tagMgrId, workerSessionId: LS.tagWorkerId, taskId: LS.tagTaskId, kind: "merge_done", detail: { repoKey: null } });
  await sessions.reconcileOrchestrationOnBoot();
  await sessions.reconcileOrchestrationOnBoot();
  check("(legacy-stuck) legacy no-branch match also takes the lean cleanup-only retry — still exactly ONE merge_done after 2 boots", db.listEventsForWorker(LS.tagWorkerId).filter((e) => e.kind === "merge_done").length === 1);
  check("(legacy-stuck) no worker_retired filed across either boot", db.listEventsForWorker(LS.tagWorkerId).every((e) => e.kind !== "worker_retired"));
  check("(legacy-stuck) worktree dir still present (genuinely un-removable)", fs.existsSync(LS.worktreePath));

  // ===================== MISMATCH (negative control): a merge_done for an UNRELATED task must NOT satisfy this row =====================
  // Legacy-shaped (no branch) AND task-mismatched — proves task-matching still dominates even when there's
  // no branch to disagree on. If Pass A's own alreadyFinalized/finalizedElsewhere wrongly read this as
  // "already finalized," it would take the lean cleanup-only path (no retireWorkerSession, no fresh
  // own-task merge_done) instead of genuinely attempting the finalize. NOTE: this fixture's foreign event
  // shares `M.tagWorkerId` with the real landing, which ALSO (incidentally, and out of this card's scope)
  // confuses `finalizeMerge`'s own SEPARATE, worker-id-only `hadPriorMergeDone` replay guard — so the
  // task-column-move/worktree-removal/branch-delete side effects are NOT asserted here (they'd conflate
  // that pre-existing, unrelated mechanism with the one under test). `worker_retired` + a fresh, correctly
  // task-scoped `merge_done` are the clean, direct signals that Pass A itself took the genuine path.
  const M = await setupLandedWorker("mismatch");
  db.insertTask({ id: M.tagTaskId, projectId: M.tagProjId, title: "PASTUCK-MISMATCH", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: M.tagWorkerId, projectId: M.tagProjId, agentId: M.tagAgentId, engineSessionId: null, title: null, cwd: M.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: M.tagMgrId, taskId: M.tagTaskId, worktreePath: M.worktreePath, branch: M.branch });
  // A foreign event under THIS session's id, stamped with an UNRELATED taskId and no branch at all.
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: M.tagMgrId, workerSessionId: M.tagWorkerId, taskId: `pastuck-mismatch-UNRELATED-task-${sfx}`, kind: "merge_done", detail: { repoKey: null } });
  check("(mismatch-pre) worktree present, genuinely never finalized for ITS OWN task", fs.existsSync(M.worktreePath));
  check("(mismatch-pre) no worker_retired filed yet", db.listEventsForWorker(M.tagWorkerId).every((e) => e.kind !== "worker_retired"));
  await sessions.reconcileOrchestrationOnBoot();
  check("(mismatch) the foreign-task merge_done did NOT satisfy alreadyFinalized — Pass A retired the worker, proving it took the GENUINE finalize path, not the cleanup-only skip", db.listEventsForWorker(M.tagWorkerId).some((e) => e.kind === "worker_retired"));
  check("(mismatch) a NEW merge_done was filed under THIS worker's own, correct task (not swallowed as a skip)", db.listEventsForWorker(M.tagWorkerId).some((e) => e.kind === "merge_done" && e.taskId === M.tagTaskId));

  // ===================== DIRTY (Round 4, card e34d475c): own-row retry whose worktree holds uncommitted =====
  // work — the branch must SURVIVE. Before the Round 4 fix, the lean cleanup-only path ran its CAS
  // deleteBranch unconditionally once a tip was expected, regardless of gcWorktreeDir's own outcome — so a
  // dirty-retained worktree (still checked out on `branch`) had its branch ref deleted anyway, breaking
  // decisions 6796c9ea/cc9bce38 (finalizeMerge itself has always gated the delete on this).
  const D = await setupLandedWorker("dirty");
  db.insertTask({ id: D.tagTaskId, projectId: D.tagProjId, title: "PASTUCK-DIRTY", body: "", columnKey: "done", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: D.tagWorkerId, projectId: D.tagProjId, agentId: D.tagAgentId, engineSessionId: null, title: null, cwd: D.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: D.tagMgrId, taskId: D.tagTaskId, worktreePath: D.worktreePath, branch: D.branch });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: D.tagMgrId, workerSessionId: D.tagWorkerId, taskId: D.tagTaskId, kind: "merge_request", detail: { branch: D.branch, filesChanged: 1, tip: D.branch, repoKey: null } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: D.tagMgrId, workerSessionId: D.tagWorkerId, taskId: D.tagTaskId, kind: "merge_done", detail: { branch: D.branch, repoKey: null } });
  // An untracked file the done pre-check / readWorktreeUncommittedState flags as dirty.
  fs.writeFileSync(path.join(D.worktreePath, "stray-uncommitted.txt"), "still here\n");
  const dBranchTipBefore = tryRevParse(D.tagRepo, `refs/heads/${D.branch}`);
  await sessions.reconcileOrchestrationOnBoot();
  check("(dirty) worktree RETAINED — holds uncommitted work, never force-removed", fs.existsSync(D.worktreePath));
  check("(dirty) the stray uncommitted file is still there (worktree genuinely untouched)", fs.existsSync(path.join(D.worktreePath, "stray-uncommitted.txt")));
  check("(dirty) branch ref SURVIVES at its landed tip (Round 4 Major fix)", dBranchTipBefore !== null && tryRevParse(D.tagRepo, `refs/heads/${D.branch}`) === dBranchTipBefore);
  check("(dirty) still exactly ONE merge_done (no replay)", db.listEventsForWorker(D.tagWorkerId).filter((e) => e.kind === "merge_done").length === 1);
  check("(dirty) no worker_retired filed", db.listEventsForWorker(D.tagWorkerId).every((e) => e.kind !== "worker_retired"));

  // ===================== NESTEDBLOCKED (Round 4): own-row retry whose worktree holds a nested git repo — ===
  // the branch must SURVIVE too (same gating as DIRTY above, different gcWorktreeDir outcome).
  const NB = await setupLandedWorker("nestedblocked");
  db.insertTask({ id: NB.tagTaskId, projectId: NB.tagProjId, title: "PASTUCK-NESTEDBLOCKED", body: "", columnKey: "done", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: NB.tagWorkerId, projectId: NB.tagProjId, agentId: NB.tagAgentId, engineSessionId: null, title: null, cwd: NB.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: NB.tagMgrId, taskId: NB.tagTaskId, worktreePath: NB.worktreePath, branch: NB.branch });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: NB.tagMgrId, workerSessionId: NB.tagWorkerId, taskId: NB.tagTaskId, kind: "merge_request", detail: { branch: NB.branch, filesChanged: 1, tip: NB.branch, repoKey: null } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: NB.tagMgrId, workerSessionId: NB.tagWorkerId, taskId: NB.tagTaskId, kind: "merge_done", detail: { branch: NB.branch, repoKey: null } });
  const nbNestedDir = addNestedRepo(NB.worktreePath, path.join("_external", "cloned-repo"));
  const nbBranchTipBefore = tryRevParse(NB.tagRepo, `refs/heads/${NB.branch}`);
  await sessions.reconcileOrchestrationOnBoot();
  check("(nested-blocked) worktree RETAINED — nested repo blocks removal", fs.existsSync(NB.worktreePath));
  check("(nested-blocked) nested clone content intact", fs.existsSync(path.join(nbNestedDir, "unpushed.txt")));
  check("(nested-blocked) branch ref SURVIVES at its landed tip (Round 4 Major fix)", nbBranchTipBefore !== null && tryRevParse(NB.tagRepo, `refs/heads/${NB.branch}`) === nbBranchTipBefore);
  check("(nested-blocked) still exactly ONE merge_done", db.listEventsForWorker(NB.tagWorkerId).filter((e) => e.kind === "merge_done").length === 1);
  check("(nested-blocked) no worker_retired filed", db.listEventsForWorker(NB.tagWorkerId).every((e) => e.kind !== "worker_retired"));

  // ===================== BRANCHPRESENT (card ed2d878e, item 2 — POSITIVE CONTROL for the spy itself) ===
  // Own-row retry, branch genuinely PRESENT at its landed tip, worktree left exactly as
  // `setupLandedWorker` created it (no stray file, no nested repo) — so `expectedBranchTip` IS set and
  // `finalizeWorktreeAndBranch` actually reaches its own `listCheckedOutBranches` call (gated on
  // `expectedBranchTip` being truthy) via the SAME `deleteBranchSpyFactory` the gone-branch fixtures
  // above use. This is NOT the "genuinely removable worktree" fixture Round 4's own note below still
  // defers to `pass-a-own-row-cleanup-deletes-branch.mjs` — this one only needs the spy to see a REAL
  // call, regardless of whether the delete itself proceeds or is skipped (this file's `removeDir` always
  // fails clean, so the worktree is retained either way; what matters is that `worktreeListCalls` is no
  // longer empty).
  const BP = await setupLandedWorker("branchpresent");
  db.insertTask({ id: BP.tagTaskId, projectId: BP.tagProjId, title: "PASTUCK-BRANCHPRESENT", body: "", columnKey: "done", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: BP.tagWorkerId, projectId: BP.tagProjId, agentId: BP.tagAgentId, engineSessionId: null, title: null, cwd: BP.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: BP.tagMgrId, taskId: BP.tagTaskId, worktreePath: BP.worktreePath, branch: BP.branch });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: BP.tagMgrId, workerSessionId: BP.tagWorkerId, taskId: BP.tagTaskId, kind: "merge_request", detail: { branch: BP.branch, filesChanged: 1, tip: BP.branch, repoKey: null } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: BP.tagMgrId, workerSessionId: BP.tagWorkerId, taskId: BP.tagTaskId, kind: "merge_done", detail: { branch: BP.branch, repoKey: null } });
  check("(branch-present pre) branch genuinely exists at its landed tip", tryRevParse(BP.tagRepo, `refs/heads/${BP.branch}`) !== null);
  check("(branch-present pre) the spy has NOT yet seen a `worktree list` call for this repo (isolating what THIS boot adds)",
    worktreeListCalls.every((c) => c.repoPath !== BP.tagRepo));
  await sessions.reconcileOrchestrationOnBoot(new Set(), { gitFactory: deleteBranchSpyFactory });
  check("(branch-present) POSITIVE CONTROL: the spy's gitFactory genuinely saw this tail's own `listCheckedOutBranches` call (`git worktree list --porcelain`) for THIS repo — proving the gone-branch fixtures' `branchDeleteAttempts.length === 0` isn't vacuously true because the spy was never wired to this tail at all",
    worktreeListCalls.some((c) => c.repoPath === BP.tagRepo));
  check("(branch-present) still exactly ONE merge_done (no replay)", db.listEventsForWorker(BP.tagWorkerId).filter((e) => e.kind === "merge_done").length === 1);
  check("(branch-present) no worker_retired filed", db.listEventsForWorker(BP.tagWorkerId).every((e) => e.kind !== "worker_retired"));

  // Round 4, MINOR item 2 (own-row retry, branch present at the landed tip, nothing blocking removal) is
  // NOT a fixture in THIS file — this whole file shares ONE SessionService whose `removeDir` ALWAYS
  // reports a clean-reject failure (see `makeStuckRemoveDir`, the file's own point), so a worktree here
  // can never be genuinely de-registered and `listCheckedOutBranches` would correctly keep holding its
  // branch — that's not "nothing blocking it," it's the SAME retained-worktree shape as DIRTY/
  // NESTEDBLOCKED above, just via a different gcWorktreeDir outcome. See
  // pass-a-own-row-cleanup-deletes-branch.mjs for that fixture, with its own genuinely-removable worktree.
  // (BRANCHPRESENT above shares that same retained-worktree shape — it exists only to positive-control
  // the spy, not to re-prove removability.)

  for (const p of [L.tagRepo, LS.tagRepo, M.tagRepo, D.tagRepo, NB.tagRepo, BP.tagRepo]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }
} finally {
  db.close();
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card e34d475c: an own-row landing already finalized (merge_done recorded for this exact task+branch) whose worktree dir can never be removed is retried for CLEANUP ONLY on every boot — never re-retired, never re-finalized, never a duplicate merge_done — while the removal attempt itself keeps firing every single boot, exactly as the stuck-forever case needs. A legacy merge_done with no recorded branch also matches on task alone (both gone- and stuck-worktree legs), while a merge_done for an unrelated task never satisfies this row's own finalize even when it carries no branch to mismatch on. Round 4: a dirty-retained or nested-repo-blocked own-row worktree never has its branch CAS-deleted out from under it. Card ed2d878e item 2: the BRANCHPRESENT fixture positive-controls the spy itself, proving it genuinely sees this tail's listCheckedOutBranches call rather than sitting unwired."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
