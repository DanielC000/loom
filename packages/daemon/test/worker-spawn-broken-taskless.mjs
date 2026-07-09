import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// TASKLESS broken-spawn watchdog coverage (CR follow-up on card 2514e6e1's taskless worker_spawn).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, mirrors worker-kickoff-guarantee.mjs's (S) block /
// idle-worker-watcher.mjs's harness: a REAL Db + SessionService driven against a lightweight recording
// pty stub (no PtyHost, no real git — this exercises notifyManagerOfIdleWorker's classification logic
// directly, not the worktree/spawn machinery those other files already cover).
//
// THE GAP CLOSED: notifyManagerOfIdleWorker (and classifyIdleWorker underneath it) hard-skipped ANY
// taskless session at their entry guard (`!w.taskId`) — so a taskless worker (an ad-hoc spike, or a
// read-only Code Reviewer with no vehicle card) whose spawn kickoff silently never ran got NO
// [loom:worker-spawn-broken] nudge at all. Before taskless spawns existed, EVERY worker carried a real
// taskId (a vehicle card, if nothing else), so this watchdog covered 100% of workers; taskless spawns
// opened a real coverage hole. FIX: notifyManagerOfIdleWorker now special-cases a taskless worker with
// its OWN narrow (board-state-free) broken-spawn check, mirroring busy-worker-watcher.ts's taskId-
// optional message shape (`w.taskId ? ... : ""`) — while classifyIdleWorker's board-column-dependent
// classification (parked-ack/stranded/etc) stays intentionally out of scope for taskless (no card to
// reconcile against — see that function's own comment).
//
// Proves:
//   (T1) a taskless worker with engineSessionId:null → the SAME [loom:worker-spawn-broken] nudge a tasked
//        worker gets, just with no "(task X)" mention (mirrors worker-kickoff-guarantee.mjs's S1).
//   (T2) a taskless worker with engineSessionId SET (a real turn ran) → NO nudge at all (there's no board-
//        column-based "did NOT call worker_report" signal for a taskless worker — regression guard: it
//        must not be silently mis-classified as broken, nor spuriously nudged for the ordinary case).
//   (T3) a taskless worker with engineSessionId:null AND pending direction already queued → still SKIPS
//        (the same redirect-race guard classifyIdleWorker applies for tasked workers, applied here too).
//   (T4) a TASKED worker's broken-spawn nudge is completely unaffected (still fires, still names the task)
//        — the taskless branch is additive, not a regression on the existing path.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-broken-taskless.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const NOW = new Date();

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-wsbt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `wsbt-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `wsbta-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "Taskless", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const enqueued = [];
  const pendingBySession = new Map();
  const pty = {
    enqueueStdin: (id, text) => {
      enqueued.push({ id, text });
      const s = db.getSession(id);
      return s?.processState === "live" ? { delivered: true } : { delivered: false, position: 1 };
    },
    getPendingEntries: (id) => pendingBySession.get(id) ?? [],
  };
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  return { dbFile, db, projId, agentId, enqueued, sessions, pendingBySession };
}
function seedSession(e, id, { role = "worker", processState = "live", parentSessionId = null, taskId = null, branch = null, engineSessionId = "eng-" + id } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId, title: null, cwd: e.projId,
    processState, resumability: "resumable", busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role,
    parentSessionId, taskId, ctxInputTokens: null, ctxTurns: null, model: null, worktreePath: null, branch,
  });
}
function seedTask(e, id, columnKey = "in_progress") {
  e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey, position: 0, priority: "p2", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============ (T1) taskless + engineSessionId:null → broken-spawn nudge, no task mention ============
{
  const e = makeEnv();
  seedSession(e, "mgr-t1", { role: "manager" });
  // TASKLESS: no taskId, no branch pinned via a task — mirrors a real taskless worker_spawn row.
  seedSession(e, "wkr-t1", { taskId: null, parentSessionId: "mgr-t1", branch: "loom/spike-t1", engineSessionId: null });

  e.sessions.notifyManagerOfIdleWorker("wkr-t1");
  const broken = e.enqueued.find((x) => x.id === "mgr-t1" && /worker-spawn-broken/.test(x.text));
  check("(T1) taskless + engineSessionId:null → a [loom:worker-spawn-broken] nudge IS pushed (the gap this closes)", !!broken);
  check("(T1) the nudge names the worker + points at re-drive (worker_message/recycle)",
    !!broken && broken.text.includes("wkr-t1") && /worker_message/.test(broken.text));
  check("(T1) the nudge has NO '(task ...)' mention (there is no task)", !!broken && !/\(task /.test(broken.text));
  check("(T1) the nudge is explicit this is NOT benign", !!broken && /NOT a benign/i.test(broken.text));
  check("(T1) exactly ONE nudge fires (no double-signal)", e.enqueued.filter((x) => x.id === "mgr-t1").length === 1);
  cleanup(e);
}

// ============ (T2) taskless + engineSessionId SET → NO nudge (regression guard) ============
{
  const e = makeEnv();
  seedSession(e, "mgr-t2", { role: "manager" });
  seedSession(e, "wkr-t2", { taskId: null, parentSessionId: "mgr-t2", branch: "loom/spike-t2", engineSessionId: "eng-wkr-t2" });

  e.sessions.notifyManagerOfIdleWorker("wkr-t2");
  check("(T2) taskless + engineSessionId set → NO nudge at all (no board-column signal exists for a taskless worker)",
    e.enqueued.filter((x) => x.id === "mgr-t2").length === 0);
  cleanup(e);
}

// ============ (T3) taskless + engineSessionId:null + pending direction queued → still SKIPS ============
{
  const e = makeEnv();
  seedSession(e, "mgr-t3", { role: "manager" });
  seedSession(e, "wkr-t3", { taskId: null, parentSessionId: "mgr-t3", branch: "loom/spike-t3", engineSessionId: null });
  e.pendingBySession.set("wkr-t3", [{ id: "m1", text: "[loom:from-manager:redirect]\ndo X instead", source: "system" }]);

  e.sessions.notifyManagerOfIdleWorker("wkr-t3");
  check("(T3) pending direction still suppresses the taskless broken-spawn nudge (same redirect-race guard as tasked)",
    e.enqueued.length === 0);
  cleanup(e);
}

// ============ (T4) a TASKED worker's broken-spawn nudge is unaffected by the taskless branch ============
{
  const e = makeEnv();
  seedSession(e, "mgr-t4", { role: "manager" });
  seedTask(e, "tk-t4");
  seedSession(e, "wkr-t4", { taskId: "tk-t4", parentSessionId: "mgr-t4", branch: "loom/tk-t4", engineSessionId: null });

  e.sessions.notifyManagerOfIdleWorker("wkr-t4");
  const broken = e.enqueued.find((x) => x.id === "mgr-t4" && /worker-spawn-broken/.test(x.text));
  check("(T4) a TASKED worker's broken-spawn nudge still fires exactly as before", !!broken);
  check("(T4) it still names the task (unlike the taskless case in T1)", !!broken && broken.text.includes("tk-t4") && /\(task /.test(broken.text));
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — notifyManagerOfIdleWorker now covers a TASKLESS worker's broken spawn (engineSessionId never established → [loom:worker-spawn-broken], no task mention, same redirect-race guard as tasked), closing the safety-net gap taskless worker_spawn opened; a taskless worker that started fine draws no false nudge; a TASKED worker's existing broken-spawn coverage is byte-unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
