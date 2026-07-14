import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Idle-worker/manager watchdog INTEGRATION test (board cards b9d479b0 + 99efaab3, landed together —
// same two watcher files, semantically entangled). Unlike idle-watcher.mjs (which drives IdleWatcher
// with a recording STUB for notifyIdleWorker), this wires the REAL SessionService.notifyManagerOfIdleWorker
// in, so the periodic idle-worker nudge exercises its ACTUAL queued-report / parked-awaiting-ack /
// broken-spawn reconciliation — proving requirement #1 from card 99efaab3 (the new periodic nudge must
// never re-implement that reconciliation, or it reintroduces the exact false alarm the card fixed).
//
// Asserts:
//   (a) DoD (a) — an idle manager whose SOLE live worker is ALSO idle, stale, and unreported: SOMETHING
//       nudges within the window. Both halves fire: the manager loop's OWN idle nudge (b9d479b0's
//       manager-skip tightening — no longer silenced by a live IDLE worker) AND the new periodic
//       idle-worker loop (via the real notifyManagerOfIdleWorker).
//   (b) DoD (b) — a worker whose OWN worker_report is sitting queued/pending in its manager's FIFO draws
//       NO "did NOT call worker_report" nudge from the periodic idle-worker path either — the real
//       QUEUED-REPORT GUARD (board card a1f06bcc) suppresses it exactly as it does on the busy→false edge.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { IdleWatcher } from "../dist/orchestration/idle-watcher.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-07-08T12:00:00.000Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-idle-wkr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `iw-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `iwa-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "IdleWorker", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

  const alive = new Set();
  const enqueued = [];
  const pendingBySession = new Map();
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => {
      enqueued.push({ id, text });
      const s = db.getSession(id);
      return s?.processState === "live" ? { delivered: true } : { delivered: false, position: 1 };
    },
    getPendingEntries: (id) => pendingBySession.get(id) ?? [],
  };
  const control = new OrchestrationControl();
  const sessions = new SessionService(db, pty, control);
  // The load-bearing wiring under test: IdleWatcher's periodic idle-worker nudge, AND the manager-loop's
  // own idle message, call straight through to the REAL SessionService methods — the same two index.ts
  // wires in production — never a re-implemented reconciliation.
  const watcher = new IdleWatcher({
    db, pty, control, recycleRatio: 0,
    notifyIdleWorker: (id) => sessions.notifyManagerOfIdleWorker(id),
    isWorkerStranded: (id) => sessions.isWorkerGenuinelyStranded(id),
  });
  return { dbFile, db, projId, agentId, alive, enqueued, control, sessions, watcher, pendingBySession };
}

