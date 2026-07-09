import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 93609ef3 — worker READ scope by recycle LINEAGE, not exact parent. HERMETIC, NO claude, NO
// external daemon: seeds a real Db (sessions only — no pty involved) and drives the REAL manager MCP
// tools (worker_status / worker_transcript / worker_stop / worker_message / worker_redirect) in-process
// over an InMemoryTransport pair, mirroring worker-reported-state.mjs's harness.
//
// The bug this guards: `recycleManager` only re-parents LIVE workers (reparentLiveWorkers) onto a fresh
// successor session — a worker that had already reported done/blocked/exited BEFORE the recycle keeps
// `parentSessionId` pointing at the now-retired predecessor. A successor manager (fresh sessionId) then
// got "not your worker" from worker_status/worker_transcript on exactly the findings it must act on. The
// fix scopes READS by lineage (walking `recycledFrom` to a shared root, mirroring the Platform Lead
// resume-doc `lineageRootId` helper) — this test proves that half, plus that a genuinely unrelated
// manager is still denied reads. WRITE ops (worker_stop/worker_message/worker_redirect) still enforce
// service.ts's UNCHANGED exact-parent guard, but now self-heal a stale link IN PLACE before reaching it
// (the fleet-lockout fix, see worker-relink-self-heal.mjs) — so a write on a lineage-owned worker now
// SUCCEEDS (and repairs the row) instead of being permanently denied.
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
const dbFile = path.join(os.tmpdir(), `loom-lineage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-07-03T12:00:00.000Z";
const projId = "proj-ln";
const agentId = "agent-ln";
db.insertProject({ id: projId, name: "Lineage", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

function seedManager(id, recycledFrom = null) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null, recycledFrom,
  });
}
function seedWorker(id, parentId, { processState = "exited", busy = false } = {}) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState, resumability: "resumable", busy, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: parentId, taskId: "tk-" + id, branch: "loom/" + id,
  });
}

// A 3-generation manager lineage: OLD -> MID (recycledFrom=OLD) -> NEW (recycledFrom=MID). W-PRED was
// spawned by OLD and already reported/exited BEFORE either recycle, so it was never reparented by
// recycleManager's reparentLiveWorkers (that only moves LIVE workers) — it still carries
// parentSessionId=OLD, two hops back from NEW.
seedManager("OLD");
seedManager("MID", "OLD");
seedManager("NEW", "MID");
seedWorker("w-pred", "OLD");

// A genuinely UNRELATED manager + its worker — a completely separate lineage. NEW must never read it.
seedManager("OTHER");
seedWorker("w-other", "OTHER");

// --- drive the REAL manager MCP tools in-process; stub `sessions` mirrors service.ts's UNCHANGED
// exact-parent write-op guard (stopWorker/messageWorker/redirectWorker each throw "not your worker" for
// a non-exact parent — see sessions/service.ts) so worker_stop/worker_message/worker_redirect exercise
// the real orchestration.ts wiring end-to-end without needing a full PtyHost.
const sessionsStub = {
  stopWorker(managerSessionId, workerSessionId) {
    const w = db.getSession(workerSessionId);
    if (!w || w.parentSessionId !== managerSessionId) throw new Error("not your worker");
    return { stopped: true };
  },
  messageWorker(managerSessionId, workerSessionId) {
    const w = db.getSession(workerSessionId);
    if (!w || w.parentSessionId !== managerSessionId) throw new Error("not your worker");
    return { delivered: true };
  },
  redirectWorker(managerSessionId, workerSessionId) {
    const w = db.getSession(workerSessionId);
    if (!w || w.parentSessionId !== managerSessionId) throw new Error("not your worker");
    return { delivered: true };
  },
  // card fb8df559 Part 1: fleetView/worker_status now read these off `sessions` — no pending ops in this
  // test, so read-only no-ops mirroring PendingOpRegistry's "nothing tracked" shape.
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
};
const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
const server = router.buildServer("NEW", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "lineage-scope-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

// ============================ (1) READ scope walks the lineage (and self-heals the stale link too) ============================
// Reads route through the SAME ensureWorkerLinked self-heal as writes (fleet-lockout fix) — a lineage-
// owned worker's stale parent_session_id is repaired on the FIRST touch, read or write, so it's already
// exact-match-correct (and thus visible to a plain worker_list) well before anything writes to it.
const stPred = await call("worker_status", { workerSessionId: "w-pred" });
check("worker_status(w-pred) on successor NEW (2 hops from spawning OLD) returns the row, not denied, self-healed to NEW",
  stPred.id === "w-pred" && stPred.parentSessionId === "NEW");

const txPred = await call("worker_transcript", { workerSessionId: "w-pred" });
check("worker_transcript(w-pred) on successor NEW returns an array, not denied", Array.isArray(txPred));

// ============================ (2) a genuinely unrelated manager is still denied ============================
const stOther = await call("worker_status", { workerSessionId: "w-other" });
check("worker_status(w-other) on NEW (unrelated lineage) denied → 'not your worker'", stOther.error === "not your worker");

const txOther = await call("worker_transcript", { workerSessionId: "w-other" });
check("worker_transcript(w-other) on NEW (unrelated lineage) denied → 'not your worker'", txOther.error === "not your worker");

// ============================ (3) sanity: the ORIGINAL manager can still reach its own worker too ============================
// w-pred's parent is currently NEW (self-healed by step 1's read). Since OLD shares the SAME lineage
// root, OLD is just as entitled to it — its own worker_status call self-heals the link right back to OLD
// (both directions are legitimate within one lineage; only a genuinely unrelated manager is ever denied —
// see step 2 / worker-relink-self-heal.mjs's scoping assertions for that boundary).
const routerOld = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
const serverOld = routerOld.buildServer("OLD", "manager");
const [clientTOld, serverTOld] = InMemoryTransport.createLinkedPair();
await serverOld.connect(serverTOld);
const clientOld = new Client({ name: "lineage-scope-test-old", version: "0" });
await clientOld.connect(clientTOld);
const stOld = JSON.parse((await clientOld.callTool({ name: "worker_status", arguments: { workerSessionId: "w-pred" } })).content[0].text);
check("worker_status(w-pred) on its ORIGINAL manager OLD still works (self-healed back to OLD)",
  stOld.id === "w-pred" && stOld.parentSessionId === "OLD");
const stopOld = JSON.parse((await clientOld.callTool({ name: "worker_stop", arguments: { workerSessionId: "w-pred" } })).content[0].text);
check("worker_stop(w-pred) on its ORIGINAL manager OLD (exact match now) allowed", stopOld.stopped === true);
await clientOld.close();

// ============================ (4) write ops self-heal a lineage-owned stale link, then succeed ============================
// (fleet-lockout self-heal — see worker-relink-self-heal.mjs for the dedicated test) — worker_stop's own
// guard fires FIRST here since w-pred's parent gets relinked to NEW as a side effect of ensureWorkerLinked,
// so this also proves the relink actually PERSISTS: a plain db.getSession read below confirms it.
const stopPred = await call("worker_stop", { workerSessionId: "w-pred" });
check("worker_stop(w-pred) on successor NEW self-heals the stale link and succeeds", stopPred.stopped === true);
check("w-pred's parent_session_id is now NEW (relinked in place, not just tolerated)",
  db.getSession("w-pred").parentSessionId === "NEW");

await client.close();
try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_status/worker_transcript scope reads by recycle LINEAGE (a successor manager can see a predecessor's already-exited worker), a write op on a lineage-owned worker self-heals its stale parent link and succeeds, and a genuinely unrelated manager is still denied reads."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
