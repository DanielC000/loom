import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_status / worker_list "reported / awaiting-review" projection test (additive status field —
// reportedState: "done"|"blocked"|null + awaitingReview: boolean). HERMETIC, NO claude, NO external
// daemon: seeds a real Db (sessions + orchestration_events) and drives the REAL manager MCP tools
// (worker_list / worker_status) in-process over an InMemoryTransport pair, so it asserts the literal
// tool output a manager would see.
//
// The bug this guards: a worker that called worker_report(done) ends its turn at busy:false —
// indistinguishable in the raw session record from a plain idle-live worker. The projection makes
// "reported, awaiting review" visible WITHOUT reading the transcript.
//
// Card 6641c3ab: a worker's latest worker_report(done|blocked) is "current" iff no event in the
// REPORT_RESOLVED_EVENT_KINDS allowlist (merge_done, message_worker, redirect_worker, recycle_begin,
// stop_worker) landed after it — NOT "iff it is the worker's chronologically LAST event of ANY kind",
// which was the pre-fix behavior. That old check went null the instant ANY later worker-keyed row
// landed, including `merge_request` — fired by a manager merely reviewing the diff (worker_merge)
// before ever deciding whether to merge — which is what this file's (f)/(g) cases guard against.
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
const dbFile = path.join(os.tmpdir(), `loom-reported-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-06-06T12:00:00.000Z";
const projId = "proj-rs";
const agentId = "agent-rs";
db.insertProject({ id: projId, name: "Reported", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

// Manager under test + a SECOND manager (to confirm the projection rides the existing scoping).
function seedManager(id) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null,
  });
}
function seedWorker(id, parentId, { busy = false } = {}) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: parentId, taskId: "tk-" + id, branch: "loom/" + id,
  });
}
// Append an orchestration_event with an explicit ts (ordering is what the freshness rule reads).
const ev = (workerId, mgrId, kind, ts, detail) => db.appendEvent({
  id: randomUUID(), ts, managerSessionId: mgrId, workerSessionId: workerId, taskId: "tk-" + workerId, kind, detail,
});
const at = (sec) => new Date(Date.parse(now) + sec * 1000).toISOString();

seedManager("MGR");
seedManager("MGR2");

// (a) reported DONE, idle, nothing since → awaiting review.
seedWorker("w-done", "MGR");
ev("w-done", "MGR", "spawn_worker", at(0));
ev("w-done", "MGR", "worker_report", at(10), { status: "done", summary: "shipped" });

// (b) reported BLOCKED, idle, nothing since → awaiting review (distinct status).
seedWorker("w-blocked", "MGR");
ev("w-blocked", "MGR", "spawn_worker", at(0));
ev("w-blocked", "MGR", "worker_report", at(10), { status: "blocked", summary: "need creds", needs: "API key" });

// (c) plain idle-live: never reported (busy:false, no worker_report) → the conflation case. Must be
//     DISTINCT from (a)/(b): same busy:false, but reportedState null / awaitingReview false.
seedWorker("w-idle", "MGR");
ev("w-idle", "MGR", "spawn_worker", at(0));

// (d) reported DONE then RESUMED (manager message_worker → a later event) and busy again → NOT awaiting.
seedWorker("w-resumed", "MGR", { busy: true });
ev("w-resumed", "MGR", "spawn_worker", at(0));
ev("w-resumed", "MGR", "worker_report", at(10), { status: "done", summary: "first cut" });
ev("w-resumed", "MGR", "message_worker", at(20), { text: "one more thing" });

// (e) only a PROGRESS checkpoint as the latest report → not terminal → not awaiting review.
seedWorker("w-progress", "MGR");
ev("w-progress", "MGR", "spawn_worker", at(0));
ev("w-progress", "MGR", "worker_report", at(10), { status: "progress", summary: "halfway" });

// (f) card 6641c3ab, THE BUG: reported DONE then merely REVIEWED (merge_request newer — worker_merge
//     was called to look at the diff, but no merge decision was ever made) → STILL awaiting review.
//     Before the fix, `merge_request` alone (fired at review-START, before any decision) wrongly
//     cleared this — a manager who reviewed a worker's diff and got pulled away before confirming lost
//     the only signal that this worker was still sitting there awaiting a decision.
seedWorker("w-reviewed-only", "MGR");
ev("w-reviewed-only", "MGR", "spawn_worker", at(0));
ev("w-reviewed-only", "MGR", "worker_report", at(10), { status: "done", summary: "ready" });
ev("w-reviewed-only", "MGR", "merge_request", at(20), {});

// (g) card 6641c3ab POSITIVE CONTROL: reported DONE, reviewed, then the merge was REJECTED
//     (merge_request + merge_rejected, no merge_done) → STILL awaiting review. A rejection is a
//     decision, but not the "merged" the doc promises clears this — the worker still needs the
//     manager's follow-up (message it with feedback, or re-task), so this must NOT read as resolved.
seedWorker("w-rejected", "MGR");
ev("w-rejected", "MGR", "spawn_worker", at(0));
ev("w-rejected", "MGR", "worker_report", at(10), { status: "done", summary: "ready" });
ev("w-rejected", "MGR", "merge_request", at(20), {});
ev("w-rejected", "MGR", "merge_rejected", at(30), { reason: "conflict" });

// (h) reported DONE, reviewed, then actually MERGED (merge_request + merge_done) → a genuine
//     resolution → not awaiting.
seedWorker("w-merged", "MGR");
ev("w-merged", "MGR", "spawn_worker", at(0));
ev("w-merged", "MGR", "worker_report", at(10), { status: "done", summary: "ready" });
ev("w-merged", "MGR", "merge_request", at(20), {});
ev("w-merged", "MGR", "merge_done", at(30), {});

// MGR2's worker — only to keep the scope honest (must not leak into MGR's worker_list).
seedWorker("w-other", "MGR2");
ev("w-other", "MGR2", "worker_report", at(10), { status: "done", summary: "not yours" });

// --- drive the REAL manager MCP tools in-process. fleetView/worker_status read `pendingMerge`/pending
// spawns off `sessions` (card fb8df559 Part 1) — no pending ops in this test, so no-ops mirroring
// PendingOpRegistry's "nothing tracked" shape; otherwise the stub is unused by worker_list/worker_status.
// isArchivedWithoutReport (card ae0b7891) is a separate, additive projection this file doesn't exercise
// (every worker seeded here is live, never archived) — stubbed false so the call doesn't throw. ---
const router = new OrchestrationMcpRouter(db, /** @type {any} */ ({
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; },
  async getDanglingWorkers() { return []; }, // card ba41b402: no stopped-but-unmerged worker in this test
}));
const server = router.buildServer("MGR", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "reported-state-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const status = async (id) => parse(await client.callTool({ name: "worker_status", arguments: { workerSessionId: id } }));

// ============================ worker_list ============================
const list = parse(await client.callTool({ name: "worker_list", arguments: {} }));
const byId = Object.fromEntries(list.map((w) => [w.workerSessionId, w]));

check("worker_list is MGR-scoped (MGR2's worker absent)", !("w-other" in byId) && list.every((w) => w.workerSessionId !== "w-other"));

check("(a) reported done → reportedState 'done' + awaitingReview true",
  byId["w-done"]?.reportedState === "done" && byId["w-done"]?.awaitingReview === true);
check("(b) reported blocked → reportedState 'blocked' + awaitingReview true",
  byId["w-blocked"]?.reportedState === "blocked" && byId["w-blocked"]?.awaitingReview === true);

// THE core distinction: w-idle and w-done are BOTH busy:false, but only w-done is awaiting review.
check("(c) plain idle-live (never reported) → reportedState null + awaitingReview false",
  byId["w-idle"]?.reportedState === null && byId["w-idle"]?.awaitingReview === false);
check("reported-done is DISTINCT from idle-live despite both being busy:false",
  byId["w-done"]?.busy === false && byId["w-idle"]?.busy === false &&
  byId["w-done"]?.awaitingReview === true && byId["w-idle"]?.awaitingReview === false);

check("(d) reported-then-resumed (busy again, later event) → reportedState null + awaitingReview false",
  byId["w-resumed"]?.busy === true && byId["w-resumed"]?.reportedState === null && byId["w-resumed"]?.awaitingReview === false);
check("(e) progress-only report → reportedState null + awaitingReview false (not terminal)",
  byId["w-progress"]?.reportedState === null && byId["w-progress"]?.awaitingReview === false);
check("(f) reported-then-reviewed-only (merge_request newer, no decision) → STILL 'done' + awaitingReview true",
  byId["w-reviewed-only"]?.reportedState === "done" && byId["w-reviewed-only"]?.awaitingReview === true);
check("(g) POSITIVE CONTROL — reported-then-rejected (merge_request + merge_rejected, no merge_done) → STILL 'done' + awaitingReview true",
  byId["w-rejected"]?.reportedState === "done" && byId["w-rejected"]?.awaitingReview === true);
check("(h) reported-then-actually-merged (merge_request + merge_done) → reportedState null + awaitingReview false",
  byId["w-merged"]?.reportedState === null && byId["w-merged"]?.awaitingReview === false);

// ============================ worker_status (full record + projection) ============================
const sDone = await status("w-done");
check("worker_status(w-done) carries the full row AND the projection",
  sDone.id === "w-done" && sDone.parentSessionId === "MGR" && sDone.reportedState === "done" && sDone.awaitingReview === true);
const sIdle = await status("w-idle");
check("worker_status(w-idle) → reportedState null + awaitingReview false (distinct from w-done)",
  sIdle.id === "w-idle" && sIdle.reportedState === null && sIdle.awaitingReview === false);
const sBlocked = await status("w-blocked");
check("worker_status(w-blocked) → reportedState 'blocked' + awaitingReview true", sBlocked.reportedState === "blocked" && sBlocked.awaitingReview === true);
const sResumed = await status("w-resumed");
check("worker_status(w-resumed) → reportedState null + awaitingReview false", sResumed.reportedState === null && sResumed.awaitingReview === false);
const sRejected = await status("w-rejected");
check("worker_status(w-rejected) POSITIVE CONTROL → reportedState 'done' + awaitingReview true (rejection does not clear it)",
  sRejected.reportedState === "done" && sRejected.awaitingReview === true);

// cross-manager denial still holds (projection didn't widen the gate).
const denied = await status("w-other");
check("worker_status(w-other) cross-manager → 'not your worker'", denied.error === "not your worker");

// ============================ worker_status with NO arg → fleet view (card 44ffc09b) ============================
// A manager's reflexive worker_status({}) must NOT throw an MCP schema-validation error; it aliases the
// fleet view (worker_list) so the no-arg call "just works" instead of forcing a worker_list fallback.
const noArg = parse(await client.callTool({ name: "worker_status", arguments: {} }));
check("worker_status({}) returns a structured fleet array (not an MCP validation throw)",
  Array.isArray(noArg) && !("error" in noArg));
check("worker_status({}) fleet view matches worker_list (same MGR-scoped children)",
  noArg.length === list.length &&
  noArg.every((w) => byId[w.workerSessionId]?.reportedState === w.reportedState) &&
  !noArg.some((w) => w.workerSessionId === "w-other"));

await client.close();
try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_status/worker_list surface reportedState+awaitingReview: a worker that called worker_report(done|blocked) is shown as awaiting review DISTINCTLY from a plain idle-live worker (both busy:false); the flag survives a mere diff review (merge_request) or a merge rejection, and clears only on a real resolution — the worker resumes (message_worker/redirect_worker) or is recycled/stopped/actually merged (merge_done) — or when only a progress checkpoint followed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
