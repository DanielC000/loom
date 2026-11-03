import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b4b246dd defect 2 — worker_status/worker_transcript/worker_report_get used to collapse "no
// session row exists for this id at all" and "a session row exists but belongs to a different
// manager's lineage" into the SAME "not your worker" message, so a manager who typo'd a workerSessionId,
// or passed a taskId/opId by mistake, was told it lacks PERMISSION rather than that the id itself
// doesn't resolve to any worker. HERMETIC, NO claude, NO external daemon: seeds a real Db (sessions
// only) and drives the REAL manager MCP tools in-process over an InMemoryTransport pair, mirroring
// worker-lineage-scope.mjs's harness (including its `sessions` stub shape).
//
// Covers:
//   (1) a genuinely unknown id (no match anywhere in this manager's scope) → "no such worker session
//       '<id>'" with NO hint suffix — never "not your worker".
//   (2) an id matching a LIVE worker's own taskId (full id) → did-you-mean names that worker's session id.
//   (3) the SAME did-you-mean fires on an unambiguous 8-char PREFIX of that taskId.
//   (4) an id matching a worker's in-flight MERGE opId → did-you-mean names that worker.
//   (5) an id matching an in-flight SPAWN op's opId/taskId → a "still spawning" hint, no workerSessionId yet.
//   (6) an id matching a CAP-QUEUED entry's opId/taskId → a "cap-queued, not spawned yet" hint.
//   (7) a genuine ownership mismatch (a real worker row belonging to ANOTHER manager) still reads the
//       UNCHANGED, hint-free "not your worker" — the two message shapes never collapse into each other.
//   (8) the same split is shared (not independently reimplemented) across worker_status, worker_transcript,
//       AND worker_report_get.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sandboxHome = mkdtempManaged("loom-notfound-hint-home-");
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
process.env.LOOM_HOME = path.join(sandboxHome, ".loom");
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