function seedManager(e, id, { busy = false, idleMin = 60 } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role: "manager",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add(id);
}
function seedWorker(e, id, parentId, taskId, { idleMin = 60, rateLimitedUntil = null } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role: "worker",
    parentSessionId: parentId, taskId, ctxInputTokens: null, ctxTurns: null, model: null, rateLimitedUntil,
  });
  e.alive.add(id);
}
function seedTask(e, id, columnKey = "in_progress") {
  e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey, position: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============ (a) idle manager + sole live worker idle-and-stale-and-unreported → SOMETHING nudges ============
{
  const e = makeEnv();
  seedManager(e, "mgr-a", { busy: false, idleMin: 60 }); // idle 60m > default idleNudgeMinutes (45)
  seedTask(e, "tk-a", "in_progress");
  seedWorker(e, "wkr-a", "mgr-a", "tk-a", { idleMin: 60 }); // idle 60m > default idleWorkerMinutes (45), never reported

  e.watcher.tick(NOW);

  const managerNudge = e.enqueued.find((x) => x.id === "mgr-a" && x.text.startsWith("[loom:idle]"));
  const workerNudge = e.enqueued.find((x) => x.id === "mgr-a" && /worker-idle/.test(x.text));
  check("(a) the manager's OWN idle nudge fires despite its live worker (no longer silenced — b9d479b0)", !!managerNudge);
  check("(a) that nudge honestly says its live worker is ALSO idle (not 'no live workers')", !!managerNudge && /live worker\(s\) are ALSO idle/.test(managerNudge.text) && !/no live workers/.test(managerNudge.text));
  check("(a) the NEW periodic idle-worker nudge ALSO fires (via the real notifyManagerOfIdleWorker)", !!workerNudge);
  check("(a) the worker nudge correctly alleges it did NOT call worker_report (it genuinely didn't)", !!workerNudge && /did NOT call worker_report/.test(workerNudge.text));
  cleanup(e);
}

// ============ (b) queued/pending worker_report → NO false 'did NOT call worker_report' from the periodic path ============
{
  const e = makeEnv();
  // Manager BUSY (mid-turn reviewing something else) so the MANAGER-loop nudge is out of scope here —
  // isolates the assertion to the periodic idle-WORKER path's reconciliation.
  seedManager(e, "mgr-b", { busy: true, idleMin: 60 });
  seedTask(e, "tk-b", "in_progress"); // never actually moved — the report is only QUEUED, not drained
  seedWorker(e, "wkr-b", "mgr-b", "tk-b", { idleMin: 60 }); // idle 60m > default idleWorkerMinutes (45)
  // The worker's own done report already fired and is sitting undelivered in the manager's pending FIFO
  // (deliveryStatus "queued" — manager was mid-turn) — exactly workerReport()'s enqueue shape.
  e.pendingBySession.set("mgr-b", [{ id: "r1", text: "[loom:worker-report] worker wkr-b (task tk-b) — done: shipped it", source: "system" }]);

  e.watcher.tick(NOW);

  check("(b) NO false 'did NOT call worker_report' nudge for a worker whose own report is queued",
    !e.enqueued.some((x) => x.id === "mgr-b" && /did NOT call worker_report/.test(x.text)));
  check("(b) NO [loom:worker-idle] nudge at all for this worker (the real QUEUED-REPORT GUARD suppresses it entirely)",
    !e.enqueued.some((x) => x.id === "mgr-b" && /worker-idle/.test(x.text)));

  // Positive control: a genuinely-unreported SIBLING worker under the SAME manager (same pending FIFO,
  // which carries wkr-b's report — not its own) still gets the normal nudge via the periodic path.
  seedTask(e, "tk-b2", "in_progress");
  seedWorker(e, "wkr-b2", "mgr-b", "tk-b2", { idleMin: 60 });
  e.watcher.tick(NOW);
  const genuineNudge = e.enqueued.find((x) => x.id === "mgr-b" && /worker-idle/.test(x.text) && /wkr-b2/.test(x.text));
  check("(b) a sibling worker with NO queued report of its OWN still nudges normally via the periodic path", !!genuineNudge);
  cleanup(e);
}

// ============ (c) CR BLOCKER #1 — a rate-limited (usage-capped) worker draws NO periodic nudge ============
// setBusy(false) fires BEFORE the rate-limit park lands, so a usage-capped worker is live+idle+unreported
// exactly like a genuine strand — but it will auto-resume itself; nagging it for the length of the cap
// (up to a week on the weekly cap) would needlessly invite the manager to stop/recycle a healthy worker.
{
  const e = makeEnv();
  seedManager(e, "mgr-c", { busy: false, idleMin: 60 });
  seedTask(e, "tk-c", "in_progress");
  // rateLimitedUntil is seeded relative to REAL Date.now(), not the fixed fake NOW above — classifyIdleWorker
  // (service.ts) checks it against real wall-clock Date.now(), unlike the injected-NOW idle-timing fields.
  seedWorker(e, "wkr-c", "mgr-c", "tk-c", { idleMin: 60, rateLimitedUntil: new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString() }); // capped 6 days out

  e.watcher.tick(NOW);

  check("(c) NO [loom:worker-idle] nudge for a rate-limited worker (it will auto-resume itself)",
    !e.enqueued.some((x) => /worker-idle/.test(x.text) && /wkr-c/.test(x.text)));
  const managerMsg = e.enqueued.find((x) => x.id === "mgr-c" && x.text.startsWith("[loom:idle]"))?.text ?? "";
  check("(c) the manager's OWN idle message ALSO does not call the rate-limited worker 'unreported'",
    !/unreported/.test(managerMsg));
  cleanup(e);
}

// ============ (d) CR BLOCKER #2 — an already-reported live worker draws no "unreported" claim ============
// A worker that reported done (task → review, still live awaiting merge) or progress (parked awaiting an
// ack) is NOT unreported — asserting "nobody else watches this" for it is the exact misleading shape
// board card 99efaab3 exists to prevent. Uses the REAL sessions.isWorkerGenuinelyStranded (wired above),
// not a stub, so this proves the manager-loop message narrowing actually holds end-to-end.
{
  // (d1) done → review, worker still live (awaiting merge).
  const e1 = makeEnv();
  seedManager(e1, "mgr-d1", { busy: false, idleMin: 60 });
  seedTask(e1, "tk-d1", "in_progress");
  seedWorker(e1, "wkr-d1", "mgr-d1", "tk-d1", { idleMin: 60 });
  await e1.sessions.workerReport("wkr-d1", { status: "done", summary: "shipped it" });
  e1.enqueued.length = 0; // isolate to the idle-tick assertions below
  e1.watcher.tick(NOW);
  const msg1 = e1.enqueued.find((x) => x.id === "mgr-d1" && x.text.startsWith("[loom:idle]"))?.text ?? "";
  check("(d1) precondition: the manager's OWN idle nudge DOES fire (a message was actually queued)", msg1.length > 0);
  check("(d1) done-and-awaiting-merge worker: manager idle message does NOT claim 'unreported'/'nobody else watches'",
    !/unreported/.test(msg1) && !/nobody else watches/.test(msg1));
  cleanup(e1);

  // (d2) progress → parked awaiting an ack (task stays in_progress by design).
  const e2 = makeEnv();
  seedManager(e2, "mgr-d2", { busy: false, idleMin: 60 });
  seedTask(e2, "tk-d2", "in_progress");
  seedWorker(e2, "wkr-d2", "mgr-d2", "tk-d2", { idleMin: 60 });
  await e2.sessions.workerReport("wkr-d2", { status: "progress", summary: "approach: X, will proceed unless redirected" });
  e2.enqueued.length = 0;
  e2.watcher.tick(NOW);
  const msg2 = e2.enqueued.find((x) => x.id === "mgr-d2" && x.text.startsWith("[loom:idle]"))?.text ?? "";
  check("(d2) precondition: the manager's OWN idle nudge DOES fire (a message was actually queued)", msg2.length > 0);
  check("(d2) progress-parked worker: manager idle message does NOT claim 'unreported'/'nobody else watches'",
    !/unreported/.test(msg2) && !/nobody else watches/.test(msg2));
  cleanup(e2);
}

// ============ (e) blocked-and-parked worker → NO false 'did NOT call worker_report' nudge ============
// Sibling of (d2)/(d1): a worker that correctly reported `blocked` and is parked awaiting its manager's
// reply must be suppressed by classifyIdleWorker's parked-ack branch exactly like progress/done, not
// treated as a silent stall (the bug this task fixes). Board has NO parked-role column so the blocked
// report's task move is a no-op and the task stays in the active lane — mirroring the existing
// done+no-review-lane precedent in classifyIdleWorker's doc comment, but for blocked+no-parked-lane.
{
  const e = makeEnv();
  e.db.setProjectConfig(e.projId, { kanbanColumns: [
    { key: "todo", label: "To Do", role: "workReady" },
    { key: "in_progress", label: "In Progress", role: "active" },
    { key: "done", label: "Done", role: "terminal" },
  ] });
  seedManager(e, "mgr-e", { busy: false, idleMin: 60 });
  seedTask(e, "tk-e", "in_progress");
  seedWorker(e, "wkr-e", "mgr-e", "tk-e", { idleMin: 60 });
  await e.sessions.workerReport("wkr-e", { status: "blocked", summary: "need a decision", needs: "manager input" });
  e.enqueued.length = 0; // isolate to the idle-tick assertions below
  e.watcher.tick(NOW);

  check("(e) NO false 'did NOT call worker_report' periodic nudge for the blocked-and-parked worker",
    !e.enqueued.some((x) => x.id === "mgr-e" && /did NOT call worker_report/.test(x.text)));
  const parkedAckNudge = e.enqueued.find((x) => x.id === "mgr-e" && /worker-idle/.test(x.text) && /parked awaiting your reply/.test(x.text));
  check("(e) the periodic path instead sends the parked-awaiting-reply nudge (classified parked-ack)", !!parkedAckNudge);
  const managerMsg = e.enqueued.find((x) => x.id === "mgr-e" && x.text.startsWith("[loom:idle]"))?.text ?? "";
  check("(e) precondition: the manager's OWN idle nudge DOES fire (a message was actually queued)", managerMsg.length > 0);
  check("(e) manager idle message does NOT claim 'unreported'/'nobody else watches' for the blocked worker",
    !/unreported/.test(managerMsg) && !/nobody else watches/.test(managerMsg));

  // Positive control: a genuinely-unreported SIBLING worker (same manager, same board) still nudges normally.
  seedTask(e, "tk-e2", "in_progress");
  seedWorker(e, "wkr-e2", "mgr-e", "tk-e2", { idleMin: 60 });
  e.watcher.tick(NOW);
  const genuineNudge = e.enqueued.find((x) => x.id === "mgr-e" && /did NOT call worker_report/.test(x.text) && /wkr-e2/.test(x.text));
  check("(e) a sibling genuinely-unreported worker still nudges normally (no regression)", !!genuineNudge);
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an idle manager with a sole idle/stale/unreported live worker gets nudged from BOTH sides (its own idle nudge no longer silenced by a live-but-idle worker, plus the new periodic idle-worker nudge); and the periodic idle-worker path, wired to the REAL SessionService.notifyManagerOfIdleWorker, respects the queued-report guard exactly like the busy→false edge nudge does — no re-implemented reconciliation, no reintroduced false alarm."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
