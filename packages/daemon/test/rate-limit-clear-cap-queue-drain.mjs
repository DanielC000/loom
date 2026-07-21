import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Cap-queue drain on usage-limit CLEAR (card 902d089f — CR Minor #3 follow-up on 81b7e346/squash ea61b16).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService + CapQueueRegistry
// driven through the REAL manager MCP tools (worker_spawn/worker_list) over an InMemoryTransport pair, a
// FAKE pty (createPty() seam, mirrors worker-spawn-cap-queue.mjs), a real temp git repo behind
// createWorktree, and a REAL RateLimitWatcher wired with the real SessionService as its new `capQueue` dep.
//
// THE GAP THIS CLOSES: maybeDrainCapQueue's UsageLimitError branch (81b7e346) requeues the popped entry
// at the FRONT and stops, because the manager itself just parked on a usage cap — but nothing then
// re-drained that manager's queue when the cap actually cleared. The requeued entry sat idle until some
// UNRELATED worker happened to exit and trigger the onExit-driven drain. FIX: RateLimitWatcher.resume()
// AND the per-session `POST /api/sessions/:id/rate-limit/clear` REST route (both DIRECTLY exercised
// below) now fire `sessions.maybeDrainCapQueue` for the RESUMED session when it's a manager, closing the
// hole without touching any existing slot-free drain path. The THIRD call site, the global
// `POST /api/usage/clear-hold` cascade, is NOT independently covered here — it's a 1-line mirror of the
// exact same `resumed && role === "manager"` guard the per-session route below proves, applied inside its
// pre-existing loop over `db.listRateLimited()`. (rate-limit-clear.mjs's Part B calls that route too, but
// with nothing parked at that point in its own test — the loop body, and so this new call, never runs
// there; it isn't cap-queue coverage.)
//
// Proves:
//   (1) a cap-queued entry popped during a slot-free drain that hits UsageLimitError (the account is
//       near its usage cap) is requeued at the front, NOT dropped or fired — AND the manager itself gets
//       parked (rateLimitedUntil + rateLimitDeadline armed), mirroring worker_spawn's own usage-limit park.
//   (2) once the RateLimitWatcher resumes that manager (tick() driven past rateLimitedUntil but before
//       rateLimitDeadline — no real waiting), the requeued entry AUTO-FIRES — with NO unrelated worker
//       exit anywhere in the test after the park.
//   (3) CAUSATION: exactly one `maybeDrainCapQueue` call happens after the park, and a spy installed
//       right after the park (so it only observes calls made from here on) proves it came from the
//       watcher's own resume() hook, not an incidental second call this test made itself.
//   (4) a NON-manager session's watcher-driven resume never touches the cap-queue at all (no drain call).
//   (5) zero behavior change: an ORDINARY slot-free drain (no usage limit involved) still auto-fires the
//       next queued entry exactly as before 902d089f.
//   (6) the per-session REST clear route (`POST /api/sessions/:id/rate-limit/clear`), driven through the
//       REAL Fastify gateway (app.inject) with the REAL SessionService as its `sessions` dep, ALSO
//       auto-fires a requeued entry on a parked manager — with the same causation proof as (2)/(3).
//   (7) negative guards on that REST route: a resumed NON-manager never drains (7a), and a manager that
//       `pty.resumeAfterRateLimit` reports as NOT actually resumed (`resumed:false`) never drains either
//       (7b) — proving both the `role === "manager"` AND the `resumed &&` guards are load-bearing, not
//       redundant.
//
// Run: 1) build (turbo builds shared first), 2) node test/rate-limit-clear-cap-queue-drain.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, { tries = 50, delayMs = 20 } = {}) => {
  for (let i = 0; i < tries; i++) { if (await fn()) return true; await sleep(delayMs); }
  return false;
};

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-rlcqd-${Date.now()}-${process.pid}`);
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
const { RateLimitWatcher } = await import("../dist/orchestration/rate-limit-watcher.js");
const { recordClaudeRateLimit, clearClaudeRateLimit } = await import("../dist/orchestration/usage-awareness.js");

const GIT_ID = "-c user.email=rlcqd@loom -c user.name=rlcqd";
function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# rlcqd\n");
  execSync(`git init -q && git config user.email rlcqd@loom && git config user.name rlcqd && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

const now = new Date().toISOString();
const db = new Db();

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
const control = new OrchestrationControl();
const svc = new SessionService(db, host, control);

