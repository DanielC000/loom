import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// TASKLESS worker_spawn (board cards 2514e6e1 + 72ee0bcf, folded into one change). DETERMINISTIC +
// CLAUDE-FREE + NETWORK-FREE, hermetic like worker-spawn-live-task-guard.mjs / merge-spawn-tracked.mjs: a
// REAL Db + SessionService driven against a FAKE pty (createPty() seam), a real temp git repo behind
// createWorktree.
//
// THE GAP THIS CLOSES: worker_spawn hard-required a taskId, so (a) an ad-hoc spike/no-commit research
// worker had to hijack an unrelated real card (falsifying its board state) just to get a worktree, and
// (b) a read-only Code Reviewer wanting to look at a LIVE author worker's branch tripped the
// one-live-worker-per-task guard on that same taskId, forcing a manager to mint a throwaway "vehicle"
// card. FIX: an empty/omitted taskId now spawns a TASKLESS worker — its own isolated worktree/branch, no
// board card touched, and it never competes for the per-task guard (a read-only reviewer just spawns
// taskless, pointed at the author's branch via its kickoff, and runs alongside the still-live author).
//
// Proves:
//   (1) a taskless spawn (taskId omitted) succeeds: role=worker, taskId===null, its OWN worktree on disk.
//   (2) TWO taskless spawns never collide — each gets a DISTINCT worktree/branch (unlike two tasked spawns
//       on the SAME task, which share a deterministic worktree — see worker-spawn-live-task-guard.mjs).
//   (3) a taskless spawn does NOT trip — and is NOT tripped by — the one-live-worker-per-task guard: a
//       taskless "reviewer" spawns successfully WHILE a real tasked worker is LIVE on a task (the CR-
//       alongside-a-live-author scenario 72ee0bcf exists to unblock), with NO vehicle card.
//   (4) the guard STILL rejects a SECOND live COMMITTING (tasked) worker on the same task — taskless
//       spawns do not weaken it.
//   (5) (isolated mini-project, cap=2) an in-flight taskless spawn still counts toward
//       maxConcurrentWorkers (the concurrency-cap admit is claim-based, not taskId-based) — a tasked +
//       a taskless spawn fill a cap of 2, and a third (of either kind) is rejected.
//   (6) workerReport(done) on a taskless worker completes cleanly with NO board transition (there is no
//       card to move) — and the declared-no-commit auto-retire path (card 14434d6b) works identically for
//       a taskless worker as it does for a tasked one, so a read-only taskless reviewer's concurrency slot
//       still frees itself with no manual worker_stop.
//   (7) a taskless worker WITH a real commit can still be landed via confirmWorkerMergeTracked — the
//       branch merges onto main, but (unlike a tasked merge) NO board task is touched anywhere in the
//       process, proving the completion/merge path is null-taskId-clean end to end, not just at report time.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-taskless.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const rejects = async (label, fn, needle) => {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  const ok = threw != null && (!needle || String(threw.message).includes(needle));
  check(`${label}${ok || !threw ? "" : ` (got: ${threw.message})`}`, ok);
};

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-wstl-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=wstl@loom -c user.name=wstl";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# wstl\n");
  execSync(`git init -q && git config user.email wstl@loom && git config user.name wstl && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

const now = new Date().toISOString();
const db = new Db();

class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

// --- main scenario project (generous cap — the cap admission itself is tested in isolation below) ---
const repo = path.join(os.tmpdir(), `loom-wstl-repo-${Date.now()}`);
initRepo(repo);
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 20 } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
// A no-commit rig (mirrors the bundled Code Reviewer) for the taskless reviewer scenario.
db.insertProfile({ id: "profCR", name: "Code Reviewer", role: "worker", description: "read-only reviewer", allowDelta: [], skills: null, model: null, icon: null, noCommit: true });
db.insertAgent({ id: "agentCR", projectId: "pP", name: "Code Reviewer", startupPrompt: "CR", position: 2, profileId: "profCR" });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
const taskGood = randomUUID();
db.insertTask({ id: taskGood, projectId: "pP", title: "real", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

const worktrees = [];
try {
  // ===================== (1) a taskless spawn succeeds, own worktree, taskId null =====================
  const spike = await svc.spawnWorker("mgr1", { agentId: "agentDev", kickoffPrompt: "investigate X, no card for this" });
  worktrees.push(spike.worktreePath);
  check("(1) taskless spawn succeeds: role=worker, taskId is null", spike.role === "worker" && spike.taskId === null);
  check("(1) taskless spawn got its OWN worktree on disk", !!spike.worktreePath && fs.existsSync(spike.worktreePath));
  check("(1) taskless spawn's session row persists taskId null", db.getSession(spike.id).taskId === null);
  check("(1) no board task was touched by a taskless spawn", db.getTask(taskGood).columnKey === "backlog");

  // ===================== (2) TWO taskless spawns never collide =====================
  const spike2 = await svc.spawnWorker("mgr1", { agentId: "agentDev", kickoffPrompt: "investigate Y, also no card" });
  worktrees.push(spike2.worktreePath);
  check("(2) a second taskless spawn gets a DISTINCT worktree from the first",
    spike2.worktreePath !== spike.worktreePath && spike2.branch !== spike.branch);
  check("(2) both taskless workers are independently live", db.getSession(spike.id).processState === "live" && db.getSession(spike2.id).processState === "live");

  // ===================== (3)/(4) taskless never trips — nor weakens — the per-task guard =====================
  const author = await svc.spawnWorker("mgr1", { taskId: taskGood, agentId: "agentDev", kickoffPrompt: "implement the real task" });
  worktrees.push(author.worktreePath);
  check("(3 setup) the tasked author worker is live on taskGood", author.taskId === taskGood && db.getSession(author.id).processState === "live");

  // (3) a read-only reviewer spawns TASKLESS, pointed at the author's branch via its kickoff — no vehicle
  // card needed, and it does NOT collide with the still-live author (own worktree, no taskId at all).
  const reviewer = await svc.spawnWorker("mgr1", {
    agentId: "agentCR",
    kickoffPrompt: `read-only review of branch ${author.branch} (task ${taskGood}) — do not commit`,
  });
  worktrees.push(reviewer.worktreePath);
  check("(3) taskless reviewer spawns successfully WHILE the author is still live on the same logical task",
    reviewer.role === "worker" && reviewer.taskId === null && reviewer.noCommit === true);
  check("(3) reviewer's worktree is DISTINCT from the author's (never shares/clobbers it)",
    reviewer.worktreePath !== author.worktreePath && reviewer.branch !== author.branch);
  check("(3) the author's worktree is untouched by the reviewer's spawn", fs.existsSync(author.worktreePath));

  // (4) the guard is STILL fully intact for a REAL second tasked (committing) spawn on the SAME task.
  await rejects("(4) a SECOND tasked/committing spawn on taskGood is still rejected (guard not weakened by taskless spawns)",
    () => svc.spawnWorker("mgr1", { taskId: taskGood, agentId: "agentDev", kickoffPrompt: "GO AGAIN" }), "already has a live worker");

  // ===================== (6) workerReport(done) on a taskless worker — no board transition =====================
  // (6a) a DECLARED no-commit taskless worker (the reviewer from (3)) reports done with 0 commits: cleanly
  // completes, auto-retires (frees its slot with no manual worker_stop — same contract as a TASKED
  // no-commit worker, see no-commit-reviewer.mjs), and — since taskId is null — touches NO board task.
  const rReviewer = await svc.workerReport(reviewer.id, { status: "done", summary: "reviewed — no findings" });
  check("(6a) taskless no-commit reviewer's done report succeeds, not refused", rReviewer.reported === true && !rReviewer.refused);
  check("(6a) taskless no-commit reviewer auto-retires (autoRetired:true, same as a tasked reviewer)", rReviewer.autoRetired === true);
  check("(6a) taskless no-commit reviewer: warning suppressed (its correct contract is 0 files changed)", rReviewer.warning === undefined);
  check("(6a) taskGood's card is UNCHANGED by the taskless reviewer's report (it was never bound to it)", db.getTask(taskGood).columnKey === "in_progress");
  const spawnEventsForReviewer = db.listEventsForWorker(reviewer.id);
  check("(6a) the recorded spawn_worker/worker_report events for the taskless reviewer carry taskId null",
    spawnEventsForReviewer.length > 0 && spawnEventsForReviewer.every((e) => e.taskId === null || e.taskId === undefined));

  // (6b) a NORMAL (non-no-commit) taskless worker (spike, 0 commits) reports done: warns (forgot-to-commit
  // safety net intact) but is NOT auto-retired and stays live — mirrors the tasked case exactly, just with
  // no task to (not) move.
  const rSpike = await svc.workerReport(spike.id, { status: "done", summary: "nothing landed, just research" });
  check("(6b) normal taskless worker, 0-ahead: reported, not refused", rSpike.reported === true && !rSpike.refused);
  check("(6b) normal taskless worker, 0-ahead: STILL warns (forgot-to-commit net intact for taskless too)", typeof rSpike.warning === "string");
  check("(6b) normal taskless worker, 0-ahead: NOT auto-retired (autoRetired absent)", rSpike.autoRetired === undefined);

  // ===================== (7) a taskless worker WITH a real commit lands via confirmWorkerMergeTracked =====================
  // A FRESH taskless worktree, constructed directly (mirrors merge-spawn-tracked.mjs's Merge scenarios,
  // which insert the session row directly rather than routing through a live pty spawn — the merge path
  // itself is what's under test here). createWorktree's key just needs to be a fresh, unique string — a
  // taskless spawn keys its worktree the same way in production (see spawnWorker's `claimKey`).
  const { worktreePath: twt, branch: tbranch } = await createWorktree(repo, "pP", `taskless-${randomUUID()}`);
  worktrees.push(twt);
  fs.writeFileSync(path.join(twt, "spike-finding.txt"), "turned out to be worth landing\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "spike: worth landing"`, { cwd: twt });
  const workerIdT = "wstl-taskless-merge-worker";
  db.insertSession({ id: workerIdT, projectId: "pP", agentId: "agentDev", engineSessionId: null, title: null,
    cwd: twt, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: "mgr1", taskId: null, worktreePath: twt, branch: tbranch });

  const headBefore = git(repo, "rev-parse HEAD");
  const tasksBefore = db.listTasks("pP").map((t) => ({ id: t.id, columnKey: t.columnKey }));
  const merge = await svc.confirmWorkerMergeTracked("mgr1", workerIdT);
  check("(7) a taskless worker's branch merges cleanly via confirmWorkerMergeTracked", merge.settled === true && merge.ok === true && merge.value.merged === true);
  check("(7) the file actually landed on main", fs.existsSync(path.join(repo, "spike-finding.txt")));
  check("(7) exactly one new commit landed (a real squash, not a no-op)", git(repo, `rev-list --count ${headBefore}..HEAD`) === "1");
  const tasksAfter = db.listTasks("pP").map((t) => ({ id: t.id, columnKey: t.columnKey }));
  check("(7) NO board task's column changed as a side effect of the taskless merge",
    JSON.stringify(tasksBefore) === JSON.stringify(tasksAfter));
  check("(7) the taskless worker's worktree was retired same as a normal merge", !fs.existsSync(twt));

  // ===================== (5) isolated mini-project: taskless spawn counts toward the concurrency cap =====================
  {
    const repoCap = path.join(os.tmpdir(), `loom-wstl-cap-repo-${Date.now()}`);
    initRepo(repoCap);
    db.insertProject({ id: "pCap", name: "Cap", repoPath: repoCap, vaultPath: repoCap, config: { orchestration: { maxConcurrentWorkers: 2 } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "capMgrAgent", projectId: "pCap", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    db.insertAgent({ id: "capDevAgent", projectId: "pCap", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
    db.insertSession({ id: "capMgr", projectId: "pCap", agentId: "capMgrAgent", engineSessionId: null, title: null,
      cwd: repoCap, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const capTask = randomUUID();
    db.insertTask({ id: capTask, projectId: "pCap", title: "cap-task", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    const capTasked = await svc.spawnWorker("capMgr", { taskId: capTask, agentId: "capDevAgent", kickoffPrompt: "GO" });
    const capTaskless = await svc.spawnWorker("capMgr", { agentId: "capDevAgent", kickoffPrompt: "a taskless spawn filling the SECOND cap slot" });
    check("(5) a tasked + a taskless spawn together fill a cap of 2", db.listWorkers("capMgr").filter((w) => w.processState === "live").length === 2);
    await rejects("(5) a THIRD spawn (of either kind) is rejected once a taskless spawn has helped fill the cap",
      () => svc.spawnWorker("capMgr", { agentId: "capDevAgent", kickoffPrompt: "one too many" }), "concurrency cap reached");

    try {
      const { removeWorktree } = await import("../dist/git/worktrees.js");
      for (const wt of [capTasked.worktreePath, capTaskless.worktreePath]) { try { await removeWorktree(repoCap, wt); } catch { /* best-effort */ } }
    } catch { /* best-effort */ }
    try { fs.rmSync(repoCap, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [...new Set(worktrees.filter(Boolean))]) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_spawn supports a TASKLESS spawn (omitted taskId): its own isolated worktree, never colliding with another taskless spawn or a live tasked author's worktree, never tripping (or weakening) the one-live-worker-per-task guard, still counted against the concurrency cap, reporting/merging cleanly with NO board transition since there is no card — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
