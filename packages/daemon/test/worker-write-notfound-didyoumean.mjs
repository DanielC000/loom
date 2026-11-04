import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 03b0377e — the not-found/not-yours split lives ONLY at the MCP layer (orchestration.ts),
// never pushed into sessions/service.ts's own throws (two other tests assert those directly); the
// pre-check must stay lineage-tolerant, never narrowed to db.listWorkers(), or an exited worker refuses.
//
// HERMETIC, NO claude, NO external daemon: seeds a real Db (sessions only) and drives the REAL manager
// MCP tools in-process over an InMemoryTransport pair, mirroring worker-notfound-didyoumean.mjs's own
// harness. A stub `sessions` object plays every underlying sessions.* method, recording each call so a
// test can prove the pre-check actually short-circuits (never reaches the stub) for the not-found/
// not-yours cases, and that it does NOT over-refuse a legitimately owned worker.
//
// Covers, once per tool-family (worker_message/worker_stop/worker_redirect/worker_set_mode/
// worker_recycle/worker_merge/worker_merge_confirm):
//   (A) a genuinely unknown id → "no such worker session '<id>'" (with the SAME did-you-mean the read
//       tools already got, proving the helper is reused, not reimplemented) — the underlying
//       sessions.* method is NEVER called.
//   (B) a real ownership mismatch (a worker row belonging to ANOTHER manager) → UNCHANGED, hint-free
//       "not your worker" — the underlying sessions.* method is NEVER called.
//   (C) a legitimately owned, LIVE worker → the call reaches the underlying sessions.* method and its
//       result passes through — the pre-check never over-refuses the happy path.
// Plus, for worker_merge and worker_merge_confirm specifically (their common real-world target):
//   (D) an EXITED worker still in the caller's own lineage is NOT refused by the new pre-check — it
//       still reaches the underlying sessions.* method, exactly like a live one.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-write-notfound-didyoumean.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sandboxHome = mkdtempManaged("loom-write-notfound-home-");
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
process.env.LOOM_HOME = path.join(sandboxHome, ".loom");
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