const router = new OrchestrationMcpRouter(db, svc);
const server = router.buildServer("mgr1", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "rate-limit-clear-cap-queue-drain-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (nameArgs, args) => parse(await client.callTool({ name: nameArgs, arguments: args ?? {} }));

// Widen the gap between the resume-at (rateLimitedUntil) and the give-up deadline (rateLimitDeadline) so
// RateLimitWatcher.tick() has real room to land BETWEEN them without any real waiting — by DEFAULT both
// derive from the SAME 6h constant off the SAME instant and land within ms of each other.
db.setPlatformConfig({ rateLimit: { recencyWindowMs: 10 * 60_000 } }); // park ~10min out; deadline stays default ~6h

const repo = path.join(os.tmpdir(), `loom-rlcqd-repo-${Date.now()}`);
initRepo(repo);
db.insertProject({ id: "pR", name: "R", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 1 } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgrR", projectId: "pR", name: "MgrR", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDevR", projectId: "pR", name: "DevR", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pR", agentId: "agentMgrR", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
const taskA = randomUUID();
const taskB = randomUUID();
db.insertTask({ id: taskA, projectId: "pR", title: "task A", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: taskB, projectId: "pR", title: "task B", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });

const worktrees = [];
try {
  // ===================== (setup) fill the cap, queue a second entry behind it =====================
  const spawnA = await call("worker_spawn", { taskId: taskA, agentId: "agentDevR", kickoffPrompt: "GO A" });
  check("(setup) taskA fills the cap (cap=1)", !!spawnA.workerSessionId);
  worktrees.push(spawnA.worktreePath);

  const rejB = await call("worker_spawn", { taskId: taskB, agentId: "agentDevR", kickoffPrompt: "GO B" });
  check("(setup) taskB is cap-queued", !!rejB.capQueued);

  // ===================== (1) slot frees WHILE the account is near its usage cap =====================
  // Mirrors the real CR-found scenario: the drain pops taskB, spawnWorker's usage-limit check fires
  // BEFORE the cap-admit check (so it fires even though the cap slot IS free), throws UsageLimitError,
  // maybeDrainCapQueue's catch requeues taskB at the front and stops — AND spawnWorker itself parks the
  // manager on the SAME usage-limit machinery worker_spawn uses.
  recordClaudeRateLimit();
  db.setProcessState(spawnA.workerSessionId, "exited");
  db.setBusy(spawnA.workerSessionId, false);
  await svc.maybeDrainCapQueue("mgr1");

  let list = await call("worker_list");
  check("(1) taskB is STILL cap-queued after the usage-limit requeue (not dropped, not fired)",
    list.some((w) => w.processState === "cap-queued" && w.taskId === taskB));
  const mgrParked = db.getSession("mgr1");
  check("(1) the manager itself got parked on the usage cap (rateLimitedUntil set)", !!mgrParked.rateLimitedUntil);
  check("(1) the manager's recovery episode deadline is armed too", !!mgrParked.rateLimitDeadline);
  check("(1) the resume-at is well before the give-up deadline (room for the tick below)",
    new Date(mgrParked.rateLimitedUntil).getTime() < new Date(mgrParked.rateLimitDeadline).getTime());

  // ===================== (2)/(3) the watcher's resume auto-fires the requeued entry — no other exit =====================
  const watcherResumedIds = [];
  const watcherPty = { isAlive: () => true, resumeAfterRateLimit: (id) => { watcherResumedIds.push(id); return true; } };
  const watcher = new RateLimitWatcher({ db, pty: watcherPty, capQueue: svc });

  // Spy installed AFTER the park above, so it only observes calls from here on — proving the fire below
  // is caused by the watcher's own resume() hook, not a second call this test made itself.
  let drainSpyCalls = 0;
  const realDrain = svc.maybeDrainCapQueue.bind(svc);
  svc.maybeDrainCapQueue = (id) => { drainSpyCalls++; return realDrain(id); };

  clearClaudeRateLimit(); // the account-wide usage limit clears
  // Fast-forward the watcher's clock PAST rateLimitedUntil but BEFORE rateLimitDeadline — no real wait.
  const tickNow = new Date(new Date(mgrParked.rateLimitedUntil).getTime() + 1000);
  watcher.tick(tickNow);

  check("(2) the watcher resumed the manager's held turn (pty.resumeAfterRateLimit called)",
    watcherResumedIds.includes("mgr1"));

  const fired = await waitUntil(async () => (await call("worker_list")).some((w) => w.taskId === taskB && w.processState === "live"));
  check("(2) taskB auto-fires on the limit-clear alone — NO unrelated worker exit happened after the park", fired);
  check("(3) exactly ONE cap-queue drain call happened after the park — caused by the watcher's resume hook",
    drainSpyCalls === 1);

  list = await call("worker_list");
  const liveB = list.find((w) => w.taskId === taskB && w.processState === "live");
  if (liveB) worktrees.push(db.getSession(liveB.workerSessionId)?.worktreePath);
  check("(2) no cap-queued placeholder remains", !list.some((w) => w.processState === "cap-queued"));
  // spawnWorker flips processState:"live" BEFORE it's fully done (M5 ordering — a still-outstanding
  // `await findShippedCardMatch` git check runs after, only THEN releasing the in-flight taskId claim).
  // Wait for it to fully settle before section (5) below drains again, or that drain could spuriously
  // cap-race against this call's still-open claim (mirrors worker-spawn-cap-queue.mjs's (19b)).
  const settled = await waitUntil(() => svc.inFlightSpawnTaskIds.size === 0);
  check("(2b) the auto-fired spawn fully unwinds (releases its in-flight claim) before continuing", settled);

  // ===================== (4) a NON-manager resume never touches the cap-queue =====================
  db.insertSession({ id: "wNonMgr", projectId: "pR", agentId: "agentDevR", engineSessionId: null, title: null,
    cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker" });
  db.setRateLimitedUntil("wNonMgr", new Date(Date.now() - 1000).toISOString(), "test park");
  db.armRateLimitDeadline("wNonMgr", new Date(Date.now() + 60 * 60_000).toISOString());
  const drainCallsBeforeNonMgr = drainSpyCalls;
  watcher.tick(new Date());
  check("(4) a non-manager session's resume fires pty.resumeAfterRateLimit too", watcherResumedIds.includes("wNonMgr"));
  check("(4) but it never calls maybeDrainCapQueue (guarded to role==='manager')", drainSpyCalls === drainCallsBeforeNonMgr);

  // ===================== (5) zero behavior change: an ORDINARY slot-free drain is untouched =====================
  const taskC = randomUUID();
  db.insertTask({ id: taskC, projectId: "pR", title: "task C", body: "", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });
  const rejC = await call("worker_spawn", { taskId: taskC, agentId: "agentDevR", kickoffPrompt: "GO C" });
  check("(5 setup) taskC is cap-queued (cap full again, taskB's worker live)", !!rejC.capQueued && !!liveB);
  db.setProcessState(liveB.workerSessionId, "exited");
  db.setBusy(liveB.workerSessionId, false);
  await svc.maybeDrainCapQueue("mgr1"); // the EXISTING slot-free path — no usage limit involved this time
  list = await call("worker_list");
  const liveC = list.find((w) => w.taskId === taskC && w.processState === "live");
  check("(5) an ordinary slot-free drain still fires the next queued entry, exactly as before 902d089f", !!liveC);
  if (liveC) worktrees.push(db.getSession(liveC.workerSessionId)?.worktreePath);

  // ===================== (6) the per-session REST clear route ALSO drains — causation proof =====================
  // DIRECTLY exercises `POST /api/sessions/:id/rate-limit/clear` through the real Fastify gateway
  // (app.inject — no port bound), with the REAL SessionService as its `sessions` dep (the real cap-queue
  // registry this test has been building against all along) and a small stub `pty` that controls
  // resumeAfterRateLimit's return value deterministically (mirrors rate-limit-clear.mjs's own stub pty).
  const { buildServer } = await import("../dist/gateway/server.js");

  const taskD = randomUUID();
  db.insertTask({ id: taskD, projectId: "pR", title: "task D", body: "", columnKey: "backlog", position: 4, priority: "p2", createdAt: now, updatedAt: now });
  const rejD = await call("worker_spawn", { taskId: taskD, agentId: "agentDevR", kickoffPrompt: "GO D" });
  check("(6 setup) taskD is cap-queued (cap full again, taskC's worker live)", !!rejD.capQueued && !!liveC);

  // Free the slot WHILE the account is near its usage cap — the SAME requeue-and-park technique as (1),
  // driven again so a FRESH park exists for the REST route (not the watcher) to resume.
  recordClaudeRateLimit();
  db.setProcessState(liveC.workerSessionId, "exited");
  db.setBusy(liveC.workerSessionId, false);
  await svc.maybeDrainCapQueue("mgr1");
  clearClaudeRateLimit();

  let listPreRest = await call("worker_list");
  check("(6) taskD is STILL cap-queued after the usage-limit requeue", listPreRest.some((w) => w.processState === "cap-queued" && w.taskId === taskD));
  const mgrParked2 = db.getSession("mgr1");
  check("(6) the manager is parked again (rateLimitedUntil set)", !!mgrParked2.rateLimitedUntil);

  const restResumed = [];
  const restPty = { isAlive: () => true, resumeAfterRateLimit: (id) => { restResumed.push(id); return true; } };
  const restStub = {};
  const app = await buildServer({ db, pty: restPty, sessions: svc, mcp: restStub, orchMcp: restStub, platformMcp: restStub, control: restStub, usageStatus: restStub });

  // A FRESH spy (the (2)/(3) spy above already has calls recorded against it) — installed right before
  // the REST call, so it only observes calls made from here on.
  let restDrainCalls = 0;
  const realDrain2 = svc.maybeDrainCapQueue.bind(svc);
  svc.maybeDrainCapQueue = (id) => { restDrainCalls++; return realDrain2(id); };

  try {
    const r = await app.inject({ method: "POST", url: "/api/sessions/mgr1/rate-limit/clear" });
    check("(6) REST clear 200 OK", r.statusCode === 200);
    check("(6) REST clear resumed the manager (pty.resumeAfterRateLimit called)", restResumed.includes("mgr1"));

    const firedD = await waitUntil(async () => (await call("worker_list")).some((w) => w.taskId === taskD && w.processState === "live"));
    check("(6) taskD auto-fires from the REST clear alone — no unrelated worker exit involved", firedD);
    check("(6) causation: exactly ONE cap-queue drain call happened, from the REST route's own hook", restDrainCalls === 1);

    let listPostRest = await call("worker_list");
    const liveD = listPostRest.find((w) => w.taskId === taskD && w.processState === "live");
    if (liveD) worktrees.push(db.getSession(liveD.workerSessionId)?.worktreePath);
    check("(6) no cap-queued placeholder remains", !listPostRest.some((w) => w.processState === "cap-queued"));
    await waitUntil(() => svc.inFlightSpawnTaskIds.size === 0); // let the async spawn fully settle (mirrors (2b))

    // ===================== (7a) a resumed NON-manager never drains via the REST route =====================
    db.insertSession({ id: "wNonMgr2", projectId: "pR", agentId: "agentDevR", engineSessionId: null, title: null,
      cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker" });
    const drainBefore7a = restDrainCalls;
    const r7a = await app.inject({ method: "POST", url: "/api/sessions/wNonMgr2/rate-limit/clear" });
    check("(7a) REST clear on a non-manager still 200s", r7a.statusCode === 200);
    check("(7a) but never calls maybeDrainCapQueue (guarded to role==='manager')", restDrainCalls === drainBefore7a);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
  }

  // ===================== (7b) a manager that ISN'T actually resumed never drains either =====================
  // `resumeAfterRateLimit` reporting `resumed:false` (e.g. the session isn't live) must skip the drain —
  // proves the `resumed &&` guard is load-bearing, not redundant with the role guard.
  const notLivePty = { isAlive: () => false, resumeAfterRateLimit: () => false };
  const app2 = await buildServer({ db, pty: notLivePty, sessions: svc, mcp: restStub, orchMcp: restStub, platformMcp: restStub, control: restStub, usageStatus: restStub });
  try {
    const drainBefore7b = restDrainCalls;
    const r7b = await app2.inject({ method: "POST", url: "/api/sessions/mgr1/rate-limit/clear" });
    check("(7b) REST clear 200s even when resumeAfterRateLimit reports resumed:false", r7b.statusCode === 200);
    check("(7b) but never calls maybeDrainCapQueue when resumed===false (guarded by `resumed &&`)", restDrainCalls === drainBefore7b);
  } finally {
    try { await app2.close(); } catch { /* ignore */ }
  }
} finally {
  clearClaudeRateLimit();
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [...new Set(worktrees.filter(Boolean))]) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a cap-queue entry requeued on a manager's usage-limit park auto-fires the instant either RateLimitWatcher OR the per-session REST clear route resumes that manager (no unrelated worker exit needed), a non-manager resume (watcher or REST) never touches the cap-queue, a REST resume:false no-op never drains either, and the existing slot-free drain path is unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
