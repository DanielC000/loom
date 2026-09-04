import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn/worker_list LIVE CAPACITY test (card 548a0c7e).
//
// THE DEFECT THIS CLOSES: a manager's worker concurrency cap was observable ONLY by failing —
// worker_spawn succeeded silently with no capacity info, worker_list exposed neither the cap nor a
// free-slot count, and the only place the number reached an agent was the CapQueueRejectedError message
// ("concurrency cap reached (N)"). Managers were deliberately provoking that error to read config, and
// hand-transcribing the value into resume docs across handoffs — where it went stale. Two recorded
// incidents: a manager reasoned from the DOCUMENTED DEFAULT (3) while an OVERRIDE (4) was in force and
// under-filled the fleet, and a second correction for idling a free slot.
//
// DETERMINISTIC + CLAUDE-FREE, hermetic: mirrors worker-spawn-cap-queue.mjs's own harness (a REAL Db +
// SessionService driven through the REAL manager MCP tools over an InMemoryTransport pair, a FAKE pty via
// the createPty() seam, a real temp git repo behind createWorktree).
//
// Proves:
//   (1) a successful worker_spawn's result carries `capacity:{cap,live,inFlight,free}` — `cap` is the
//       RESOLVED (override, not platform-default) maxConcurrentWorkers; `live`/`free` update correctly
//       across successive spawns up to the cap.
//   (2) a cap-rejected spawn's error message is BYTE-IDENTICAL to before (CapQueueRejectedError untouched).
//   (3) worker_list's rows (real worker AND cap-queued placeholder alike) carry the SAME `capacity`
//       object, matching what the most recent worker_spawn reported.
//   (4) once a worker retires (frees a slot) with NO new spawn, worker_list's `capacity.free` reflects
//       the freed slot on its own — a manager can tell "I have room" WITHOUT provoking a spawn/rejection.
//   (5) a hermetic MCP router wired with a plain stub `sessions` object (no getWorkerCapacity method —
//       the shape most of this test suite's OTHER hermetic tests already use) never throws; worker_list
//       still returns rows, with a defensive all-zero capacity rather than crashing.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-capacity.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (set BEFORE importing dist — paths.ts reads it at import time) ---
const tmpHome = path.join(os.tmpdir(), `loom-wcap-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

const GIT_ID = "-c user.email=wcap@loom -c user.name=wcap";
function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# wcap\n");
  execSync(`git init -q && git config user.email wcap@loom && git config user.name wcap`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

const now = new Date().toISOString();
const db = new Db();

// mirrors worker-spawn-cap-queue.mjs's own SeamHost — onExit CAPTURES its callback (never discards it),
// even though this test drives worker exit directly via db.setProcessState rather than kill(); a fake pty
// whose onExit can't receive a callback at all is the exact shape onexit-discard-guard.mjs polices.
class SeamHost extends PtyHost {
  createPty() {
    let exitCb = null;
    return {
      pid: 4242, write() {}, onData() { return { dispose() {} }; },
      onExit(cb) { exitCb = cb; return { dispose() {} }; },
      kill() { if (exitCb) setTimeout(() => exitCb({ exitCode: 0 }), 0); },
      resize() {},
    };
  }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const router = new OrchestrationMcpRouter(db, svc);
const server = router.buildServer("mgr1", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "worker-capacity-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} }));

// --- project: maxConcurrentWorkers OVERRIDDEN to 2 — deliberately different from the platform's
// documented default (3), mirroring the exact incident the card records. ---
const repo = path.join(os.tmpdir(), `loom-wcap-repo-${Date.now()}-${process.pid}`);
initRepo(repo);
db.insertProject({ id: "pCap", name: "Cap", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 2 } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pCap", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pCap", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pCap", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
const taskA = randomUUID();
const taskB = randomUUID();
const taskC = randomUUID();
db.insertTask({ id: taskA, projectId: "pCap", title: "task A", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: taskB, projectId: "pCap", title: "task B", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: taskC, projectId: "pCap", title: "task C", body: "", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });

const worktrees = [];
try {
  // ===================== (1) first spawn: cap=2 (the RESOLVED override, not the documented default 3) =====================
  const spawnA = await call("worker_spawn", { taskId: taskA, agentId: "agentDev", kickoffPrompt: "GO A" });
  check("(setup) spawnA succeeds", !!spawnA.workerSessionId);
  worktrees.push(spawnA.worktreePath);
  check("(1) spawnA's result carries capacity", !!spawnA.capacity);
  check("(1) RED-PROVEN: cap is the RESOLVED override (2), never the platform's documented default (3)", spawnA.capacity?.cap === 2);
  check("(1) live counts spawnA itself (already live by the time the response is built)", spawnA.capacity?.live === 1);
  check("(1) inFlight excludes spawnA's OWN claim (it already resolved into `live`)", spawnA.capacity?.inFlight === 0);
  check("(1) free is cap(2) - live(1) - inFlight(0) = 1", spawnA.capacity?.free === 1);

  // ===================== (1b) second spawn: fills the cap exactly =====================
  const spawnB = await call("worker_spawn", { taskId: taskB, agentId: "agentDev", kickoffPrompt: "GO B" });
  check("(1b) spawnB succeeds", !!spawnB.workerSessionId);
  worktrees.push(spawnB.worktreePath);
  check("(1b) live now counts BOTH live workers", spawnB.capacity?.live === 2);
  check("(1b) free is now 0 — the fleet is FULL", spawnB.capacity?.free === 0);
  check("(1b) cap is unchanged (2)", spawnB.capacity?.cap === 2);

  // ===================== (2) a cap-rejected THIRD spawn keeps CapQueueRejectedError's message unchanged =====================
  const rejC = await call("worker_spawn", { taskId: taskC, agentId: "agentDev", kickoffPrompt: "GO C" });
  check("(2) cap-rejected spawn keeps the EXACT pre-548a0c7e error string (CapQueueRejectedError untouched)", rejC.error === "concurrency cap reached (2)");
  check("(2) a rejected spawn's result carries NO capacity field (only a SUCCESS response does)", !("capacity" in rejC));
  check("(2) the rejected spawn still records the existing capQueued marker (untouched)", !!rejC.capQueued && rejC.capQueued.taskId === taskC);

  // ===================== (3) worker_list: every row (real + placeholder) carries the SAME capacity =====================
  const list = await call("worker_list");
  check("(3) worker_list stays a bare array (no {workers,...} wrapper — mirrors worker-list-pending-ops.mjs's own pin)", Array.isArray(list));
  const rowA = list.find((w) => w.workerSessionId === spawnA.workerSessionId);
  const rowB = list.find((w) => w.workerSessionId === spawnB.workerSessionId);
  const placeholder = list.find((w) => w.processState === "cap-queued");
  check("(3) the real worker row for A carries capacity", !!rowA?.capacity);
  check("(3) the real worker row for B carries the SAME capacity as A", JSON.stringify(rowB?.capacity) === JSON.stringify(rowA?.capacity));
  check("(3) the cap-queued placeholder row ALSO carries the SAME capacity (additive on every row, not just live ones)",
    !!placeholder && JSON.stringify(placeholder.capacity) === JSON.stringify(rowA?.capacity));
  check("(3) worker_list's capacity matches what worker_spawn's OWN most recent success response reported", rowA?.capacity?.cap === 2 && rowA?.capacity?.live === 2 && rowA?.capacity?.free === 0);

  // ===================== (4) a worker retires (frees a slot) — worker_list reflects it with NO new spawn =====================
  // This is the case the card names as the higher-value half: a manager deciding whether to dispatch
  // again must NOT have to provoke a worker_spawn (success or failure) just to learn a slot freed.
  db.setProcessState(spawnA.workerSessionId, "exited");
  const listAfterFree = await call("worker_list");
  const anyRowAfterFree = listAfterFree.find((w) => w.workerSessionId === spawnB.workerSessionId);
  check("(4) worker_list's capacity.free reflects the freed slot with NO new worker_spawn call", anyRowAfterFree?.capacity?.free === 1);
  check("(4) live now counts only the ONE still-live worker (B)", anyRowAfterFree?.capacity?.live === 1);
  check("(4) cap is still the resolved override (2)", anyRowAfterFree?.capacity?.cap === 2);
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [...new Set(worktrees.filter(Boolean))]) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ===================== (5) a stub `sessions` (no getWorkerCapacity) never throws — the SAME defensive
// posture the rest of this file's own suite already relies on for `pty?.` (a 3-arg/no-pty router still
// works) =====================
{
  const dbFile2 = path.join(os.tmpdir(), `loom-wcap-stub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db2 = new Db(dbFile2);
  const now2 = new Date().toISOString();
  db2.insertProject({ id: "pStub", name: "Stub", repoPath: "pStub", vaultPath: "pStub", config: {}, createdAt: now2, archivedAt: null });
  db2.insertAgent({ id: "agentStub", projectId: "pStub", name: "t", startupPrompt: "orchestrate", position: 0 });
  db2.insertSession({ id: "mgrStub", projectId: "pStub", agentId: "agentStub", engineSessionId: "eng-mgrStub", title: null, cwd: "pStub", processState: "live", resumability: "resumable", busy: false, createdAt: now2, lastActivity: now2, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });
  db2.insertSession({ id: "wStub", projectId: "pStub", agentId: "agentStub", engineSessionId: "eng-wStub", title: null, cwd: "pStub", processState: "live", resumability: "unknown", busy: false, createdAt: now2, lastActivity: now2, lastError: null, role: "worker", parentSessionId: "mgrStub", taskId: null });
  const sessionsStub = {
    peekPendingMerge() { return undefined; },
    listPendingSpawns() { return []; },
    listCapQueuedSpawns() { return []; },
    isArchivedWithoutReport() { return false; },
    async getDanglingWorkers() { return []; },
    // deliberately NO getWorkerCapacity — the exact shape this test suite's OTHER hermetic stubs already use
  };
  const router2 = new OrchestrationMcpRouter(db2, /** @type {any} */ (sessionsStub));
  const server2 = router2.buildServer("mgrStub", "manager");
  const [clientT2, serverT2] = InMemoryTransport.createLinkedPair();
  await server2.connect(serverT2);
  const client2 = new Client({ name: "worker-capacity-stub-test", version: "0" });
  await client2.connect(clientT2);
  const list2 = JSON.parse((await client2.callTool({ name: "worker_list", arguments: {} })).content[0].text);
  check("(5) a stub sessions object with no getWorkerCapacity does NOT throw — worker_list still returns rows", Array.isArray(list2) && list2.length === 1);
  check("(5) the row carries a DEFENSIVE all-zero capacity rather than crashing or omitting the field", JSON.stringify(list2[0].capacity) === JSON.stringify({ cap: 0, live: 0, inFlight: 0, free: 0 }));
  db2.close();
  try { fs.rmSync(dbFile2, { force: true }); } catch { /* best-effort */ }
}

db.close(); // free the WAL handle before removing the temp dir (Windows)
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_spawn's success response and every worker_list row carry the SAME live {cap,live,inFlight,free} capacity snapshot (the RESOLVED override, never the documented default), a cap-rejected spawn's error message is untouched, a retired worker's freed slot is visible with no new spawn call, and a stub sessions object with no getWorkerCapacity degrades to a defensive all-zero read instead of throwing."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
