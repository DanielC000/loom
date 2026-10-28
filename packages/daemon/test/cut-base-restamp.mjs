import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cc788ae4 — SessionService.restampWorkerCutBase + the manager-only MCP registration. Design/trust
// analysis: docs/decisions/cc788ae4-*.md. Pure eligibility-check scenarios live in
// cut-base-restamp-eligibility.mjs.
//
// Scenario 8 (end-to-end): a genuine cross-lineage divergence + a linear rebase + a real restamp updates
//   the DB, files the audit event, and makes the merge-time checkCutBaseAncestry pass where it refused.
// Scenario 9: a workerSessionId in a different project is refused.
// Scenario 10: a live/queued gate op on the repo refuses the restamp.
// Scenario 11: a task already proven merged is refused.
// Scenario 12: the branch no longer exists in the canonical repo is refused.
// Scenario 13: a true no-op (cutBaseSha already equals the target tip) — no write, no audit event.
// Scenario 14: `dryRun:true` writes nothing and files no audit event; a real follow-up call still writes.
// Scenario 15 (MCP surface): manager-only, absent from the worker router.
// Scenario 16: a session with a NEWER sibling row at the same worktree path/branch is refused; the
//   newest row itself still succeeds.
//
// Run: 1) build daemon (pnpm build), 2) node test/cut-base-restamp.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { useOwnLoomHome, registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("loom-cbr-home-");
requireHermeticEnv();

