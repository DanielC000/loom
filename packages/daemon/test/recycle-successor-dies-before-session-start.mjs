import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card f349f5cb (follow-up to 4be56c33/08320d02/dc1604c7) — a recycle successor whose `pty.spawn`
// SUCCEEDS but whose process exits before it ever reaches SessionStart leaves the SAME stray
// `recycled_from` link 4be56c33's own catch already handles for a SYNCHRONOUS pre-spawn throw — but that
// catch only runs BEFORE `pty.spawn` returns, so it never observes this later, async death. The
// predecessor stays permanently `hasSuccessor()===true` ("stuck superseded": a retried recycle refused,
// crash-recovery skipping it forever) even though its "successor" never ran a turn. NOTE: for a manager,
// the ORIGINATING card also named a lineage left with nothing live / a stranded fleet — that consequence
// is NOT what this file (or the fix it covers) resolves; it's deferred to card e07b1b1a. This file/fix
// only correct `hasSuccessor()` so the predecessor becomes resumable again.
//
// Fix: `SessionService.reconcileNeverStartedRecycleSuccessor(sessionId, intended)`, called from index.ts's
// `onExit` hook for every exited session. No-op unless the exited session still has `recycledFrom` set AND
// never captured an `engineSessionId` — additionally gated on `PtyHost.hasReachedReady` (the PRIMARY
// proof: markReady never ran, so no kickoff was ever written to stdin — sound even when the
// UserPromptSubmit/SessionStart hook relay itself is lost, dc1604c7's own counterexample), plus
// `hasFirstTurnStarted`/a recorded `worker_report` event as EXTRA gates, so a successor recovered by the
// pty/host.ts spawn-armed readiness fallback (real turns ran despite SessionStart itself never landing) is
// left alone rather than wrongly hidden from `getDanglingWorkers`'s own `recycle_failed`-keyed exclusion.
// Also suppressed entirely (`recycleTeardownInFlight` / `hasSuccessor(sessionId)`) when the exiting session
// is itself mid- or already-recycled into a further successor — see recycle-successor-double-recycle-
// chain.mjs for that proof.
//
// Proves:
//   (A) WORKER, REAL PIPELINE — recycleWorker succeeds (a real fake-pty spawn, no throw), the successor's
//       pty then dies before any onData ever fires (no SessionStart, no ready marker — genuinely nothing
//       happened): reconcileNeverStartedRecycleSuccessor unlinks recycledFrom, hasSuccessor(predecessor)
//       flips true -> false, and a recycle_failed event is recorded under the right ids.
//   (B) MANAGER, REAL PIPELINE — identical shape via recycleManager: same unlink + hasSuccessor flip, and
//       the recycle_failed event is filed under the PREDECESSOR id (mirrors 08320d02's own convention),
//       with no workerSessionId. Does NOT claim to pin "nothing live"/fleet recovery — see the note above.
//   (A2) REAL PIPELINE, hasReachedReady:true via a REAL SessionStart hook (no engine id) — closes a gap
//       (C) alone left: (C) only proves the gate via a STUB pty, never the real PtyHost's own `ready`
//       field. A real successor driven to `ready` (a genuine SessionStart hook carrying no session_id,
//       mirroring the readiness-fallback shape) must be left LINKED with no recycle_failed on its own kill.
//   (C)/(C2) dc1604c7 INTERACTION GUARDS — hasReachedReady:true (C, the primary gate) or
//       hasFirstTurnStarted:true (C2, an extra gate) — the readiness-fallback path: a real turn ran despite
//       no SessionStart -> the method must NOT unlink and must NOT record recycle_failed; a genuinely-
//       dangling branch on that same worker must still APPEAR in getDanglingWorkers.
//   (D) dc1604c7 INTERACTION GUARD 3 — neither gate fires, but a worker_report event IS on record ->
//       same non-action as (C) (a third, independent proof real activity happened).
//   (E) NO-OP GUARDS — engineSessionId already captured (SessionStart landed at some point), recycledFrom
//       already null (not a recycle successor), and (E3) this session ALREADY has its own successor
//       (hasSuccessor(sessionId) true — a legitimate, chain-continuing retirement) all leave the session
//       completely untouched.
//   (F) RED/GREEN — the exact defect (A) fixes, demonstrated against a REAL revert of the fix: see the
//       recipe at the bottom of this file (a no-op stub, not a bare revert — a bare revert crashes with a
//       TypeError rather than failing the assertions for the right reason).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: (A)/(B) use a REAL Db + SessionService + PtyHost driven
// against a FAKE low-level pty (the shared createPty() seam — see _seam-host-fixture.mjs) with a captured
// handle so the test can `kill()` the successor's OWN pty directly, exercising the REAL host.ts spawn/
// onExit wiring end to end (not just this method in isolation) — though see the note at the bottom on what
// this does NOT cover (index.ts's own wiring/ordering). (C)/(C2)/(D)/(E) use a lighter stub `pty` (mirrors
// worker-exited-without-report.mjs's own style) since they only need controllable `hasReachedReady`/
// `hasFirstTurnStarted`, not a real spawn.
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-successor-dies-before-session-start.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rsdbss-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=rsdbss@loom -c user.name=rsdbss";
function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-rsdbss-repo-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# recycle-successor-dies-before-session-start ${tag}\n`);
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
function commitToBranch(worktreePath, file) {
  fs.writeFileSync(path.join(worktreePath, file), "committed to branch, not merged\n");
  commitAll(worktreePath, file, GIT_ID);
}

