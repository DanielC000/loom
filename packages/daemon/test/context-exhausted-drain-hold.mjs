import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 66ff7321 (part C of 8c7dfc65), Addition A — the DRAIN HAZARD: once a session is marked
// context-exhausted, clearing `busy` must NOT let a queued message drain into the dead turn. Drives a
// REAL PtyHost (fake pty via the createPty() seam, _seam-host-fixture.mjs — no real claude, no daemon).
//
// Proves:
//   (1) a message enqueued WHILE busy queues normally (pre-existing behaviour, unaffected).
//   (2) markContextExhausted clears busy AND sets live.contextExhausted — observable via getPendingQueueDepth
//       staying put and the queued message never being handed to the fake pty's write().
//   (3) a FURTHER message enqueued AFTER exhaustion is marked is ALSO held (queued), never delivered
//       immediately — even though `busy` now reads false (idleEligible's own !live.contextExhausted gate).
//   (4) PtyHost.reconcile() — the periodic safety net that unconditionally calls drainPending for every
//       live claude session — does NOT flush the held queue while contextExhausted is set (drainPending's
//       own guard). The queue depth is UNCHANGED across a reconcile() call, and the fake pty's write()
//       is never invoked with the held text.
//   (5) DB-level clear (`Db.clearContextExhaustedOnResume`): stamped, then cleared on a call mirroring
//       the rising-edge chokepoint (SessionService.handleBusyEdge busy=true), and the GUARD — a row that
//       was NEVER exhausted keeps its own (unrelated) lastError completely untouched by the same call;
//       round 2 adds a SECOND guard — a row re-exhausted-then-overwritten-by-something-else keeps that
//       UNRELATED LATER lastError untouched too (the prefix match, not just the WHERE clause).
//   (6) a fresh UserPromptSubmit rising edge clears the in-memory hold end-to-end.
//   (7) round 2 (CR finding, mutant B2): an exhausted session with an EMPTY pending queue — the ONE
//       shape (3) above can't exercise — still holds a new enqueue (no write, depth 1).
//   (8) round 2 (CR finding): a HUMAN_COMPOSER_SENDER_ID entry delivers despite exhaustion (a human
//       acting IS the recovery); an ordinary agent-kind entry on an identical setup stays held.
//   (8c) round 3 (CR finding, Major 1): the round-2 exemption above only ever mattered on an EMPTY
//       queue — with a PRE-HELD agent entry already queued, a composer entry still delivers immediately
//       (bypassing FIFO, since nothing ahead of it could ever drain while exhausted anyway), and the
//       pre-held entry stays held — then drains normally once the composer's own turn completes.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/context-exhausted-drain-hold.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME — set BEFORE any dist/ import (paths.ts/host.ts read it at module-top-level). ---
const tmpHome = path.join(os.tmpdir(), `loom-ctxexh-drain-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost, HUMAN_COMPOSER_SENDER_ID } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");

const writes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    return { ...base, write: (data) => { writes.push({ sessionId: opts.sessionId, data }); } };
  }
}

const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {},
  onRateLimited() {}, onExit() {},
};

const host = new TestPtyHost(events);
function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

try {
  const SID = "wkr-drain-hold";
  spawnReady(SID);

  // ===== (1) baseline: first enqueue delivers immediately (idle), second queues (busy) =====
  const r1 = host.enqueueStdin(SID, "FIRST_TURN_TEXT");
  check("(1) first enqueue (idle) delivers immediately, busy armed", r1.delivered === true && busyLog[SID]?.at(-1) === true);
  const r2 = host.enqueueStdin(SID, "QUEUED_WHILE_BUSY", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-2");
  check("(1) second enqueue while busy is HELD (pre-existing behaviour, unaffected)", r2.delivered === false);
  check("(1) pendingQueueDepth is 1", host.getPendingQueueDepth(SID) === 1);

  // ===== (2) mark context-exhausted =====
  const marked = host.markContextExhausted(SID);
  check("(2) markContextExhausted returns true for this live claude session", marked === true);
  check("(2) busy is now false (the ordinary falling-edge path)", busyLog[SID]?.at(-1) === false);
  check("(2) the already-queued message was NOT drained as a side effect of clearing busy", host.getPendingQueueDepth(SID) === 1);
  check("(2) the fake pty's write() was never called with the held text (no delivery happened)",
    !writes.some((w) => w.sessionId === SID && typeof w.data === "string" && w.data.includes("QUEUED_WHILE_BUSY")));

  // ===== (3) a FURTHER enqueue after exhaustion is held too, despite busy now reading false =====
  const r3 = host.enqueueStdin(SID, "ENQUEUED_AFTER_EXHAUSTION", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-3");
  check("(3) a message enqueued AFTER exhaustion is marked is HELD (delivered:false), not sent straight through", r3.delivered === false);
  check("(3) pendingQueueDepth is now 2 — the new message queued, it did not bypass the hold", host.getPendingQueueDepth(SID) === 2);
  const heldTextWritten = () => writes.some((w) => w.sessionId === SID && typeof w.data === "string"
    && (w.data.includes("QUEUED_WHILE_BUSY") || w.data.includes("ENQUEUED_AFTER_EXHAUSTION")));
  check("(3) still no write() of either HELD message's own text (the first, pre-exhaustion delivery's own write is expected and excluded)", !heldTextWritten());

  // ===== (4) reconcile() — the periodic drain safety net — must NOT flush the held queue =====
  host.reconcile();
  check("(4) reconcile() does NOT change the pending queue depth (drainPending's own contextExhausted guard holds)", host.getPendingQueueDepth(SID) === 2);
  check("(4) reconcile() did NOT flip busy back to true (no submit happened)", busyLog[SID]?.at(-1) === false);
  check("(4) reconcile() never handed either held message's text to the fake pty's write()", !heldTextWritten());

  // ===== negative control: an ORDINARY (never-exhausted) busy session's held queue DOES drain on its
  // own falling edge — proves the hold in (2)-(4) is specific to contextExhausted, not a general queue
  // freeze that would make this whole test suite vacuously pass. =====
  {
    const SID2 = "wkr-ordinary-drain";
    spawnReady(SID2);
    host.enqueueStdin(SID2, "ORDINARY_FIRST");
    host.enqueueStdin(SID2, "ORDINARY_QUEUED", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-x");
    check("(neg) ordinary session: queue depth 1 before any Stop", host.getPendingQueueDepth(SID2) === 1);
    host.deliverHook(SID2, { hook_event_name: "Stop" });
    check("(neg) ordinary session: an ordinary Stop DOES drain the held queue (depth back to 0)", host.getPendingQueueDepth(SID2) === 0);
    check("(neg) ordinary session: the queued text WAS handed to write() this time", writes.some((w) => w.sessionId === SID2));
  }
  // ===== (6) CLEARS ON RISING EDGE: a fresh UserPromptSubmit hook (the real resume/next-turn chokepoint
  // — PtyHost.setBusy's own `if (busy) live.contextExhausted = false` branch) lifts the hold. Proven
  // via the SAME drains-vs-holds shape as the (neg) control above: a message queued AFTER the rising
  // edge, then a Stop, DRAINS this time — it would stay held forever if the flag hadn't cleared. =====
  {
    const SID3 = "wkr-rising-edge-clear";
    spawnReady(SID3);
    host.enqueueStdin(SID3, "RE_FIRST_TURN");
    const r = host.markContextExhausted(SID3);
    check("(6) setup: a fresh session can be marked exhausted too", r === true);
    check("(6) setup: busy is false right after marking", busyLog[SID3]?.at(-1) === false);

    // The resume/next-turn rising edge — mirrors the real UserPromptSubmit hook's own unconditional
    // setBusy(true) call (host.ts), which this card's fix made ALSO clear live.contextExhausted.
    host.deliverHook(SID3, { hook_event_name: "UserPromptSubmit", prompt: "RE_FIRST_TURN" });
    check("(6) the rising edge set busy back to true", busyLog[SID3]?.at(-1) === true);

    // Queue a message mid-turn, then end the turn — if contextExhausted truly cleared, this drains
    // exactly like the ordinary (neg) control; if it hadn't, drainPending's own guard would hold it
    // forever, indistinguishable from a bug.
    host.enqueueStdin(SID3, "RE_QUEUED_AFTER_CLEAR", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-re");
    check("(6) a message queued after the rising edge sits at depth 1 (ordinary busy-queue behaviour)", host.getPendingQueueDepth(SID3) === 1);
    host.deliverHook(SID3, { hook_event_name: "Stop" });
    check("(6) the Stop DRAINS it (depth back to 0) — proves contextExhausted was actually cleared, not still holding", host.getPendingQueueDepth(SID3) === 0);
    check("(6) the drained text WAS handed to write() — a real delivery, not a silent drop",
      writes.some((w) => w.sessionId === SID3 && typeof w.data === "string" && w.data.includes("RE_QUEUED_AFTER_CLEAR")));
  }

  // ===== (7) MUTANT B2 CATCH (CR finding, round 2): an exhausted session with an EMPTY pending
  // queue. The immediate-submit branch only requires `idleEligible && pending.length === 0` — a
  // mutant that dropped `!live.contextExhausted` from `idleEligible` would pass that check here
  // (pending genuinely IS empty) and write straight into the dead turn. (3) above can't catch this:
  // its queue already holds an entry at the time of enqueue, so it never reaches the immediate branch
  // either way. =====
  {
    const SID4 = "wkr-empty-queue-exhausted";
    spawnReady(SID4);
    host.enqueueStdin(SID4, "T4_FIRST_TURN"); // delivers immediately; busy=true, pending stays empty
    check("(7) setup: pending queue is empty before marking", host.getPendingQueueDepth(SID4) === 0);
    check("(7) setup: markContextExhausted succeeds", host.markContextExhausted(SID4) === true);
    check("(7) setup: queue is STILL empty right after marking (the mutant's exact precondition)", host.getPendingQueueDepth(SID4) === 0);
    const r4 = host.enqueueStdin(SID4, "ENQUEUED_ON_EMPTY_EXHAUSTED_QUEUE", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-4");
    check("(7) a message enqueued on an EMPTY exhausted queue is HELD, not delivered immediately", r4.delivered === false);
    check("(7) pendingQueueDepth is now 1 (held, not dropped)", host.getPendingQueueDepth(SID4) === 1);
    check("(7) no write() of the held text happened (the mutant's own failure signature)",
      !writes.some((w) => w.sessionId === SID4 && typeof w.data === "string" && w.data.includes("ENQUEUED_ON_EMPTY_EXHAUSTED_QUEUE")));
  }

  // ===== (8) HUMAN COMPOSER EXEMPTION (CR finding, round 2): an entry carrying
  // HUMAN_COMPOSER_SENDER_ID delivers immediately even while context-exhausted — a human acting IS
  // the recovery (e.g. /compact), and its own submit's busy rising edge clears the mark for everyone
  // queued behind it. "Test both": (8a) on an otherwise-identical empty-exhausted-queue setup, an
  // ordinary agent-kind entry stays held (the exemption is per-sender, never a session-wide bypass);
  // (8b) the composer entry on its OWN session delivers straight through. =====
  {
    const SID5a = "wkr-composer-negative";
    spawnReady(SID5a);
    host.enqueueStdin(SID5a, "T5A_FIRST_TURN");
    host.markContextExhausted(SID5a);
    const r5agent = host.enqueueStdin(SID5a, "AGENT_ENTRY_STAYS_HELD", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-5a");
    check("(8a) an ordinary agent-kind entry on an exhausted session is still HELD (the exemption is per-sender)", r5agent.delivered === false);
    check("(8a) pendingQueueDepth is 1 (held, not delivered)", host.getPendingQueueDepth(SID5a) === 1);

    const SID5b = "wkr-composer-positive";
    spawnReady(SID5b);
    host.enqueueStdin(SID5b, "T5B_FIRST_TURN");
    host.markContextExhausted(SID5b);
    check("(8b) setup: queue empty, session exhausted", host.getPendingQueueDepth(SID5b) === 0 && busyLog[SID5b]?.at(-1) === false);
    const r5 = host.enqueueStdin(SID5b, "HUMAN_COMPOSER_TEXT", "human", undefined, undefined, "agent", undefined, "HUMAN_COMPOSER_TEXT", undefined, HUMAN_COMPOSER_SENDER_ID);
    check("(8b) a HUMAN_COMPOSER_SENDER_ID entry delivers immediately DESPITE exhaustion (the exemption)", r5.delivered === true);
    check("(8b) its own submit's busy rising edge ALSO cleared contextExhausted (the shared setBusy(true) chokepoint)", busyLog[SID5b]?.at(-1) === true);
    check("(8b) the composer text WAS handed to write() — a real delivery, not held",
      writes.some((w) => w.sessionId === SID5b && typeof w.data === "string" && w.data.includes("HUMAN_COMPOSER_TEXT")));
  }
  // ===== (8c) ROUND 3 MAJOR (CR finding): the round-2 exemption above only ever bypassed
  // `contextExhaustedHold`, but `idleEligible && live.pending.length === 0` STILL gated immediate
  // delivery — so with so much as ONE already-held entry in front of it (the realistic case: a held
  // worker report, an idle nudge, queued manager direction), the composer's own recovery message queued
  // FIFO behind it and was NEVER drained (drainPending's own unconditional contextExhausted early
  // return holds the WHOLE queue, composer entry included), so the one write that can actually clear
  // the mark never ran either. Repro: markContextExhausted; enqueue a pre-held agent entry; enqueue a
  // composer entry — pre-fix this returned delivered:false and depth stayed 2 forever. =====
  {
    const SID6 = "wkr-composer-preheld";
    spawnReady(SID6);
    host.enqueueStdin(SID6, "T6_FIRST_TURN");
    host.markContextExhausted(SID6);
    const heldAgent = host.enqueueStdin(SID6, "PRE_HELD_AGENT_ENTRY", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-6");
    check("(8c) setup: the pre-held agent entry is held, not delivered", heldAgent.delivered === false);
    check("(8c) setup: pendingQueueDepth is 1 before the composer arrives", host.getPendingQueueDepth(SID6) === 1);

    const composerAfterHeld = host.enqueueStdin(SID6, "COMPOSER_DESPITE_PREHELD_QUEUE", "human", undefined, undefined, "agent", undefined, "COMPOSER_DESPITE_PREHELD_QUEUE", undefined, HUMAN_COMPOSER_SENDER_ID);
    check("(8c) MAJOR FIX: a composer entry delivers immediately even with a non-empty (held) queue ahead of it", composerAfterHeld.delivered === true);
    check("(8c) its own submit's rising edge cleared contextExhausted", busyLog[SID6]?.at(-1) === true);
    check("(8c) the composer text WAS handed to write()",
      writes.some((w) => w.sessionId === SID6 && typeof w.data === "string" && w.data.includes("COMPOSER_DESPITE_PREHELD_QUEUE")));
    check("(8c) the pre-held agent entry STAYS held (queue depth still 1 — not drained, not dropped) while the composer's own turn is in flight",
      host.getPendingQueueDepth(SID6) === 1);
    check("(8c) the pre-held agent entry's text was NOT written (still held, not drained as a side effect of the composer's delivery)",
      !writes.some((w) => w.sessionId === SID6 && typeof w.data === "string" && w.data.includes("PRE_HELD_AGENT_ENTRY")));

    // Once the composer's own turn ends (Stop), contextExhausted is already cleared and busy falls —
    // the pre-held agent entry should now drain NORMALLY (ordinary busy-queue behaviour), proving it
    // wasn't dropped or orphaned, just held until it was its turn.
    host.deliverHook(SID6, { hook_event_name: "Stop" });
    check("(8c) the pre-held agent entry DRAINS normally once the composer's turn completes (depth back to 0)", host.getPendingQueueDepth(SID6) === 0);
    check("(8c) the pre-held agent entry's text WAS eventually written, proving it drained normally rather than vanishing",
      writes.some((w) => w.sessionId === SID6 && typeof w.data === "string" && w.data.includes("PRE_HELD_AGENT_ENTRY")));
  }
} finally {
  try { host.stop?.("wkr-drain-hold"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-ordinary-drain"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-rising-edge-clear"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-empty-queue-exhausted"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-composer-negative"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-composer-positive"); } catch { /* best-effort */ }
  try { host.stop?.("wkr-composer-preheld"); } catch { /* best-effort */ }
}

// ===== (5) DB-level clear: stamped, then cleared on a rising-edge-shaped call; guarded against an
// unrelated lastError on a row that was never exhausted. Pure Db-level, no PtyHost needed. =====
{
  const dbFile = path.join(os.tmpdir(), `loom-ctxexh-drain-db-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const now = "2026-11-02T21:30:00.000Z";
  const projId = "proj-ctxexh-drain";
  const agentId = "agent-ctxexh-drain";
  db.insertProject({ id: projId, name: "CtxExhDrainDb", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  db.insertSession({ id: "s-exh", projectId: projId, agentId, engineSessionId: "eng-s-exh", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker" });
  db.insertSession({ id: "s-clean", projectId: projId, agentId, engineSessionId: "eng-s-clean", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: "an UNRELATED crash-loop banner", role: "worker" });

  try {
    db.setContextExhausted("s-exh", now, "Context exhausted — test stamp.");
    let row = db.getSession("s-exh");
    check("(5) setContextExhausted stamps contextExhaustedAt + lastError", row.contextExhaustedAt === now && /test stamp/.test(row.lastError ?? ""));

    db.clearContextExhaustedOnResume("s-exh");
    row = db.getSession("s-exh");
    check("(5) clearContextExhaustedOnResume clears contextExhaustedAt", row.contextExhaustedAt === null);
    check("(5) clearContextExhaustedOnResume ALSO clears the exhaustion lastError (it was this call's own stamp)", row.lastError === null);

    // Guard: a row that was NEVER exhausted — its own unrelated lastError must survive untouched.
    db.clearContextExhaustedOnResume("s-clean");
    const clean = db.getSession("s-clean");
    check("(5) GUARD: calling clearContextExhaustedOnResume on a never-exhausted row leaves its unrelated lastError completely untouched",
      clean.lastError === "an UNRELATED crash-loop banner" && clean.contextExhaustedAt === null);

    // Round 2 (CR finding #6): a row RE-marked exhausted, then OVERWRITTEN by something unrelated
    // (a crash-loop banner landing after the exhaustion stamp, before the next turn-start) must keep
    // that unrelated LATER lastError untouched too — the old unconditional clear used to wipe it
    // purely because context_exhausted_at was still set, with no regard for what lastError had become.
    db.insertSession({ id: "s-overwritten", projectId: projId, agentId, engineSessionId: "eng-s-overwritten", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker" });
    db.setContextExhausted("s-overwritten", now, "Context exhausted — the engine rejected the next prompt as too long (Prompt is too long).");
    db.setContextExhausted("s-overwritten", now, "an UNRELATED crash-loop banner landing AFTER the exhaustion stamp");
    let overwritten = db.getSession("s-overwritten");
    check("(5) round-2 setup: contextExhaustedAt is still set after the overwrite (the mark itself wasn't touched)", overwritten.contextExhaustedAt === now);
    check("(5) round-2 setup: lastError now holds the LATER, unrelated banner, not the exhaustion text", overwritten.lastError === "an UNRELATED crash-loop banner landing AFTER the exhaustion stamp");

    db.clearContextExhaustedOnResume("s-overwritten");
    overwritten = db.getSession("s-overwritten");
    check("(5) round-2: clearContextExhaustedOnResume still clears contextExhaustedAt", overwritten.contextExhaustedAt === null);
    check("(5) round-2: but it does NOT clobber the LATER unrelated lastError (prefix no longer matches)",
      overwritten.lastError === "an UNRELATED crash-loop banner landing AFTER the exhaustion stamp");

    // Positive counterpart: a row whose lastError STILL carries the exhaustion prefix clears exactly
    // as before (the fix narrows the clear, it does not disable it).
    db.setContextExhausted("s-overwritten", now, "Context exhausted — the engine rejected the next prompt as too long (Prompt is too long).");
    db.clearContextExhaustedOnResume("s-overwritten");
    overwritten = db.getSession("s-overwritten");
    check("(5) round-2: a lastError STILL carrying the exhaustion prefix DOES clear", overwritten.lastError === null && overwritten.contextExhaustedAt === null);
  } finally {
    try { db.close(); } catch { /* ignore */ }
    for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — once a session is marked context-exhausted, its held queue survives both the exhaustion-clearing-busy side effect AND the periodic reconcile() drain safety net (proven against a negative control: an ORDINARY session's queue DOES drain on an ordinary Stop, so the hold is specific to contextExhausted, not a general freeze); a fresh UserPromptSubmit rising edge (the real resume/next-turn chokepoint) clears the in-memory hold end-to-end (a message queued after it DOES drain on the next Stop); round 2's mutant-B2 catch proves the hold also fires on an EMPTY queue (not just a pre-populated one); the HUMAN_COMPOSER_SENDER_ID exemption lets a human's own composer entry deliver despite exhaustion while an ordinary agent entry on the identical setup stays held — round 3 proves that exemption ALSO fires with a PRE-HELD entry already queued ahead of it, with the pre-held entry staying held and draining normally once the composer's own turn completes; and the DB-level clear (clearContextExhaustedOnResume) correctly resets the mark while leaving an unrelated session's own lastError completely untouched — both for a row never exhausted AND for one re-exhausted-then-overwritten by something unrelated."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
