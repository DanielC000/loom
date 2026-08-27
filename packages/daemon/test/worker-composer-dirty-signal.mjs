import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_list/worker_status/my_context composerDirtyLen PULL-read test (card dcd8659c).
//
// SYMPTOM this closes: 2026-08-01 the owner twice spotted, BY EYE, text sitting unsubmitted in a
// session's terminal — no manager-visible field caught it (busy read true, lastEngineOutputAt advanced,
// turnSeq:0 is normal for a healthy first turn). The daemon already logs the state in its own words
// ("composer possibly dirty from an earlier unconfirmed give-up (N chars)") but never exposed it via a
// tool. FIX: surface `Live.composerDirtyLen` (pty/host.ts, card 3ce3fa39) on worker_list/worker_status
// (third-party, for a manager checking a worker) AND my_context (self-check, for a manager/worker
// checking itself) — a synchronous PULL read, never riding submit()/enqueueStdin/drainPending/the pty.
//
// THE SHARPEST QUESTION THIS TEST ANSWERS: is the field actually non-zero and READABLE during the
// window a manager would check it — i.e. AFTER a give-up fires and BEFORE anything ever resolves it
// (the defining property of a truly stuck session: nothing further arrives, and no confirming hook for
// this generation ever lands either)? Traced in pty/host.ts: composerDirtyLen is SET synchronously the
// moment a give-up/heal-if-stuck fires (line ~5689/5731/5109). It CLEARS via either of TWO independent,
// gated paths: (a) a SUBSEQUENT submit()'s own defensive clear-prefix going on to CONFIRM
// (composerDirtyLenClearedByGen gates the reset, ~line 4014/4191), or (b) card b932558c's
// `clearComposerDirtyOnConfirm` — a confirming hook for THIS generation resolving through
// `purgeConfirmedGiveUpRequeue` itself (content-match or its FIFO-position fallback), gated on
// `composerDirtyMarkedGens` (card a6c1d413's per-generation map — see pty-giveup-composerdirty-confirmed-
// clear.mjs and pty-composerdirtymarkedgens-per-generation.mjs for that path's own coverage). Scenario (2)
// below exercises NEITHER path — it drives a genuine give-up (mirroring
// test/pty-giveup-clear.mjs's technique) on session SID, then DELIBERATELY never calls host.reconcile()
// AND never delivers any confirming hook for SID at all, observing the value across a bounded window —
// backed by a REQUIRED positive control that proves, on a SEPARATE session/PtyHost instance, that the
// identical sampling mechanism CAN observe a real clear (drives a redrain + confirms it via a real hook)
// — so a "the field just happens to look non-zero because nothing tried to clear it" reading is ruled
// out: the same instrument demonstrably CAN see it flip to 0, and does not, on SID.
//
// DISCRIMINATOR (card DoD-4): scenario (1) exercises a HEALTHY, mid-first-turn session (enqueued +
// CONFIRMED via a real UserPromptSubmit hook, busy genuinely true, nothing ever gives up) and asserts
// composerDirtyLen reads exactly 0 there — never a false positive on a session that is actually fine.
//
// NULL vs 0 (card DoD-3): scenario (3) asserts a session not live in this PtyHost process reads
// composerDirtyLen:null (unknown), never 0 (a DIFFERENT claim — "composer is clean") — the absent-signal-
// read-as-measured-zero bug this whole card exists to prevent.
//
// HERMETIC: a REAL PtyHost driven by a FAKE pty injected via the createPty() seam (see
// _seam-host-fixture.mjs) — no real claude, no daemon — wired into a REAL OrchestrationMcpRouter, same
// technique as worker-liveness-signal.mjs. The give-up-driving technique (env-pinned fast timeouts, wait
// for the observed busy=false transition) is lifted directly from pty-giveup-clear.mjs.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-composer-dirty-signal.mjs
//
// EXTENDED for card c148f118: composerDirtyLen alone cannot tell "a defensive clear worked, the repaste
// after it just hasn't confirmed" from "the clear did nothing" — see pty-composer-dirty-believed.mjs for
// the host.ts-layer proof of the new composerDirtyLenBelieved (optimistic) counterpart and the genuine
// divergence case. THIS file's job is narrower but load-bearing on its own: prove the VALUE actually
// reaches worker_list/worker_status/my_context, not just the PtyHost getter — a router that silently drops
// the field from its response shape would leave this card's updated tool docs (which now instruct a
// reader to "read the two together") teaching a comparison the reader cannot perform. Scenarios (1)/(3)/(4)
// below assert composerDirtyLenBelieved alongside every existing composerDirtyLen assertion; scenario (2)'s
// give-up never attempts a defensive clear (TEXT is SID's first-ever message), so the two fields track in
// lockstep there rather than diverging — asserting the exact VALUE anyway is what proves the wiring, not
// merely that the key exists.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNeverWithControl, observeOnce } from "./_timing-guard.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Hermetic LOOM_HOME — set BEFORE any dist/ import (paths.ts/host.ts read it at module-top-level). ---
const tmpHome = path.join(os.tmpdir(), `loom-composerdirty-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

// Give-up timing, pinned small — mirrors pty-giveup-clear.mjs exactly (see that file for why each knob
// exists; this fake pty never confirms anything on its own, so every bounded wait below always maxes out
// its bound). GIVE_UP_HOLD_MS is pinned small too, so the positive control's own redrain (scenario 2's
// `proveClearMechanismWorks`) doesn't need to wait the 20s production default.
// Card 733e1403 audit of this file's TWO `windowMs` sites (both feed `_timing-guard.mjs`, not a bare
// sleep): injection-tested by delaying every production verify-timeout `setTimeout` (host.ts's
// `sendEnterAndVerify`, the `ms === SUBMIT_VERIFY_TIMEOUT_MS` calls — here pinned to 600) by 8x, confirmed
// real and consequential by wall-clock (this file's own run: ~7.4s unmodified -> ~32.6s injected, ~4.4x,
// matching the two give-up chains — SID's and the positive control's — each paying 3 attempts x
// (4800-600)ms of extra delay) — NOT by a single check flipping, since none needed to for either site to
// be proven safe. Pushed to 9x as a SEPARATE control run (never committed) to confirm the harness CAN fail
// loud under enough delay — at 9x, `waitForBusyFalse`'s own 15s poll bound is exceeded and
// `assertNeverWithControl` correctly THROWS ("positive control did NOT observe check() go true") rather
// than silently passing — proving the 8x null above is a genuine null, not a vacuous one.
// (1) Line ~181's `observeOnce({..., windowMs: VERIFY_TIMEOUT})` inside `proveClearMechanismWorks`: proven
// safe by construction, not injection-dependent at all — the reset it polls for
// (`composerDirtyLenClearedByGen === submitGeneration`) is stamped SYNCHRONOUSLY inside `deliverHook`
// itself (see the comment two lines above that call), never behind the delayed `SUBMIT_VERIFY_TIMEOUT_MS`
// timer, so `check()` is already true on `observeOnce`'s first (pre-wait) poll regardless of how late that
// timer fires.
// (2) Line ~250's `assertNeverWithControl` (the real negative assertion, `windowMs: VERIFY_TIMEOUT *
// (MAX_ATTEMPTS + 1)`): proven safe under 8x — held throughout, mandatory positive control fired correctly
// — because give-up structurally never writes anything that could flip `composerDirtyLen` away from the
// stranded length on its own (confirmed by scenario 2's own later assertion, and by the mirror case in
// worker-flush-composer.mjs's scenario 3), so the check's OUTCOME cannot depend on WHEN the delayed give-up
// timer fires, only on whether it fires at all — mechanism (2) from 6d53b02b's audit (a verdict decided by
// already-fixed state is invariant to callback timing). Not converted (converting would be symmetry, not a
// fix — see 1aabf969's identical finding on codescape-health-probe.mjs).
const ENTER_DELAY = 50;
const VERIFY_TIMEOUT = 600;
const MAX_ATTEMPTS = 3;
const SETTLE_POLL = 10;
const SETTLE_MAX_POLLS = 5;
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 5;
const HOLD_MS = 10;
const HOLD_WAIT = HOLD_MS + 20;
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
    await sharedWaitUntil(() => busyLog[sessionId]?.at(-1) === false, { timeoutMs: remainingMs, intervalMs: GIVE_UP_POLL_MS, label: "worker-composer-dirty-signal: busy fell back to false" });
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

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const fake = { ...base, write: () => {} };
    fakes.push(fake);
    return fake;
  }
}

