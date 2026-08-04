import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_list/worker_status `neverCompletedTurn` signal test (card 8d1abb7a).
//
// THE DEFECT THIS CLOSES: `ctxInputTokens` reads `null` until a worker's FIRST turn completes (the Stop
// hook is what calls setContextCounters/incrementTurnSeq) — but a bare `null` is indistinguishable from
// "something is wrong with measurement". Codescape mgr #35 measured this directly on a live worker: two
// OTHER cheap discriminators (ctxInputTokens climbing, git status/--numstat) BOTH silently return false
// negatives on exactly this worker class, and a manager following worker_list's OLD cost-ordered menu
// concluded a healthy worker was stuck. FIX: a `neverCompletedTurn` field (`turnSeq === 0`) makes the
// null DECIDABLE at the point of use, and the worker_list/worker_status descriptions now lead with the
// ONE discriminator (a named transcript artifact) that still works on this worker class.
//
// HERMETIC, NO claude, NO real spawn/merge — mirrors worker-list-pending-ops.mjs's pattern: a real Db
// with real worker rows, driven through the REAL manager MCP tools (worker_list/worker_status) over an
// InMemoryTransport pair, with a stub `sessions` for the three placeholder-row surfaces.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-never-completed-turn-signal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbFile = path.join(os.tmpdir(), `loom-wnct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-08-04T12:00:00.000Z";
const projId = "proj-wnct";
const agentId = "agent-wnct";
db.insertProject({ id: projId, name: "WNCT", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });

