import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Self-host daemon-restart support test (the `daemon_restart` manager tool). NO claude, NO live
// daemon, NO process.exit — drives the restart module + SessionService directly against an isolated
// LOOM_HOME. Proves:
//   (1) restart-intent roundtrips: write → read → clear (and reads null when absent), INCLUDING a
//       `pending` FIFO snapshot (sessionId → queued inbound msgs) persisted byte-for-byte, order intact.
//   (4) boot replay seam: replaying an intent's `pending` snapshot onto a resumed (not-yet-ready) pty
//       re-enqueues each session's messages in FIFO order (getPending after replay == the snapshot) —
//       the persisted analogue of recycle's in-process carriedPending, mirrored from index.ts boot.
//   (2) reconcileOrchestrationOnBoot PROTECTS a restart-intent worker's worktree from boot GC: WITH
//       the worker in the protected set the worktree is RETAINED (prunes 0) so boot can resume into it.
//       And WITHOUT protection the same work-holding worktree is STILL retained — now by the P0
//       safe-to-discard guard (defense-in-depth: a worktree holding unmerged/uncommitted work is never
//       auto-deleted on boot, protected or not). (Pre-guard the unprotected exited worktree was pruned —
//       the data-loss bug that guard fixes.)
//   (3) requestDaemonRestart REFUSES when unsupervised (LOOM_SUPERVISED unset) — returns
//       {restarting:false,error} and writes NO intent + does NOT exit (so a dev/non-supervised
//       daemon can't be killed with nothing to bring it back).
// Run: 1) build daemon, 2) node test/restart-intent.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ri-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
delete process.env.LOOM_SUPERVISED; // ensure the unsupervised-refusal test is deterministic