const worktreesToClean = [];

// ==================== (A)/(B) REAL PIPELINE — captures the actual low-level pty handle per spawn ====================
class SeamHost extends createSeamHost(PtyHost) {
  handles = new Map(); // sessionId -> the fake low-level pty object (pid/write/onData/onExit/kill/resize)
  createPty(opts) {
    const pty = super.createPty(opts);
    this.handles.set(opts.sessionId, pty);
    return pty;
  }
}
const db = new Db();
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id, code, info) {
    db.setProcessState(id, "exited");
    db.setBusy(id, false);
    // Mirrors index.ts's real onExit hook: archiveOnExit then the new reconciliation call, threading
    // info.intended through exactly as index.ts's own call site does.
    const exited = db.getSession(id);
    if (exited) sessions.archiveOnExit(exited);
    if (exited) sessions.reconcileNeverStartedRecycleSuccessor(id, info.intended);
  },
};
const host = new SeamHost(events);
const sessions = new SessionService(db, host, new OrchestrationControl());

try {
  // -------------------- (A) WORKER --------------------
  {
    const P = "rsdbss-worker", repo = makeRepo("worker");
    const { worktreePath, branch } = await createWorktree(repo, P, "wa");
    worktreesToClean.push([repo, worktreePath]);
    commitToBranch(worktreePath, "predecessor-work.txt"); // the predecessor's OWN real, unmerged work
    db.insertProject({ id: P, name: "RSDBSS-Worker", repoPath: repo, vaultPath: repo, config: {}, createdAt: new Date().toISOString(), archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
    db.insertTask({ id: "wa", projectId: P, title: "wa", body: "", columnKey: "in_progress", position: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const mgrId = `${P}-mgr1`, workerAId = `${P}-wkrA`;
    const now = new Date().toISOString();
    db.insertSession({ id: mgrId, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: "eng-old-a", title: null, cwd: worktreePath, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "wa", worktreePath, branch });

    check("(A pre) hasSuccessor(predecessor) is FALSE before any recycle", db.hasSuccessor(workerAId) === false);
    const workerB = await sessions.recycleWorker(mgrId, workerAId, "handoff — spawn succeeds, then the child dies before SessionStart");
    check("(A) recycleWorker succeeded (a real fake-pty spawn, no throw)", !!workerB && workerB.id !== workerAId);
    // The predecessor was DB-seeded directly (never host.spawn()'d), so it has no PtyHost `live` entry for
    // recycleWorker's own internal hard-kill to act on (a real predecessor WOULD have one, from its own
    // earlier spawn) — stamp its state directly, as it genuinely would end up: exited + archived (a real
    // onExit's own archiveOnExit call, mirrored here since this harness never spawned it for real).
    db.setProcessState(workerAId, "exited");
    db.archiveSession(workerAId);
    check("(A pre) hasSuccessor(predecessor) is now TRUE (the exact 'stuck superseded' state, pre-fix-callsite)", db.hasSuccessor(workerAId) === true);
    check("(A pre) the successor never captured an engineSessionId yet", !db.getSession(workerB.id)?.engineSessionId);
    check("(A pre) the successor never started a first turn (no onData ever fired)", host.hasFirstTurnStarted(workerB.id) === false);

    // --- THE BUG'S TRIGGER: the child process dies before SessionStart. No onData (no ready marker, no
    // SessionStart hook) was ever delivered to this fake pty — kill() fires the REAL host.ts onExit wiring
    // (registered by the REAL spawn() this SeamHost only fakes the low-level pty for), which in turn calls
    // this test's own `events.onExit` above (mirroring index.ts's real hook, including the new call). ---
    const successorPty = host.handles.get(workerB.id);
    check("(setup precondition) the successor's own fake pty handle was captured", !!successorPty);
    successorPty.kill();

    check("(A) the successor's own row is 'exited'", db.getSession(workerB.id)?.processState === "exited");
    check("(A) FIX: recycledFrom is unlinked on the successor's own row", db.getSession(workerB.id)?.recycledFrom === null);
    check("(A) FIX: hasSuccessor(predecessor) flips back to FALSE — no longer 'stuck superseded'", db.hasSuccessor(workerAId) === false);
    const aFailedEvents = db.listEventsForWorker(workerB.id).filter((e) => e.kind === "recycle_failed");
    check("(A) FIX: exactly one recycle_failed event recorded, filed under the manager + this successor's own id",
      aFailedEvents.length === 1 && aFailedEvents[0].managerSessionId === mgrId && aFailedEvents[0].taskId === "wa");
    check("(A) FIX: the event's detail names the predecessor + marks diedBeforeSessionStart",
      aFailedEvents[0]?.detail?.recycledFrom === workerAId && aFailedEvents[0]?.detail?.diedBeforeSessionStart === true);

    // dc1604c7 interaction: getDanglingWorkers must EXCLUDE the never-started successor (it never held
    // any work) while still surfacing the PREDECESSOR's own genuinely-unmerged commit.
    const danglingA = await sessions.getDanglingWorkers(mgrId);
    check("(A) dc1604c7 interaction: the never-started successor is EXCLUDED from getDanglingWorkers",
      !danglingA.some((e) => e.workerSessionId === workerB.id));
    check("(A) dc1604c7 interaction: the predecessor's real unmerged work still APPEARS (not hidden by the fix)",
      danglingA.some((e) => e.workerSessionId === workerAId));
    // PERSISTENCE (not a one-shot snapshot): re-read hasSuccessor after further activity (the
    // getDanglingWorkers call above) to confirm the unlink is a real, durable DB write, not a transient
    // in-memory state that could still revert. Without the fix, this would stay stuck TRUE indefinitely —
    // nothing else in the system ever clears it (see the RED/GREEN recipe at the bottom of this file).
    check("(A) FIX PERSISTS: hasSuccessor(predecessor) is still FALSE after further activity, not a transient flip",
      db.hasSuccessor(workerAId) === false);
  }

  // -------------------- (B) MANAGER --------------------
  {
    const P = "rsdbss-manager", repo = makeRepo("manager");
    worktreesToClean.push([repo, null]);
    db.insertProject({ id: P, name: "RSDBSS-Manager", repoPath: repo, vaultPath: repo, config: {}, createdAt: new Date().toISOString(), archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    const mgrAId = `${P}-mgrA`;
    const now = new Date().toISOString();
    db.insertSession({ id: mgrAId, projectId: P, agentId: `${P}-mgr`, engineSessionId: "eng-old-mgr", title: null, cwd: repo, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    check("(B pre) hasSuccessor(predecessor manager) is FALSE before any recycle", db.hasSuccessor(mgrAId) === false);
    const mgrB = await sessions.recycleManager(mgrAId, "continuation — spawn succeeds, then the child dies before SessionStart");
    check("(B) recycleManager succeeded (a real fake-pty spawn, no throw)", !!mgrB && mgrB.id !== mgrAId);
    db.setProcessState(mgrAId, "exited"); // recycleManager's own deferred 3s hard-stop — modeled directly, as the fake pty never fires a real onExit for a stop() call
    check("(B pre) hasSuccessor(predecessor manager) is now TRUE", db.hasSuccessor(mgrAId) === true);

    const successorPty = host.handles.get(mgrB.id);
    check("(setup precondition) the manager successor's own fake pty handle was captured", !!successorPty);
    successorPty.kill();

    check("(B) the manager successor's own row is 'exited'", db.getSession(mgrB.id)?.processState === "exited");
    check("(B) FIX: recycledFrom is unlinked on the successor's own row", db.getSession(mgrB.id)?.recycledFrom === null);
    check("(B) FIX: hasSuccessor(predecessor manager) flips back to FALSE — the lineage is no longer permanently stuck",
      db.hasSuccessor(mgrAId) === false);
    // Filed under the PREDECESSOR id (08320d02's own convention for manager/platform — the dead successor
    // never became a discoverable identity), so it's found via listEventsForSession(mgrAId), NOT
    // listEventsForWorker(mgrB.id) (workerSessionId is never set on this event at all for this role).
    const bFailedEvents = db.listEventsForSession(mgrAId).filter((e) => e.kind === "recycle_failed");
    check("(B) FIX: exactly one recycle_failed event recorded, filed under the PREDECESSOR id (mirrors 08320d02's own convention for manager/platform)",
      bFailedEvents.length === 1 && bFailedEvents[0].managerSessionId === mgrAId && !bFailedEvents[0].workerSessionId);
  }

  // -------------------- (A2) REAL PIPELINE — hasReachedReady:true via a REAL SessionStart hook, no engine id --------------------
  // Code Review pass 2, minor-1: (C)'s hasReachedReady:true coverage above uses the STUB pty, never the
  // real PtyHost — the reviewer proved this is a real gap by patching every onExit site to force
  // `live.ready = false` right before calling `events.onExit(...)` and finding BOTH test files still went
  // fully green. This section closes that gap: drive a REAL successor to `ready` via a genuine
  // `SessionStart` hook that carries no `session_id` (mirrors the readiness-fallback shape — a kickoff was
  // deliverable — without waiting the real ~20s READY_FALLBACK_MS timer), confirm `engineSessionId` stays
  // null, kill it, and assert it is left alone. See the bottom of this file for the RED proof against
  // exactly the mutation the reviewer used.
  //
  // Uses recycleManager, NOT recycleWorker: `resolveAgentSpawn` PINS a worker's own `startupModeCycles` to
  // whatever `auto` requires, independent of `config.permission.startupModeCycles` (card 760cd01d) — so a
  // worker's own mode-cycle is ALWAYS a real, async `cycleToMode` call here, never the synchronous
  // no-cycle path this scenario needs. A manager carries no such pin, so `startupModeCycles: 0` reaches it
  // untouched and `markReady` runs synchronously off the `deliverHook` call below.
  {
    const P = "rsdbss-manager-ready", repo = makeRepo("manager-ready");
    worktreesToClean.push([repo, null]);
    const now = new Date().toISOString();
    db.insertProject({ id: P, name: "RSDBSS-Manager-Ready", repoPath: repo, vaultPath: repo, config: { permission: { startupModeCycles: 0 } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    const mgrAId2 = `${P}-mgrA`;
    db.insertSession({ id: mgrAId2, projectId: P, agentId: `${P}-mgr`, engineSessionId: "eng-old-mgr-a2", title: null, cwd: repo, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const mgrB2 = await sessions.recycleManager(mgrAId2, "continuation — driven to ready via a real SessionStart hook, no engine id");
    db.setProcessState(mgrAId2, "exited");
    check("(A2) recycleManager succeeded (a real fake-pty spawn, no throw)", !!mgrB2 && mgrB2.id !== mgrAId2);

    // Real SessionStart hook, deliberately with NO `session_id` field — engineSessionId must stay null.
    host.deliverHook(mgrB2.id, { hook_event_name: "SessionStart" });
    check("(A2 pre) hasReachedReady is now TRUE via a REAL SessionStart hook (not the stub)", host.hasReachedReady(mgrB2.id) === true);
    check("(A2 pre) engineSessionId is STILL null (the hook carried no session_id)", !db.getSession(mgrB2.id)?.engineSessionId);

    const successorPty2 = host.handles.get(mgrB2.id);
    check("(setup precondition) the (A2) successor's own fake pty handle was captured", !!successorPty2);
    successorPty2.kill();

    check("(A2) FIX: recycledFrom is LEFT LINKED — hasReachedReady:true means real activity may have happened",
      db.getSession(mgrB2.id)?.recycledFrom === mgrAId2);
    check("(A2) FIX: NO recycle_failed event was fabricated",
      db.listEventsForSession(mgrAId2).filter((e) => e.kind === "recycle_failed").length === 0);
    check("(A2) FIX: hasSuccessor(predecessor) stays TRUE (unaffected by a genuinely-ready successor's own later death)",
      db.hasSuccessor(mgrAId2) === true);
  }
} finally {
  for (const [repo, wt] of worktreesToClean) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

// ==================== (C)/(D)/(E) — stub pty, DB-seeded scenarios (dc1604c7 interaction + no-op guards) ====================
{
  const db2 = new Db();
  const reachedReadyIds = new Set(); // controllable per-sessionId hasReachedReady stub (the PRIMARY gate)
  const firstTurnStartedIds = new Set(); // controllable per-sessionId hasFirstTurnStarted stub (an EXTRA gate)
  const pty2 = {
    hasReachedReady: (id) => reachedReadyIds.has(id),
    hasFirstTurnStarted: (id) => firstTurnStartedIds.has(id),
  };
  const sessions2 = new SessionService(db2, pty2, new OrchestrationControl());
  const now = new Date().toISOString();
  const GIT_ID2 = "-c user.email=rsdbss2@loom -c user.name=rsdbss2";
  const repoC = path.join(os.tmpdir(), `loom-rsdbss-repoC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repoC, { recursive: true });
  fs.writeFileSync(path.join(repoC, "README.md"), "# rsdbss-c\n");
  execSync(`git init -q`, { cwd: repoC });
  commitAll(repoC, "init", GIT_ID2);

  try {
    db2.insertProject({ id: "pC", name: "C", repoPath: repoC, vaultPath: repoC, config: {}, createdAt: now, archivedAt: null });
    db2.insertAgent({ id: "agentC", projectId: "pC", name: "Dev", startupPrompt: "DEV", position: 0, profileId: null });
    db2.insertSession({ id: "mgrC", projectId: "pC", agentId: "agentC", engineSessionId: null, title: null, cwd: repoC, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    // -------------------- (C) hasReachedReady:true (the PRIMARY gate) — real work MAY have happened via the readiness fallback --------------------
    {
      const { worktreePath, branch } = await createWorktree(repoC, "pC", "tC1");
      commitToBranch(worktreePath, "c1.txt"); // this successor DID real work
      db2.insertTask({ id: "tC1", projectId: "pC", title: "tC1", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db2.insertSession({ id: "predC1", projectId: "pC", agentId: "agentC", engineSessionId: "eng-predC1", title: null, cwd: worktreePath, processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgrC", taskId: "tC1", worktreePath, branch });
      db2.insertSession({ id: "succC1", projectId: "pC", agentId: "agentC", engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgrC", taskId: "tC1", worktreePath, branch, recycledFrom: "predC1" });
      db2.archiveSession("succC1");
      reachedReadyIds.add("succC1"); // markReady ran (the readiness-fallback path) — a kickoff MAY have been delivered

      sessions2.reconcileNeverStartedRecycleSuccessor("succC1", false);
      check("(C) hasReachedReady:true — recycledFrom is LEFT LINKED (real work may exist)", db2.getSession("succC1")?.recycledFrom === "predC1");
      check("(C) hasReachedReady:true — NO recycle_failed event recorded", db2.listEventsForWorker("succC1").filter((e) => e.kind === "recycle_failed").length === 0);
      check("(C) hasReachedReady:true — hasSuccessor(predecessor) stays TRUE (unchanged — not this method's business here)", db2.hasSuccessor("predC1") === true);
      const danglingC = await sessions2.getDanglingWorkers("mgrC");
      check("(C) dc1604c7 interaction: the genuinely-active successor's own real commit STILL APPEARS in getDanglingWorkers (not hidden)",
        danglingC.some((e) => e.workerSessionId === "succC1"));
    }

    // -------------------- (C2) hasReachedReady:false but hasFirstTurnStarted:true (an EXTRA gate catching what the primary gate alone would miss) --------------------
    {
      const { worktreePath, branch } = await createWorktree(repoC, "pC", "tC2");
      db2.insertTask({ id: "tC2", projectId: "pC", title: "tC2", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db2.insertSession({ id: "predC2", projectId: "pC", agentId: "agentC", engineSessionId: "eng-predC2", title: null, cwd: worktreePath, processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgrC", taskId: "tC2", worktreePath, branch });
      db2.insertSession({ id: "succC2", projectId: "pC", agentId: "agentC", engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgrC", taskId: "tC2", worktreePath, branch, recycledFrom: "predC2" });
      firstTurnStartedIds.add("succC2"); // UserPromptSubmit fired despite hasReachedReady reading false (the two are stubbed independently on purpose)

      sessions2.reconcileNeverStartedRecycleSuccessor("succC2", false);
      check("(C2) hasFirstTurnStarted:true (extra gate) — recycledFrom is LEFT LINKED", db2.getSession("succC2")?.recycledFrom === "predC2");
      check("(C2) hasFirstTurnStarted:true (extra gate) — NO recycle_failed event recorded", db2.listEventsForWorker("succC2").filter((e) => e.kind === "recycle_failed").length === 0);
    }

    // -------------------- (D) hasReachedReady:false, hasFirstTurnStarted:false, but a worker_report event IS on record --------------------
    {
      const { worktreePath, branch } = await createWorktree(repoC, "pC", "tD1");
      db2.insertTask({ id: "tD1", projectId: "pC", title: "tD1", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db2.insertSession({ id: "predD1", projectId: "pC", agentId: "agentC", engineSessionId: "eng-predD1", title: null, cwd: worktreePath, processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgrC", taskId: "tD1", worktreePath, branch });
      db2.insertSession({ id: "succD1", projectId: "pC", agentId: "agentC", engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgrC", taskId: "tD1", worktreePath, branch, recycledFrom: "predD1" });
      db2.appendEvent({ id: "evD1", ts: now, managerSessionId: "mgrC", workerSessionId: "succD1", taskId: "tD1", kind: "worker_report", detail: { status: "progress", summary: "a real report actually fired" } });

      sessions2.reconcileNeverStartedRecycleSuccessor("succD1", false);
      check("(D) a worker_report event on record — recycledFrom is LEFT LINKED", db2.getSession("succD1")?.recycledFrom === "predD1");
      check("(D) a worker_report event on record — NO recycle_failed event recorded (would double-count as a real report AND a failure)",
        db2.listEventsForWorker("succD1").filter((e) => e.kind === "recycle_failed").length === 0);
    }

    // -------------------- (E) NO-OP GUARDS --------------------
    {
      // (E1) engineSessionId already captured — SessionStart landed at some point in this session's life.
      db2.insertSession({ id: "predE1", projectId: "pC", agentId: "agentC", engineSessionId: "eng-predE1", title: null, cwd: repoC, processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgrC" });
      db2.insertSession({ id: "succE1", projectId: "pC", agentId: "agentC", engineSessionId: "eng-succE1", title: null, cwd: repoC, processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgrC", recycledFrom: "predE1" });
      sessions2.reconcileNeverStartedRecycleSuccessor("succE1", false);
      check("(E1) engineSessionId already captured — recycledFrom untouched", db2.getSession("succE1")?.recycledFrom === "predE1");
      check("(E1) engineSessionId already captured — hasSuccessor(predecessor) untouched (still TRUE)", db2.hasSuccessor("predE1") === true);

      // (E2) recycledFrom already null — not a recycle successor at all.
      db2.insertSession({ id: "plainE2", projectId: "pC", agentId: "agentC", engineSessionId: null, title: null, cwd: repoC, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgrC" });
      sessions2.reconcileNeverStartedRecycleSuccessor("plainE2", false); // must not throw, must not append anything
      check("(E2) recycledFrom already null — no recycle_failed event fabricated", db2.listEventsForWorker("plainE2").filter((e) => e.kind === "recycle_failed").length === 0);

      // (E3) this session ALREADY has its OWN successor (hasSuccessor(sessionId) true) — a legitimate,
      // chain-continuing retirement, never a dead end (the same guard that protects recycleManager/
      // recyclePlatformLead — see recycle-successor-double-recycle-chain.mjs for the full recycleWorker
      // chain proof via the real teardown-in-flight marker instead).
      db2.insertSession({ id: "predE3", projectId: "pC", agentId: "agentC", engineSessionId: null, title: null, cwd: repoC, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgrC" });
      db2.insertSession({ id: "succE3", projectId: "pC", agentId: "agentC", engineSessionId: null, title: null, cwd: repoC, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgrC", recycledFrom: "predE3" });
      db2.insertSession({ id: "succOfSuccE3", projectId: "pC", agentId: "agentC", engineSessionId: null, title: null, cwd: repoC, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgrC", recycledFrom: "succE3" });
      sessions2.reconcileNeverStartedRecycleSuccessor("succE3", false);
      check("(E3) this session already has its OWN successor — recycledFrom untouched (a legitimate chain-continuing retirement, never a dead end)",
        db2.getSession("succE3")?.recycledFrom === "predE3");
      check("(E3) hasSuccessor(predE3) stays TRUE via succE3 (unchanged)", db2.hasSuccessor("predE3") === true);
      check("(E3) no recycle_failed event fabricated for succE3", db2.listEventsForWorker("succE3").filter((e) => e.kind === "recycle_failed").length === 0);
    }
  } finally {
    db2.close();
    try { fs.rmSync(repoC, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

db.close();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

// RED/GREEN, VERIFIED (not just argued): a BARE revert of the fix (`git checkout HEAD --
// packages/daemon/src/sessions/service.ts packages/daemon/src/index.ts`) does NOT produce a clean RED
// here — it removes `reconcileNeverStartedRecycleSuccessor` entirely, so the shim's own call to it (the
// `events.onExit` object above, mirroring index.ts's real call site) throws a TypeError ("... is not a
// function") from inside `successorPty.kill()`, crashing the whole file before any assertion runs. To see
// the intended RED — the (A)/(B) "FIX:" assertions failing for the RIGHT reason (the method ran, but did
// nothing) — stub the method to a NO-OP body instead of deleting it: temporarily replace
// `reconcileNeverStartedRecycleSuccessor`'s ENTIRE body (signature through closing brace — leaving any of
// the original body as dead code past a bare `return;` makes `tsc` fail on now-unreachable-but-still-
// checked nullability, e.g. `'s' is possibly undefined`) with just `return;`, rebuild, re-run this file.
// VERIFIED result: 9 failures, no crash — "(A) FIX: recycledFrom is unlinked", "(A) FIX:
// hasSuccessor(predecessor) flips back to FALSE", "(A) FIX PERSISTS: ... not a transient flip", the
// recycle_failed/detail checks, and the dc1604c7-exclusion check all fail for (A); the three "(B) FIX:"
// checks fail identically for the manager path; (C)/(C2)/(D)/(E) — which exercise the stub-pty path,
// unaffected by this stub — still pass. Revert the stub and rebuild to restore GREEN (all pass again).
//
// COVERAGE GAP (say-so, not fixed here): this file drives `reconcileNeverStartedRecycleSuccessor` via its
// OWN `events.onExit` shim, which re-implements (rather than imports) index.ts's real onExit hook body —
// so it proves the METHOD's own behavior, never that index.ts's REAL onExit actually calls it, or that it
// runs in the right position relative to `archiveOnExit`. See
// recycle-successor-onexit-wiring.mjs for a cheap, separate source-text pin of exactly that wiring.
console.log(failures === 0
  ? "\n✅ ALL PASS — a recycle successor whose process dies before SessionStart (spawn succeeded, no pre-spawn throw) is now unlinked + audited (recycle_failed) exactly like a synchronous pre-spawn failure, for both worker and manager; a successor recovered by the readiness fallback (a real turn ran, or a worker_report already fired) is left untouched and still surfaces in getDanglingWorkers, never hidden by this fix; a successor with an already-captured engineSessionId or no recycledFrom at all is a complete no-op."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