const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {},
  onRateLimited() {}, onExit() {},
};

const dbFile = path.join(os.tmpdir(), `loom-composerdirty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const seededActivity = "2026-08-01T12:00:00.000Z";
const projId = "proj-composerdirty";
const agentId = "agent-composerdirty";
db.insertProject({ id: projId, name: "ComposerDirty", repoPath: projId, vaultPath: projId, config: {}, createdAt: seededActivity, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });
db.insertSession({ id: "w-healthy", projectId: projId, agentId, engineSessionId: "eng-w-healthy", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-healthy" });
db.insertSession({ id: "w-give-up", projectId: projId, agentId, engineSessionId: "eng-w-give-up", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-give-up" });
db.insertSession({ id: "w-not-in-pty", projectId: projId, agentId, engineSessionId: "eng-w-other", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-other" });

const sessionsStub = {
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; },
  async getDanglingWorkers() { return []; },
};

// `reconcile()` sweeps EVERY live session's pending queue on the HOST INSTANCE IT'S CALLED ON — global to
// that instance, not scoped to one session. Scenario (2)'s whole point is that SID's give-up entry is
// NEVER redrained (no further write ever arrives), so the positive control below runs its own redrain on
// a SEPARATE PtyHost instance (`proveClearMechanismWorks`'s own `controlHost`) — calling reconcile() there
// can never touch SID's still-held entry on the main `host`.
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
  const client = new Client({ name: `composer-dirty-test-${sessionId}`, version: "0" });
  await client.connect(clientT);
  const parse = (res) => JSON.parse(res.content[0].text);
  return { call: async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} })) };
}

const mgrClient = await connectAs("mgr", "manager");

// POSITIVE CONTROL for scenario (2): proves the SAME sampling mechanism (`observeOnce`, the one
// `assertNeverWithControl` uses internally for the real run) CAN observe composerDirtyLen actually
// clearing to 0 — on its OWN isolated PtyHost instance/session, never touching the main `host`/SID. Drives
// a real give-up, then a real redrain (reconcile()) whose own Enter is confirmed via a genuine
// UserPromptSubmit hook — the exact `composerDirtyLenClearedByGen === submitGeneration` gate (host.ts
// ~4007) that resets the field to 0.
async function proveClearMechanismWorks() {
  const CTRL = "w-control-clear-proof";
  const CTRL_TEXT = "CONTROL_STRANDED_TEXT_FOR_CLEAR_PROOF";
  const controlHost = new TestPtyHost(events);
  try {
    spawnReady(controlHost, CTRL);
    const t0 = Date.now();
    const r = controlHost.enqueueStdin(CTRL, CTRL_TEXT);
    if (!r.delivered) return false;
    await waitForBusyFalse(busyLog, CTRL, t0);
    if (controlHost.getComposerDirtyLen(CTRL) !== CTRL_TEXT.length) return false; // sanity: control genuinely went dirty first
    await sleep(HOLD_WAIT); // past GIVE_UP_HOLD_MS — the requeued entry is no longer held from drain
    controlHost.reconcile(); // redrains the held entry: submit() stamps composerDirtyLenClearedByGen synchronously, before any async write completes
    controlHost.deliverHook(CTRL, { hook_event_name: "UserPromptSubmit" }); // confirms THIS redrain's Enter -> gate matches -> resets to 0
    return await observeOnce({
      check: () => controlHost.getComposerDirtyLen(CTRL) === 0,
      windowMs: VERIFY_TIMEOUT,
    });
  } finally {
    try { controlHost.stop(CTRL, "hard"); } catch { /* ignore */ }
  }
}

try {
  // ===================== (1) DISCRIMINATOR: a HEALTHY, mid-first-turn session never false-positives =====
  {
    spawnReady(host, "w-healthy");
    const r = host.enqueueStdin("w-healthy", "hello from a healthy worker");
    check("(1) setup: idle-submit delivered, busy armed", r.delivered === true && busyLog["w-healthy"]?.at(-1) === true);
    // Confirm it via a REAL UserPromptSubmit hook — enterConfirmed:true — so give-up's own trigger
    // condition (composerDirtyLen marking is gated on `!live.enterConfirmed`, host.ts ~5096/5688/5731)
    // structurally cannot apply. This is the "turnSeq:0, healthy" shape memory f91c8634 names as the one
    // every OTHER signal false-reads as fine.
    host.deliverHook("w-healthy", { hook_event_name: "UserPromptSubmit" });
    check("(1) PtyHost level: getComposerDirtyLen reads exactly 0 on a healthy confirmed turn", host.getComposerDirtyLen("w-healthy") === 0);
    // Card c148f118: getComposerDirtyLenBelieved (the optimistic counterpart) must track composerDirtyLen
    // in lockstep here too — a healthy session never had anything to be ambiguous about.
    check("(1) PtyHost level: getComposerDirtyLenBelieved reads exactly 0 too", host.getComposerDirtyLenBelieved("w-healthy") === 0);
    check("(1) genuinely mid-turn: busy is true (turn ongoing, not idle-because-stuck)", busyLog["w-healthy"]?.at(-1) === true);

    const list = await mgrClient.call("worker_list");
    const healthyRow = list.find((w) => w.workerSessionId === "w-healthy");
    check("(1) worker_list: composerDirtyLen is 0 (a NUMBER, not null) on a healthy live session", healthyRow?.composerDirtyLen === 0);
    check("(1) worker_list: composerDirtyLenBelieved is 0 (a NUMBER, not null) too — card c148f118's wiring",
      healthyRow?.composerDirtyLenBelieved === 0);

    const status = await mgrClient.call("worker_status", { workerSessionId: "w-healthy" });
    check("(1) worker_status: composerDirtyLen is 0 on the same healthy session", status.composerDirtyLen === 0);
    check("(1) worker_status: composerDirtyLenBelieved is 0 too", status.composerDirtyLenBelieved === 0);

    const workerClient = await connectAs("w-healthy", "worker");
    const ctx = await workerClient.call("my_context");
    check("(1) my_context (self-check as w-healthy): composerDirtyLen is 0", ctx.composerDirtyLen === 0);
    check("(1) my_context (self-check as w-healthy): composerDirtyLenBelieved is 0 too", ctx.composerDirtyLenBelieved === 0);

    // End the turn cleanly so it doesn't interfere with later scenarios.
    host.deliverHook("w-healthy", { hook_event_name: "Stop" });
  }

  // ===================== (2) THE SHARPEST QUESTION: a genuine give-up, then NOTHING further arrives ======
  // ===================== — composerDirtyLen must stay non-zero and readable, not require a later write ===
  {
    const SID = "w-give-up";
    const TEXT = "STRANDED_KICKOFF_TEXT_NEVER_CONFIRMED"; // 38 chars
    spawnReady(host, SID);
    const t0 = Date.now();
    const r = host.enqueueStdin(SID, TEXT);
    check("(2) setup: idle-submit delivered, busy armed", r.delivered === true && busyLog[SID]?.at(-1) === true);

    // Never deliver any confirming hook — this drives the exact GIVE-UP RECOVERY path pty-giveup-clear.mjs
    // exercises. Wait for the OBSERVED busy=false transition (bounded poll, not a fixed sleep).
    await waitForBusyFalse(busyLog, SID, t0);
    check("(2) GIVE-UP RECOVERY landed: busy fell back to false (bounded poll didn't time out)", busyLog[SID]?.at(-1) === false);

    check("(2) PtyHost level: getComposerDirtyLen is now the exact stranded length, set SYNCHRONOUSLY at give-up (no later write needed)",
      host.getComposerDirtyLen(SID) === TEXT.length);
    // Card c148f118: THIS give-up never attempted a defensive clear (TEXT is the FIRST message ever sent
    // to SID, so composerDirtyLen started at 0 and the plain-write branch fired, not the clear branch) —
    // so composerDirtyLenBelieved tracks composerDirtyLen in lockstep here, NOT diverging. That is itself
    // a real assertion (the field must equal composerDirtyLen exactly, not merely be non-null) — the
    // genuine divergence case (a defensive clear attempted, then also unconfirmed) is covered at the
    // host.ts layer by pty-composer-dirty-believed.mjs's own scenario (3); this file's job is proving the
    // VALUE — whichever it is — actually reaches the MCP surface, which the assertions below do either way.
    check("(2) PtyHost level: getComposerDirtyLenBelieved is the exact stranded length too (no clear was attempted here)",
      host.getComposerDirtyLenBelieved(SID) === TEXT.length);

    const list1 = await mgrClient.call("worker_list");
    const row1 = list1.find((w) => w.workerSessionId === SID);
    check("(2) worker_list surfaces the exact stranded length right after give-up", row1?.composerDirtyLen === TEXT.length);
    check("(2) worker_list surfaces the same value for composerDirtyLenBelieved — card c148f118's wiring, not just the getter",
      row1?.composerDirtyLenBelieved === TEXT.length);
    check("(2) the session reads busy:false here — this IS the 'idle, no further writes' shape the card is about", row1?.busy === false);

    // THE CRITICAL STEP: deliberately never call host.reconcile() and never enqueue anything further for
    // SID — that's the one thing that would trigger the NEXT submit()'s defensive clear-prefix and
    // eventually (only on ITS OWN confirmation) reset the field. Observe across a bounded window DERIVED
    // from the give-up timing constants above (long enough to cover a full further retry/give-up cycle
    // if the field were wrongly re-armed or cleared on its own) — backed by the REQUIRED positive control
    // (proveClearMechanismWorks) which proves this exact sampling mechanism CAN see a real clear, on a
    // fully separate session/host instance.
    const stayedDirty = await assertNeverWithControl({
      label: "(2) composerDirtyLen changes on its own with no further write to SID",
      check: () => host.getComposerDirtyLen(SID) !== TEXT.length,
      windowMs: VERIFY_TIMEOUT * (MAX_ATTEMPTS + 1),
      positiveControl: proveClearMechanismWorks,
    });
    check("(2) composerDirtyLen holds the exact stranded length throughout the observation window — the positive control proved the SAME instrument CAN see a real clear, and it never fired here",
      stayedDirty);

    const list2 = await mgrClient.call("worker_list");
    const row2 = list2.find((w) => w.workerSessionId === SID);
    check("(2) worker_list: reads the exact stranded length AFTER the observation window too — the read a manager would make during the stuck window sees a real, persisted value",
      row2?.composerDirtyLen === TEXT.length);
    check("(2) worker_list: composerDirtyLenBelieved also persists at the same value after the observation window",
      row2?.composerDirtyLenBelieved === TEXT.length);

    const status = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(2) worker_status: same value", status.composerDirtyLen === TEXT.length);
    check("(2) worker_status: composerDirtyLenBelieved matches too", status.composerDirtyLenBelieved === TEXT.length);

    const workerClient = await connectAs(SID, "worker");
    const ctx = await workerClient.call("my_context");
    check("(2) my_context (self-check as the stuck worker itself): composerDirtyLen is the same value", ctx.composerDirtyLen === TEXT.length);
    check("(2) my_context: composerDirtyLenBelieved matches too — THE CARD'S ACCEPTANCE TEST, proven at the MCP surface a manager/worker actually reads, not just at the host.ts layer",
      ctx.composerDirtyLenBelieved === TEXT.length);
  }

  // ===================== (3) NULL vs 0: a session not live in THIS PtyHost process =====================
  {
    const list = await mgrClient.call("worker_list");
    const other = list.find((w) => w.workerSessionId === "w-not-in-pty");
    check("(3) worker_list: a worker never spawned in this process reads composerDirtyLen:null (unknown), never 0", other && other.composerDirtyLen === null);
    // Card c148f118: the SAME null-vs-0 discipline must hold for composerDirtyLenBelieved — undefined
    // (not live) collapses to null, exactly like composerDirtyLen, never a measured-clean 0.
    check("(3) worker_list: composerDirtyLenBelieved is null too (never collapsed to a measured 0)", other && other.composerDirtyLenBelieved === null);

    const status = await mgrClient.call("worker_status", { workerSessionId: "w-not-in-pty" });
    check("(3) worker_status: same null (unknown, not a measured-clean 0)", status.composerDirtyLen === null);
    check("(3) worker_status: composerDirtyLenBelieved is null too", status.composerDirtyLenBelieved === null);

    // The manager's own my_context, before the manager itself is ever spawned in this PtyHost.
    const ctx = await mgrClient.call("my_context");
    check("(3) my_context: a caller not live in this process reads composerDirtyLen:null too", ctx.composerDirtyLen === null);
    check("(3) my_context: composerDirtyLenBelieved is null too", ctx.composerDirtyLenBelieved === null);
  }

  // ===================== (4) byte-compat: a router built the OLD way (no pty arg) still works =====================
  {
    const routerNoPty = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
    const server = routerNoPty.buildServer("mgr", "manager");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "composer-dirty-nopty-test", version: "0" });
    await client.connect(clientT);
    const list = JSON.parse((await client.callTool({ name: "worker_list", arguments: {} })).content[0].text);
    check("(4) a 3-arg (no pty) router still returns worker_list without throwing", Array.isArray(list) && list.length === 3);
    check("(4) every row reads composerDirtyLen:null when no PtyHost was wired", list.every((w) => w.composerDirtyLen === null));
    check("(4) every row reads composerDirtyLenBelieved:null too — card c148f118's wiring stays byte-compatible with no PtyHost",
      list.every((w) => w.composerDirtyLenBelieved === null));
  }
} finally {
  for (const sid of ["w-healthy", "w-give-up"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  db.close();
  try { fs.rmSync(dbFile, { force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — composerDirtyLen (pty/host.ts's Live.composerDirtyLen, card 3ce3fa39) is surfaced read-only on worker_list/worker_status/my_context; a healthy confirmed turn never false-positives (reads 0); a genuine give-up marks it non-zero SYNCHRONOUSLY and it holds that value with NO further write ever arriving (the stuck-forever case), proven against a positive control that shows the same instrument CAN see a real clear; a session not live in this process reads null, never 0; a router built without a PtyHost stays byte-compatible."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