const dbFile = path.join(os.tmpdir(), `loom-write-notfound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-11-04T12:00:00.000Z";
const projId = "proj-wnf";
const agentId = "agent-wnf";
db.insertProject({ id: projId, name: "WriteNotFoundHint", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

db.insertSession({
  id: "MGR", projectId: projId, agentId, engineSessionId: "eng-MGR", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null,
});
db.insertSession({
  id: "OTHER-MGR", projectId: projId, agentId, engineSessionId: "eng-OTHER-MGR", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null,
});

// A live worker genuinely owned by MGR — the (A) did-you-mean target and the (C) happy-path target.
const TASK_ID = "aaaaaaaa-0000-4000-8000-000000000001"; // >= 8 chars, a real taskId MGR's own worker carries
db.insertSession({
  id: "w-live", projectId: projId, agentId, engineSessionId: "eng-w-live", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker", parentSessionId: "MGR", taskId: TASK_ID, branch: "loom/w-live",
});
// A real worker belonging to a DIFFERENT manager — the (B) genuine-ownership-mismatch target.
db.insertSession({
  id: "w-foreign", projectId: projId, agentId, engineSessionId: "eng-w-foreign", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker", parentSessionId: "OTHER-MGR", taskId: "bbbbbbbb-0000-4000-8000-000000000002", branch: "loom/w-foreign",
});
// (D) An EXITED worker, still in MGR's own lineage — worker_merge/worker_merge_confirm's common target
// (reported done, exited, awaiting review/confirm). processState:"exited", never archived — matches the
// ordinary un-merged-but-exited shape, not the rarer archived-dangling one.
db.insertSession({
  id: "w-exited", projectId: projId, agentId, engineSessionId: "eng-w-exited", title: null, cwd: projId,
  processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker", parentSessionId: "MGR", taskId: "cccccccc-0000-4000-8000-000000000003", branch: "loom/w-exited",
});

const UNKNOWN_ID = "00000000-ffff-4fff-8fff-ffffffffffff";

// Records every underlying sessions.* call this stub plays, so a test can assert the pre-check
// short-circuited (no entry at all) or passed through (exactly one entry, with the right workerSessionId).
const calls = [];
const sessionsStub = {
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; },
  async getDanglingWorkers() { return []; },
  messageWorker(managerSessionId, workerSessionId) {
    calls.push(["messageWorker", workerSessionId]);
    return { delivered: true, deliveryState: "handed-off", msgId: "msg-1" };
  },
  async stopWorker(managerSessionId, workerSessionId) {
    calls.push(["stopWorker", workerSessionId]);
    return { stopped: true };
  },
  redirectWorker(managerSessionId, workerSessionId) {
    calls.push(["redirectWorker", workerSessionId]);
    return { delivered: true, msgId: "msg-2" };
  },
  async setWorkerMode(managerSessionId, workerSessionId) {
    calls.push(["setWorkerMode", workerSessionId]);
    return "auto";
  },
  async recycleWorker(managerSessionId, workerSessionId) {
    calls.push(["recycleWorker", workerSessionId]);
    return { id: "succ-1", gen: 1, recycledFrom: workerSessionId };
  },
  async reviewWorkerMerge(managerSessionId, workerSessionId) {
    calls.push(["reviewWorkerMerge", workerSessionId]);
    return { filesChanged: 0, insertions: 0, deletions: 0, diffstat: [] };
  },
  async confirmWorkerMergeTracked(managerSessionId, workerSessionId) {
    calls.push(["confirmWorkerMergeTracked", workerSessionId]);
    return { settled: true, ok: true, value: { merged: true, opId: "mc-op-1" } };
  },
};

async function clientFor(managerSessionId) {
  const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
  const server = router.buildServer(managerSessionId, "manager");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "write-notfound-hint-test", version: "0" });
  await client.connect(clientT);
  return { client, call: async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text) };
}

const { client: mgrClient, call } = await clientFor("MGR");

// Per tool-family: args (minimal valid payload besides workerSessionId), the underlying stub key, and
// the expected happy-path call entry for (C)/(D).
const TOOLS = [
  { tool: "worker_message", extraArgs: { text: "hi" }, stubKey: "messageWorker" },
  { tool: "worker_stop", extraArgs: {}, stubKey: "stopWorker" },
  { tool: "worker_redirect", extraArgs: { text: "stop" }, stubKey: "redirectWorker" },
  { tool: "worker_set_mode", extraArgs: { mode: "auto" }, stubKey: "setWorkerMode" },
  { tool: "worker_recycle", extraArgs: { handoffSummary: "HS" }, stubKey: "recycleWorker" },
  { tool: "worker_merge", extraArgs: {}, stubKey: "reviewWorkerMerge" },
  { tool: "worker_merge_confirm", extraArgs: {}, stubKey: "confirmWorkerMergeTracked" },
];
const MERGE_TOOLS = new Set(["worker_merge", "worker_merge_confirm"]);

for (const { tool, extraArgs, stubKey } of TOOLS) {
  calls.length = 0;

  // ---------------------------- (A) unknown id --------------------------------------------------------
  const unknown = await call(tool, { workerSessionId: UNKNOWN_ID, ...extraArgs });
  check(`(A) ${tool}: an unknown id reads 'no such worker session', not 'not your worker'`, unknown.error === `no such worker session '${UNKNOWN_ID}'`);
  check(`(A) ${tool}: the underlying service method is NEVER called for an unknown id`, calls.length === 0);

  calls.length = 0;
  const byTaskId = await call(tool, { workerSessionId: TASK_ID, ...extraArgs });
  check(`(A) ${tool}: passing a TASK id instead of a session id gets the SAME did-you-mean the read tools use`, byTaskId.error?.includes("did you mean worker 'w-live'"));
  check(`(A) ${tool}: the did-you-mean path also never reaches the underlying service method`, calls.length === 0);

  // ---------------------------- (B) real ownership mismatch -------------------------------------------
  calls.length = 0;
  const foreign = await call(tool, { workerSessionId: "w-foreign", ...extraArgs });
  check(`(B) ${tool}: a real worker owned by ANOTHER manager reads EXACTLY 'not your worker' — unchanged`, foreign.error === "not your worker");
  check(`(B) ${tool}: the ownership-mismatch path also never reaches the underlying service method`, calls.length === 0);

  // ---------------------------- (C) legitimately owned, LIVE worker — not over-refused ----------------
  calls.length = 0;
  const live = await call(tool, { workerSessionId: "w-live", ...extraArgs });
  check(`(C) ${tool}: a legitimately owned live worker reaches the underlying service method`, calls.some(([k, id]) => k === stubKey && id === "w-live"));
  check(`(C) ${tool}: the happy path is not refused as 'no such worker session' or 'not your worker'`, live.error !== `no such worker session 'w-live'` && live.error !== "not your worker");

  // ---------------------------- (D) exited lineage worker — merge tools only --------------------------
  if (MERGE_TOOLS.has(tool)) {
    calls.length = 0;
    const exited = await call(tool, { workerSessionId: "w-exited", ...extraArgs });
    check(`(D) ${tool}: an EXITED worker still in the caller's own lineage is NOT refused by the new pre-check`, calls.some(([k, id]) => k === stubKey && id === "w-exited"));
    check(`(D) ${tool}: the exited-lineage path never reads 'no such worker session' or 'not your worker'`, exited.error !== `no such worker session 'w-exited'` && exited.error !== "not your worker");
  }
}

// worker_stop's opId path is untouched by this card (no workerSessionId involved) — a quick sanity check
// that the new pre-check didn't somehow regress it.
calls.length = 0;
const stopNoArgs = await call("worker_stop", {});
check("worker_stop: still requires EITHER workerSessionId or opId (untouched by this card)", stopNoArgs.error === "worker_stop requires either workerSessionId or opId");

await mgrClient.close();
try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_message/worker_stop/worker_redirect/worker_set_mode/worker_recycle/worker_merge/worker_merge_confirm now split 'no such worker session' (an unknown id, with the SAME did-you-mean hint the read tools already use) from 'not your worker' (a real ownership mismatch, unchanged) via an MCP-layer pre-check that never reaches the underlying sessions.* method for either refusal case — and never over-refuses a legitimately owned worker, live OR exited (worker_merge/worker_merge_confirm's own common target)."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
