import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_list/worker_status PENDING-OPS surfacing test (card fb8df559 Part 1, Auditor b9515beb).
// HERMETIC, NO claude, NO real spawn/merge — seeds a real Db (two live workers, one already
// awaiting-review) and drives the REAL manager MCP tools (worker_list / worker_status) in-process over
// an InMemoryTransport pair, with a STUB `sessions` object standing in for peekPendingMerge/
// listPendingSpawns (the actual PendingOpRegistry plumbing is exercised for real in
// pending-ops-registry.mjs + merge-spawn-tracked.mjs — this test is about the MCP-facing SHAPE).
//
// Proves the manager's DECISION on the Part 1 design (worker_list stays a BARE ARRAY, additive-only):
//   - a real worker row gains a `pendingMerge` field (non-null only for the one with an in-flight merge);
//   - a pending worker_spawn with NO worker row yet surfaces as an ADDITIVE PLACEHOLDER row —
//     `workerSessionId:null`, `pendingSpawn:{opId,startedAt}`, `processState:"starting"`,
//     `reportedState:null`, `awaitingReview:false` — clearly distinguishable so an existing "count LIVE
//     workers" / "find one AWAITING REVIEW" consumer skips it instead of miscounting a phantom worker;
//   - worker_status(id) on a real worker also carries its `pendingMerge` field.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-list-pending-ops.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbFile = path.join(os.tmpdir(), `loom-wlpo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-07-04T12:00:00.000Z";
const projId = "proj-wlpo";
const agentId = "agent-wlpo";
db.insertProject({ id: projId, name: "WLPO", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });

function seedWorker(id, taskId) {
  db.insertSession({ id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgr", taskId });
}
seedWorker("w-plain", "task-plain");     // a normal live worker, no pending op
seedWorker("w-merging", "task-merging"); // a live worker with an in-flight merge (stubbed pendingMerge)
seedWorker("w-done", "task-done");       // a worker that already reported done (awaitingReview true)
db.appendEvent({ id: "ev-done", ts: now, managerSessionId: "mgr", workerSessionId: "w-done", taskId: "task-done", kind: "worker_report", detail: { status: "done", summary: "shipped" } });

const PENDING_MERGE_VIEW = { opId: "op-merge-1", kind: "merge", key: "merge:w-merging", managerSessionId: "mgr", startedAt: now, state: "running" };
const PENDING_SPAWN = { opId: "op-spawn-1", kind: "spawn", key: "spawn:task-spawning", managerSessionId: "mgr", startedAt: now, state: "running", taskId: "task-spawning" };

const sessionsStub = {
  peekPendingMerge(workerSessionId) { return workerSessionId === "w-merging" ? PENDING_MERGE_VIEW : undefined; },
  listPendingSpawns(managerSessionId) { return managerSessionId === "mgr" ? [PENDING_SPAWN] : []; },
  listCapQueuedSpawns() { return []; }, // no cap-queued markers in this stub's scenario — exercised for real in worker-spawn-cap-queue.mjs
};

const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
const server = router.buildServer("mgr", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "worker-list-pending-ops-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} }));

try {
  const list = await call("worker_list");
  check("worker_list stays a BARE ARRAY (non-breaking — no {workers,pendingSpawns} wrapper)", Array.isArray(list));
  check("worker_list has 3 real workers + 1 placeholder = 4 rows", list.length === 4);

  const plain = list.find((w) => w.workerSessionId === "w-plain");
  check("(w-plain) a worker with no pending op → pendingMerge:null", plain && plain.pendingMerge === null);

  const merging = list.find((w) => w.workerSessionId === "w-merging");
  check("(w-merging) pendingMerge is populated with the stubbed op view", merging && merging.pendingMerge && merging.pendingMerge.opId === "op-merge-1" && merging.pendingMerge.state === "running");

  const done = list.find((w) => w.workerSessionId === "w-done");
  check("(w-done) reportedState/awaitingReview projection still works alongside pendingMerge", done && done.reportedState === "done" && done.awaitingReview === true && done.pendingMerge === null);

  const placeholder = list.find((w) => w.workerSessionId === null);
  check("(placeholder) a pending spawn with NO worker row surfaces additively", !!placeholder);
  check("(placeholder) carries taskId + the pendingSpawn opId/startedAt", placeholder.taskId === "task-spawning" && placeholder.pendingSpawn.opId === "op-spawn-1" && placeholder.pendingSpawn.startedAt === now);
  check("(placeholder) processState is 'starting', NOT 'live' — a 'count live workers' consumer must skip it", placeholder.processState === "starting");
  check("(placeholder) reportedState:null + awaitingReview:false — an 'awaiting review' consumer must skip it too", placeholder.reportedState === null && placeholder.awaitingReview === false);
  check("(placeholder) pendingMerge:null (it has no worker row to hang a merge off)", placeholder.pendingMerge === null);

  // --- prove a naive "live workers" / "awaiting review" consumer is NOT fooled by the placeholder ---
  const liveWorkers = list.filter((w) => w.processState === "live");
  check("(consumer) filtering processState==='live' excludes the placeholder (3 real live workers)", liveWorkers.length === 3 && !liveWorkers.some((w) => w.workerSessionId === null));
  const awaitingReview = list.filter((w) => w.awaitingReview);
  check("(consumer) filtering awaitingReview excludes the placeholder (only w-done)", awaitingReview.length === 1 && awaitingReview[0].workerSessionId === "w-done");

  // --- worker_status(id) on a real worker also carries pendingMerge ---
  const status = await call("worker_status", { workerSessionId: "w-merging" });
  check("worker_status(w-merging) carries pendingMerge too", status.pendingMerge && status.pendingMerge.opId === "op-merge-1");
  const statusPlain = await call("worker_status", { workerSessionId: "w-plain" });
  check("worker_status(w-plain) pendingMerge:null", statusPlain.pendingMerge === null);
} finally {
  db.close();
  try { fs.rmSync(dbFile, { force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_list stays a bare array (additive-only): a real worker's in-flight merge surfaces as pendingMerge, a pending spawn with no worker row yet surfaces as a clearly-flagged placeholder row that a 'live workers'/'awaiting review' consumer correctly skips, and worker_status carries the same pendingMerge projection."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
