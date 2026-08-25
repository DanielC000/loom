import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_list/worker_status/my_context unconfirmedDeliveryMs PULL-read test (card a33a72f7).
//
// THE BLIND WINDOW THIS CLOSES: `composerDirtyLen` (card 3ce3fa39, see worker-composer-dirty-signal.mjs)
// only ever goes non-zero once a give-up/heal-if-stuck actually FIRES — `FIRST_TURN_STALE_MS` (30s) or
// `SUBMIT_MAX_ATTEMPTS` retries + `GIVE_UP_HOLD_MS` (20s) after the write. Between the moment Loom writes
// unconfirmed text into a composer and that moment, composerDirtyLen reads 0 — byte-identical to a
// genuinely clean composer. `unconfirmedDeliveryMs` (pty/host.ts `getPendingConfirmMs`) exists to give a
// manager a signal DURING that exact window: milliseconds elapsed since the current generation's Enter was
// written, non-null the INSTANT a write is outstanding, with no dependency on the give-up budget firing.
//
// WHAT THIS TEST PROVES (three states, matching the card's own DoD ask):
//   (1) IN-FLIGHT, UNCONFIRMED: right after a write, unconfirmedDeliveryMs is already a growing number
//       while composerDirtyLen is STILL 0 — the exact blind window, closed. Sampled twice with a real
//       sleep between to prove it's live elapsed time, not a stuck flag.
//   (1B) GIVE-UP FIRED, OUTCOME UNKNOWN: the SAME session, driven through a full give-up (mirroring
//        worker-composer-dirty-signal.mjs's technique) — unconfirmedDeliveryMs stays non-null (does NOT
//        reset on give-up), verifying in code the documented limitation at the getter's own doc comment:
//        this field alone cannot tell "still retrying" from "already gave up" for one generation. A
//        comment asserting this without a test proving it is exactly the class of claim this project's
//        own doctrine (memory a-comment-is-a-claim-grep-them-when-you-fix) distrusts by default.
//   (2) CONFIRMED LANDED: a real UserPromptSubmit hook flips enterConfirmed true — unconfirmedDeliveryMs
//       reads null, even though the turn is still busy/running (the "healthy, mid-turn" shape).
//   (3)/(4)/(5): never-submitted, not-live-in-process, and no-PtyHost-wired all read null (never a
//   fabricated number) — the same null-vs-measured discipline getComposerDirtyLen already established.
//
// NO give-up/retry budget constant is touched by the change under test — this file only PROVES that,
// via scenario (1B): the give-up timing (env-pinned small, same technique/knobs as
// worker-composer-dirty-signal.mjs / pty-giveup-clear.mjs) is exercised unmodified from production shape,
// only sped up for the test.
//
// HERMETIC: a REAL PtyHost driven by a FAKE pty injected via the createPty() seam (see
// _seam-host-fixture.mjs) — no real claude, no daemon — wired into a REAL OrchestrationMcpRouter, same
// technique as worker-composer-dirty-signal.mjs.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-unconfirmed-delivery-signal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pollUntil } from "./_timing-guard.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Hermetic LOOM_HOME — set BEFORE any dist/ import (paths.ts/host.ts read it at module-top-level). ---
const tmpHome = path.join(os.tmpdir(), `loom-unconfirmed-delivery-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

// Give-up timing, pinned small — mirrors worker-composer-dirty-signal.mjs / pty-giveup-clear.mjs exactly
// (this fake pty never confirms anything on its own, so every bounded wait below always maxes out its
// bound for scenario 1B's own give-up).
const ENTER_DELAY = 50;
const VERIFY_TIMEOUT = 600;
const MAX_ATTEMPTS = 3;
const SETTLE_POLL = 10;
const SETTLE_MAX_POLLS = 5;
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 5;
const HOLD_MS = 10;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);

// Card 259c15fa (see pty-giveup-clear.mjs): real give-up completion is a chain of setTimeout hops that
// routinely overshoots a hand-computed sum — poll for the OBSERVED busy=false transition instead of a
// fixed sleep.
const GIVE_UP_POLL_MS = 20;
const GIVE_UP_POLL_TIMEOUT_MS = 15_000;
// Retrofitted onto the shared _wait.mjs waitUntil (card c9bba0b2): same GIVE_UP_POLL_TIMEOUT_MS budget,
// anchored to the SAME external t0 (remaining budget = GIVE_UP_POLL_TIMEOUT_MS minus elapsed since t0,
// never a fresh timer from this call). Never returns the observed value — every call site reads busyLog
// directly afterward via its own check() — so a genuine timeout is swallowed exactly as before; only a
// non-timeout error (a real bug) now propagates instead of being silently absorbed by the old while loop.
async function waitForBusyFalse(busyLog, sessionId, t0) {
  const remainingMs = Math.max(0, GIVE_UP_POLL_TIMEOUT_MS - (Date.now() - t0));
  try {
    await sharedWaitUntil(() => busyLog[sessionId]?.at(-1) === false, { timeoutMs: remainingMs, intervalMs: GIVE_UP_POLL_MS, label: "worker-unconfirmed-delivery-signal: busy fell back to false" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
  }
}

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

const dbFile = path.join(os.tmpdir(), `loom-unconfirmed-delivery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const seededActivity = "2026-08-04T12:00:00.000Z";
const projId = "proj-unconfirmed-delivery";
const agentId = "agent-unconfirmed-delivery";
db.insertProject({ id: projId, name: "UnconfirmedDelivery", repoPath: projId, vaultPath: projId, config: {}, createdAt: seededActivity, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });
db.insertSession({ id: "w-inflight", projectId: projId, agentId, engineSessionId: "eng-w-inflight", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-inflight" });
db.insertSession({ id: "w-confirmed", projectId: projId, agentId, engineSessionId: "eng-w-confirmed", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-confirmed" });
db.insertSession({ id: "w-fresh", projectId: projId, agentId, engineSessionId: "eng-w-fresh", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-fresh" });
db.insertSession({ id: "w-not-in-pty", projectId: projId, agentId, engineSessionId: "eng-w-other", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-other" });

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
  const client = new Client({ name: `unconfirmed-delivery-test-${sessionId}`, version: "0" });
  await client.connect(clientT);
  const parse = (res) => JSON.parse(res.content[0].text);
  return { call: async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} })) };
}

const mgrClient = await connectAs("mgr", "manager");

try {
  // ============== (1) IN-FLIGHT, UNCONFIRMED — the blind window, closed ==============
  {
    const SID = "w-inflight";
    const TEXT = "IN_FLIGHT_TEXT_NOT_YET_CONFIRMED";
    spawnReady(host, SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, TEXT);
    check("(1) setup: idle-submit delivered, busy armed", r.delivered === true && busyLog[SID]?.at(-1) === true);

    // Deterministic settlement: poll for the real completion signal (currentGenFirstWrittenAt actually
    // stamped by fireEnterAndVerify's attempt===1) instead of a guessed fixed sleep.
    const gotFirstReading = await pollUntil(() => host.getPendingConfirmMs(SID) != null, { timeoutMs: VERIFY_TIMEOUT, intervalMs: 10 });
    check("(1) getPendingConfirmMs becomes non-null once the first Enter attempt is written (bounded poll didn't time out)", gotFirstReading);

    const first = host.getPendingConfirmMs(SID);
    check("(1) PtyHost level: getPendingConfirmMs is a real elapsed-ms NUMBER, not a boolean/marker", typeof first === "number" && first >= 0);
    check("(1) THE BLIND WINDOW: composerDirtyLen is STILL 0 here — give-up has not fired yet", host.getComposerDirtyLen(SID) === 0);
    check("(1) genuinely in flight: busy is still true (no give-up has resolved this generation)", busyLog[SID]?.at(-1) === true);

    // Prove it's LIVE elapsed time, not a stuck flag: a second reading after a real sleep must be larger.
    // TIMING-GUARD-FALSE-MATCH: keyword-in-methodology-aside — NEG_KEYWORDS' bare "not" below matches inside
    // the label's methodology parenthetical ("proves it's elapsed time, not a static marker"), which
    // describes HOW the claim is proven, not the claim's own polarity. The assertion itself
    // (`typeof second === "number" && second > first`) is POSITIVE-polarity and fails loudly on a
    // static/wrong-typed value — this 40ms wait IS the quantity under test, not a guessed duration (card
    // 1c5dda5d).
    await sleep(40);
    const second = host.getPendingConfirmMs(SID);
    check("(1) getPendingConfirmMs is monotonically increasing across a real sleep (proves it's elapsed time, not a static marker)",
      typeof second === "number" && second > first);

    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === SID);
    check("(1) worker_list: unconfirmedDeliveryMs is a non-null NUMBER while composerDirtyLen reads 0 — the blind window, visible over MCP",
      typeof row?.unconfirmedDeliveryMs === "number" && row.unconfirmedDeliveryMs >= 0 && row.composerDirtyLen === 0);

    const status = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(1) worker_status: same shape (non-null unconfirmedDeliveryMs, composerDirtyLen still 0)",
      typeof status?.unconfirmedDeliveryMs === "number" && status.composerDirtyLen === 0);

    const workerClient = await connectAs(SID, "worker");
    const ctx = await workerClient.call("my_context");
    check("(1) my_context (self-check as the in-flight worker): unconfirmedDeliveryMs is non-null too",
      typeof ctx?.unconfirmedDeliveryMs === "number");

    // ============== (1B) GIVE-UP FIRED, OUTCOME UNKNOWN — same SID, driven to a real give-up ==============
    // Verifies IN CODE the getter's own documented limitation: give-up does not reset enterConfirmed or
    // currentGenFirstWrittenAt, so unconfirmedDeliveryMs must stay non-null straight through it.
    await waitForBusyFalse(busyLog, SID, t0);
    check("(1B) GIVE-UP RECOVERY landed: busy fell back to false (bounded poll didn't time out)", busyLog[SID]?.at(-1) === false);
    check("(1B) composerDirtyLen is now non-zero — give-up actually fired for this generation", host.getComposerDirtyLen(SID) === TEXT.length);
    const afterGiveUp = host.getPendingConfirmMs(SID);
    check("(1B) unconfirmedDeliveryMs is STILL a non-null number after give-up — it does NOT reset on give-up (the documented ambiguity, proven, not just asserted)",
      typeof afterGiveUp === "number" && afterGiveUp >= second);

    const list2 = await mgrClient.call("worker_list");
    const row2 = list2.find((w) => w.workerSessionId === SID);
    check("(1B) worker_list: both signals now non-zero/non-null simultaneously — exactly the ambiguous pair the getter's doc names",
      typeof row2?.unconfirmedDeliveryMs === "number" && row2.composerDirtyLen === TEXT.length);
  }

  // ============== (2) CONFIRMED LANDED — a real confirming hook makes it go null ==============
  {
    const SID = "w-confirmed";
    spawnReady(host, SID);
    const r = host.enqueueStdin(SID, "hello from a healthy worker");
    check("(2) setup: idle-submit delivered, busy armed", r.delivered === true && busyLog[SID]?.at(-1) === true);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" }); // confirms — enterConfirmed:true

    check("(2) PtyHost level: getPendingConfirmMs reads null once confirmed", host.getPendingConfirmMs(SID) === null);
    check("(2) still genuinely mid-turn: busy is true (turn ongoing, not idle-because-stuck)", busyLog[SID]?.at(-1) === true);

    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === SID);
    check("(2) worker_list: unconfirmedDeliveryMs is null on a confirmed, healthy mid-turn session", row?.unconfirmedDeliveryMs === null);

    const status = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(2) worker_status: same null", status.unconfirmedDeliveryMs === null);

    const workerClient = await connectAs(SID, "worker");
    const ctx = await workerClient.call("my_context");
    check("(2) my_context (self-check as the confirmed worker itself): unconfirmedDeliveryMs is null", ctx.unconfirmedDeliveryMs === null);

    host.deliverHook(SID, { hook_event_name: "Stop" }); // end the turn cleanly
  }

  // ============== (3) NEVER SUBMITTED — a fresh spawn with no outstanding write ==============
  {
    const SID = "w-fresh";
    spawnReady(host, SID);
    check("(3) PtyHost level: a fresh spawn with no submit() ever called reads null (nothing outstanding)", host.getPendingConfirmMs(SID) === null);
    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === SID);
    check("(3) worker_list: same null for a never-submitted session", row?.unconfirmedDeliveryMs === null);
  }

  // ============== (4) NULL for a session not live in THIS PtyHost process ==============
  {
    const list = await mgrClient.call("worker_list");
    const other = list.find((w) => w.workerSessionId === "w-not-in-pty");
    check("(4) worker_list: a worker never spawned in this process reads unconfirmedDeliveryMs:null", other && other.unconfirmedDeliveryMs === null);

    const status = await mgrClient.call("worker_status", { workerSessionId: "w-not-in-pty" });
    check("(4) worker_status: same null", status.unconfirmedDeliveryMs === null);

    const ctx = await mgrClient.call("my_context"); // the manager's own my_context, before it's ever spawned in this PtyHost
    check("(4) my_context: a caller not live in this process reads unconfirmedDeliveryMs:null too", ctx.unconfirmedDeliveryMs === null);
  }

  // ============== (5) byte-compat: a router built the OLD way (no pty arg) still works ==============
  {
    const routerNoPty = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
    const server = routerNoPty.buildServer("mgr", "manager");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "unconfirmed-delivery-nopty-test", version: "0" });
    await client.connect(clientT);
    const list = JSON.parse((await client.callTool({ name: "worker_list", arguments: {} })).content[0].text);
    check("(5) a router with no PtyHost wired still returns worker_list without throwing", Array.isArray(list) && list.length === 4);
    check("(5) every row reads unconfirmedDeliveryMs:null when no PtyHost was wired", list.every((w) => w.unconfirmedDeliveryMs === null));
  }
} finally {
  for (const sid of ["w-inflight", "w-confirmed", "w-fresh"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  db.close();
  try { fs.rmSync(dbFile, { force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — unconfirmedDeliveryMs (pty/host.ts's getPendingConfirmMs, card a33a72f7) closes the composerDirtyLen blind window: non-null the instant a write is outstanding (while composerDirtyLen is still 0), stays non-null straight through a real give-up (proving the documented cross-signal ambiguity in code, not just in a comment), reads null once a confirming hook lands, null for a never-submitted session, null for a session not live in this process, and byte-compatible on a router built without a PtyHost."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
