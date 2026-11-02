import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c5b234aa, Code Review round 2, item 4 — behavioural `ctxMidTurn` cases on the real MCP projection
// (worker_list / worker_status / my_context), driven through the REAL OrchestrationMcpRouter over an
// InMemoryTransport pair (mirrors worker-context-surface.mjs's own harness). `ctxMidTurn` is derived in
// `ctxMidTurnFields` (mcp/orchestration.ts): `busy && ctxUpdatedAt != null && ctxUpdatedAt >= lastActivity`
// — true only while the ctxInputTokens reading was taken DURING the turn that's still running.
//
// Covers: busy vs idle; ctxUpdatedAt strictly BEFORE lastActivity (the exact stale-reading incident
// shape) vs AFTER; the equal-timestamp `>=` edge (a reading taken in the SAME instant the turn started);
// and the exited/archivedWithoutReport row, whose `busy:false` is FORCED regardless of the raw stored
// value (mcp/orchestration.ts's own override for that row shape).
// Run: 1) build (turbo builds shared first), 2) node test/ctx-mid-turn-field.mjs
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

const NOW = "2026-06-03T12:00:00.000Z";
const BEFORE = "2026-06-03T11:00:00.000Z"; // strictly before NOW (the turn's rising edge)
const AFTER = "2026-06-03T13:00:00.000Z";  // strictly after NOW

