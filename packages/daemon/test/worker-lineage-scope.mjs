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
// resume-doc `lineageRootId` helper) while WRITE ops (worker_stop/worker_message/worker_redirect) stay
// exact-parent-scoped — this test proves both halves, plus that a genuinely unrelated manager is still
// denied reads.
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

// ============================ (1) READ scope walks the lineage ============================
const stPred = await call("worker_status", { workerSessionId: "w-pred" });
check("worker_status(w-pred) on successor NEW (2 hops from spawning OLD) returns the row, not denied",
  stPred.id === "w-pred" && stPred.parentSessionId === "OLD");

const txPred = await call("worker_transcript", { workerSessionId: "w-pred" });
check("worker_transcript(w-pred) on successor NEW returns an array, not denied", Array.isArray(txPred));

// ============================ (2) a genuinely unrelated manager is still denied ============================
const stOther = await call("worker_status", { workerSessionId: "w-other" });
check("worker_status(w-other) on NEW (unrelated lineage) denied → 'not your worker'", stOther.error === "not your worker");

const txOther = await call("worker_transcript", { workerSessionId: "w-other" });
check("worker_transcript(w-other) on NEW (unrelated lineage) denied → 'not your worker'", txOther.error === "not your worker");

// ============================ (3) write ops stay EXACT-parent-scoped even within the lineage ============================
const stopPred = await call("worker_stop", { workerSessionId: "w-pred" });
check("worker_stop(w-pred) on successor NEW denied (write ops do NOT widen to lineage)", stopPred.error === "not your worker");

const msgPred = await call("worker_message", { workerSessionId: "w-pred", text: "hi" });
check("worker_message(w-pred) on successor NEW denied (write ops do NOT widen to lineage)", msgPred.error === "not your worker");

const redirectPred = await call("worker_redirect", { workerSessionId: "w-pred", text: "hi" });
check("worker_redirect(w-pred) on successor NEW denied (write ops do NOT widen to lineage)", redirectPred.error === "not your worker");

// ============================ (4) sanity: the ORIGINAL manager still reads/writes its own worker exactly ============================
const routerOld = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
const serverOld = routerOld.buildServer("OLD", "manager");
const [clientTOld, serverTOld] = InMemoryTransport.createLinkedPair();
await serverOld.connect(serverTOld);
const clientOld = new Client({ name: "lineage-scope-test-old", version: "0" });
await clientOld.connect(clientTOld);
const stOld = JSON.parse((await clientOld.callTool({ name: "worker_status", arguments: { workerSessionId: "w-pred" } })).content[0].text);
check("worker_status(w-pred) on its ORIGINAL manager OLD (exact match) still works", stOld.id === "w-pred");
const stopOld = JSON.parse((await clientOld.callTool({ name: "worker_stop", arguments: { workerSessionId: "w-pred" } })).content[0].text);
check("worker_stop(w-pred) on its ORIGINAL manager OLD (exact match) still allowed", stopOld.stopped === true);
await clientOld.close();

await client.close();
try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_status/worker_transcript scope reads by recycle LINEAGE (a successor manager can see a predecessor's already-exited worker), while worker_stop/worker_message/worker_redirect stay EXACT-parent-scoped, and a genuinely unrelated manager is still denied reads."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
