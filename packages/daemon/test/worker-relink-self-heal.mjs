import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Fleet-lockout self-heal (P1: a manager gets locked out of its OWN live fleet — worker_list returns all
// its workers, but every per-id op (worker_status/worker_message/worker_redirect/worker_merge/...)
// returned "not your worker"; the only previously-known recovery was a full daemon_restart). HERMETIC, NO
// claude, NO external daemon: seeds a real Db (sessions only — no pty involved) and drives the REAL
// manager MCP tools in-process over an InMemoryTransport pair, mirroring worker-lineage-scope.mjs's
// harness.
//
// This test simulates the desync directly (a worker whose `parent_session_id` points at a PREDECESSOR
// manager two recycle-hops back, exactly like worker-lineage-scope.mjs's w-pred fixture) and proves:
//  (1) a per-id WRITE op that would previously have been permanently denied now self-heals the stale
//      link in place and succeeds, WITHOUT a daemon restart;
//  (2) the desync is logged (op, worker id, both session ids) so a real repro can finally be pinned;
//  (3) the explicit `worker_relink` backstop tool does the same repair on demand, and is IDEMPOTENT;
//  (4) the self-heal is scoped to the calling manager's OWN lineage — a genuinely unrelated manager's
//      worker is never relinked, never logged as a desync, and stays denied.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- hermetic Db (own temp file) ---
const dbFile = path.join(os.tmpdir(), `loom-relink-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-07-09T12:00:00.000Z";
const projId = "proj-relink";
const agentId = "agent-relink";
db.insertProject({ id: projId, name: "Relink", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
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

// A 2-generation manager lineage: OLD -> NEW (recycledFrom=OLD). Every fixture worker below is spawned
// by OLD and never reparented (mirrors an exited/not-live worker at recycle time, or any other desync
// that leaves parent_session_id stale) — same shape worker-lineage-scope.mjs uses for READS.
seedManager("OLD");
seedManager("NEW", "OLD");
seedWorker("w-desync-1", "OLD"); // for the write-op self-heal
seedWorker("w-desync-2", "OLD"); // for the explicit worker_relink tool

// A genuinely UNRELATED manager + its worker — a completely separate lineage. NEW must never relink it.
seedManager("MGR_B");
seedWorker("w-b", "MGR_B");

// --- drive the REAL manager MCP tools in-process; stub `sessions` mirrors service.ts's UNCHANGED
// exact-parent write-op guard (each throws "not your worker" for a non-exact parent), so worker_message/
// worker_redirect exercise the real orchestration.ts wiring (ensureWorkerLinked) end-to-end without
// needing a full PtyHost.
const sessionsStub = {
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
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
};

const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
const server = router.buildServer("NEW", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "relink-self-heal-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

// --- capture console.warn to prove the emit-on-disagreement instrumentation actually fires ---
const warnBuf = [];
const origWarn = console.warn;
console.warn = (...args) => { warnBuf.push(args.join(" ")); };

// ============================ (1) a write op self-heals a stale link and succeeds ============================
check("w-desync-1 starts parented to the retired predecessor OLD",
  db.getSession("w-desync-1").parentSessionId === "OLD");

const msg = await call("worker_message", { workerSessionId: "w-desync-1", text: "hi" });
check("worker_message(w-desync-1) on successor NEW self-heals the stale link and succeeds (no restart)",
  msg.delivered === true);
check("w-desync-1's parent_session_id is now NEW (relinked in place)",
  db.getSession("w-desync-1").parentSessionId === "NEW");

// A second call needs no further heal — plain exact-match success now.
const redirect = await call("worker_redirect", { workerSessionId: "w-desync-1", text: "steer" });
check("worker_redirect(w-desync-1) on NEW succeeds post-heal (already exact-matched)", redirect.delivered === true);

// ============================ (2) the desync was logged for a real repro ============================
const desyncLog = warnBuf.find((l) => l.includes("worker/manager parent desync") && l.includes("w-desync-1"));
check("the disagreement was logged", !!desyncLog);
check("the log names the op", desyncLog?.includes("op=worker_message"));
check("the log names the manager's closure sessionId", desyncLog?.includes("managerSessionId(closure)=NEW"));
check("the log names the stale row parentSessionId", desyncLog?.includes("row.parentSessionId=OLD"));

// ============================ (3) the explicit worker_relink backstop tool ============================
check("w-desync-2 starts parented to the retired predecessor OLD",
  db.getSession("w-desync-2").parentSessionId === "OLD");
warnBuf.length = 0;

const relink1 = await call("worker_relink", { workerSessionId: "w-desync-2" });
check("worker_relink(w-desync-2) on NEW reports found+relinked", relink1.found === true && relink1.relinked === true);
check("worker_relink(w-desync-2) reports wasStale:true", relink1.wasStale === true);
check("worker_relink(w-desync-2) returns the NEW parentSessionId", relink1.parentSessionId === "NEW");
check("w-desync-2's parent_session_id is persisted as NEW", db.getSession("w-desync-2").parentSessionId === "NEW");
check("the explicit relink also logged the disagreement",
  warnBuf.some((l) => l.includes("worker/manager parent desync") && l.includes("w-desync-2") && l.includes("op=worker_relink")));

// Idempotent: calling again on an already-correct link is a no-op (not re-logged as a fresh desync).
warnBuf.length = 0;
const relink2 = await call("worker_relink", { workerSessionId: "w-desync-2" });
check("a second worker_relink(w-desync-2) is a no-op: found:true, relinked:false, wasStale:false",
  relink2.found === true && relink2.relinked === false && relink2.wasStale === false);
check("no repeat desync is logged for an already-correct link", warnBuf.length === 0);

// A missing workerSessionId reports found:false, never throws.
const relinkMissing = await call("worker_relink", { workerSessionId: "does-not-exist" });
check("worker_relink on a nonexistent id returns found:false (never throws)", relinkMissing.found === false);

// ============================ (4) scoping: a genuinely unrelated manager's worker is NEVER relinked ============================
warnBuf.length = 0;
const relinkOther = await call("worker_relink", { workerSessionId: "w-b" });
check("worker_relink(w-b) on NEW (unrelated lineage) reports found:true but relinked:false",
  relinkOther.found === true && relinkOther.relinked === false);
check("worker_relink(w-b) reports the UNCHANGED owner MGR_B, not NEW", relinkOther.parentSessionId === "MGR_B");
check("w-b's parent_session_id in the DB is untouched", db.getSession("w-b").parentSessionId === "MGR_B");
check("an unrelated-lineage lookup is NOT logged as a desync (it's a legitimate denial, not a repair)",
  warnBuf.length === 0);

const msgOther = await call("worker_message", { workerSessionId: "w-b", text: "hi" });
check("worker_message(w-b) on NEW (unrelated lineage) still denied — 'not your worker'",
  msgOther.error === "not your worker");
check("w-b's parent_session_id is STILL untouched after the denied write attempt",
  db.getSession("w-b").parentSessionId === "MGR_B");

console.warn = origWarn;
await client.close();
try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — a manager's per-id op on a lineage-owned worker self-heals a stale parent link and succeeds without a daemon restart, the desync is logged, the explicit worker_relink backstop repairs on demand + is idempotent, and a genuinely unrelated manager's worker is never relinked, logged, or granted access."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