function seedWorker(id, taskId) {
  db.insertSession({ id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId, processState: "live", resumability: "unknown", busy: true, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgr", taskId });
}
// (w-fresh) never completed a turn — the exact class the card is about: turn_seq DEFAULTs to 0 on
// insertSession (it isn't even in the INSERT column list — see db.ts's CREATE TABLE comment), and
// ctxInputTokens is never set until the Stop hook fires.
seedWorker("w-fresh", "task-fresh");
// (w-ran) completed a turn for real: turnSeq bumped + ctx counters set, mirroring what onTurnCompleted/
// onContextStats actually do together on a real Stop hook (index.ts wires both from the SAME event).
seedWorker("w-ran", "task-ran");
db.incrementTurnSeq("w-ran");
db.setContextCounters("w-ran", { ctxInputTokens: 42000, ctxTurns: 1, model: "claude-sonnet-5" });
// (w-anomaly) the case `neverCompletedTurn` is SUPPOSED to distinguish from w-fresh: turnSeq bumped
// (a turn completed) but ctxInputTokens is STILL null (e.g. a transcript-read failure on that Stop hook —
// see setContextCounters's own doc: it's conditional on a successful transcript read). Genuinely
// anomalous, unlike w-fresh's expected pre-first-turn null.
seedWorker("w-anomaly", "task-anomaly");
db.incrementTurnSeq("w-anomaly");

const CAP_QUEUED = { opId: "op-cq-1", agentId, taskId: "task-capq", kickoffLabel: "cap-queued worker", queuedAt: now };
const DANGLING = { workerSessionId: "w-dangling", taskId: "task-dangling", branch: "loom/w-dangling", worktreePath: "/tmp/wld-dangling", lastActivity: now };

const sessionsStub = {
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return [{ opId: "op-sp-1", kind: "spawn", key: "spawn:task-spawning", managerSessionId: "mgr", startedAt: now, state: "running", taskId: "task-spawning" }]; },
  listCapQueuedSpawns(managerSessionId) { return managerSessionId === "mgr" ? [CAP_QUEUED] : []; },
  isArchivedWithoutReport() { return false; },
  async getDanglingWorkers() { return [DANGLING]; },
};

const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
const server = router.buildServer("mgr", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "worker-never-completed-turn-signal-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} }));

try {
  const list = await call("worker_list");

  const fresh = list.find((w) => w.workerSessionId === "w-fresh");
  check("(w-fresh) worker_list: ctxInputTokens is null (no completed turn yet)", fresh && fresh.ctxInputTokens === null);
  check("(w-fresh) worker_list: neverCompletedTurn is true — the null is DECIDABLE, not ambiguous", fresh.neverCompletedTurn === true);
  check("(w-fresh) ctxInputTokens is NOT defaulted to 0 (the card's explicit prohibition)", fresh.ctxInputTokens !== 0);

  const ran = list.find((w) => w.workerSessionId === "w-ran");
  check("(w-ran) worker_list: ctxInputTokens is the real measured value once a turn completed", ran && ran.ctxInputTokens === 42000);
  check("(w-ran) worker_list: neverCompletedTurn is false — a turn genuinely completed", ran.neverCompletedTurn === false);

  const anomaly = list.find((w) => w.workerSessionId === "w-anomaly");
  check("(w-anomaly) DISCRIMINATOR PROOF: turnSeq>0 but ctxInputTokens still null is the ANOMALOUS case", anomaly && anomaly.ctxInputTokens === null);
  check("(w-anomaly) neverCompletedTurn is false here — distinct from w-fresh's true despite BOTH reading ctxInputTokens:null (the same-signature bug this field fixes)", anomaly.neverCompletedTurn === false);
  check("(w-fresh) vs (w-anomaly): same ctxInputTokens signature, DIFFERENT neverCompletedTurn", fresh.ctxInputTokens === anomaly.ctxInputTokens && fresh.neverCompletedTurn !== anomaly.neverCompletedTurn);

  // --- worker_status carries the same field for a single worker ---
  const statusFresh = await call("worker_status", { workerSessionId: "w-fresh" });
  check("(w-fresh) worker_status: neverCompletedTurn true, matching worker_list", statusFresh.neverCompletedTurn === true);
  const statusRan = await call("worker_status", { workerSessionId: "w-ran" });
  check("(w-ran) worker_status: neverCompletedTurn false, matching worker_list", statusRan.neverCompletedTurn === false);

  // --- the three placeholder rows: a pendingSpawn/capQueued worker has definitionally never completed a
  // turn (true); a dangling (already-stopped) worker doesn't track this at all (null, not applicable) ---
  const pendingSpawn = list.find((w) => w.workerSessionId === null && w.pendingSpawn);
  check("(pendingSpawn placeholder) neverCompletedTurn is true — it hasn't even started", pendingSpawn && pendingSpawn.neverCompletedTurn === true);

  const capQueued = list.find((w) => w.workerSessionId === null && w.capQueued);
  check("(capQueued placeholder) neverCompletedTurn is true", capQueued && capQueued.neverCompletedTurn === true);

  const dangling = list.find((w) => w.processState === "dangling");
  check("(dangling placeholder) neverCompletedTurn is null — not tracked for an already-stopped worker", dangling && dangling.neverCompletedTurn === null);

  // --- byte-compat: a router built the OLD way (no pty arg) still returns the field correctly ---
  const routerNoPty = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
  const serverNoPty = routerNoPty.buildServer("mgr", "manager");
  const [clientT2, serverT2] = InMemoryTransport.createLinkedPair();
  await serverNoPty.connect(serverT2);
  const client2 = new Client({ name: "worker-never-completed-turn-signal-nopty-test", version: "0" });
  await client2.connect(clientT2);
  const list2 = JSON.parse((await client2.callTool({ name: "worker_list", arguments: {} })).content[0].text);
  const fresh2 = list2.find((w) => w.workerSessionId === "w-fresh");
  check("(no-pty router) neverCompletedTurn still computed correctly without a wired PtyHost", fresh2 && fresh2.neverCompletedTurn === true);
} finally {
  db.close();
  try { fs.rmSync(dbFile, { force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_list/worker_status now surface `neverCompletedTurn` (turnSeq===0), making a `ctxInputTokens:null` row DECIDABLE (never-completed-turn vs the genuinely anomalous turn-completed-but-unmeasured case) instead of one ambiguous null signature, on real worker rows and every placeholder row shape."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
