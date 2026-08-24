import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_status / worker_list "staleReport" projection test (card 4491bd3b, DoD-1 — the reconciliation
// detector). Mirrors stale-directive-projection.mjs's discipline exactly, but for the OPPOSITE
// direction: a worker_report sitting `awaitingReview:true` while the MANAGER's own turnSeq keeps
// advancing (proof its pty is alive and cycling) with this SAME report still unresolved.
//
// THE INCIDENT THIS GUARDS (card body): a worker's `worker_report(done)` was enqueued, written in full,
// submitted, and ran a real 36.4s turn on the manager's session — yet left no perceptible trace at all.
// `session_transcript` (the only instrument that could show what that turn actually did) is Platform-
// only and out of THIS card's scope (DoD-2). What IS buildable, server-side, from fields Loom already
// stores: the worker's own reportedState/awaitingReview (existing), and the MANAGER's turnSeq at the
// moment the report was recorded (`managerTurnSeqAtReport`, newly stamped by workerReport) vs its turnSeq
// NOW. staleReport is deliberately mechanism-agnostic — it does NOT claim the report was lost, evicted,
// or misrendered; it only asserts that the manager's session kept taking turns of its own while this
// specific report sat unresolved, which holds true under every one of the card's four open candidates.
//
// HERMETIC, NO claude, NO external daemon: seeds a real Db (sessions + orchestration_events, incl. the
// turn_seq counter) and drives the REAL manager MCP tools (worker_list / worker_status) in-process over
// an InMemoryTransport pair, so it asserts the literal tool output a manager would see.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { SessionService } from "../dist/sessions/service.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- hermetic Db (own temp file) ---
const dbFile = path.join(os.tmpdir(), `loom-report-reconciliation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-08-04T19:44:00.000Z";
const projId = "proj-rr";
const agentId = "agent-rr";
db.insertProject({ id: projId, name: "ReportReconciliation", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

// turnSeq is NOT settable at insertSession time — mirrors production (schema DEFAULT 0, only
// db.incrementTurnSeq ever advances it, exactly as onTurnCompleted does at the real Stop-hook chokepoint).
function seedManager(id, { turnSeq = 0 } = {}) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null,
  });
  for (let i = 0; i < turnSeq; i++) db.incrementTurnSeq(id);
}
function seedWorker(id, parentId, { busy = false } = {}) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: parentId, taskId: "tk-" + id, branch: "loom/" + id,
  });
}
const ev = (workerId, mgrId, kind, ts, detail) => db.appendEvent({
  id: randomUUID(), ts, managerSessionId: mgrId, workerSessionId: workerId, taskId: "tk-" + workerId, kind, detail,
});
const at = (sec) => new Date(Date.parse(now) + sec * 1000).toISOString();

// Each case gets its own manager so one worker's manager-turnSeq bumps never leak into another's math —
// mirrors real workerReport's per-manager baseline (managerTurnSeqAtReport is captured against THIS
// worker's OWN parent, never a global counter).

// (a) FIRES — THE INCIDENT'S SHAPE: reported at managerTurnSeqAtReport=0, the manager has since
// completed 3 real turns of its OWN (proof it's alive and cycling), report still unresolved.
seedManager("MGR-a", { turnSeq: 3 });
seedWorker("w-stale", "MGR-a");
ev("w-stale", "MGR-a", "worker_report", at(10), { status: "done", summary: "shipped", managerTurnSeqAtReport: 0 });

// (b) NO-FIRE — the long-single-turn case: the manager has only completed ONE turn since the report (the
// very turn that presumably processed it) — turnsSinceReport=1, below threshold. Still awaitingReview.
seedManager("MGR-b", { turnSeq: 1 });
seedWorker("w-fresh", "MGR-b");
ev("w-fresh", "MGR-b", "worker_report", at(10), { status: "done", summary: "shipped", managerTurnSeqAtReport: 0 });

// (c) POSITIVE CONTROL, direction 2 — NO-FIRE on a NORMAL report: the manager reviews and actually merges
// it (a real resolution) even though its OWN turnSeq has advanced well past the threshold. Proves
// staleReport does not fire on ordinary, successfully-reconciled work just because turns kept happening.
seedManager("MGR-c", { turnSeq: 9 });
seedWorker("w-merged", "MGR-c");
ev("w-merged", "MGR-c", "worker_report", at(10), { status: "done", summary: "shipped", managerTurnSeqAtReport: 0 });
ev("w-merged", "MGR-c", "merge_request", at(20), {});
ev("w-merged", "MGR-c", "merge_done", at(30), {});

// (d) boundary: exactly threshold-1 (2) turns since report → NO-FIRE; exactly threshold (3) → FIRES.
seedManager("MGR-d1", { turnSeq: 2 });
seedWorker("w-below-threshold", "MGR-d1");
ev("w-below-threshold", "MGR-d1", "worker_report", at(10), { status: "done", summary: "x", managerTurnSeqAtReport: 0 });
seedManager("MGR-d2", { turnSeq: 3 });
seedWorker("w-at-threshold", "MGR-d2");
ev("w-at-threshold", "MGR-d2", "worker_report", at(10), { status: "done", summary: "x", managerTurnSeqAtReport: 0 });

// (e) never reported at all → staleReport null, no crash (mirrors reportedState null / awaitingReview false).
seedManager("MGR-e", { turnSeq: 9 });
seedWorker("w-never-reported", "MGR-e");

// (f) LEGACY / PRE-CARD SHAPE: a worker_report persisted before this card's stamp landed carries no
// `managerTurnSeqAtReport` key at all. Must NOT crash and must NOT misread the missing stamp as
// turnsSinceReport:0 (falsely "not stale") or NaN (falsely "stale") — staleReport stays null regardless
// of how far the manager's turnSeq has since advanced. Permanent regression coverage for the defensive
// `stampedAt !== undefined` guard; an already-persisted legacy row is never retroactively reinterpreted.
seedManager("MGR-f", { turnSeq: 9 });
seedWorker("w-legacy-no-stamp", "MGR-f");
ev("w-legacy-no-stamp", "MGR-f", "worker_report", at(10), { status: "done", summary: "pre-card row" });

// (g) status BLOCKED also fires the same way — staleReport is keyed to awaitingReview, not to which
// terminal status produced it.
seedManager("MGR-g", { turnSeq: 5 });
seedWorker("w-blocked-stale", "MGR-g");
ev("w-blocked-stale", "MGR-g", "worker_report", at(10), { status: "blocked", summary: "need creds", needs: "API key", managerTurnSeqAtReport: 0 });

// (h) NO-FIRE — a later worker_report(progress) checkpoint isn't terminal, so awaitingReview is already
// false and staleReport must be null regardless of turnSeq (mirrors reportedProjection's own (e) case).
seedManager("MGR-h", { turnSeq: 9 });
seedWorker("w-progress-only", "MGR-h");
ev("w-progress-only", "MGR-h", "worker_report", at(10), { status: "progress", summary: "halfway", managerTurnSeqAtReport: 0 });

const router = new OrchestrationMcpRouter(db, /** @type {any} */ ({
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; },
  async getDanglingWorkers() { return []; },
}));

// Each manager gets its own connected client (mirrors this test's one-manager-per-case seeding above).
const managers = ["MGR-a", "MGR-b", "MGR-c", "MGR-d1", "MGR-d2", "MGR-e", "MGR-f", "MGR-g", "MGR-h"];
const clients = {};
for (const mgrId of managers) {
  const server = router.buildServer(mgrId, "manager");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: `report-reconciliation-test-${mgrId}`, version: "0" });
  await client.connect(clientT);
  clients[mgrId] = client;
}
const parse = (res) => JSON.parse(res.content[0].text);
const listFor = async (mgrId) => parse(await clients[mgrId].callTool({ name: "worker_list", arguments: {} }));
const statusFor = async (mgrId, workerId) => parse(await clients[mgrId].callTool({ name: "worker_status", arguments: { workerSessionId: workerId } }));

// ============================ worker_list ============================
const byIdA = Object.fromEntries((await listFor("MGR-a")).map((w) => [w.workerSessionId, w]));
check("(a) FIRES: 3 manager turns since report, still awaitingReview, no resolution",
  byIdA["w-stale"]?.awaitingReview === true
  && byIdA["w-stale"]?.staleReport !== null
  && byIdA["w-stale"]?.staleReport?.managerTurnsSinceReport === 3
  && byIdA["w-stale"]?.staleReport?.reportedAt === at(10));

const byIdB = Object.fromEntries((await listFor("MGR-b")).map((w) => [w.workerSessionId, w]));
check("(b) NO-FIRE: one manager turn since report (below threshold) — still awaitingReview true",
  byIdB["w-fresh"]?.awaitingReview === true && byIdB["w-fresh"]?.staleReport === null);

const byIdC = Object.fromEntries((await listFor("MGR-c")).map((w) => [w.workerSessionId, w]));
check("(c) POSITIVE CONTROL: a normally-merged report never fires staleReport, even at turnSeq=9",
  byIdC["w-merged"]?.awaitingReview === false && byIdC["w-merged"]?.staleReport === null);

const byIdD1 = Object.fromEntries((await listFor("MGR-d1")).map((w) => [w.workerSessionId, w]));
check("(d) boundary: turnsSinceReport=2 (threshold-1) → NO-FIRE",
  byIdD1["w-below-threshold"]?.staleReport === null);
const byIdD2 = Object.fromEntries((await listFor("MGR-d2")).map((w) => [w.workerSessionId, w]));
check("(d) boundary: turnsSinceReport=3 (== threshold) → FIRES",
  byIdD2["w-at-threshold"]?.staleReport !== null && byIdD2["w-at-threshold"]?.staleReport?.managerTurnsSinceReport === 3);

const byIdE = Object.fromEntries((await listFor("MGR-e")).map((w) => [w.workerSessionId, w]));
check("(e) never reported → staleReport null, no crash",
  byIdE["w-never-reported"]?.reportedState === null && byIdE["w-never-reported"]?.staleReport === null);

const byIdF = Object.fromEntries((await listFor("MGR-f")).map((w) => [w.workerSessionId, w]));
check("(f) LEGACY pre-card row (no managerTurnSeqAtReport stamp): staleReport stays null despite turnSeq=9 — never misread as turnsSinceReport:0 or NaN",
  byIdF["w-legacy-no-stamp"]?.awaitingReview === true && byIdF["w-legacy-no-stamp"]?.staleReport === null);

const byIdG = Object.fromEntries((await listFor("MGR-g")).map((w) => [w.workerSessionId, w]));
check("(g) BLOCKED status fires the same way as DONE",
  byIdG["w-blocked-stale"]?.reportedState === "blocked"
  && byIdG["w-blocked-stale"]?.staleReport !== null
  && byIdG["w-blocked-stale"]?.staleReport?.managerTurnsSinceReport === 5);

const byIdH = Object.fromEntries((await listFor("MGR-h")).map((w) => [w.workerSessionId, w]));
check("(h) NO-FIRE: progress-only checkpoint isn't terminal — awaitingReview false, staleReport null regardless of turnSeq",
  byIdH["w-progress-only"]?.reportedState === null
  && byIdH["w-progress-only"]?.awaitingReview === false
  && byIdH["w-progress-only"]?.staleReport === null);

// ============================ worker_status mirrors worker_list ============================
const sStale = await statusFor("MGR-a", "w-stale");
check("worker_status(w-stale) carries the same staleReport as worker_list",
  sStale.staleReport?.managerTurnsSinceReport === 3 && sStale.staleReport?.reportedAt === at(10));
const sFresh = await statusFor("MGR-b", "w-fresh");
check("worker_status(w-fresh) → staleReport null (below threshold)", sFresh.staleReport === null);
const sLegacy = await statusFor("MGR-f", "w-legacy-no-stamp");
check("worker_status(w-legacy-no-stamp) → staleReport null (no stamp to compare against)", sLegacy.staleReport === null);

for (const mgrId of managers) await clients[mgrId].close();
try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

// ============================ END-TO-END: the REAL SessionService.workerReport stamps it ============================
// Everything above hand-seeds the `managerTurnSeqAtReport` detail key directly, which only proves the
// PROJECTION reads it correctly — not that the real stamp-writing code (sessions/service.ts's
// `workerReport`) actually writes it. This section drives the ACTUAL service method (mirroring
// worker-report-delivery-status.mjs's own harness: a fake PtyHost matching host.ts's three return
// shapes, SessionService called directly, no claude/no daemon) to close that gap end-to-end.
{
  const dbFile2 = path.join(os.tmpdir(), `loom-report-reconciliation-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db2 = new Db(dbFile2);
  const projId2 = "proj-rr-e2e";
  const agentId2 = "agent-rr-e2e";
  db2.insertProject({ id: projId2, name: "ReportReconciliationE2E", repoPath: projId2, vaultPath: projId2, config: {}, createdAt: now, archivedAt: null });
  db2.insertAgent({ id: agentId2, projectId: projId2, name: "t", startupPrompt: "orchestrate", position: 0 });
  const pty2 = { enqueueStdin: (id) => (db2.getSession(id)?.processState === "live" ? { delivered: true } : { delivered: false }) };
  const sessions2 = new SessionService(db2, pty2, new OrchestrationControl());

  db2.insertSession({
    id: "mgr-e2e", projectId: projId2, agentId: agentId2, engineSessionId: "eng-mgr-e2e", title: null, cwd: projId2,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null,
  });
  db2.insertSession({
    id: "wkr-e2e", projectId: projId2, agentId: agentId2, engineSessionId: "eng-wkr-e2e", title: null, cwd: projId2,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: "mgr-e2e", taskId: "tk-wkr-e2e",
  });

  // Manager starts at turnSeq=0 (fresh row). The real workerReport() call must stamp
  // managerTurnSeqAtReport:0 on the event it appends — no hand-seeding here at all.
  const reportRes = await sessions2.workerReport("wkr-e2e", { status: "done", summary: "shipped for real" });
  check("(e2e) the real workerReport() call succeeds", reportRes.reported === true);
  const reportEvent = db2.listEventsForWorker("wkr-e2e").find((ev) => ev.kind === "worker_report");
  check("(e2e) the REAL service stamped managerTurnSeqAtReport:0 on the event (manager was fresh, turnSeq=0)",
    reportEvent?.detail?.managerTurnSeqAtReport === 0);

  // Now advance the manager's OWN turnSeq by 3 real turns (simulating it staying alive and cycling
  // afterward, exactly like the incident's 36.4s turn plus further activity) and re-read via the router.
  for (let i = 0; i < 3; i++) db2.incrementTurnSeq("mgr-e2e");
  const router2 = new OrchestrationMcpRouter(db2, /** @type {any} */ ({
    peekPendingMerge() { return undefined; },
    listPendingSpawns() { return []; },
    listCapQueuedSpawns() { return []; },
    isArchivedWithoutReport() { return false; },
    async getDanglingWorkers() { return []; },
  }));
  const server2 = router2.buildServer("mgr-e2e", "manager");
  const [clientT2, serverT2] = InMemoryTransport.createLinkedPair();
  await server2.connect(serverT2);
  const client2 = new Client({ name: "report-reconciliation-e2e", version: "0" });
  await client2.connect(clientT2);
  const list2 = JSON.parse((await client2.callTool({ name: "worker_list", arguments: {} })).content[0].text);
  const wkr2 = list2.find((w) => w.workerSessionId === "wkr-e2e");
  check("(e2e) end-to-end: real stamp + 3 real manager turns since → staleReport fires with managerTurnsSinceReport:3",
    wkr2?.staleReport !== null && wkr2?.staleReport?.managerTurnsSinceReport === 3);

  await client2.close();
  try { db2.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile2 + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================ FALSE-POSITIVE SUPPRESSION (card 456bf38a) ============================
// staleReport must return null while THIS worker has a live (queued OR running) pendingMerge — firing a
// merge IS the resolution of a `done` report; the merge simply hasn't reached `merge_done` (and therefore
// REPORT_RESOLVED_EVENT_KINDS) yet. Must still FIRE for the cases it exists for: no merge fired at all
// (covered above by case (a), reproduced fresh here as the required DoD-3 positive control under the SAME
// peekPendingMerge stub the suppression cases use), and a report left unresolved after a rejected/cancelled
// merge (below). Own db/router — the shared one above hard-codes `peekPendingMerge` to always return
// `undefined`, which cannot express a live pendingMerge at all.
{
  const dbFile3 = path.join(os.tmpdir(), `loom-report-reconciliation-pendingmerge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db3 = new Db(dbFile3);
  const projId3 = "proj-rr-pm";
  const agentId3 = "agent-rr-pm";
  db3.insertProject({ id: projId3, name: "ReportReconciliationPendingMerge", repoPath: projId3, vaultPath: projId3, config: {}, createdAt: now, archivedAt: null });
  db3.insertAgent({ id: agentId3, projectId: projId3, name: "t", startupPrompt: "orchestrate", position: 0 });

  function seedManager3(id, turnSeq) {
    db3.insertSession({
      id, projectId: projId3, agentId: agentId3, engineSessionId: "eng-" + id, title: null, cwd: projId3,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null,
    });
    for (let i = 0; i < turnSeq; i++) db3.incrementTurnSeq(id);
  }
  function seedWorker3(id, parentId) {
    db3.insertSession({
      id, projectId: projId3, agentId: agentId3, engineSessionId: "eng-" + id, title: null, cwd: projId3,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "worker", parentSessionId: parentId, taskId: "tk-" + id, branch: "loom/" + id,
    });
  }
  const ev3 = (workerId, mgrId, kind, ts, detail) => db3.appendEvent({
    id: randomUUID(), ts, managerSessionId: mgrId, workerSessionId: workerId, taskId: "tk-" + workerId, kind, detail,
  });

  // POSITIVE CONTROL (DoD-3): identical shape to case (a) above — turnSeq=3, stamp=0, no merge events at
  // all — reproduced fresh in THIS db/router, under the SAME peekPendingMerge stub the suppression cases
  // below use, to prove the pre-fix behavior (staleReport fires) BEFORE trusting a null result from that
  // stub. Without this, a null on "w-merge-running" could mean "correctly suppressed" OR "this fixture
  // never fires staleReport at all" — indistinguishable without a same-fixture positive control.
  seedManager3("MGR-pm-control", 3);
  seedWorker3("w-no-merge", "MGR-pm-control");
  ev3("w-no-merge", "MGR-pm-control", "worker_report", at(10), { status: "done", summary: "shipped", managerTurnSeqAtReport: 0 });

  // (running, mid gate-execution): pendingMerge.state:"running", gatePhase:"running" — the actual
  // incident's shape (card body: workers 51a92d1a / 2dad7234 / 5ad0351b, all gatePhase:"running").
  seedManager3("MGR-pm-running", 3);
  seedWorker3("w-merge-running", "MGR-pm-running");
  ev3("w-merge-running", "MGR-pm-running", "worker_report", at(10), { status: "done", summary: "shipped", managerTurnSeqAtReport: 0 });

  // (queued behind a same-repo sibling): pendingMerge.state:"running" but gatePhase:"queued" — the card's
  // own DoD says explicitly BOTH phases are in scope, not just an executing gate.
  seedManager3("MGR-pm-queued", 3);
  seedWorker3("w-merge-queued", "MGR-pm-queued");
  ev3("w-merge-queued", "MGR-pm-queued", "worker_report", at(10), { status: "done", summary: "shipped", managerTurnSeqAtReport: 0 });

  // (worktree prep, pre gate-admission): pendingMerge.state:"running", gatePhase:null — the op was minted
  // but hasn't reached the GateSemaphore yet (or has already left it, finalize still running).
  seedManager3("MGR-pm-prep", 3);
  seedWorker3("w-merge-prep", "MGR-pm-prep");
  ev3("w-merge-prep", "MGR-pm-prep", "worker_report", at(10), { status: "done", summary: "shipped", managerTurnSeqAtReport: 0 });

  // (settled, non-"running" state): pendingMerge sitting in its brief RETAINED terminal view
  // (state:"done") with no `merge_done` EVENT landed yet (a narrow settle-vs-append race) — must NOT be
  // treated as suppressing: only state:"running" suppresses, never "done"/"failed".
  seedManager3("MGR-pm-settled", 3);
  seedWorker3("w-merge-settled-race", "MGR-pm-settled");
  ev3("w-merge-settled-race", "MGR-pm-settled", "worker_report", at(10), { status: "done", summary: "shipped", managerTurnSeqAtReport: 0 });

  // TRUE POSITIVE preserved — re-arm after REJECTED: staleReport must still fire once a `merge_rejected`
  // has landed (never in REPORT_RESOLVED_EVENT_KINDS) and the pendingMerge op has since settled/evicted
  // (peekPendingMerge back to undefined) — the case DoD-2 says must NOT be silenced by this fix.
  seedManager3("MGR-pm-rejected", 4);
  seedWorker3("w-merge-rejected", "MGR-pm-rejected");
  ev3("w-merge-rejected", "MGR-pm-rejected", "worker_report", at(10), { status: "done", summary: "shipped", managerTurnSeqAtReport: 0 });
  ev3("w-merge-rejected", "MGR-pm-rejected", "merge_request", at(20), {});
  ev3("w-merge-rejected", "MGR-pm-rejected", "merge_rejected", at(30), { reason: "gate_failed" });

  const pendingMergeByWorker = {
    "w-merge-running": { opId: "op-running", kind: "merge", key: "merge:w-merge-running", managerSessionId: "MGR-pm-running", startedAt: at(20), state: "running" },
    "w-merge-queued": { opId: "op-queued", kind: "merge", key: "merge:w-merge-queued", managerSessionId: "MGR-pm-queued", startedAt: at(20), state: "running" },
    "w-merge-prep": { opId: "op-prep", kind: "merge", key: "merge:w-merge-prep", managerSessionId: "MGR-pm-prep", startedAt: at(20), state: "running" },
    "w-merge-settled-race": { opId: "op-settled", kind: "merge", key: "merge:w-merge-settled-race", managerSessionId: "MGR-pm-settled", startedAt: at(20), state: "done", outcome: "merged" },
  };
  const gatePhaseByOpId = { "op-running": "running", "op-queued": "queued", "op-prep": null };

  const router3 = new OrchestrationMcpRouter(db3, /** @type {any} */ ({
    peekPendingMerge(workerSessionId) { return pendingMergeByWorker[workerSessionId]; },
    gatePhaseForOpId(opId) { return gatePhaseByOpId[opId] ?? null; },
    listPendingSpawns() { return []; },
    listCapQueuedSpawns() { return []; },
    isArchivedWithoutReport() { return false; },
    async getDanglingWorkers() { return []; },
  }));

  const managers3 = ["MGR-pm-control", "MGR-pm-running", "MGR-pm-queued", "MGR-pm-prep", "MGR-pm-settled", "MGR-pm-rejected"];
  const clients3 = {};
  for (const mgrId of managers3) {
    const server = router3.buildServer(mgrId, "manager");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: `report-reconciliation-pm-test-${mgrId}`, version: "0" });
    await client.connect(clientT);
    clients3[mgrId] = client;
  }
  const listFor3 = async (mgrId) => parse(await clients3[mgrId].callTool({ name: "worker_list", arguments: {} }));

  const byIdControl = Object.fromEntries((await listFor3("MGR-pm-control")).map((w) => [w.workerSessionId, w]));
  check("(pm-control) POSITIVE CONTROL: same shape as case (a), no pendingMerge at all → staleReport FIRES (proves this fixture/stub can fire before trusting a null result from it)",
    byIdControl["w-no-merge"]?.awaitingReview === true && byIdControl["w-no-merge"]?.staleReport?.managerTurnsSinceReport === 3);

  const byIdRunning = Object.fromEntries((await listFor3("MGR-pm-running")).map((w) => [w.workerSessionId, w]));
  check("(pm-running) SUPPRESSED: pendingMerge running + gatePhase running (the actual incident's shape) → staleReport null, still awaitingReview",
    byIdRunning["w-merge-running"]?.awaitingReview === true && byIdRunning["w-merge-running"]?.staleReport === null);

  const byIdQueued = Object.fromEntries((await listFor3("MGR-pm-queued")).map((w) => [w.workerSessionId, w]));
  check("(pm-queued) SUPPRESSED: pendingMerge running but gatePhase queued (behind a same-repo sibling) → staleReport null",
    byIdQueued["w-merge-queued"]?.awaitingReview === true && byIdQueued["w-merge-queued"]?.staleReport === null);

  const byIdPrep = Object.fromEntries((await listFor3("MGR-pm-prep")).map((w) => [w.workerSessionId, w]));
  check("(pm-prep) SUPPRESSED: pendingMerge running, gatePhase null (worktree prep, pre gate-admission) → staleReport null",
    byIdPrep["w-merge-prep"]?.awaitingReview === true && byIdPrep["w-merge-prep"]?.staleReport === null);

  const byIdSettled = Object.fromEntries((await listFor3("MGR-pm-settled")).map((w) => [w.workerSessionId, w]));
  check("(pm-settled) NOT suppressed: pendingMerge state:\"done\" (retained terminal view, no merge_done EVENT landed yet) is not \"running\" → staleReport still fires",
    byIdSettled["w-merge-settled-race"]?.staleReport !== null && byIdSettled["w-merge-settled-race"]?.staleReport?.managerTurnsSinceReport === 3);

  const byIdRejected = Object.fromEntries((await listFor3("MGR-pm-rejected")).map((w) => [w.workerSessionId, w]));
  check("(pm-rejected) TRUE POSITIVE preserved: merge_rejected landed (not merge_done) and pendingMerge has since settled/evicted → staleReport still FIRES (re-arms)",
    byIdRejected["w-merge-rejected"]?.awaitingReview === true
    && byIdRejected["w-merge-rejected"]?.staleReport !== null
    && byIdRejected["w-merge-rejected"]?.staleReport?.managerTurnsSinceReport === 4);

  for (const mgrId of managers3) await clients3[mgrId].close();
  try { db3.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile3 + ext, { force: true }); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — staleReport (card 4491bd3b, DoD-1) fires only once a worker's report has sat awaitingReview:true while the MANAGER's own turnSeq has advanced past STALE_REPORT_TURN_THRESHOLD since the report was recorded — proof the manager's session kept cycling turns while this specific report went unresolved, asserted without any claim about mechanism. It does NOT fire on a single long manager turn, a normally-reviewed-and-merged report (however many turns later), a never-reported worker, a non-terminal progress checkpoint, or a pre-card legacy row missing the new stamp — the positive control holds in BOTH directions. It also does NOT fire while this same worker's merge is actively queued or running (card 456bf38a), and still correctly re-arms once a merge is rejected/cancelled rather than merged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
