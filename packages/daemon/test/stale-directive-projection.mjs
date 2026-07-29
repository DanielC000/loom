import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_status / worker_list "staleDirective" projection test (card 343441bd) — the manager-facing
// signal distinguishing "worker_message delivered" from "apparently acted upon". Mirrors
// worker-reported-state.mjs's discipline: HERMETIC, NO claude, NO external daemon — seeds a real Db
// (sessions + orchestration_events, incl. the new turn_seq counter) and drives the REAL manager MCP
// tools (worker_list / worker_status) in-process over an InMemoryTransport pair, so it asserts the
// literal tool output a manager would see.
//
// THE LOAD-BEARING PROPERTY under test: staleDirective must NOT fire for a worker legitimately mid a
// single long turn (turnsSinceDelivery stays <= 1 no matter how long that one turn runs — turn-count
// based, never wall-clock), and must NOT fire once any worker_report lands after delivery. A false
// positive here is worse than no signal at all (see the card body's anti-goal).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- hermetic Db (own temp file) ---
const dbFile = path.join(os.tmpdir(), `loom-stale-directive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-07-24T12:00:00.000Z";
const projId = "proj-sd";
const agentId = "agent-sd";
db.insertProject({ id: projId, name: "StaleDirective", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

function seedManager(id) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null,
  });
}
// turnSeq is NOT settable at insertSession time (mirrors production — a fresh row always starts at the
// schema DEFAULT 0; only `db.incrementTurnSeq` ever advances it, exactly as onTurnCompleted does at the
// real Stop-hook chokepoint). So this seeds it the SAME way production does: N real increments.
function seedWorker(id, parentId, { busy = false, turnSeq = 0 } = {}) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: parentId, taskId: "tk-" + id, branch: "loom/" + id,
  });
  for (let i = 0; i < turnSeq; i++) db.incrementTurnSeq(id);
}
const ev = (workerId, mgrId, kind, ts, detail) => db.appendEvent({
  id: randomUUID(), ts, managerSessionId: mgrId, workerSessionId: workerId, taskId: "tk-" + workerId, kind, detail,
});
const at = (sec) => new Date(Date.parse(now) + sec * 1000).toISOString();

seedManager("MGR");

// (a) FIRES: immediate delivery at turnSeq=0, worker now at turnSeq=3 (three real turns, no report at all).
seedWorker("w-stale", "MGR", { turnSeq: 3 });
ev("w-stale", "MGR", "message_worker", at(0), { msgId: "m-stale", turnSeqAtDelivery: 0 });

// (b) NO-FIRE — the long-single-turn case: immediate delivery at turnSeq=0, worker only at turnSeq=1
// (ONE completed turn since delivery, however long it ran — turnsSinceDelivery=1 < threshold).
seedWorker("w-onelongturn", "MGR", { turnSeq: 1 });
ev("w-onelongturn", "MGR", "message_worker", at(0), { msgId: "m-onelongturn", turnSeqAtDelivery: 0 });

// (c) NO-FIRE — acknowledged: a worker_report lands AFTER delivery, even though turnSeq has advanced
// well past the threshold.
seedWorker("w-acked", "MGR", { turnSeq: 5 });
ev("w-acked", "MGR", "message_worker", at(0), { msgId: "m-acked", turnSeqAtDelivery: 0 });
ev("w-acked", "MGR", "worker_report", at(10), { status: "progress", summary: "on it" });

// (d) FIRES — the HELD/incident-relevant path: message_worker held at send (no turnSeqAtDelivery on
// its own event), delivered LATER via session_message_delivered stamped at turnSeq=1; worker now at 4.
seedWorker("w-held-stale", "MGR", { turnSeq: 4 });
ev("w-held-stale", "MGR", "message_worker", at(0), { msgId: "m-held-stale" });
ev("w-held-stale", "MGR", "session_message_delivered", at(1), { msgId: "m-held-stale", turnSeqAtDelivery: 1 });

// (e) NO-FIRE — still queued: held at send, never resolved (no session_message_delivered event at all).
seedWorker("w-still-queued", "MGR", { turnSeq: 9 });
ev("w-still-queued", "MGR", "message_worker", at(0), { msgId: "m-still-queued" });

// (f) NO-FIRE — held then SUPERSEDED (e.g. a later worker_redirect flushed it): the resolution event
// carries a reason and deliberately no turnSeqAtDelivery, since it never actually delivered the text.
seedWorker("w-superseded", "MGR", { turnSeq: 9 });
ev("w-superseded", "MGR", "message_worker", at(0), { msgId: "m-superseded" });
ev("w-superseded", "MGR", "session_message_delivered", at(1), { msgId: "m-superseded", reason: "superseded" });

// (g) boundary: exactly threshold-1 turns since delivery → NO-FIRE; exactly threshold turns → FIRES.
seedWorker("w-below-threshold", "MGR", { turnSeq: 2 });
ev("w-below-threshold", "MGR", "message_worker", at(0), { msgId: "m-below", turnSeqAtDelivery: 0 });
seedWorker("w-at-threshold", "MGR", { turnSeq: 3 });
ev("w-at-threshold", "MGR", "message_worker", at(0), { msgId: "m-at", turnSeqAtDelivery: 0 });

// (h) never messaged at all → staleDirective null, no crash on a worker with zero message_worker events.
seedWorker("w-never-messaged", "MGR", { turnSeq: 9 });

// (i) a LATEST message_worker after an earlier stale one clears tracking back to the new (fresh) one —
// "latest wins", mirroring reportedProjection's own scoping.
seedWorker("w-superseded-by-newer", "MGR", { turnSeq: 5 });
ev("w-superseded-by-newer", "MGR", "message_worker", at(0), { msgId: "m-old", turnSeqAtDelivery: 0 });
ev("w-superseded-by-newer", "MGR", "message_worker", at(20), { msgId: "m-new", turnSeqAtDelivery: 5 });

const router = new OrchestrationMcpRouter(db, /** @type {any} */ ({
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; }, // card ae0b7891: no archived-without-report worker in this test
}));
const server = router.buildServer("MGR", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "stale-directive-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const status = async (id) => parse(await client.callTool({ name: "worker_status", arguments: { workerSessionId: id } }));

const list = parse(await client.callTool({ name: "worker_list", arguments: {} }));
const byId = Object.fromEntries(list.map((w) => [w.workerSessionId, w]));

check("(a) FIRES: 3 real turns since immediate delivery, no report at all",
  byId["w-stale"]?.staleDirective !== null
  && byId["w-stale"]?.staleDirective?.msgId === "m-stale"
  && byId["w-stale"]?.staleDirective?.turnsSinceDelivery === 3);

check("(b) NO-FIRE: one long single turn since delivery (turnsSinceDelivery=1, below threshold)",
  byId["w-onelongturn"]?.staleDirective === null);

check("(c) NO-FIRE: acknowledged by a worker_report after delivery, even at turnSeq=5",
  byId["w-acked"]?.staleDirective === null);

check("(d) FIRES: the HELD/incident-relevant path — stamped at actual (held) delivery, not enqueue",
  byId["w-held-stale"]?.staleDirective !== null
  && byId["w-held-stale"]?.staleDirective?.msgId === "m-held-stale"
  && byId["w-held-stale"]?.staleDirective?.turnsSinceDelivery === 3);

check("(e) NO-FIRE: still queued (held, never resolved) — nothing to judge staleness against yet",
  byId["w-still-queued"]?.staleDirective === null);

check("(f) NO-FIRE: held then superseded — never actually delivered",
  byId["w-superseded"]?.staleDirective === null);

check("(g) boundary: turnsSinceDelivery=2 (threshold-1) → NO-FIRE",
  byId["w-below-threshold"]?.staleDirective === null);
check("(g) boundary: turnsSinceDelivery=3 (== threshold) → FIRES",
  byId["w-at-threshold"]?.staleDirective !== null);

check("(h) never messaged → staleDirective null, no crash",
  byId["w-never-messaged"]?.staleDirective === null);

check("(i) latest message_worker wins — tracks the NEW directive (turnsSinceDelivery=0), not the old stale one",
  byId["w-superseded-by-newer"]?.staleDirective === null);

// ============================ worker_status mirrors worker_list ============================
const sStale = await status("w-stale");
check("worker_status(w-stale) carries the same staleDirective as worker_list",
  sStale.staleDirective?.msgId === "m-stale" && sStale.staleDirective?.turnsSinceDelivery === 3);
const sAcked = await status("w-acked");
check("worker_status(w-acked) → staleDirective null (acknowledged)", sAcked.staleDirective === null);

await client.close();
try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — staleDirective fires only once a worker_message directive has aged past the turn threshold with no worker_report since delivery (both the immediate and held delivery paths), never fires on a long single turn or once acknowledged by any report, and correctly ignores a still-queued/superseded/never-messaged/superseded-by-a-newer-directive worker."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
