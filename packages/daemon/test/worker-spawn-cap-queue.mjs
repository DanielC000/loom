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
//  (14) takeOldest() pops FIFO and carries the FULL kickoffPrompt (not just the display-only kickoffLabel).
//  (15) requeueFront() restores a popped entry to the FRONT of the queue (ahead of a newer entry).
//  (16) cancel() is ownership-scoped (a different manager's opId is refused) and a repeat cancel is a safe no-op.
//
// Proves (Section C — card 81b7e346, the REAL queue: auto-fire on slot-free + cancellation):
//   (8) once a concurrency slot frees, the OLDEST queued entry auto-fires with NO second worker_spawn
//       call — AND with the FULL original kickoff prompt (never the 120-char-truncated display label).
//   (9) FIFO: two entries queued behind one full slot; freeing it fires the OLDER one, the younger stays queued.
//  (10) two concurrent maybeDrainCapQueue calls for the same manager never double-dispatch one queued entry.
//  (11) an auto-fire that itself fails (its task went HELD) is dropped (with the manager actually notified —
//       [loom:cap-queue-autofire-failed] naming the opId/task/agent), NOT retried forever, and the drain
//       continues on to fire the NEXT queued entry in the same pass.
//  (12) worker_stop({opId}) withdraws a queued entry before it fires; re-cancelling it is a safe no-op
//       ({cancelled:false}), and freeing the slot afterward never resurrects it.
//  (13) a manager-paused cap-queue is left completely untouched by a drain (neither dropped nor fired) —
//       the killAllWorkers hazard found while tracing this — and resumes firing once unpaused.
//  (17) a cap-race on the drain (spawnWorker cap-rejects a re-call FROM the drain) preserves the popped
//       entry's ORIGINAL opId and FIFO front position via requeueFront — NOT a fresh record() at the back,
//       which would silently invalidate a worker_stop({opId}) a caller already holds for it.
//
// Proves (Section D — Code Review follow-up: recycleWorker's drain-suppression guard, own project/manager):
//  (18) a queued entry stays queued THROUGH a recycle's predecessor-exit-to-successor-insert window even
//       when an UNRELATED sibling worker frees a slot mid-recycle (suppression is manager-wide) — no overshoot.
//  (19) it fires from the finally's fire-and-forget catch-up drain once the swap settles, claiming the
//       leftover headroom the unrelated worker's exit left behind; no overshoot the other way either.
//  (20)-(22) the suppression is REFCOUNTED, not a boolean: two overlapping recycles both hold it, ONE
//       unsuppress leaves it still held, and only the SECOND drops it to 0 and lets the drain proceed.
//  (23)/(24) worker_stop's neither-arg and both-arg (workerSessionId + opId) validation branches.
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
// Bounded poll for a DETACHED fire-and-forget async op (e.g. recycleWorker's own `void
// this.maybeDrainCapQueue(...)` catch-up call in its finally, which — correctly, per its own doc —
// completes AFTER recycleWorker's returned promise itself resolves). No real op in this suite takes
// anywhere near this long; the bound is a safety net against a genuine hang, not a tuned timing budget.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, { tries = 50, delayMs = 20 } = {}) => {
  for (let i = 0; i < tries; i++) { if (await fn()) return true; await sleep(delayMs); }
  return false;
};

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
  spawnedPrompts = new Map(); // sessionId -> the FULL startupPrompt handed to spawn() — for the full-kickoff assertion (8)
  enqueueLog = []; // {sessionId, text} for every enqueueStdin call — for the autofire-failure notification assertion
  createPty() {
    let exitCb = null;
    return {
      pid: 4242, write() {}, onData() { return { dispose() {} }; },
      onExit(cb) { exitCb = cb; return { dispose() {} }; },
      // A REAL node-pty fires onExit ASYNCHRONOUSLY — mirror that (not a synchronous call) so
      // recycleWorker's own `isAlive` poll observes a genuine async transition, exactly as it must
      // against the real daemon, instead of a same-tick sync flip that model bugs wouldn't reproduce.
      kill() { if (exitCb) setTimeout(() => exitCb({ exitCode: 0 }), 0); },
      resize() {},
    };
  }
  spawn(opts) { this.spawnedPrompts.set(opts.sessionId, opts.startupPrompt); return super.spawn(opts); }
  enqueueStdin(sessionId, text, ...rest) { this.enqueueLog.push({ sessionId, text }); return super.enqueueStdin(sessionId, text, ...rest); }
}
// lastDrainPromise: the fake pty (above) never actually fires its registered onExit callback on kill(), so
// this harness — like index.ts — treats `onExit` as the terminal-exit signal a test can simulate directly.
// Mirrors index.ts's real onExit hook (card 81b7e346): after retiring the row, auto-drain that worker's
// manager's cap-queue. Captured (not `void`-discarded, unlike production) so a test can `await` the SAME
// drain the exit just kicked off, deterministically, instead of racing a fire-and-forget promise.
let lastDrainPromise = Promise.resolve();
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) {
    db.setProcessState(id, "exited");
    db.setBusy(id, false);
    const exited = db.getSession(id);
    lastDrainPromise = (exited && exited.role === "worker" && exited.parentSessionId)
      ? svc.maybeDrainCapQueue(exited.parentSessionId)
      : Promise.resolve();
  },
};
const host = new SeamHost(events);
const control = new OrchestrationControl(); // retained so Section C can pause/resume a manager directly
const svc = new SessionService(db, host, control);

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
  // NOTE: db/svc/host are SHARED with Section C below (the auto-drain needs the real SessionService this
  // test built) — db.close() + tmpHome cleanup are deferred to the very end of the script, after Section C.
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [...new Set(worktrees.filter(Boolean))]) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ===================== Section C (card 81b7e346): the REAL queue — auto-fire + cancellation =====================
// Own project/manager/repo — isolated from Section A's "pQ"/"mgr1" so the two sections can't interfere.
{
  const repoC = path.join(os.tmpdir(), `loom-wscq-repoC-${Date.now()}`);
  initRepo(repoC);
  const worktreesC = [];
  try {
    db.insertProject({ id: "pC", name: "C", repoPath: repoC, vaultPath: repoC, config: { orchestration: { maxConcurrentWorkers: 1 } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "agentMgrC", projectId: "pC", name: "MgrC", startupPrompt: "MGR", position: 0, profileId: null });
    db.insertAgent({ id: "agentDevC", projectId: "pC", name: "DevC", startupPrompt: "DEV", position: 1, profileId: null });
    db.insertSession({ id: "mgr2", projectId: "pC", agentId: "agentMgrC", engineSessionId: null, title: null,
      cwd: repoC, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const mkTask = (n) => {
      const id = randomUUID();
      db.insertTask({ id, projectId: "pC", title: `task C${n}`, body: "", columnKey: "backlog", position: n, priority: "p2", createdAt: now, updatedAt: now });
      return id;
    };
    const taskC = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => [n, mkTask(n)]));

    const router2 = new OrchestrationMcpRouter(db, svc);
    const server2 = router2.buildServer("mgr2", "manager");
    const [clientT2, serverT2] = InMemoryTransport.createLinkedPair();
    await server2.connect(serverT2);
    const client2 = new Client({ name: "worker-spawn-cap-queue-test-C", version: "0" });
    await client2.connect(clientT2);
    const callC = async (nameArgs, args) => parse(await client2.callTool({ name: nameArgs, arguments: args ?? {} }));
    const retireAndDrain = async (workerSessionId) => { events.onExit(workerSessionId, 0, { intended: true }); await lastDrainPromise; };

    // ===================== (8) auto-fire on slot-free, WITH the FULL kickoff prompt (not the truncated label) =====================
    const spawnC1 = await callC("worker_spawn", { taskId: taskC[1], agentId: "agentDevC", kickoffPrompt: "GO C1" });
    check("(8 setup) taskC1 fills the cap (cap=1)", !!spawnC1.workerSessionId);
    worktreesC.push(spawnC1.worktreePath);

    const longKickoff = "This kickoff prompt is deliberately long — well over the 120-character KICKOFF_LABEL_MAX truncation used for the worker_list display-only label, so it MUST NOT be what an auto-fired worker actually receives.";
    check("(8 setup) the long kickoff really is over KICKOFF_LABEL_MAX (120)", longKickoff.length > 120);
    const rejC2 = await callC("worker_spawn", { taskId: taskC[2], agentId: "agentDevC", kickoffPrompt: longKickoff });
    check("(8 setup) taskC2 is cap-queued", !!rejC2.capQueued && rejC2.capQueued.taskId === taskC[2]);

    await retireAndDrain(spawnC1.workerSessionId);
    let listC = await callC("worker_list");
    check("(8) the cap-queued placeholder for C2 is GONE — it auto-fired with NO second worker_spawn call",
      !listC.some((w) => w.processState === "cap-queued" && w.taskId === taskC[2]));
    const liveC2 = listC.find((w) => w.taskId === taskC[2] && w.processState === "live");
    check("(8) a REAL live worker now exists for taskC2", !!liveC2);
    if (liveC2) worktreesC.push(db.getSession(liveC2.workerSessionId)?.worktreePath);
    const promptC2 = liveC2 && host.spawnedPrompts.get(liveC2.workerSessionId);
    check("(8) the auto-fired worker's startup prompt carries the FULL original kickoff, not the truncated label",
      !!promptC2 && promptC2.includes(longKickoff));

    // ===================== (9) FIFO: two entries queued behind one full slot — the OLDER fires first =====================
    const rejC3 = await callC("worker_spawn", { taskId: taskC[3], agentId: "agentDevC", kickoffPrompt: "GO C3" });
    check("(9 setup) taskC3 is cap-queued (queued FIRST)", !!rejC3.capQueued);
    const rejC4 = await callC("worker_spawn", { taskId: taskC[4], agentId: "agentDevC", kickoffPrompt: "GO C4" });
    check("(9 setup) taskC4 is cap-queued (queued SECOND, behind C3)", !!rejC4.capQueued);

    await retireAndDrain(liveC2.workerSessionId);
    listC = await callC("worker_list");
    const liveC3 = listC.find((w) => w.taskId === taskC[3] && w.processState === "live");
    check("(9) the OLDER queued entry (C3) fires first", !!liveC3);
    if (liveC3) worktreesC.push(db.getSession(liveC3.workerSessionId)?.worktreePath);
    check("(9) the YOUNGER queued entry (C4) is still queued, NOT fired early",
      listC.some((w) => w.processState === "cap-queued" && w.taskId === taskC[4]));

    // ===================== (10) two CONCURRENT drain calls never double-dispatch the same queued entry =====================
    db.setProcessState(liveC3.workerSessionId, "exited"); // free the slot WITHOUT going through the onExit-driven drain
    db.setBusy(liveC3.workerSessionId, false);
    await Promise.all([svc.maybeDrainCapQueue("mgr2"), svc.maybeDrainCapQueue("mgr2")]);
    listC = await callC("worker_list");
    const liveC4Rows = listC.filter((w) => w.taskId === taskC[4] && w.processState === "live");
    check("(10) exactly ONE worker was spawned for C4, not two, despite two concurrent drain calls", liveC4Rows.length === 1);
    check("(10) no cap-queued placeholder remains", !listC.some((w) => w.processState === "cap-queued"));
    if (liveC4Rows[0]) worktreesC.push(db.getSession(liveC4Rows[0].workerSessionId)?.worktreePath);

    // ===================== (17) a cap-race on the drain preserves the entry's opId + FIFO position =====================
    // taskC4 is still live (cap=1, full). Queue TWO more entries behind it, then call the drain WITHOUT
    // freeing anything — spawnWorker's own cap-admit will (correctly) reject, forcing the EXACT
    // CapQueueRejectedError branch a real slot-stealing race would hit, deterministically.
    const rejC6 = await callC("worker_spawn", { taskId: taskC[6], agentId: "agentDevC", kickoffPrompt: "GO C6, will race the cap" });
    check("(17 setup) taskC6 is cap-queued (queued FIRST)", !!rejC6.capQueued);
    const rejC11 = await callC("worker_spawn", { taskId: taskC[11], agentId: "agentDevC", kickoffPrompt: "GO C11, queued behind C6" });
    check("(17 setup) taskC11 is cap-queued (queued SECOND, behind C6)", !!rejC11.capQueued);

    await svc.maybeDrainCapQueue("mgr2"); // nothing actually freed — this MUST cap-race
    listC = await callC("worker_list");
    check("(17) C6 is STILL cap-queued after the race (not dropped, not fired)",
      listC.some((w) => w.processState === "cap-queued" && w.taskId === taskC[6]));
    const c6After = listC.find((w) => w.taskId === taskC[6]);
    check("(17) C6 kept its ORIGINAL opId — a fresh record() would have minted a new one", c6After && c6After.capQueued.opId === rejC6.capQueued.opId);
    check("(17) C11 (the younger entry) is untouched", listC.some((w) => w.processState === "cap-queued" && w.taskId === taskC[11]));

    // Now free the slot for real: C6 must still be the OLDEST — i.e. it fires BEFORE C11 — proving the
    // requeueFront kept it at the FRONT rather than letting it get demoted to the back of the queue.
    await retireAndDrain(liveC4Rows[0].workerSessionId);
    listC = await callC("worker_list");
    const liveC6 = listC.find((w) => w.taskId === taskC[6] && w.processState === "live");
    check("(17) once a slot genuinely frees, C6 (not C11) fires — FIFO position was preserved through the race", !!liveC6);
    check("(17) C11 is still queued behind it", listC.some((w) => w.processState === "cap-queued" && w.taskId === taskC[11]));
    if (liveC6) worktreesC.push(db.getSession(liveC6.workerSessionId)?.worktreePath);

    // Cancel C11 now (it's no longer needed for a later test) so it doesn't linger into (11)'s failure test.
    const cancelC11 = await callC("worker_stop", { opId: rejC11.capQueued.opId });
    check("(17 cleanup) C11 cancelled so it doesn't interfere with test (11) below", cancelC11.cancelled === true);

    // ===================== (11) a failed auto-spawn is dropped, not retried forever, and the drain continues =====================
    const rejC5 = await callC("worker_spawn", { taskId: taskC[5], agentId: "agentDevC", kickoffPrompt: "GO C5, will be HELD before it can fire" });
    check("(11 setup) taskC5 is cap-queued", !!rejC5.capQueued);
    const rejC7 = await callC("worker_spawn", { taskId: taskC[7], agentId: "agentDevC", kickoffPrompt: "GO C7, should still fire despite C5 failing" });
    check("(11 setup) taskC7 is cap-queued behind C5", !!rejC7.capQueued);
    db.updateTask(taskC[5], { held: true }); // make C5's eventual auto-fire attempt fail for real (spawnWorker refuses a HELD task)

    host.enqueueLog.length = 0; // clean slate so the notification assertion below can't accidentally match an earlier call
    await retireAndDrain(liveC6.workerSessionId); // C6 (not C4) is the CURRENTLY live worker after test (17)
    listC = await callC("worker_list");
    check("(11) the failed entry (C5, held) never became a live worker", !listC.some((w) => w.taskId === taskC[5] && w.processState === "live"));
    check("(11) the failed entry is DROPPED, not left cap-queued forever", !listC.some((w) => w.taskId === taskC[5] && w.processState === "cap-queued"));
    const liveC7 = listC.find((w) => w.taskId === taskC[7] && w.processState === "live");
    check("(11) the drain did NOT wedge — it continued past the failure and fired the NEXT queued entry (C7)", !!liveC7);
    if (liveC7) worktreesC.push(db.getSession(liveC7.workerSessionId)?.worktreePath);
    check("(11) the manager was actually notified — [loom:cap-queue-autofire-failed] naming the opId/task/agent",
      host.enqueueLog.some((e) => e.sessionId === "mgr2" && e.text.includes("[loom:cap-queue-autofire-failed]")
        && e.text.includes(rejC5.capQueued.opId) && e.text.includes(taskC[5]) && e.text.includes("agentDevC")));

    // ===================== (12) cancellation withdraws a queued entry before it fires =====================
    const rejC8 = await callC("worker_spawn", { taskId: taskC[8], agentId: "agentDevC", kickoffPrompt: "GO C8, will be cancelled" });
    check("(12 setup) taskC8 is cap-queued", !!rejC8.capQueued);
    const cancelResult = await callC("worker_stop", { opId: rejC8.capQueued.opId });
    check("(12) worker_stop({opId}) cancels the queued entry", cancelResult.cancelled === true);
    listC = await callC("worker_list");
    check("(12) the cancelled entry is gone from worker_list", !listC.some((w) => w.taskId === taskC[8]));
    const recancelResult = await callC("worker_stop", { opId: rejC8.capQueued.opId });
    check("(12) re-cancelling an already-gone entry is a safe no-op ({cancelled:false}), not an error",
      recancelResult.cancelled === false && recancelResult.error === undefined);

    await retireAndDrain(liveC7.workerSessionId);
    listC = await callC("worker_list");
    check("(12) freeing the slot afterward never resurrects the cancelled entry", !listC.some((w) => w.taskId === taskC[8]));

    // ===================== (13) a PAUSED manager's cap-queue is left untouched by a drain (not dropped, not fired) =====================
    const spawnC10 = await callC("worker_spawn", { taskId: taskC[10], agentId: "agentDevC", kickoffPrompt: "GO C10, refills the cap" });
    check("(13 setup) taskC10 fills the cap again", !!spawnC10.workerSessionId);
    worktreesC.push(spawnC10.worktreePath);
    const rejC9 = await callC("worker_spawn", { taskId: taskC[9], agentId: "agentDevC", kickoffPrompt: "GO C9, should survive a pause" });
    check("(13 setup) taskC9 is cap-queued", !!rejC9.capQueued);

    control.pause("mgr2");
    db.setProcessState(spawnC10.workerSessionId, "exited"); // free the slot WITHOUT the onExit-driven drain (paused, so drain manually below)
    db.setBusy(spawnC10.workerSessionId, false);
    await svc.maybeDrainCapQueue("mgr2");
    listC = await callC("worker_list");
    check("(13) a paused manager's queued entry is left QUEUED (neither dropped nor fired) by a drain",
      listC.some((w) => w.processState === "cap-queued" && w.taskId === taskC[9]));

    control.resume("mgr2");
    await svc.maybeDrainCapQueue("mgr2");
    listC = await callC("worker_list");
    const liveC9 = listC.find((w) => w.taskId === taskC[9] && w.processState === "live");
    check("(13) once unpaused, the SAME entry fires on the next drain", !!liveC9);
    if (liveC9) worktreesC.push(db.getSession(liveC9.workerSessionId)?.worktreePath);
  } finally {
    try {
      const { removeWorktree } = await import("../dist/git/worktrees.js");
      for (const wt of [...new Set(worktreesC.filter(Boolean))]) { try { await removeWorktree(repoC, wt); } catch { /* best-effort */ } }
    } catch { /* best-effort */ }
    try { fs.rmSync(repoC, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ===================== Section D (Code Review follow-up, card 81b7e346): recycleWorker's drain =====================
// ===================== suppression guard — the sole backstop against overshooting maxConcurrentWorkers =====================
// during a recycle's predecessor-exit-to-successor-insert window. Own project (cap=2 — a plain 1:1 recycle
// swap never creates room for anything else, so this needs a SECOND, independently-freed slot to prove the
// finally's catch-up drain claims real leftover headroom once the swap settles) + manager "mgr3".
{
  const repoD = path.join(os.tmpdir(), `loom-wscq-repoD-${Date.now()}`);
  initRepo(repoD);
  const worktreesD = [];
  try {
    db.insertProject({ id: "pD", name: "D", repoPath: repoD, vaultPath: repoD, config: { orchestration: { maxConcurrentWorkers: 2 } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "agentMgrD", projectId: "pD", name: "MgrD", startupPrompt: "MGR", position: 0, profileId: null });
    db.insertAgent({ id: "agentDevD", projectId: "pD", name: "DevD", startupPrompt: "DEV", position: 1, profileId: null });
    db.insertSession({ id: "mgr3", projectId: "pD", agentId: "agentMgrD", engineSessionId: null, title: null,
      cwd: repoD, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const mkTaskD = (n) => {
      const id = randomUUID();
      db.insertTask({ id, projectId: "pD", title: `task D${n}`, body: "", columnKey: "backlog", position: n, priority: "p2", createdAt: now, updatedAt: now });
      return id;
    };
    const taskD = Object.fromEntries([1, 2, 3, 4].map((n) => [n, mkTaskD(n)]));

    const routerD = new OrchestrationMcpRouter(db, svc);
    const serverD = routerD.buildServer("mgr3", "manager");
    const [clientTD, serverTD] = InMemoryTransport.createLinkedPair();
    await serverD.connect(serverTD);
    const clientD = new Client({ name: "worker-spawn-cap-queue-test-D", version: "0" });
    await clientD.connect(clientTD);
    const callD = async (nameArgs, args) => parse(await clientD.callTool({ name: nameArgs, arguments: args ?? {} }));
    const retireAndDrainD = async (workerSessionId) => { events.onExit(workerSessionId, 0, { intended: true }); await lastDrainPromise; };

    // ===================== (18)/(19) suppressed DURING a recycle, fires from the finally catch-up drain AFTER =====================
    const spawnD1 = await callD("worker_spawn", { taskId: taskD[1], agentId: "agentDevD", kickoffPrompt: "GO D1 — will be recycled" });
    check("(18 setup) taskD1 live", !!spawnD1.workerSessionId);
    const spawnD4 = await callD("worker_spawn", { taskId: taskD[4], agentId: "agentDevD", kickoffPrompt: "GO D4 — retires independently mid-recycle" });
    check("(18 setup) taskD4 live, cap now full (2/2)", !!spawnD4.workerSessionId);
    const rejD2 = await callD("worker_spawn", { taskId: taskD[2], agentId: "agentDevD", kickoffPrompt: "GO D2 — should survive the recycle window, then auto-fire" });
    check("(18 setup) taskD2 cap-queued", !!rejD2.capQueued);

    const recyclePromise = svc.recycleWorker("mgr3", spawnD1.workerSessionId, "recycle — testing the drain-suppression guard");
    // By the time the line above returns a Promise, recycleWorker's SYNCHRONOUS prefix (including
    // suppressCapQueueDrain) has already run — JS executes an async function's body synchronously up to
    // its first internal `await` before handing back a pending Promise. Suppression is active NOW.
    await retireAndDrainD(spawnD4.workerSessionId); // an UNRELATED worker frees a slot WHILE mgr3 is suppressed
    const listMid = await callD("worker_list");
    check("(18) D2 stays cap-queued mid-recycle even though D4 just freed a slot (suppression holds)",
      listMid.some((w) => w.processState === "cap-queued" && w.taskId === taskD[2]));
    check("(18) no overshoot mid-recycle — never more live workers than the cap (2) allows",
      listMid.filter((w) => w.processState === "live").length <= 2);

    await recyclePromise; // recycleWorker's own finally unsuppresses + fires a fire-and-forget catch-up drain
    const fired = await waitUntil(async () => (await callD("worker_list")).some((w) => w.taskId === taskD[2] && w.processState === "live"));
    check("(19) once the swap settles, the finally's catch-up drain fires D2 into the leftover headroom D4 left behind", fired);
    const listAfter = await callD("worker_list");
    check("(19) no overshoot the OTHER way either — exactly 2 live workers (D1's successor + D2), not 3", listAfter.filter((w) => w.processState === "live").length === 2);
    check("(19) no cap-queued placeholder remains", !listAfter.some((w) => w.processState === "cap-queued"));
    for (const w of listAfter) if (w.processState === "live") worktreesD.push(db.getSession(w.workerSessionId)?.worktreePath);

    // spawnWorker flips processState:"live" BEFORE it's fully done (M5 ordering, pre-existing/deliberate —
    // a still-outstanding `await findShippedCardMatch` git check runs AFTER, and only THEN does the
    // `finally` release its inFlightSpawnTaskIds claim). `waitUntil` above only proves D2 is *visible* as
    // live, not that the detached catch-up drain's OWN spawnWorker call has fully unwound — so wait for the
    // daemon-global in-flight claim set to drain to empty before starting the refcount test below, or its
    // own D3 spawn could spuriously cap-race against this call's still-open claim (white-box: same
    // TS-`private`-erased-at-runtime access as suppressCapQueueDrain).
    const settled = await waitUntil(() => svc.inFlightSpawnTaskIds.size === 0);
    check("(19b) the recycle's detached catch-up drain fully unwinds (releases its in-flight claim) before continuing", settled);

    // ===================== (20)/(21)/(22) refcounted suppression: no premature un-suppress =====================
    // White-box: suppressCapQueueDrain/unsuppressCapQueueDrain are TS `private` (compile-time only — the
    // emitted dist/ has no runtime enforcement), called directly here to simulate TWO overlapping recycles
    // on the SAME manager without the timing fragility of racing two real recycleWorker calls.
    const rejD3 = await callD("worker_spawn", { taskId: taskD[3], agentId: "agentDevD", kickoffPrompt: "GO D3 — refcount test" });
    check("(20 setup) taskD3 cap-queued (cap is full again: D1-successor + D2)", !!rejD3.capQueued);
    const liveNow = listAfter.find((w) => w.processState === "live");

    svc.suppressCapQueueDrain("mgr3"); // simulated recycle #1 entering
    svc.suppressCapQueueDrain("mgr3"); // simulated recycle #2 entering — refcount now 2
    await retireAndDrainD(liveNow.workerSessionId); // frees a slot while refcount=2
    check("(20) D3 stays queued while refcount=2 (both simulated recycles still in flight)",
      (await callD("worker_list")).some((w) => w.processState === "cap-queued" && w.taskId === taskD[3]));

    svc.unsuppressCapQueueDrain("mgr3"); // simulated recycle #1 finishing — refcount now 1, STILL suppressed
    await svc.maybeDrainCapQueue("mgr3"); // an explicit drain attempt while refcount=1
    check("(21) D3 is STILL queued after only ONE of two unsuppress calls — a boolean flag would have wrongly let this through",
      (await callD("worker_list")).some((w) => w.processState === "cap-queued" && w.taskId === taskD[3]));

    svc.unsuppressCapQueueDrain("mgr3"); // simulated recycle #2 finishing — refcount now 0
    await svc.maybeDrainCapQueue("mgr3");
    const liveD3 = (await callD("worker_list")).find((w) => w.taskId === taskD[3] && w.processState === "live");
    check("(22) D3 fires only once BOTH simulated recycles have unsuppressed (refcount reached 0)", !!liveD3);
    if (liveD3) worktreesD.push(db.getSession(liveD3.workerSessionId)?.worktreePath);

    // ===================== (23)/(24) worker_stop's neither-arg / both-arg validation =====================
    const neither = await callD("worker_stop", {});
    check("(23) worker_stop({}) — neither workerSessionId nor opId — a clear error, not a schema throw", neither.error === "worker_stop requires either workerSessionId or opId");
    const both = await callD("worker_stop", { workerSessionId: "some-id", opId: "some-op" });
    check("(24) worker_stop({workerSessionId, opId}) — BOTH given — rejected as ambiguous, not silently picking one", both.error === "worker_stop takes EITHER workerSessionId OR opId, not both");
  } finally {
    try {
      const { removeWorktree } = await import("../dist/git/worktrees.js");
      for (const wt of [...new Set(worktreesD.filter(Boolean))]) { try { await removeWorktree(repoD, wt); } catch { /* best-effort */ } }
    } catch { /* best-effort */ }
    try { fs.rmSync(repoD, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
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

  // (14)-(16): the new primitives maybeDrainCapQueue is built on (takeOldest/requeueFront/cancel), unit-tested directly.
  const reg3 = new CapQueueRegistry(() => fakeNow);
  const eZ1 = reg3.record("mgrZ", "agentZ", "tZ1", "kickoff Z1 — full text, over 4 chars anyway");
  const eZ2 = reg3.record("mgrZ", "agentZ", "tZ2", "kickoff Z2");
  const taken = reg3.takeOldest("mgrZ");
  check("(14) takeOldest returns the OLDEST entry (Z1, recorded first)", taken && taken.opId === eZ1.opId);
  check("(14) takeOldest carries the FULL kickoffPrompt (not just kickoffLabel)", taken && taken.kickoffPrompt === "kickoff Z1 — full text, over 4 chars anyway");
  check("(14) takeOldest REMOVES it — a second call now returns Z2", reg3.takeOldest("mgrZ")?.opId === eZ2.opId);
  check("(14) the queue is now empty for mgrZ", reg3.takeOldest("mgrZ") === undefined);

  const eZ3 = reg3.record("mgrZ", "agentZ", "tZ3", "kickoff Z3");
  const takenZ3 = reg3.takeOldest("mgrZ");
  reg3.record("mgrZ", "agentZ", "tZ4", "kickoff Z4"); // a newer entry, recorded AFTER Z3 was popped
  reg3.requeueFront(takenZ3);
  const afterRequeue = reg3.listByManager("mgrZ");
  check("(15) requeueFront puts the popped entry back", afterRequeue.some((e) => e.opId === eZ3.opId));
  check("(15) requeueFront restores it at the FRONT — takeOldest returns it again, not the newer Z4",
    reg3.takeOldest("mgrZ")?.opId === eZ3.opId);

  const eZ5 = reg3.record("mgrZ", "agentZ", "tZ5", "kickoff Z5");
  check("(16) cancel() refuses a DIFFERENT manager's opId (ownership-scoped)", reg3.cancel("someOtherMgr", eZ5.opId) === false);
  check("(16) the wrongly-scoped cancel left the entry in place", reg3.listByManager("mgrZ").some((e) => e.opId === eZ5.opId));
  check("(16) cancel() by the OWNING manager removes it", reg3.cancel("mgrZ", eZ5.opId) === true);
  check("(16) a repeat cancel of an already-gone opId is a safe no-op (false, not a throw)", reg3.cancel("mgrZ", eZ5.opId) === false);
}

db.close();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — a cap-rejected worker_spawn (tasked or taskless) records + surfaces a bounded, TTL-reaped, additive-only cap-queued marker in worker_list, distinct from a live/pendingSpawn/awaiting-review row, cleared on a successful re-spawn, and completely invisible under the cap — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