const dbFile = path.join(os.tmpdir(), `loom-ctx-midturn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const projId = "proj-ctxmt";
const agentId = "agent-ctxmt";
db.insertProject({ id: projId, name: "CtxMidTurn", repoPath: projId, vaultPath: projId, config: {}, createdAt: NOW, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: NOW, lastActivity: NOW, lastError: null, role: "manager" });

function seedWorker(id, { busy, lastActivity, ctxUpdatedAt, ctxInputTokens = 400_000, model = "claude-sonnet-5" }) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState: "live", resumability: "unknown", busy, createdAt: NOW, lastActivity, lastError: null,
    role: "worker", parentSessionId: "mgr", taskId: "tk-" + id,
    ctxInputTokens, ctxTurns: 3, ctxUpdatedAt, model,
  });
}

// (1) BUSY + ctxUpdatedAt AFTER lastActivity — the mid-turn sampler's own normal case: a fresh reading
//     taken WHILE the turn that's still running. ⇒ ctxMidTurn:true.
seedWorker("w-fresh-midturn", { busy: true, lastActivity: NOW, ctxUpdatedAt: AFTER });

// (2) BUSY + ctxUpdatedAt BEFORE lastActivity — the EXACT incident shape (worker 09e8c9f1): a long turn
//     started, and the only reading on file predates it (carried over from the PREVIOUS turn's Stop).
//     ⇒ ctxMidTurn:false — this is the stale reading a manager must not trust as current.
seedWorker("w-stale-busy", { busy: true, lastActivity: NOW, ctxUpdatedAt: BEFORE });

// (3) IDLE (busy:false) with a reading AFTER what would be lastActivity if it were busy — idle always
//     reads ctxMidTurn:false, regardless of the timestamp relationship; this is the ORDINARY, trustworthy
//     turn-end reading (the session isn't mid-anything right now).
seedWorker("w-idle-fresh", { busy: false, lastActivity: NOW, ctxUpdatedAt: AFTER });

// (4) IDLE with a reading BEFORE lastActivity too — same verdict (false), for the same reason as (3).
seedWorker("w-idle-stale", { busy: false, lastActivity: NOW, ctxUpdatedAt: BEFORE });

// (5) THE EQUAL-TIMESTAMP `>=` EDGE: busy:true, ctxUpdatedAt === lastActivity EXACTLY — a reading taken
//     in the SAME instant the turn started (e.g. the sampler's very first tick after a fast turn-start).
//     The derivation uses `>=`, not `>`, so this must read ctxMidTurn:true, not false.
seedWorker("w-tie-edge", { busy: true, lastActivity: NOW, ctxUpdatedAt: NOW });

// (6) UNMEASURED: ctxInputTokens null ⇒ ctxMidTurn must be false (never null/true) even though busy — no
//     reading exists to be "mid-turn" or "stale" about.
seedWorker("w-unmeasured", { busy: true, lastActivity: NOW, ctxUpdatedAt: null, ctxInputTokens: null });

// (7) EXITED / archivedWithoutReport row: the row's OWN stored `busy` is (unrealistically, but exercising
//     the defensive override) left `true` in the DB, with a ctxUpdatedAt AFTER lastActivity (which, read
//     naively, would look mid-turn) — but this row shape FORCES busy:false in the projection (the worker
//     already exited), so ctxMidTurn must still read false. `archivedAt` is set so this row is EXCLUDED
//     from the plain `workers` roster (db.listWorkers filters out archived rows) and surfaces ONLY as the
//     archivedUnreported placeholder — otherwise `list.find` could match the ordinary live-worker copy
//     of this id instead and silently test the wrong code path.
db.insertSession({
  id: "w-exited-ctx", projectId: projId, agentId, engineSessionId: "eng-w-exited-ctx", title: null, cwd: projId,
  processState: "exited", resumability: "unknown", busy: true, createdAt: NOW, lastActivity: NOW, lastError: null,
  role: "worker", parentSessionId: "mgr", taskId: "tk-w-exited-ctx",
  ctxInputTokens: 400_000, ctxTurns: 3, ctxUpdatedAt: AFTER, model: "claude-sonnet-5",
});
db.archiveSession("w-exited-ctx"); // `insertSession`'s own column list has no archived_at — a real setter is required
db.appendEvent({
  id: randomUUID(), ts: NOW, managerSessionId: "mgr", workerSessionId: "w-exited-ctx",
  taskId: "tk-w-exited-ctx", kind: "worker_exited_without_report", detail: {},
});

const sessionsStub = {
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport(id) { return id === "w-exited-ctx"; },
  async getDanglingWorkers() { return []; },
};
const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
const server = router.buildServer("mgr", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "ctx-mid-turn-field-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} }));

try {
  const list = await call("worker_list");
  const find = (id) => list.find((w) => w.workerSessionId === id);

  const freshMidTurn = find("w-fresh-midturn");
  check("(1) worker_list: busy + ctxUpdatedAt AFTER lastActivity ⇒ ctxMidTurn:true", freshMidTurn?.ctxMidTurn === true);
  check("(1) worker_list: ctxMeasuredAt carries the raw ctxUpdatedAt too", freshMidTurn?.ctxMeasuredAt === AFTER);

  const staleBusy = find("w-stale-busy");
  check("(2) worker_list: busy + ctxUpdatedAt BEFORE lastActivity (the incident shape) ⇒ ctxMidTurn:false", staleBusy?.ctxMidTurn === false);

  const idleFresh = find("w-idle-fresh");
  check("(3) worker_list: idle, reading nominally 'after' ⇒ ctxMidTurn:false (idle always reads false)", idleFresh?.ctxMidTurn === false);

  const idleStale = find("w-idle-stale");
  check("(4) worker_list: idle, reading 'before' ⇒ ctxMidTurn:false (same verdict as (3))", idleStale?.ctxMidTurn === false);

  const tieEdge = find("w-tie-edge");
  check("(5) worker_list: the equal-timestamp >= edge (ctxUpdatedAt === lastActivity) ⇒ ctxMidTurn:true", tieEdge?.ctxMidTurn === true);

  const unmeasured = find("w-unmeasured");
  check("(6) worker_list: ctxInputTokens null ⇒ ctxMidTurn:false (never null/true) despite busy", unmeasured?.ctxMidTurn === false);

  const exitedCtx = find("w-exited-ctx");
  check("(7) worker_list: the archivedWithoutReport row shape exists", exitedCtx !== undefined);
  check("(7) worker_list: its FORCED busy:false overrides the raw stored busy:true ⇒ ctxMidTurn:false", exitedCtx?.busy === false && exitedCtx?.ctxMidTurn === false);

  // --- Same five live cases via worker_status(id) — a SEPARATE code path (projectSessionRowFields + the
  //     derived ctxMidTurn), not fleetView's own row builders. ---
  const statusFresh = await call("worker_status", { workerSessionId: "w-fresh-midturn" });
  check("(1b) worker_status: same verdict as worker_list (true)", statusFresh.ctxMidTurn === true);
  const statusStale = await call("worker_status", { workerSessionId: "w-stale-busy" });
  check("(2b) worker_status: same verdict as worker_list (false)", statusStale.ctxMidTurn === false);
  const statusIdle = await call("worker_status", { workerSessionId: "w-idle-fresh" });
  check("(3b) worker_status: same verdict as worker_list (false)", statusIdle.ctxMidTurn === false);
  const statusTie = await call("worker_status", { workerSessionId: "w-tie-edge" });
  check("(5b) worker_status: same verdict as worker_list (true, the >= edge)", statusTie.ctxMidTurn === true);

  // --- my_context: the SAME session self-reading its own occupancy (busy vs idle, before vs after). ---
  const serverBusy = router.buildServer("w-fresh-midturn", "worker");
  const [cT1, sT1] = InMemoryTransport.createLinkedPair();
  await serverBusy.connect(sT1);
  const clientBusy = new Client({ name: "ctx-mid-turn-field-my_context-busy", version: "0" });
  await clientBusy.connect(cT1);
  const myCtxBusy = JSON.parse((await clientBusy.callTool({ name: "my_context", arguments: {} })).content[0].text);
  check("(1c) my_context (self, busy + after): ctxMidTurn:true", myCtxBusy.ctxMidTurn === true);

  const serverIdle = router.buildServer("w-idle-fresh", "worker");
  const [cT2, sT2] = InMemoryTransport.createLinkedPair();
  await serverIdle.connect(sT2);
  const clientIdle = new Client({ name: "ctx-mid-turn-field-my_context-idle", version: "0" });
  await clientIdle.connect(cT2);
  const myCtxIdle = JSON.parse((await clientIdle.callTool({ name: "my_context", arguments: {} })).content[0].text);
  check("(3c) my_context (self, idle): ctxMidTurn:false", myCtxIdle.ctxMidTurn === false);

  const serverUnmeasured = router.buildServer("w-unmeasured", "worker");
  const [cT3, sT3] = InMemoryTransport.createLinkedPair();
  await serverUnmeasured.connect(sT3);
  const clientUnmeasured = new Client({ name: "ctx-mid-turn-field-my_context-unmeasured", version: "0" });
  await clientUnmeasured.connect(cT3);
  const myCtxUnmeasured = JSON.parse((await clientUnmeasured.callTool({ name: "my_context", arguments: {} })).content[0].text);
  check("(6c) my_context (self, unmeasured): ctxMidTurn:false, not null/true", myCtxUnmeasured.ctxMidTurn === false);
} finally {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — ctxMidTurn (worker_list/worker_status/my_context, mcp/orchestration.ts's ctxMidTurnFields): " +
    "true only while busy AND ctxUpdatedAt is at-or-after lastActivity (a fresh mid-turn sample); false while idle " +
    "(regardless of the timestamp relationship), when ctxUpdatedAt predates lastActivity (the incident's own stale- " +
    "reading shape), when ctxInputTokens is unmeasured, and on the archivedWithoutReport row whose busy:false is " +
    "forced regardless of the raw stored value; and the equal-timestamp >= edge reads true, not false."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
