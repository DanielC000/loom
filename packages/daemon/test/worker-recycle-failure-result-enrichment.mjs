import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a187fc9b — `worker_recycle`'s MCP handler (mcp/orchestration.ts) used to return a bare
// `{error: message}` on a failed recycle, even though by that point `recycleWorker` (sessions/service.ts)
// had already hard-stopped the predecessor, cancelled its wakes, and forwarded/dropped/counted its
// queued messages — nothing in the result told a manager any of that, so it could reasonably believe the
// old worker was still alive and message it. The fix enriches the tool result by recovering those SAME
// facts from `recycleWorker`'s own durable `recycle_failed` event (an indexed
// `getLatestEventForManagerByKind` point lookup), guarded so it only ever fires when THIS call's own
// teardown genuinely produced that event.
//
// Code Review fix on this card's first pass: matching on `detail.recycledFrom === workerSessionId` alone
// is NOT enough — a predecessor W whose recycle already failed once (event E1, recycledFrom=W) can be
// recycled again, and if THAT second call throws EARLY (before any teardown — a blank handoffSummary, an
// "already recycled" guard, anything pre-teardown), `getLatestEventForManagerByKind` still returns E1,
// whose `recycledFrom` still equals W — misattributing E1's counts to a call that never touched anything.
// The fix captures the latest recycle_failed event's OWN id BEFORE calling recycleWorker, and only trusts
// the post-call lookup when its id differs from that captured one (a genuinely NEW event, minted during
// THIS call) AND its recycledFrom matches — both checks are needed, neither alone is sufficient (see the
// scenarios below). Also: `worktreeIntact:true` was an ASSERTION with no observation behind it; it's now
// `worktreeExists`, a real `fs.existsSync` check on the recorded worktreePath taken at the moment of
// failure.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db (so the real
// `getLatestEventForManagerByKind`/`getSession` the handler calls are genuinely exercised) + the REAL
// OrchestrationMcpRouter over an in-process MCP InMemoryTransport, with a STUB `sessions.recycleWorker`
// that plays out each scenario's own teardown/event-writing by hand — mirrors recycle-param-alias.mjs's
// proven "stub SessionService, real router" harness, extended to also exercise the DB reads the new
// catch-block enrichment performs, plus a real temp directory so `worktreeExists` has something genuine
// to observe in both directions.
//
// Proves:
//   (1) POST-TEARDOWN FAILURE: recycleWorker hard-stops the predecessor, writes a `recycle_failed` event
//       naming it, then throws — the tool result carries predecessorStopped/worktreePath/branch/
//       worktreeExists:true (a REAL directory backs this predecessor)/cancelledWakes/queuedMessages/
//       recovery, matching the event's own detail exactly.
//   (2) SAME-PREDECESSOR RETRY, EARLY THROW — the exact race the Code Review fix closes: the SAME
//       workerSessionId as (1), recycled AGAIN, this time throwing BEFORE any teardown (no new event
//       written). The stale event from (1) must NOT be misattributed to this call — plain {error} only.
//   (3) PRE-TEARDOWN FAILURE, fresh predecessor never seen before — plain {error}, nothing fabricated
//       (the original negative control: no event exists for this predecessor at all).
//   (4) STALE-EVENT GUARD, cross-predecessor: with (1)'s event still the "latest recycle_failed" for this
//       manager, a pre-teardown failure for a DIFFERENT, brand-new predecessor must not pick it up either
//       — proves the `recycledFrom` match is still load-bearing, not superseded by the id check alone.
//   (5) POST-TEARDOWN FAILURE, worktree ALREADY GONE: same shape as (1) but the recorded worktreePath was
//       never created on disk — `worktreeExists:false`, proving the field is a genuine observation in
//       BOTH directions, not a hardcoded true.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-recycle-failure-result-enrichment.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function tmpDbFile(tag) {
  return path.join(os.tmpdir(), `loom-wrfe-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}
function rmDb(file) { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(file + ext, { force: true }); } catch { /* ignore */ } } }

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const file = tmpDbFile("main");
const db = new Db(file);
const now = new Date().toISOString();
db.insertProject({ id: "pR", name: "Recycle Enrichment", repoPath: "/r", vaultPath: "/r", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "aR", projectId: "pR", name: "r", startupPrompt: "", position: 0 });
db.insertSession({
  id: "mgrR", projectId: "pR", agentId: "aR", engineSessionId: null, title: null, cwd: "/r",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager",
});
db.insertTask({ id: "taskR1", projectId: "pR", title: "task R1", body: "", columnKey: "in_progress", position: 1, priority: "p2", createdAt: now, updatedAt: now });

// A REAL scratch dir for worktreePath — so `worktreeExists` has something genuine to observe (positive
// case), distinct from a predecessor whose worktreePath was never actually created (negative case, (5)).
const realWorktreeRoot = path.join(os.tmpdir(), `loom-wrfe-wt-${Date.now()}-${process.pid}`);
fs.mkdirSync(realWorktreeRoot, { recursive: true });

function insertWorker(id, { worktreePath } = {}) {
  const wt = worktreePath ?? `/r/wt-${id}`;
  db.insertSession({
    id, projectId: "pR", agentId: "aR", engineSessionId: `eng-${id}`, title: null,
    cwd: wt, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: "mgrR", taskId: "taskR1", worktreePath: wt, branch: `loom/${id}`,
  });
}

// Stub SessionService.recycleWorker: plays out each scenario's own teardown + event-writing by hand
// (mirroring what the real recycleWorker's catch block does), then throws — so this test proves the MCP
// handler's OWN recovery/enrichment logic, independent of the real (heavy) recycle mechanics already
// covered by worker-recycle-retry-after-prespawn-failure.mjs / worker-recycle-prespawn-failure-preserves-carried-queue.mjs.
// `posttdAttempted` tracks which "post-teardown" predecessors have already had their ONE failure — a
// SECOND call on the same id (scenario 2) throws early instead, with no new teardown/event, exactly
// mirroring a real retried recycle that fails before ever reaching the successor spawn.
const posttdAttempted = new Set();
const POSTTD_IDS = new Set(["wkr-posttd", "wkr-posttd-gone"]);
const sessions = {
  async recycleWorker(managerSessionId, workerSessionId) {
    if (POSTTD_IDS.has(workerSessionId)) {
      if (!posttdAttempted.has(workerSessionId)) {
        posttdAttempted.add(workerSessionId);
        db.setProcessState(workerSessionId, "exited");
        db.appendEvent({
          id: randomUUID(), ts: new Date().toISOString(), managerSessionId, workerSessionId: `fresh-dead-${workerSessionId}`, taskId: "taskR1",
          kind: "recycle_failed",
          detail: {
            recycledFrom: workerSessionId, failedSuccessorId: `fresh-dead-${workerSessionId}`, cancelledWakes: 2,
            carriedForwarded: 1, carriedDropped: 1, carriedContentCut: 0, carriedTruncated: 0, carriedDurableUndelivered: 3,
            error: "injected post-teardown spawn failure",
          },
        });
        throw new Error("injected post-teardown spawn failure");
      }
      // Scenario 2: retried on the SAME predecessor — this time throws EARLY, before any teardown ran and
      // before any new event was written (mirrors a real "this worker has already been recycled" guard,
      // or any other pre-teardown throw on a second attempt).
      throw new Error("this worker has already been recycled — its successor is live");
    }
    if (workerSessionId === "wkr-pretd" || workerSessionId === "wkr-pretd2") {
      throw new Error("not your worker");
    }
    throw new Error(`unexpected workerSessionId in stub: ${workerSessionId}`);
  },
};

try {
  const server = new OrchestrationMcpRouter(db, sessions).buildServer("mgrR", "manager");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "worker-recycle-failure-result-enrichment-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  // ===================== (1) post-teardown failure — enriched result, REAL worktree (existsSync:true) ====
  const realWt = path.join(realWorktreeRoot, "wkr-posttd");
  fs.mkdirSync(realWt, { recursive: true });
  insertWorker("wkr-posttd", { worktreePath: realWt });
  const r1 = await call("worker_recycle", { workerSessionId: "wkr-posttd", handoffSummary: "HS-1" });
  check("(1) error message passed through unchanged", r1.error === "injected post-teardown spawn failure");
  check("(1) predecessorStopped:true", r1.predecessorStopped === true);
  check("(1) worktreePath names the predecessor's own worktree", r1.worktreePath === realWt);
  check("(1) branch names the predecessor's own branch", r1.branch === "loom/wkr-posttd");
  check("(1) worktreeExists:true — a REAL directory backs this predecessor's worktreePath", r1.worktreeExists === true);
  check("(1) cancelledWakes matches the event's own count", r1.cancelledWakes === 2);
  check("(1) queuedMessages.forwardedToManager matches the event's own count", r1.queuedMessages?.forwardedToManager === 1);
  check("(1) queuedMessages.droppedAsMoot matches the event's own count", r1.queuedMessages?.droppedAsMoot === 1);
  check("(1) queuedMessages.contentCut matches the event's own count", r1.queuedMessages?.contentCut === 0);
  check("(1) queuedMessages.notShown matches the event's own count", r1.queuedMessages?.notShown === 0);
  check("(1) queuedMessages.durableUndelivered matches the event's own count", r1.queuedMessages?.durableUndelivered === 3);
  check("(1) recovery names both worker_recycle-again and worker_spawn", typeof r1.recovery === "string" && r1.recovery.includes("worker_recycle") && r1.recovery.includes("worker_spawn"));

  // ===================== (2) SAME predecessor, retried, EARLY throw — the exact race this fix closes ====
  // The stale event from (1) (recycledFrom === "wkr-posttd") is still the manager's "latest recycle_failed"
  // — this call must NOT report (1)'s counts as its own, since THIS call's own throw happened before any
  // teardown ran at all.
  const r1b = await call("worker_recycle", { workerSessionId: "wkr-posttd", handoffSummary: "HS-1b" });
  check("(2) error message passed through unchanged", r1b.error === "this worker has already been recycled — its successor is live");
  check("(2) NO predecessorStopped fabricated — this call's own throw was pre-teardown, despite a STALE event for the SAME predecessor existing",
    r1b.predecessorStopped === undefined);
  check("(2) NO worktreePath/worktreeExists/cancelledWakes/queuedMessages/recovery leaked from the stale same-predecessor event",
    r1b.worktreePath === undefined && r1b.worktreeExists === undefined && r1b.cancelledWakes === undefined
      && r1b.queuedMessages === undefined && r1b.recovery === undefined);

  // ===================== (3) pre-teardown failure, fresh predecessor — plain {error}, nothing fabricated =
  insertWorker("wkr-pretd");
  const r2 = await call("worker_recycle", { workerSessionId: "wkr-pretd", handoffSummary: "HS-2" });
  check("(3) error message passed through unchanged", r2.error === "not your worker");
  check("(3) NO predecessorStopped fabricated (nothing happened — the throw was pre-teardown)", r2.predecessorStopped === undefined);
  check("(3) NO worktreePath/worktreeExists fabricated", r2.worktreePath === undefined && r2.worktreeExists === undefined);
  check("(3) NO cancelledWakes fabricated", r2.cancelledWakes === undefined);
  check("(3) NO queuedMessages fabricated", r2.queuedMessages === undefined);
  check("(3) NO recovery fabricated", r2.recovery === undefined);

  // ===================== (4) stale-event guard, cross-predecessor ==========================================
  // (1)'s recycle_failed event (recycledFrom === "wkr-posttd") is still the manager's latest. A pre-teardown
  // failure for a DIFFERENT, brand-new predecessor must not be misattributed to it either — proves the
  // recycledFrom match is still load-bearing on its own, not superseded by the id-freshness check alone.
  insertWorker("wkr-pretd2");
  const r3 = await call("worker_recycle", { workerSessionId: "wkr-pretd2", handoffSummary: "HS-3" });
  check("(4) error message passed through unchanged", r3.error === "not your worker");
  check("(4) the STALE event (for a different predecessor) is NOT misattributed — no predecessorStopped fabricated",
    r3.predecessorStopped === undefined);
  check("(4) no worktreePath/worktreeExists/cancelledWakes/queuedMessages/recovery leaked from the unrelated stale event",
    r3.worktreePath === undefined && r3.worktreeExists === undefined && r3.cancelledWakes === undefined
      && r3.queuedMessages === undefined && r3.recovery === undefined);

  // ===================== (5) post-teardown failure, worktree already GONE (worktreeExists:false) =========
  // Same shape as (1), but this predecessor's recorded worktreePath was never created on disk — proves
  // worktreeExists is a genuine two-directional observation, not a hardcoded true.
  const goneWt = path.join(realWorktreeRoot, "never-created", "wkr-posttd-gone");
  insertWorker("wkr-posttd-gone", { worktreePath: goneWt });
  const r4 = await call("worker_recycle", { workerSessionId: "wkr-posttd-gone", handoffSummary: "HS-4" });
  check("(5) error message passed through unchanged", r4.error === "injected post-teardown spawn failure");
  check("(5) predecessorStopped:true", r4.predecessorStopped === true);
  check("(5) worktreePath names the predecessor's own (non-existent) worktree", r4.worktreePath === goneWt);
  check("(5) worktreeExists:false — the recorded path genuinely does not exist on disk", r4.worktreeExists === false);

  await client.close();
} finally {
  db.close();
  rmDb(file);
  try { fs.rmSync(realWorktreeRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_recycle's failure result now tells a manager what a failed recycle already did (predecessor stopped, worktree existence observed not asserted, wakes cancelled, queued messages accounted for, recovery path) when that teardown genuinely ran DURING this call, and stays the plain {error} shape (nothing fabricated, no stale-event leakage — including a retry on the SAME predecessor that throws early the second time) when it didn't."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