const restart = await import("../dist/orchestration/restart.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=ri@loom -c user.name=ri";
const now = new Date().toISOString();

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const repo = path.join(os.tmpdir(), `loom-ri-repo-${sfx}`);
const ids = { projId: `ri-proj-${sfx}`, agentId: `ri-top-${sfx}`, taskId: `ri-task-${sfx}`, mgrId: `ri-mgr-${sfx}`, workerId: `ri-wkr-${sfx}` };
let worktreePath; // hoisted so the finally cleanup can reach it

try {
  // --- (1) intent roundtrip ---
  check("(1) reads null when no intent present", restart.readRestartIntent() === null);
  const intent = { reason: "deploy merged daemon code", managerSessionId: ids.mgrId, workerSessionIds: [ids.workerId], requestedAt: now };
  restart.writeRestartIntent(intent);
  const read = restart.readRestartIntent();
  check("(1) intent roundtrips (reason + manager + workers)",
    read && read.reason === intent.reason && read.managerSessionId === ids.mgrId && JSON.stringify(read.workerSessionIds) === JSON.stringify([ids.workerId]));
  restart.clearRestartIntent();
  check("(1) intent cleared → reads null again", restart.readRestartIntent() === null);
  check("(1) RESTART_EXIT_CODE is the agreed sentinel (75)", restart.RESTART_EXIT_CODE === 75);

  // --- (1b) an intent carrying a `pending` FIFO snapshot round-trips intact (order preserved) ---
  const pendingSnap = {
    [ids.mgrId]: ["queued for busy manager (worker_report frame)", "second manager msg"],
    [ids.workerId]: ["queued for busy worker"],
  };
  restart.writeRestartIntent({ reason: "deploy", managerSessionId: ids.mgrId, workerSessionIds: [ids.workerId], requestedAt: now, pending: pendingSnap });
  const readP = restart.readRestartIntent();
  check("(1b) intent's pending snapshot round-trips byte-for-byte (FIFO order preserved)",
    readP && JSON.stringify(readP.pending) === JSON.stringify(pendingSnap));
  restart.clearRestartIntent();

  // --- setup: a real exited worker with a committed-but-unmerged worktree on disk ---
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# ri\n");
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const wt = await createWorktree(repo, ids.projId, ids.taskId);
  worktreePath = wt.worktreePath;
  const branch = wt.branch;
  fs.writeFileSync(path.join(worktreePath, "work.txt"), "in-flight worker change\n");
  commitAll(worktreePath, "work", GIT_ID);

  db.insertProject({ id: ids.projId, name: "RI", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: ids.agentId, projectId: ids.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: ids.taskId, projectId: ids.projId, title: "RI", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: ids.mgrId, projectId: ids.projId, agentId: ids.agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // The worker was LIVE at restart, marked 'exited' by recoverStaleSessions — exactly pass-B's GC target.
  db.insertSession({ id: ids.workerId, projectId: ids.projId, agentId: ids.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: ids.mgrId, taskId: ids.taskId, worktreePath, branch });

  // --- (2) protection: WITH the worker protected, its worktree survives the reconcile ---
  check("(2-pre) worktree present before reconcile", fs.existsSync(worktreePath));
  const rProtected = await sessions.reconcileOrchestrationOnBoot(new Set([ids.workerId]));
  check("(2) protected reconcile pruned 0 worktrees", rProtected.worktreesPruned === 0);
  check("(2) protected worker's worktree RETAINED (resumable)", fs.existsSync(worktreePath));

  // --- and WITHOUT protection, the same worktree is STILL retained — now by the P0 safe-to-discard
  //     guard (it holds unmerged committed work). Defense-in-depth: a work-holding worktree is NEVER
  //     auto-deleted on boot, protected or not. (Pre-guard this exited worktree was pruned — the bug.) ---
  const rUnprotected = await sessions.reconcileOrchestrationOnBoot();
  check("(2) unprotected reconcile prunes 0 (work-holding worktree kept by the safety net)", rUnprotected.worktreesPruned === 0);
  check("(2) unprotected work-holding worktree KEPT (never auto-deleted)", rUnprotected.worktreesKept === 1 && fs.existsSync(worktreePath));

  // --- (3) unsupervised refusal ---
  const refusal = await sessions.requestDaemonRestart(ids.mgrId, "should be refused");
  check("(3) unsupervised requestDaemonRestart returns restarting:false", refusal.restarting === false);
  check("(3) unsupervised refusal carries an explanatory error", typeof refusal.error === "string" && refusal.error.length > 0);
  check("(3) unsupervised refusal wrote NO intent (daemon left untouched)", restart.readRestartIntent() === null);
  // role gate: a non-manager cannot restart the daemon.
  let threw = false;
  try { await sessions.requestDaemonRestart(ids.workerId, "nope"); } catch { threw = true; }
  check("(3) a worker calling requestDaemonRestart throws (manager-only)", threw);

  // --- (3b) card 83718377: supervised BUT the live supervisor process can no longer be confirmed —
  // requestDaemonRestart must refuse in the SAME {restarting:false, error} shape as the unsupervised
  // case above, WITHOUT ever reaching buildDaemon (a doomed restart shouldn't pay for a rebuild) or exit
  // (the daemon must stay fully up). buildDeps.runStep records a call so a false PASS (build ran anyway)
  // is caught rather than silently missed.
  let buildStepCalled = false;
  const buildDepsNeverCalled = { runStep: async () => { buildStepCalled = true; return { code: 0, out: "" }; } };
  let exitCalled = false;
  process.env.LOOM_SUPERVISED = "1";
  let livenessRefusal;
  try {
    livenessRefusal = await sessions.requestDaemonRestart(ids.mgrId, "should be refused — supervisor unconfirmed", {
      buildDeps: buildDepsNeverCalled,
      exit: () => { exitCalled = true; },
      isSupervisorAlive: async () => ({ alive: false, reason: "TEST: supervisor pid no longer running" }),
    });
  } finally {
    delete process.env.LOOM_SUPERVISED;
  }
  check("(3b) unconfirmed-supervisor requestDaemonRestart returns restarting:false", livenessRefusal.restarting === false);
  check("(3b) unconfirmed-supervisor refusal carries an explanatory error naming the reason", typeof livenessRefusal.error === "string" && livenessRefusal.error.includes("TEST: supervisor pid no longer running"));
  check("(3b) unconfirmed-supervisor refusal never reached buildDaemon", buildStepCalled === false);
  check("(3b) unconfirmed-supervisor refusal never called exit (daemon stays up)", exitCalled === false);
  check("(3b) unconfirmed-supervisor refusal wrote NO intent (daemon left untouched)", restart.readRestartIntent() === null);

  // --- (3c) same shape, but the CHECK ITSELF failed (enumeration timeout/error) rather than confirming
  // the supervisor is dead — the refusal must still leave the daemon up, and should read as "retry", not
  // "the supervisor is gone" (checkFailed:true is surfaced distinctly in requestDaemonRestart's wording).
  process.env.LOOM_SUPERVISED = "1";
  let checkFailedRefusal;
  try {
    checkFailedRefusal = await sessions.requestDaemonRestart(ids.mgrId, "should be refused — liveness check itself failed", {
      buildDeps: buildDepsNeverCalled,
      exit: () => { exitCalled = true; },
      isSupervisorAlive: async () => ({ alive: false, checkFailed: true, reason: "TEST: enumeration timed out" }),
    });
  } finally {
    delete process.env.LOOM_SUPERVISED;
  }
  check("(3c) check-failed requestDaemonRestart also returns restarting:false", checkFailedRefusal.restarting === false);
  check("(3c) check-failed refusal wording is distinguishable from a confirmed-dead supervisor (says it's a failed CHECK)", /failed CHECK/i.test(checkFailedRefusal.error) && /retry/i.test(checkFailedRefusal.error));
  check("(3c) the confirmed-dead refusal (3b) does NOT carry that same distinguishing wording", !/failed CHECK/i.test(livenessRefusal.error));
  check("(3c) check-failed refusal never reached buildDaemon either", buildStepCalled === false);
  check("(3c) check-failed refusal never called exit either", exitCalled === false);

  // --- (3d) card 83718377 Code Review finding #3: buildDaemon() and the merge-danger wait can each take
  // minutes AFTER the first liveness check — a supervisor that dies during either window must still be
  // caught by a SECOND check right before exit, not sail through on a stale "yes" from minutes earlier.
  // isSupervisorAlive here is STATEFUL: alive on its first call (so the pre-build gate passes and a real
  // build/intent-write actually happens), dead on every call after (simulating the supervisor dying
  // during buildDaemon/the merge-danger wait) — proving the recheck actually fires post-build, refuses,
  // clears the now-stale intent it just wrote, and never calls exit.
  let buildStepCalledInPassThenFail = false;
  const buildDepsForPassThenFail = { runStep: async () => { buildStepCalledInPassThenFail = true; return { code: 0, out: "" }; } };
  let exitCalledInPassThenFail = false;
  let livenessCallCount = 0;
  process.env.LOOM_SUPERVISED = "1";
  let passThenFailResult;
  try {
    passThenFailResult = await sessions.requestDaemonRestart(ids.mgrId, "should build, then refuse right before exit", {
      buildDeps: buildDepsForPassThenFail,
      exit: () => { exitCalledInPassThenFail = true; },
      mergeDangerGraceMs: 200,
      isSupervisorAlive: async () => {
        livenessCallCount++;
        return livenessCallCount === 1
          ? { alive: true }
          : { alive: false, reason: "TEST: supervisor died during buildDaemon/the merge-danger wait" };
      },
    });
  } finally {
    delete process.env.LOOM_SUPERVISED;
  }
  check("(3d) the pre-build check passed and a real build actually ran (not skipped)", buildStepCalledInPassThenFail === true);
  check("(3d) liveness was checked AT LEAST twice (pre-build AND pre-exit)", livenessCallCount >= 2);
  check("(3d) the pass-then-fail sequence still returns restarting:false", passThenFailResult.restarting === false);
  check("(3d) the pass-then-fail refusal names the second-check reason", typeof passThenFailResult.error === "string" && passThenFailResult.error.includes("TEST: supervisor died during buildDaemon/the merge-danger wait"));
  check("(3d) exit was NEVER called, even though the build succeeded", exitCalledInPassThenFail === false);
  check("(3d) the intent written after the (passing) pre-build check was CLEARED by the failed recheck", restart.readRestartIntent() === null);

  // --- (4) boot replay seam: replaying the intent's pending snapshot onto a resumed pty preserves FIFO order ---
  // A minimal stand-in for the PTY host's FIFO seam: a freshly resumed pty is not-ready, so every
  // enqueueStdin QUEUES (the ready-gated path in host.ts) and getPending returns a copy — exactly what
  // boot's replay relies on. Claude-free: proves the replay re-enqueues in order without a live engine.
  class PtyStub {
    constructor() { this.q = new Map(); }
    enqueueStdin(id, text) { const a = this.q.get(id) ?? []; a.push(text); this.q.set(id, a); return { delivered: false, position: a.length }; }
    getPending(id) { return [...(this.q.get(id) ?? [])]; }
  }
  const replaySnap = {
    [ids.mgrId]: ["mgr msg 1 (worker_report frame)", "mgr msg 2", "mgr msg 3"],
    [ids.workerId]: ["wkr msg A", "wkr msg B"],
  };
  restart.writeRestartIntent({ reason: "deploy", managerSessionId: ids.mgrId, workerSessionIds: [ids.workerId], requestedAt: now, pending: replaySnap });
  const replayIntent = restart.readRestartIntent();
  const pty = new PtyStub();
  // Mirror index.ts boot exactly: replay each resumed session's pending IN ORDER (BEFORE any nudge).
  const replayPending = (id) => { for (const m of replayIntent.pending?.[id] ?? []) pty.enqueueStdin(id, m); };
  for (const wid of replayIntent.workerSessionIds) replayPending(wid);
  replayPending(replayIntent.managerSessionId);
  check("(4) manager FIFO replayed onto resumed pty in order",
    JSON.stringify(pty.getPending(ids.mgrId)) === JSON.stringify(replaySnap[ids.mgrId]));
  check("(4) worker FIFO replayed onto resumed pty in order",
    JSON.stringify(pty.getPending(ids.workerId)) === JSON.stringify(replaySnap[ids.workerId]));
  check("(4) a session with no pending snapshot replays nothing",
    pty.getPending("no-such-session").length === 0);
  restart.clearRestartIntent();
} finally {
  db.close();
  try { if (worktreePath) fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — restart intent roundtrips (incl. the pending FIFO snapshot, replayed in order onto a resumed pty), the reconcile retains an intent worker's worktree (protected, and — defense-in-depth — even unprotected when it holds work), and an unsupervised/non-manager daemon_restart is refused without side effects."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
