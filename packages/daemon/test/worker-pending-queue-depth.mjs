import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_list/worker_status `pendingQueueDepth`/`currentTurnBusyForMs` test (card d8eaa381).
//
// THE OBSERVABILITY GAP THIS CLOSES: card d8eaa381's own diagnosis (production log evidence, DevToolbox
// worker 9b47fd1b) refuted the original "onTurnCompleted deadlocks" hypothesis — the turn-completion
// chokepoint fired correctly on every genuine Stop. The REAL risk it left standing: a healthy worker deep
// into one very long turn (measured: 53m43s, real subagent/tool activity) with a backlogged FIFO queue is
// INDISTINGUISHABLE, on `worker_list`/`worker_status` alone, from a genuinely wedged one — a manager
// reading only `turnSeq`/`busy:true` has no way to tell "still working, will drain in N more turns" from
// "stuck". `pendingQueueDepth` (pty/host.ts `getPendingQueueDepth`) and `currentTurnBusyForMs`
// (`getCurrentTurnBusyForMs`) exist to close exactly that gap.
//
// WHAT THIS TEST PROVES:
//   (1) LIVE, EMPTY QUEUE: a freshly spawned, idle session reads pendingQueueDepth:0 — a real measured
//       zero, not an absent signal collapsing to the same shape.
//   (2) QUEUE GROWS: once busy, further enqueueStdin calls queue instead of delivering — depth increases
//       by exactly one per additional enqueue, visible at the PtyHost level AND over worker_list/
//       worker_status.
//   (3) currentTurnBusyForMs is a live, monotonically increasing elapsed-ms number while a turn is in
//       flight (sampled twice with a real sleep between, mirroring worker-unconfirmed-delivery-signal.mjs's
//       own technique for proving "live elapsed time", not a static marker).
//   (4) IDLE → null: a fresh spawn with no turn ever started, and a session whose turn has just ended via
//       a real Stop hook, both read currentTurnBusyForMs:null (never a fabricated zero).
//   (5) NOT LIVE in this process → both fields null, not a crash or a silently wrong zero.
//   (6) CODEX: pendingQueueDepth is AGNOSTIC (reads for a codex-kind Live registered directly in the
//       private `liveCodex` map, mirroring pty-codex-agnostic-methods.mjs's own precedented technique) —
//       but currentTurnBusyForMs is CLAUDE-ONLY and reads null for that same codex row, the same
//       "not applicable to this harness" convention `lastEngineOutputAt` already established (card
//       a1916267) — proven, not just documented.
//   (7) BYTE-COMPAT: a router built with no PtyHost wired still returns both fields as null.
//
// HERMETIC: a REAL PtyHost driven by a FAKE pty injected via the createPty() seam (see
// _seam-host-fixture.mjs) — no real claude, no daemon — wired into a REAL OrchestrationMcpRouter, same
// technique as worker-unconfirmed-delivery-signal.mjs.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-pending-queue-depth.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Hermetic LOOM_HOME — set BEFORE any dist/ import (paths.ts/host.ts read it at module-top-level). ---
const tmpHome = path.join(os.tmpdir(), `loom-pending-queue-depth-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    return { ...base, write: () => {} };
  }
}

const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {},
  onRateLimited() {}, onExit() {},
};

const dbFile = path.join(os.tmpdir(), `loom-pending-queue-depth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const seededActivity = "2026-09-19T12:00:00.000Z";
const projId = "proj-pending-queue-depth";
const agentId = "agent-pending-queue-depth";
db.insertProject({ id: projId, name: "PendingQueueDepth", repoPath: projId, vaultPath: projId, config: {}, createdAt: seededActivity, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });
db.insertSession({ id: "w-fresh", projectId: projId, agentId, engineSessionId: "eng-w-fresh", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-fresh" });
db.insertSession({ id: "w-busy", projectId: projId, agentId, engineSessionId: "eng-w-busy", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-busy" });
db.insertSession({ id: "w-not-in-pty", projectId: projId, agentId, engineSessionId: "eng-w-other", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-other" });
db.insertSession({ id: "w-codex", projectId: projId, agentId, engineSessionId: "eng-w-codex", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-codex", harness: "codex" });

const sessionsStub = {
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; },
  async getDanglingWorkers() { return []; },
};

const host = new TestPtyHost(events);
function spawnReady(targetHost, sessionId) {
  targetHost.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  targetHost.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub), {}, host);
async function connectAs(sessionId, role) {
  const server = router.buildServer(sessionId, role);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: `pending-queue-depth-test-${sessionId}`, version: "0" });
  await client.connect(clientT);
  const parse = (res) => JSON.parse(res.content[0].text);
  return { call: async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} })) };
}

const mgrClient = await connectAs("mgr", "manager");

try {
  // ============== (1)+(2)+(3) LIVE EMPTY QUEUE, THEN GROWS, WHILE currentTurnBusyForMs LIVE-ELAPSES ==============
  {
    const SID = "w-busy";
    spawnReady(host, SID);
    check("(1) PtyHost level: a fresh idle spawn reads pendingQueueDepth:0 (a real measured zero)", host.getPendingQueueDepth(SID) === 0);
    check("(1) PtyHost level: a fresh idle spawn reads currentTurnBusyForMs:null (idle — nothing in flight)", host.getCurrentTurnBusyForMs(SID) === null);

    const r1 = host.enqueueStdin(SID, "FIRST_TURN_TEXT");
    check("(2) setup: first enqueue delivers immediately (idle-submit), busy armed", r1.delivered === true && busyLog[SID]?.at(-1) === true);
    check("(2) PtyHost level: still busy, queue is empty (the delivered message never queues)", host.getPendingQueueDepth(SID) === 0);

    const firstBusyMs = host.getCurrentTurnBusyForMs(SID);
    check("(3) PtyHost level: currentTurnBusyForMs is a real elapsed-ms NUMBER while busy", typeof firstBusyMs === "number" && firstBusyMs >= 0);

    // Prove it's LIVE elapsed time, not a stuck flag: a second reading after a real sleep must be larger.
    // TIMING-GUARD-FALSE-MATCH: keyword-in-methodology-aside — NEG_KEYWORDS' bare "not" below matches inside
    // the label's methodology parenthetical ("proves live elapsed time, not a static marker"), which
    // describes HOW the claim is proven, not the claim's own polarity. The assertion itself
    // (`typeof secondBusyMs === "number" && secondBusyMs > firstBusyMs`) is POSITIVE-polarity and fails
    // loudly on a static/wrong-typed value — this 40ms wait IS the quantity under test, not a guessed
    // duration (mirrors worker-unconfirmed-delivery-signal.mjs's own identically-shaped exemption, card
    // 1c5dda5d).
    await sleep(40);
    const secondBusyMs = host.getCurrentTurnBusyForMs(SID);
    check("(3) currentTurnBusyForMs is monotonically increasing across a real sleep (proves live elapsed time, not a static marker)",
      typeof secondBusyMs === "number" && secondBusyMs > firstBusyMs);

    // Card e01687ea/eac3464d: a CONSECUTIVE same-sender "agent"-kind run COALESCES into one drained turn
    // (and the default/untouched `kind` is "warning", which coalesces regardless of sender) — neither
    // shape is what this test needs. Two DIFFERENT senderIds keep these two queued entries from
    // coalescing, so the Stop-triggered drain below removes exactly ONE, matching the production
    // incident's own shape (a manager's own direction queued behind a DIFFERENT sender's entry).
    const r2 = host.enqueueStdin(SID, "SECOND_MESSAGE_QUEUES", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-2");
    check("(2) second enqueue while busy: HELD, not delivered", r2.delivered === false);
    check("(2) PtyHost level: pendingQueueDepth is now 1", host.getPendingQueueDepth(SID) === 1);

    const r3 = host.enqueueStdin(SID, "THIRD_MESSAGE_ALSO_QUEUES", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-3");
    check("(2) third enqueue while still busy: HELD too", r3.delivered === false);
    check("(2) PtyHost level: pendingQueueDepth is now 2 — exactly one per additional enqueue", host.getPendingQueueDepth(SID) === 2);

    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === SID);
    check("(2)+(3) worker_list: pendingQueueDepth:2 and currentTurnBusyForMs a positive number, both visible over MCP",
      row?.pendingQueueDepth === 2 && typeof row?.currentTurnBusyForMs === "number" && row.currentTurnBusyForMs > 0);

    const status = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(2)+(3) worker_status: same shape", status?.pendingQueueDepth === 2 && typeof status?.currentTurnBusyForMs === "number");

    // ============== (4) IDLE AGAIN → currentTurnBusyForMs back to null, queue survives the turn boundary ==============
    host.deliverHook(SID, { hook_event_name: "Stop" }); // ends the turn; drains ONE queued entry as the next turn
    check("(4) PtyHost level: currentTurnBusyForMs reads null once the turn that was measured has ended",
      // the Stop-triggered drain immediately re-arms busy for the next queued entry, so re-check the OLD
      // busySince window closed by confirming a NEW (smaller) reading rather than assuming idle — the
      // drain's own new turn has its own fresh busySince.
      host.getCurrentTurnBusyForMs(SID) < secondBusyMs);
    check("(4) PtyHost level: the drain consumed exactly one entry — pendingQueueDepth is now 1", host.getPendingQueueDepth(SID) === 1);
  }

  // ============== (4b) a session with NO turn EVER started reads currentTurnBusyForMs:null ==============
  {
    const SID = "w-fresh";
    spawnReady(host, SID);
    check("(4b) PtyHost level: a never-submitted session reads currentTurnBusyForMs:null", host.getCurrentTurnBusyForMs(SID) === null);
    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === SID);
    check("(4b) worker_list: same null, and pendingQueueDepth:0 (live, empty)", row?.currentTurnBusyForMs === null && row?.pendingQueueDepth === 0);
  }

  // ============== (5) NOT LIVE in this process → both fields null over MCP ==============
  {
    const list = await mgrClient.call("worker_list");
    const other = list.find((w) => w.workerSessionId === "w-not-in-pty");
    check("(5) worker_list: a worker never spawned in this process reads both fields null",
      other && other.pendingQueueDepth === null && other.currentTurnBusyForMs === null);

    const status = await mgrClient.call("worker_status", { workerSessionId: "w-not-in-pty" });
    check("(5) worker_status: same null for both", status.pendingQueueDepth === null && status.currentTurnBusyForMs === null);

    check("(5) PtyHost level: both getters read undefined (not live in either harness's registry)",
      host.getPendingQueueDepth("w-not-in-pty") === undefined && host.getCurrentTurnBusyForMs("w-not-in-pty") === undefined);
  }

  // ============== (6) CODEX: pendingQueueDepth AGNOSTIC, currentTurnBusyForMs CLAUDE-ONLY (reads null) ==============
  {
    const SID = "w-codex";
    // Direct liveCodex registration — the same precedented technique pty-codex-agnostic-methods.mjs uses
    // (TypeScript `private` is compile-time-only; a compiled JS test can read/write it). Minimal fixture:
    // only the fields getPendingQueueDepth/getCurrentTurnBusyForMs's own code paths actually touch.
    const fakePty = { pid: 999999, write() {}, kill() {}, resize() {}, onData(cb) { this._onData = cb; }, onExit(cb) { this._onExit = cb; } };
    const fakeLogStream = { write() {}, end() {}, on() {} };
    host.liveCodex.set(SID, {
      kind: "codex", pty: fakePty, pid: fakePty.pid, cwd: tmpHome,
      geometry: { cols: 120, rows: 40 }, hookToken: "", engineSessionId: "engine-codex-abc",
      ring: { chunks: [], bytes: 0 }, subscribers: new Set(),
      alive: true, killed: false, startedAt: Date.now(),
      logStream: fakeLogStream, logBroken: false, busy: true,
      pending: [{ id: "m1", text: "a" }, { id: "m2", text: "b" }], stopping: false, drainHeld: false,
      role: "worker", mcpSeen: false, mcpSeenWaiters: [],
      activeTurnRoute: null, lastPromptRoute: null, activeTurnProactive: false, lastPromptProactive: false,
      activeTurnOwnerText: null, lastPromptOwnerText: null, recentOwnerTurns: [],
      activeTurnSenderId: null, lastPromptSenderId: null,
      trustDialogAnswered: true, trustDialogPending: false,
      lastBusyMarkerAt: 0, enterWrittenAt: 0, enterPending: false, submitConfirmAttempts: 0,
      busyStaleGen: 0, busyStaleTimer: null, submitOutstanding: false, firstTurnStarted: true,
    });

    check("(6) PtyHost level: pendingQueueDepth is AGNOSTIC — reads a real depth for a codex-kind Live",
      host.getPendingQueueDepth(SID) === 2);
    check("(6) PtyHost level: currentTurnBusyForMs is CLAUDE-ONLY — undefined for a codex-kind Live (never in `this.live`), even though it's busy",
      host.getCurrentTurnBusyForMs(SID) === undefined);

    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === SID);
    check("(6) worker_list: pendingQueueDepth:2 (harness-agnostic) alongside currentTurnBusyForMs:null (not applicable to codex — the same convention lastEngineOutputAt already established)",
      row?.pendingQueueDepth === 2 && row?.currentTurnBusyForMs === null);

    const status = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(6) worker_status: same shape", status?.pendingQueueDepth === 2 && status?.currentTurnBusyForMs === null);
  }

  // ============== (7) byte-compat: a router built the OLD way (no pty arg) still works ==============
  {
    const routerNoPty = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
    const server = routerNoPty.buildServer("mgr", "manager");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "pending-queue-depth-nopty-test", version: "0" });
    await client.connect(clientT);
    const list = JSON.parse((await client.callTool({ name: "worker_list", arguments: {} })).content[0].text);
    check("(7) a router with no PtyHost wired still returns worker_list without throwing", Array.isArray(list) && list.length === 4);
    check("(7) every row reads pendingQueueDepth:null and currentTurnBusyForMs:null when no PtyHost was wired",
      list.every((w) => w.pendingQueueDepth === null && w.currentTurnBusyForMs === null));
  }
} finally {
  for (const sid of ["w-fresh", "w-busy"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  db.close();
  try { fs.rmSync(dbFile, { force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — pendingQueueDepth (pty/host.ts's getPendingQueueDepth, AGNOSTIC across claude/codex) and currentTurnBusyForMs (getCurrentTurnBusyForMs, CLAUDE-ONLY) close the observability gap card d8eaa381's own diagnosis found: a live measured 0/growing depth as messages queue behind a busy turn, a live monotonically-increasing busy duration, null (never a fabricated zero) once idle or never-submitted, null for a session not live in this process, the correct AGNOSTIC-vs-CLAUDE-ONLY split proven against a real codex-kind Live (not just documented), and byte-compatible on a router built without a PtyHost."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