const dbFile = path.join(os.tmpdir(), `loom-notfound-hint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-11-03T12:00:00.000Z";
const projId = "proj-nf";
const agentId = "agent-nf";
db.insertProject({ id: projId, name: "NotFoundHint", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
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

const TASK_ID = "aaaaaaaa-0000-4000-8000-000000000001"; // >= 8 chars, a real taskId MGR's own worker carries
db.insertSession({
  id: "w-live", projectId: projId, agentId, engineSessionId: "eng-w-live", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker", parentSessionId: "MGR", taskId: TASK_ID, branch: "loom/w-live",
});
// A real worker belonging to a DIFFERENT manager — the genuine-ownership-mismatch case (7), and (card
// b4b246dd round 2) the SCOPE case (1b): its own taskId must not leak a did-you-mean to MGR either.
const FOREIGN_TASK_ID = "bbbbbbbb-0000-4000-8000-000000000002";
db.insertSession({
  id: "w-foreign", projectId: projId, agentId, engineSessionId: "eng-w-foreign", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker", parentSessionId: "OTHER-MGR", taskId: FOREIGN_TASK_ID, branch: "loom/w-foreign",
});

// A second live worker of MGR's OWN, with a full-length (>= 8 char) session id — case (9)'s own-session-id
// did-you-mean fires on a PREFIX of a worker's `id`, not just its taskId/opId; "w-live"/"w-foreign" above
// are both too short (< MIN_ID_PREFIX_LEN) to ever prefix-match, so this fixture needs its own longer id.
const OWN_WORKER_ID = "99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
db.insertSession({
  id: OWN_WORKER_ID, projectId: projId, agentId, engineSessionId: "eng-w-ownid", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker", parentSessionId: "MGR", taskId: null, branch: "loom/w-ownid",
});

// worker_report (needed for worker_report_get's own happy path, case 8) so the tool has something to read.
db.appendEvent({
  id: randomUUID(), ts: now, managerSessionId: "MGR", workerSessionId: "w-live", taskId: TASK_ID,
  kind: "worker_report", detail: { status: "progress", summary: "working" },
});

const MERGE_OP_ID = "merge-op-aaaaaaaa";
const SPAWN_OP_ID = "spawn-op-bbbbbbbb";
const SPAWN_TASK_ID = "cccccccc-0000-4000-8000-000000000003";
const CAPQ_OP_ID = "capq-op-dddddddd";
const CAPQ_TASK_ID = "eeeeeeee-0000-4000-8000-000000000004";

// card fb8df559/ae0b7891/ba41b402-shaped stub — mirrors worker-lineage-scope.mjs's sessionsStub, plus the
// THREE sources workerNotFoundHint actually reads beyond db.listWorkers itself: a live worker's own
// in-flight merge opId, an in-flight spawn op, and a cap-queued entry — EACH scoped to MGR only, so a
// hint can never see OTHER-MGR's own ops. `db.listWorkers(managerSessionId)` (the REAL db query, not this
// stub) is scoped the same way — case (1b) below asserts that directly, by passing w-foreign's own
// taskId and confirming MGR gets no did-you-mean for it at all.
const sessionsStub = {
  peekPendingMerge(w) {
    return w?.id === "w-live" ? { opId: MERGE_OP_ID, state: "running" } : undefined;
  },
  listPendingSpawns(managerSessionId) {
    return managerSessionId === "MGR" ? [{ opId: SPAWN_OP_ID, taskId: SPAWN_TASK_ID, startedAt: now }] : [];
  },
  listCapQueuedSpawns(managerSessionId) {
    return managerSessionId === "MGR"
      ? [{ opId: CAPQ_OP_ID, agentId, taskId: CAPQ_TASK_ID, kickoffLabel: "queued task", queuedAt: now }]
      : [];
  },
  isArchivedWithoutReport() { return false; },
  async getDanglingWorkers() { return []; },
};

async function clientFor(managerSessionId) {
  const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
  const server = router.buildServer(managerSessionId, "manager");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "notfound-hint-test", version: "0" });
  await client.connect(clientT);
  return { client, call: async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text) };
}

const { client: mgrClient, call } = await clientFor("MGR");

// ============================ (1) genuinely unknown id — no hint, never "not your worker" ===============
const UNKNOWN_ID = "00000000-ffff-4fff-8fff-ffffffffffff";
const unknown = await call("worker_status", { workerSessionId: UNKNOWN_ID });
check("(1) an unknown id reads a DISTINCT 'no such worker session' error, not 'not your worker'", unknown.error === `no such worker session '${UNKNOWN_ID}'`);
check("(1) the two error shapes are different strings", unknown.error !== "not your worker");

// ============================ (1b) SCOPE: another manager's worker's own taskId leaks NO hint to MGR ====
// card b4b246dd round 2 — workerNotFoundHint must draw candidates ONLY from the CALLING manager's own
// scope. w-foreign belongs to OTHER-MGR; MGR passing w-foreign's own taskId must read the SAME
// hint-free "no such worker session" as a genuinely unknown id — never a did-you-mean naming w-foreign.
const byForeignTaskId = await call("worker_status", { workerSessionId: FOREIGN_TASK_ID });
check("(1b) a DIFFERENT manager's worker's own taskId reads EXACTLY 'no such worker session', no hint", byForeignTaskId.error === `no such worker session '${FOREIGN_TASK_ID}'`);
check("(1b) the hint never names w-foreign", !byForeignTaskId.error?.includes("w-foreign"));

// ============================ (2) a taskId (full id) gets a did-you-mean naming the real worker =========
const byTaskId = await call("worker_status", { workerSessionId: TASK_ID });
check("(2) passing a TASK id instead of a session id gets a did-you-mean naming the worker", byTaskId.error?.includes("did you mean worker 'w-live'"));
check("(2) the hint names the task id too", byTaskId.error?.includes(TASK_ID));

// ============================ (3) the SAME hint fires on an 8-char prefix of the taskId ==================
const byTaskPrefix = await call("worker_status", { workerSessionId: TASK_ID.slice(0, 8) });
check("(3) an 8-char PREFIX of the taskId gets the same did-you-mean", byTaskPrefix.error?.includes("did you mean worker 'w-live'"));

// ============================ (4) an in-flight MERGE opId gets a did-you-mean ============================
const byMergeOp = await call("worker_status", { workerSessionId: MERGE_OP_ID });
check("(4) a worker's in-flight merge opId gets a did-you-mean naming that worker", byMergeOp.error?.includes("did you mean worker 'w-live'") && byMergeOp.error?.includes(MERGE_OP_ID));

// ============================ (5) an in-flight SPAWN op's opId/taskId → 'still spawning' ==================
const bySpawnOp = await call("worker_status", { workerSessionId: SPAWN_OP_ID });
check("(5) a pending spawn's opId gets a 'still spawning' hint, no workerSessionId suggested", bySpawnOp.error?.includes("spawn still in flight") && bySpawnOp.error?.includes(SPAWN_OP_ID));
const bySpawnTask = await call("worker_status", { workerSessionId: SPAWN_TASK_ID });
check("(5) the pending spawn's OWN taskId also gets the 'still spawning' hint", bySpawnTask.error?.includes("spawn still in flight"));

// ============================ (6) a CAP-QUEUED entry's opId/taskId → 'cap-queued' =========================
const byCapQOp = await call("worker_status", { workerSessionId: CAPQ_OP_ID });
check("(6) a cap-queued entry's opId gets a 'cap-queued, not spawned yet' hint", byCapQOp.error?.includes("cap-queued") && byCapQOp.error?.includes(CAPQ_OP_ID));

// ============================ (7) a REAL ownership mismatch stays EXACTLY 'not your worker' ===============
const foreign = await call("worker_status", { workerSessionId: "w-foreign" });
check("(7) a real worker row owned by ANOTHER manager reads EXACTLY 'not your worker' — no hint, unchanged", foreign.error === "not your worker");

// ============================ (8) the SAME split is shared by worker_transcript/worker_report_get =========
const txUnknown = await call("worker_transcript", { workerSessionId: TASK_ID });
check("(8) worker_transcript shares the SAME did-you-mean (not independently reimplemented)", txUnknown.error?.includes("did you mean worker 'w-live'"));
const txForeign = await call("worker_transcript", { workerSessionId: "w-foreign" });
check("(8) worker_transcript's genuine-mismatch case also stays EXACTLY 'not your worker'", txForeign.error === "not your worker");

const rgUnknown = await call("worker_report_get", { workerSessionId: TASK_ID });
check("(8) worker_report_get shares the SAME did-you-mean too", rgUnknown.error?.includes("did you mean worker 'w-live'"));
const rgForeign = await call("worker_report_get", { workerSessionId: "w-foreign" });
check("(8) worker_report_get's genuine-mismatch case also stays EXACTLY 'not your worker'", rgForeign.error === "not your worker");
const rgLive = await call("worker_report_get", { workerSessionId: "w-live" });
check("(8) worker_report_get's real happy path is unaffected by this change", rgLive.status === "progress" && rgLive.summary === "working");

// ============================ (9) an 8-char PREFIX of a worker's own session id gets a did-you-mean =====
// card b4b246dd round 2, item 4 — the most common wrong id: a truncated/typo'd prefix of the worker's
// OWN session id (not its taskId/opId). Own workers only.
const byOwnIdPrefix = await call("worker_status", { workerSessionId: OWN_WORKER_ID.slice(0, 8) });
check("(9) an 8-char prefix of a worker's own session id gets a did-you-mean naming the full id", byOwnIdPrefix.error?.includes(`did you mean worker session '${OWN_WORKER_ID}'`));

await mgrClient.close();
try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_status/worker_transcript/worker_report_get now split 'no such worker session' (an id that matches no session row at all, with a did-you-mean when it matches a known session id/taskId/opId in the CALLING manager's own scope: a live worker's own session id, its taskId, an in-flight merge opId, a pending spawn's opId/taskId, or a cap-queued entry's opId/taskId) from 'not your worker' (a session row exists but belongs to a different manager's lineage — unchanged, no hint) — so a manager who passes the wrong KIND of id is told the id doesn't resolve, not that it lacks permission. The hint is strictly scoped to the CALLING manager: a DIFFERENT manager's worker's own taskId leaks no hint at all, and a match is only ever returned when it is unambiguous."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
