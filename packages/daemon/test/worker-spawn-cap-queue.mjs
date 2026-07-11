import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn CAP-QUEUED VISIBILITY MARKER test.
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven through the
// REAL manager MCP tools (worker_spawn/worker_list) over an InMemoryTransport pair (mirrors
// worker-list-pending-ops.mjs, but with the REAL SessionService — not a stub — so listCapQueuedSpawns
// is exercised for real), a FAKE pty (createPty() seam), a real temp git repo behind createWorktree.
//
// THE GAP THIS CLOSES: a worker_spawn rejected by the concurrency cap used to return a bare
// {"error":"concurrency cap reached (N)"} and record NOTHING durable — the manager had to remember to
// re-spawn later, and evidence showed a card sat un-dispatched ~150 turns because it forgot. FIX: the
// rejected intent is now recorded (CapQueueRegistry) and surfaced in worker_list as a distinct
// placeholder row, mirroring the EXISTING pendingSpawn placeholder — so the intent is never silently
// lost. This is a VISIBILITY MARKER ONLY: nothing auto-dispatches it, the manager still re-drives it
// itself by re-calling worker_spawn.
//
// Proves (Section A — integration via the real MCP tools):
//   (1) a cap-rejected TASKED worker_spawn's result carries `capQueued:{opId,taskId,queuedAt}`
//       ADDITIVELY alongside the EXISTING bare error message (byte-identical `.error` string).
//   (2) worker_list surfaces that rejected intent as a DISTINCT placeholder row: workerSessionId:null,
//       processState:"cap-queued", capQueued:{...} — and it is NEVER counted by a "live workers" /
//       "awaiting review" / "pendingSpawn" consumer (each of those filters excludes it).
//   (3) once the cap slot frees, a successful RE-spawn for the SAME taskId clears the marker — the
//       placeholder is gone from worker_list, and the newly-spawned real worker row carries NO
//       `capQueued` field (additive-only: a real worker row's shape is untouched).
//   (4) a cap-rejected TASKLESS worker_spawn also records + surfaces a marker (taskId:null), and it is
//       cleared in bulk once a taskless spawn for the SAME agentId later succeeds.
//   (5) UNDER the cap, spawn + worker_list are BYTE-IDENTICAL to today: a live worker row never grows a
//       `capQueued` field, and worker_list has no cap-queued placeholder at all.
//
// Proves (Section B — unit test of CapQueueRegistry in isolation, injectable clock):
//   (6) an entry is reaped once CAP_QUEUE_TTL_MS elapses (fast-forwarded via a fake clock — no real wait).
//   (7) the map is BOUNDED at CAP_QUEUE_MAX: recording one more evicts the OLDEST entry, never grows past it.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-cap-queue.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-wscq-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { CapQueueRegistry, CAP_QUEUE_TTL_MS, CAP_QUEUE_MAX } = await import("../dist/orchestration/cap-queue.js");