const { commitAll } = await import("./_git-commit.mjs");
const { git, GIT_ID, ptyStub, noReap, PASS_GATE, listToolNames, callTool, parse } = await import("./_project-checkout-branch-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { createWorktree, checkCutBaseAncestry } = await import("../dist/git/worktrees.js");
const { canonicalGit } = await import("../dist/git/bounded.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function freshRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-cbr-repo-${tag}-${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# cbr ${tag}\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", [..."config user.email cbr@loom".split(" ")], { cwd: repo });
  execFileSync("git", [..."config user.name cbr".split(" ")], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

const db = new Db();
let fxSeq = 0;
/** Builds a fresh repo + project + manager (+ worker, unless opts.noWorker) for ONE scenario. The
 *  worker's worktree/branch is a REAL createWorktree cut, with its real `mainSha` captured and stamped
 *  as the session's `cutBaseSha` explicitly (the fixture's own addWorker leaves it null/legacy by
 *  design — this file needs it set so the restamp has something real to clear). */
async function makeFixture(label, opts = {}) {
  const sfx = `${Date.now()}-${++fxSeq}-${Math.random().toString(36).slice(2, 6)}`;
  const repo = opts.repo ?? freshRepo(label);
  const now = new Date().toISOString();
  const projId = `cbr-${label}-proj-${sfx}`, agentId = `cbr-${label}-agent-${sfx}`, mgrId = `cbr-${label}-mgr-${sfx}`;
  db.insertProject({ id: projId, name: label, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS_GATE, reapWorktreeProcesses: noReap });
  const orch = new OrchestrationMcpRouter(db, sessions);
  const call = (toolName, args) => callTool(orch.buildServer(mgrId, "manager"), toolName, args);
  let worker;
  if (!opts.noWorker) {
    const taskId = `cbr-${label}-task-${sfx}`, workerId = `cbr-${label}-wkr-${sfx}`;
    db.insertTask({ id: taskId, projectId: projId, title: `feat(x): change ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch, mainSha } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, `${label}.ts`), `export const ${label} = 1;\n`);
    commitAll(worktreePath, `feat(x): change ${label}`, GIT_ID);
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch, cutBaseSha: mainSha });
    worker = { taskId, workerId, worktreePath, branch, cutBaseSha: mainSha };
  }
  return { label, repo, projId, agentId, mgrId, sessions, orch, call, worker };
}
const eventsFor = (projectId) => db.listEventsSince(0, 100000).filter((e) => e.kind === "worker_cut_base_restamped" && e.detail?.projectId === projectId);

try {
  // ===================================================================================
  // SCENARIO 8 — end-to-end: a real cross-lineage divergence, a real linear rebase, a real restamp, and
  // a real merge-time ancestry recheck that now passes where it used to fail.
  // ===================================================================================
  {
    // Mainline advances to c1 BEFORE the worker is ever cut (createWorktree's own mainSha = c1), so the
    // worker's recorded cutBaseSha is c1, NOT the repo's root — mirroring fork-point-ancestry.mjs's own
    // scenario A exactly (a worker cut from the repo's bare ROOT trivially "contains" anything diverged
    // from that same root, so the divergence must happen BEFORE the cut, from an EARLIER commit).
    const repo = freshRepo("e2e");
    const base = git(repo, "rev-parse", "HEAD"); // the repo's own root commit
    fs.writeFileSync(path.join(repo, "main-advance-e2e.txt"), "main advanced\n");
    commitAll(repo, "main advances", GIT_ID);

    const fx = await makeFixture("e2e", { repo });
    const { workerId, worktreePath, branch, cutBaseSha: oldCutBaseSha } = fx.worker;
    check("(8 setup) the worker's recorded cutBaseSha is c1, not the repo's root", oldCutBaseSha !== base);
    // Canonical diverts to an UNRELATED "atlas" lineage, cut from the EARLIER root — the worker's own
    // cutBaseSha (c1) is genuinely not an ancestor of it.
    execFileSync("git", ["checkout", "-q", "-b", "atlas-e2e", base], { cwd: repo });
    fs.writeFileSync(path.join(repo, "atlas-e2e.txt"), "atlas work\n");
    commitAll(repo, "atlas work", GIT_ID);
    const atlasTip = git(repo, "rev-parse", "HEAD");
    check("(8 setup) the worker's OLD cutBaseSha is NOT an ancestor of the new target",
      (() => { try { execFileSync("git", ["merge-base", "--is-ancestor", oldCutBaseSha, atlasTip], { cwd: repo }); return false; } catch { return true; } })());
    const gitInst = canonicalGit(repo, 15_000);
    const preCheck = await checkCutBaseAncestry(gitInst, 15_000, oldCutBaseSha, atlasTip);
    check("(8 setup) the merge-time check genuinely refuses against the OLD cutBaseSha", preCheck.ok === false);

    // The worker's branch is rebased LINEARLY onto atlasTip — real git rebase, mirroring the real remedy.
    // Run INSIDE the worker's own worktree (where the branch is actually checked out) — rebasing it from
    // the canonical repo refuses with "already used by worktree".
    execFileSync("git", ["rebase", "-q", "--onto", atlasTip, oldCutBaseSha], { cwd: worktreePath });
    const newBranchTip = git(worktreePath, "rev-parse", "HEAD");

    const result = await fx.call("worker_restamp_cut_base", { workerSessionId: workerId });
    check("(8) restamp succeeds", result.ok === true);
    check("(8) reports the OLD cut base", result.oldCutBaseSha === oldCutBaseSha);
    check("(8) reports the NEW cut base as the atlas tip", result.newCutBaseSha === atlasTip);
    check("(8) reports noop:false (a real change)", result.noop === false);
    check("(8) reports the real branchExtraCount (one worker commit, rebased)", result.branchExtraCount === 1);

    const row = db.getSession(workerId);
    check("(8) the session's OWN cutBaseSha is updated in the DB", row.cutBaseSha === atlasTip);
    const evts = eventsFor(fx.projId);
    check("(8) exactly one worker_cut_base_restamped audit event filed", evts.length === 1);
    check("(8) the event names the old/new sha, branch, and acting manager",
      evts[0].detail.oldCutBaseSha === oldCutBaseSha && evts[0].detail.newCutBaseSha === atlasTip &&
      evts[0].detail.branch === branch && evts[0].managerSessionId === fx.mgrId);

    const postCheck = await checkCutBaseAncestry(gitInst, 15_000, row.cutBaseSha, atlasTip);
    check("(8) the SAME merge-time check now PASSES against the NEW cutBaseSha", postCheck.ok === true);
    check("(8) the branch's real tip is unaffected by the restamp (restamp never touches the branch)", git(fx.repo, "rev-parse", branch) === newBranchTip);
  }

  // ===================================================================================
  // SCENARIO 9 — a workerSessionId in a DIFFERENT project is refused.
  // ===================================================================================
  {
    const fxA = await makeFixture("cross-a");
    const fxB = await makeFixture("cross-b");
    const result = await fxA.call("worker_restamp_cut_base", { workerSessionId: fxB.worker.workerId });
    check("(9) refused — cross-project workerSessionId", result.ok === false);
    check("(9) the OTHER project's session is untouched", db.getSession(fxB.worker.workerId).cutBaseSha === fxB.worker.cutBaseSha);
  }

  // ===================================================================================
  // SCENARIO 10 — a live/queued gate op on the repo refuses the restamp.
  // ===================================================================================
  {
    const fx = await makeFixture("gate");
    const pendingOpId = "cbr-gate-pending-1";
    db.insertPendingGateOp({
      opId: pendingOpId, kind: "gate", key: `worker-gate:${pendingOpId}`, ownerSessionId: fx.mgrId,
      projectId: fx.projId, taskId: fx.worker.taskId, branch: fx.worker.branch, startedAt: new Date().toISOString(),
      state: "pending", surfacedPending: true,
    });
    const r1 = await fx.call("worker_restamp_cut_base", { workerSessionId: fx.worker.workerId });
    check("(10) refused while a gate op is live", r1.ok === false && r1.refused === true && Array.isArray(r1.liveGateOps) && r1.liveGateOps.some((o) => o.opId === pendingOpId));
    check("(10) the session is untouched", db.getSession(fx.worker.workerId).cutBaseSha === fx.worker.cutBaseSha);
    db.settlePendingGateOp(pendingOpId);
    check("(10) negative control: once settled, liveGateOpsForRepoPath no longer sees it", !fx.sessions.liveGateOpsForRepoPath(fx.repo).some((o) => o.opId === pendingOpId));
  }

  // ===================================================================================
  // SCENARIO 11 — a task already proven merged is refused.
  // ===================================================================================
  {
    const fx = await makeFixture("merged");
    // Land the worker for real (a genuine merge) so getTaskMergedInfo finds a real squash commit.
    const confirmed = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, fx.worker.workerId);
    check("(11 setup) the worker lands for real", confirmed.settled === true && confirmed.ok === true && confirmed.value.merged === true);
    const result = await fx.call("worker_restamp_cut_base", { workerSessionId: fx.worker.workerId });
    check("(11) refused — task already proven merged", result.ok === false && /already proven merged/i.test(result.error ?? ""));
  }

  // ===================================================================================
  // SCENARIO 12 — the branch no longer exists in the canonical repo.
  // ===================================================================================
  {
    const fx = await makeFixture("gone");
    // Remove the worktree FIRST — a branch checked out in its own worktree refuses a plain `branch -D`.
    execFileSync("git", ["worktree", "remove", "--force", fx.worker.worktreePath], { cwd: fx.repo });
    execFileSync("git", ["branch", "-D", fx.worker.branch], { cwd: fx.repo });
    const result = await fx.call("worker_restamp_cut_base", { workerSessionId: fx.worker.workerId });
    check("(12) refused — branch no longer exists", result.ok === false && /no longer exists/i.test(result.error ?? ""));
  }

  // ===================================================================================
  // SCENARIO 13 — a true no-op: cutBaseSha already equals the current target tip.
  // ===================================================================================
  {
    const fx = await makeFixture("noop");
    // The worker's recorded cutBaseSha IS the canonical repo's current HEAD already (no checkout switch,
    // no divergence) — restamping should re-verify and report a clean no-op, no write, no event.
    check("(13 setup) the session's cutBaseSha already equals the current canonical HEAD", fx.worker.cutBaseSha === git(fx.repo, "rev-parse", "HEAD"));
    const result = await fx.call("worker_restamp_cut_base", { workerSessionId: fx.worker.workerId });
    check("(13) ok:true, noop:true", result.ok === true && result.noop === true);
    check("(13) no audit event filed for a no-op", eventsFor(fx.projId).length === 0);
    check("(13) the session row is byte-identical (no spurious write)", db.getSession(fx.worker.workerId).cutBaseSha === fx.worker.cutBaseSha);
  }

  // ===================================================================================
  // SCENARIO 14 — dryRun:true writes nothing and files no audit event, even on a call that would
  // otherwise succeed for real.
  // ===================================================================================
  {
    const repo = freshRepo("dryrun");
    const base = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "main-advance-dryrun.txt"), "main advanced\n");
    commitAll(repo, "main advances", GIT_ID);

    const fx = await makeFixture("dryrun", { repo });
    const { workerId, worktreePath, cutBaseSha: oldCutBaseSha } = fx.worker;
    execFileSync("git", ["checkout", "-q", "-b", "atlas-dryrun", base], { cwd: repo });
    fs.writeFileSync(path.join(repo, "atlas-dryrun.txt"), "atlas work\n");
    commitAll(repo, "atlas work", GIT_ID);
    const atlasTip = git(repo, "rev-parse", "HEAD");
    execFileSync("git", ["rebase", "-q", "--onto", atlasTip, oldCutBaseSha], { cwd: worktreePath });

    const result = await fx.call("worker_restamp_cut_base", { workerSessionId: workerId, dryRun: true });
    check("(14) dryRun reports ok:true, dryRun:true", result.ok === true && result.dryRun === true);
    check("(14) dryRun reports the SAME new cut base a real call would stamp", result.newCutBaseSha === atlasTip);
    check("(14) the session row is UNCHANGED by a dry run", db.getSession(workerId).cutBaseSha === oldCutBaseSha);
    check("(14) no audit event filed by a dry run", eventsFor(fx.projId).length === 0);
    // Negative control: a REAL (non-dryRun) call right after still succeeds and DOES write — proves the
    // dry run above didn't silently consume/invalidate anything.
    const real = await fx.call("worker_restamp_cut_base", { workerSessionId: workerId });
    check("(14 control) the SAME request without dryRun actually writes", real.ok === true && real.noop === false);
    check("(14 control) the session row IS updated by the real call", db.getSession(workerId).cutBaseSha === atlasTip);
    check("(14 control) exactly one audit event exists after the real call", eventsFor(fx.projId).length === 1);
  }

  // ===================================================================================
  // SCENARIO 15 — MCP surface: manager-only, absent from the worker router.
  // ===================================================================================
  {
    const fx = await makeFixture("surface", { noWorker: true });
    const managerTools = await listToolNames(fx.orch.buildServer(fx.mgrId, "manager"));
    check("(15) worker_restamp_cut_base IS on the manager surface", managerTools.includes("worker_restamp_cut_base"));
    const workerSessionIdForSurface = `cbr-surface-wkr-${Date.now()}`;
    const now = new Date().toISOString();
    db.insertSession({ id: workerSessionIdForSurface, projectId: fx.projId, agentId: fx.agentId, engineSessionId: null, title: null, cwd: fx.repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker" });
    const workerTools = await listToolNames(fx.orch.buildServer(workerSessionIdForSurface, "worker"));
    check("(15) worker_restamp_cut_base is ABSENT from the worker surface", !workerTools.includes("worker_restamp_cut_base"));
  }

  // ===================================================================================
  // SCENARIO 16 (Code Review fix round, manager ruling) — a NEWER sibling row (a real recycled
  // successor) at the same worktree path/branch: restamping the OLD (predecessor) row is refused,
  // naming the successor's id; restamping the NEWEST (successor) row itself succeeds.
  // ===================================================================================
  {
    const repo = freshRepo("recycle");
    const base = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "main-advance-recycle.txt"), "main advanced\n");
    commitAll(repo, "main advances", GIT_ID);
    const now = new Date().toISOString();
    const projId = "cbr-recycle-proj", agentId = "cbr-recycle-agent", mgrId = "cbr-recycle-mgr", taskId = "cbr-recycle-task";
    db.insertProject({ id: projId, name: "recycle", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0, profileId: null });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertTask({ id: taskId, projectId: projId, title: "feat(x): recycle scenario", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    // A real fake-pty seam (card ec7983c6's canonical shape) — recycleWorker hard-stops the predecessor's
    // pty and waits on isAlive() before reusing the worktree; this seam drives no real OS process, so
    // isAlive() must read false immediately for that wait to resolve.
    class SeamHost extends createSeamHost(PtyHost) { isAlive() { return false; } }
    const events16 = {
      onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
      onBusy(id, busy) { db.setBusy(id, busy); },
      onContextStats() {}, onRateLimited() {},
      onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
    };
    const host16 = new SeamHost(events16);
    const sessions16 = new SessionService(db, host16, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS_GATE, reapWorktreeProcesses: noReap });
    const orch16 = new OrchestrationMcpRouter(db, sessions16);
    const call16 = (toolName, args) => callTool(orch16.buildServer(mgrId, "manager"), toolName, args);

    const predecessor = await sessions16.spawnWorker(mgrId, { taskId, agentId, kickoffPrompt: "GO" });
    registerForCleanup(predecessor.worktreePath);
    const oldCutBaseSha = db.getSession(predecessor.id).cutBaseSha;
    check("(16 setup) the predecessor has a real recorded cutBaseSha", typeof oldCutBaseSha === "string" && oldCutBaseSha.length > 0);
    const successor = await sessions16.recycleWorker(mgrId, predecessor.id, "handing off to successor for scenario 16");
    check("(16 setup) the successor is a genuinely different session id", successor.id !== predecessor.id);
    check("(16 setup) the successor shares the predecessor's own worktree path", successor.worktreePath === predecessor.worktreePath);
    check("(16 setup) the successor carries the SAME recorded cutBaseSha forward", successor.cutBaseSha === oldCutBaseSha);
    check("(16 setup) the successor's row is genuinely newer than the predecessor's", successor.createdAt >= predecessor.createdAt);

    // Divert canonical to an unrelated lineage and rebase the (shared) worktree's branch onto it, exactly
    // as scenario 8 does — the SAME divergence/rebase applies to whichever row's id names this worktree.
    execFileSync("git", ["checkout", "-q", "-b", "atlas-recycle", base], { cwd: repo });
    fs.writeFileSync(path.join(repo, "atlas-recycle.txt"), "atlas work\n");
    commitAll(repo, "atlas work", GIT_ID);
    const atlasTip = git(repo, "rev-parse", "HEAD");
    execFileSync("git", ["rebase", "-q", "--onto", atlasTip, oldCutBaseSha], { cwd: successor.worktreePath });

    const refused = await call16("worker_restamp_cut_base", { workerSessionId: predecessor.id });
    check("(16) restamping the OLD (predecessor) row is refused", refused.ok === false);
    check("(16) the refusal names the successor's id", (refused.error ?? "").includes(successor.id));
    check("(16) the predecessor's own row is untouched", db.getSession(predecessor.id).cutBaseSha === oldCutBaseSha);

    const succeeded = await call16("worker_restamp_cut_base", { workerSessionId: successor.id });
    check("(16) restamping the NEWEST (successor) row succeeds", succeeded.ok === true && succeeded.noop === false);
    check("(16) the successor's own row IS updated", db.getSession(successor.id).cutBaseSha === atlasTip);
  }
} finally {
  // registerForCleanup-tracked dirs are swept by the harness; LOOM_HOME itself is cleaned by useOwnLoomHome.
  // db.close() first — an open sqlite handle otherwise leaves loom.db locked when the harness tries to
  // remove LOOM_HOME at exit.
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a real cross-lineage divergence + linear rebase + restamp updates the DB, files a durable audit event, and makes the merge-time ancestry check pass where it used to refuse; a cross-project workerSessionId, a live gate op, an already-merged task, and a gone branch are all refused; a same-state call is a true no-op (no write, no event); dryRun:true reports the same shape with no write and no event, and a REAL follow-up call still succeeds; the tool is manager-only, absent from the worker surface; and, with a real recycled pair, restamping the superseded predecessor row is refused (naming the successor) while the newest row itself succeeds."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