const GIT_ID = "-c user.email=wscq@loom -c user.name=wscq";
function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# wscq\n");
  execSync(`git init -q && git config user.email wscq@loom && git config user.name wscq && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

const now = new Date().toISOString();
const db = new Db();

class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
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
const client = new Client({ name: "worker-spawn-cap-queue-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (nameArgs, args) => parse(await client.callTool({ name: nameArgs, arguments: args ?? {} }));

// --- project: cap=1, so the SECOND concurrent spawn always hits the cap ---
const repo = path.join(os.tmpdir(), `loom-wscq-repo-${Date.now()}`);
initRepo(repo);
db.insertProject({ id: "pQ", name: "Q", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 1 } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pQ", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pQ", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pQ", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
const taskA = randomUUID();
const taskB = randomUUID();
db.insertTask({ id: taskA, projectId: "pQ", title: "task A", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: taskB, projectId: "pQ", title: "task B", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });

const worktrees = [];
try {
  // ===================== (1)/(2) a cap-rejected TASKED spawn records + surfaces a marker =====================
  const spawnA = await call("worker_spawn", { taskId: taskA, agentId: "agentDev", kickoffPrompt: "GO A" });
  check("(setup) taskA fills the cap (cap=1)", !!spawnA.workerSessionId);
  worktrees.push(spawnA.worktreePath);

  const rejB = await call("worker_spawn", { taskId: taskB, agentId: "agentDev", kickoffPrompt: "GO B" });
  check("(1) cap-rejected spawn keeps the EXACT pre-existing error string", rejB.error === "concurrency cap reached (1)");
  check("(1) cap-rejected spawn ADDITIVELY carries capQueued{opId,taskId,queuedAt}",
    !!rejB.capQueued && typeof rejB.capQueued.opId === "string" && rejB.capQueued.taskId === taskB && typeof rejB.capQueued.queuedAt === "string");

  let list = await call("worker_list");
  const placeholder = list.find((w) => w.processState === "cap-queued");
  check("(2) worker_list surfaces the cap-queued intent as a DISTINCT placeholder row", !!placeholder);
  check("(2) placeholder: workerSessionId:null, taskId===taskB, capQueued.opId matches the spawn result",
    placeholder && placeholder.workerSessionId === null && placeholder.taskId === taskB && placeholder.capQueued.opId === rejB.capQueued.opId);
  check("(2) placeholder: reportedState:null + awaitingReview:false (an 'awaiting review' consumer must skip it)",
    placeholder && placeholder.reportedState === null && placeholder.awaitingReview === false);
  check("(2) a 'live workers' consumer (processState==='live') excludes the placeholder",
    !list.filter((w) => w.processState === "live").some((w) => w.workerSessionId === null));
  check("(2) an 'awaiting review' consumer excludes the placeholder", !list.filter((w) => w.awaitingReview).some((w) => w.workerSessionId === null));
  check("(2) the placeholder is NOT a pendingSpawn row (distinct kind — no pendingSpawn field)", placeholder && placeholder.pendingSpawn === undefined);
  const liveA = list.find((w) => w.workerSessionId === spawnA.workerSessionId);
  check("(2) the REAL live worker row never grows a capQueued field (additive-only)", liveA && !("capQueued" in liveA));

  // ===================== (3) once the slot frees, a re-spawn for the SAME taskId clears the marker =====================
  db.setProcessState(spawnA.workerSessionId, "exited"); // deterministically free the slot (fake pty never really exits)
  const spawnB = await call("worker_spawn", { taskId: taskB, agentId: "agentDev", kickoffPrompt: "GO B AGAIN" });
  check("(3) the re-spawn for taskB now succeeds (cap slot freed)", !!spawnB.workerSessionId && spawnB.workerSessionId !== spawnA.workerSessionId);
  worktrees.push(spawnB.worktreePath);
  list = await call("worker_list");
  check("(3) the cap-queued placeholder for taskB is GONE from worker_list (cleared on successful re-spawn)",
    !list.some((w) => w.processState === "cap-queued"));
  const liveB = list.find((w) => w.workerSessionId === spawnB.workerSessionId);
  check("(3) the newly-spawned real worker row carries no capQueued field either", liveB && !("capQueued" in liveB));

  // ===================== (4) a cap-rejected TASKLESS spawn also records/surfaces + bulk-clears =====================
  db.setProcessState(spawnB.workerSessionId, "exited"); // free the slot taskB's re-spawn was holding
  const spike = await call("worker_spawn", { agentId: "agentDev", kickoffPrompt: "a taskless spike, no card" });
  check("(4 setup) the taskless spike fills the cap (cap=1)", !!spike.workerSessionId);
  worktrees.push(spike.worktreePath);

  const rejSpike2 = await call("worker_spawn", { agentId: "agentDev", kickoffPrompt: "a SECOND taskless spike, rejected" });
  check("(4) a cap-rejected TASKLESS spawn also carries capQueued with taskId:null",
    rejSpike2.error === "concurrency cap reached (1)" && !!rejSpike2.capQueued && rejSpike2.capQueued.taskId === null);
  list = await call("worker_list");
  check("(4) worker_list surfaces the taskless cap-queued placeholder (taskId:null)",
    list.some((w) => w.processState === "cap-queued" && w.taskId === null));

  db.setProcessState(spike.workerSessionId, "exited"); // free the slot again
  const spike2 = await call("worker_spawn", { agentId: "agentDev", kickoffPrompt: "the taskless retry, now succeeds" });
  check("(4) the taskless retry for the SAME agentId now succeeds", !!spike2.workerSessionId);
  worktrees.push(spike2.worktreePath);
  list = await call("worker_list");
  check("(4) the taskless cap-queued placeholder is cleared (bulk-cleared on a successful taskless spawn by the same agentId)",
    !list.some((w) => w.processState === "cap-queued"));

  // ===================== (5) UNDER the cap: spawn + worker_list are byte-identical to today =====================
  db.setProcessState(spike2.workerSessionId, "exited"); // free the slot so this project sits at 0/1
  const under = await call("worker_spawn", { taskId: taskA, agentId: "agentDev", kickoffPrompt: "GO A again, well under cap" });
  check("(5) a normal under-cap spawn succeeds with the EXACT pre-existing shape (no capQueued key at all)",
    !!under.workerSessionId && !("capQueued" in under));
  worktrees.push(under.worktreePath);
  list = await call("worker_list");
  check("(5) worker_list under the cap has NO cap-queued placeholder row", !list.some((w) => w.processState === "cap-queued"));
  const underRow = list.find((w) => w.workerSessionId === under.workerSessionId);
  check("(5) the live worker row itself carries no capQueued field", underRow && !("capQueued" in underRow));
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [...new Set(worktrees.filter(Boolean))]) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ===================== Section B: CapQueueRegistry unit tests (injectable clock, no real wait) =====================
{
  let fakeNow = 1_000_000;
  const reg = new CapQueueRegistry(() => fakeNow);
  const e1 = reg.record("mgrX", "agentX", "taskTTL", "kickoff");
  check("(6 setup) a freshly-recorded entry is listed", reg.listByManager("mgrX").some((e) => e.opId === e1.opId));
  fakeNow += CAP_QUEUE_TTL_MS - 1;
  check("(6) an entry just under the TTL is STILL listed", reg.listByManager("mgrX").some((e) => e.opId === e1.opId));
  fakeNow += 2; // now past CAP_QUEUE_TTL_MS since queuedAt
  check("(6) an entry past the TTL is REAPED (no longer listed)", !reg.listByManager("mgrX").some((e) => e.opId === e1.opId));

  // (7) bounded at CAP_QUEUE_MAX — recording one more evicts the OLDEST.
  const reg2 = new CapQueueRegistry(() => fakeNow);
  const ids = [];
  for (let i = 0; i < CAP_QUEUE_MAX; i++) {
    fakeNow += 1;
    ids.push(reg2.record("mgrY", "agentY", `t${i}`, "kickoff").taskId);
  }
  check(`(7 setup) exactly ${CAP_QUEUE_MAX} entries recorded`, reg2.listByManager("mgrY").length === CAP_QUEUE_MAX);
  fakeNow += 1;
  reg2.record("mgrY", "agentY", "tOverflow", "kickoff");
  const after = reg2.listByManager("mgrY");
  check(`(7) the map NEVER grows past CAP_QUEUE_MAX`, after.length === CAP_QUEUE_MAX);
  check("(7) the OLDEST entry (t0) was evicted to make room", !after.some((e) => e.taskId === "t0"));
  check("(7) the newest entry (tOverflow) is present", after.some((e) => e.taskId === "tOverflow"));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a cap-rejected worker_spawn (tasked or taskless) records + surfaces a bounded, TTL-reaped, additive-only cap-queued marker in worker_list, distinct from a live/pendingSpawn/awaiting-review row, cleared on a successful re-spawn, and completely invisible under the cap — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
